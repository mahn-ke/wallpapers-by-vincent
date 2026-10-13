import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchAlbumAssets } from '../utils/immichAlbum.js';

const config = { baseUrl: 'https://immich.example/', apiKey: 'test-key', albumId: 'test-album' };
const response = (data) => ({ ok: true, json: async () => data });

test('older Immich album responses do not require a search request', async () => {
  const assets = [{ id: 'first', fileCreatedAt: '2025-01-01T00:00:00Z' }];
  let calls = 0;
  const result = await fetchAlbumAssets(config, async (url, options) => {
    calls += 1;
    assert.equal(url, 'https://immich.example/api/albums/test-album');
    assert.equal(options.headers['x-api-key'], 'test-key');
    return response({ assets });
  });
  assert.deepEqual(result, assets);
  assert.equal(calls, 1);
});

test('Immich v3 album assets are fetched across all search pages', async () => {
  const pages = [];
  const result = await fetchAlbumAssets(config, async (url, options) => {
    if (url.endsWith('/api/albums/test-album')) return response({ assetCount: 2 });
    assert.equal(url, 'https://immich.example/api/search/metadata');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['x-api-key'], 'test-key');
    assert.equal(options.headers['content-type'], 'application/json');
    const body = JSON.parse(options.body);
    assert.deepEqual(body.albumIds, ['test-album']);
    assert.equal(body.size, 1000);
    pages.push(body.page);
    return response({ assets: { items: [{ id: `asset-${body.page}` }], nextPage: body.page === 1 ? '2' : null } });
  });
  assert.deepEqual(pages, [1, 2]);
  assert.deepEqual(result.map((asset) => asset.id), ['asset-1', 'asset-2']);
});

test('empty legacy albums remain empty without searching', async () => {
  assert.deepEqual(await fetchAlbumAssets(config, async () => response({ assets: [] })), []);
});

test('missing search permissions produce an actionable error', async () => {
  await assert.rejects(fetchAlbumAssets(config, async (url) => {
    if (url.includes('/api/albums/')) return response({ assetCount: 1 });
    return { ok: false, status: 403, statusText: 'Forbidden', text: async () => 'Permission denied' };
  }), /asset:read permission.*403/);
});

test('invalid search responses and repeated pages are rejected', async () => {
  for (const assets of [{}, { items: [], nextPage: '1' }]) {
    await assert.rejects(fetchAlbumAssets(config, async (url) => {
      return response(url.includes('/api/albums/') ? { assetCount: 1 } : { assets });
    }), /Unexpected album asset search/);
  }
});