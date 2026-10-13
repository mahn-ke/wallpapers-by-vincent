import fetch from 'node-fetch';

export async function fetchAlbumAssets({ baseUrl, apiKey, albumId }, fetchImpl = fetch) {
  const base = baseUrl.replace(/\/$/, '');
  const headers = { 'x-api-key': apiKey, accept: 'application/json' };
  const albumResponse = await fetchImpl(`${base}/api/albums/${encodeURIComponent(albumId)}`, { headers });
  if (!albumResponse.ok) {
    throw new Error(`Failed to fetch album assets: ${albumResponse.status} ${albumResponse.statusText} - ${await albumResponse.text()}`);
  }

  const album = await albumResponse.json();
  if (Array.isArray(album.assets)) {
    return album.assets;
  }

  const assets = [];
  let page = 1;
  while (true) {
    const response = await fetchImpl(`${base}/api/search/metadata`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ albumIds: [albumId], page, size: 1000 })
    });
    if (!response.ok) {
      throw new Error(`Failed to search album assets (requires asset:read permission): ${response.status} ${response.statusText} - ${await response.text()}`);
    }

    const data = await response.json();
    if (!Array.isArray(data.assets?.items)) {
      throw new Error('Unexpected album asset search response');
    }
    assets.push(...data.assets.items);
    if (data.assets.nextPage === null || data.assets.nextPage === undefined) {
      return assets;
    }
    const nextPage = Number(data.assets.nextPage);
    if (!Number.isInteger(nextPage) || nextPage <= page) {
      throw new Error('Unexpected album asset search pagination');
    }
    page = nextPage;
  }
}