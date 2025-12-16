function enforceToken(req, res, next) {
    const expected = process.env.APP_ACCESS_TOKEN;
    const provided = req.query?.token;

    if (!expected) {
        return res.status(500).send('Server misconfigured: APP_ACCESS_TOKEN not set');
    }
    if (provided !== expected) {
        return res.status(403).send('Forbidden: invalid or missing token');
    }
    next();
}

import express from 'express';
import fetch from 'node-fetch';
import SmartCrop from 'smartcrop-sharp';
import sharp from 'sharp';

const IMMICH_API_KEY = process.env.IMMICH_API_KEY;
const IMMICH_BASE_URL = process.env.IMMICH_BASE_URL;
const IMMICH_ALBUM_ID = process.env.IMMICH_ALBUM_ID;

const PORT = process.env.PORT || 3000;

const app = express();

app.use(enforceToken);

function validateAndParseDims(qw, qh) {
  const width = Number.parseInt(qw, 10);
  const height = Number.parseInt(qh, 10);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('Both width and height query params must be positive integers');
  }
  return { width, height };
}

function maxCropForAspect(imgW, imgH, reqW, reqH) {
  const aspect = reqW / reqH;
  // Try full width first
  let w = imgW;
  let h = Math.floor(imgW / aspect);
  if (h > imgH) {
    h = imgH;
    w = Math.floor(imgH * aspect);
  }
  // Ensure at least 1x1
  w = Math.max(1, Math.min(w, imgW));
  h = Math.max(1, Math.min(h, imgH));
  return { width: w, height: h };
}

function formatToMime(format) {
  switch (format) {
    case 'jpeg':
    case 'jpg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    case 'tiff':
      return 'image/tiff';
    case 'heif':
      return 'image/heif';
    case 'avif':
      return 'image/avif';
    default:
      return 'application/octet-stream';
  }
}

async function getRandomAssetIdFromAlbum(albumId) {
  // Fetch album details (which include `assets` array)
  const url = `${IMMICH_BASE_URL}/api/albums/${encodeURIComponent(albumId)}`;
  const res = await fetch(url, {
    headers: {
      'x-api-key': IMMICH_API_KEY,
      'accept': 'application/json'
    }
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to fetch album assets: ${res.status} ${res.statusText} - ${text}`);
  }

  const data = await res.json();
  // Album endpoint returns an object with an `assets` array
  const assets = data?.assets || [];
  if (!assets.length) {
    throw new Error('Album has no assets or response format unexpected');
  }

  const random = assets[Math.floor(Math.random() * assets.length)];
  // Immich usually returns `id` for asset identifier.
  return random.id || random.assetId || random.uuid;
}

async function cropAssetAndSend(res, assetId, reqW, reqH) {
  const url = `${IMMICH_BASE_URL}/api/assets/${encodeURIComponent(assetId)}/original`;
  const assetRes = await fetch(url, {
    headers: { 'x-api-key': IMMICH_API_KEY }
  });

  if (!assetRes.ok) {
    const text = await assetRes.text();
    throw new Error(`Failed to fetch asset original: ${assetRes.status} ${assetRes.statusText} - ${text}`);
  }

  const arrayBuf = await assetRes.arrayBuffer();
  const inputBuffer = Buffer.from(arrayBuf);
  // Apply EXIF orientation before analyzing/cropping
  const orientedBuffer = await sharp(inputBuffer).rotate().toBuffer();

  const meta = await sharp(orientedBuffer).metadata();
  const imgW = meta.width || 0;
  const imgH = meta.height || 0;
  if (!imgW || !imgH) {
    throw new Error('Unable to read image dimensions');
  }

  const { width: cropW, height: cropH } = maxCropForAspect(imgW, imgH, reqW, reqH);

  const result = await SmartCrop.crop(orientedBuffer, { width: cropW, height: cropH });
  const top = result.topCrop;
  const left = Math.max(0, Math.floor(top.x));
  const topPx = Math.max(0, Math.floor(top.y));
  const extW = Math.min(imgW - left, Math.floor(top.width));
  const extH = Math.min(imgH - topPx, Math.floor(top.height));

  const outBuffer = await sharp(orientedBuffer)
    .extract({ left, top: topPx, width: extW, height: extH })
    .toBuffer();

  const outMeta = await sharp(outBuffer).metadata();
  const mime = formatToMime(outMeta.format || meta.format);

  res.status(200);
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', 'no-store');
  res.send(outBuffer);
}

app.get('/', async (req, res) => {
  try {
    if (!IMMICH_API_KEY || IMMICH_API_KEY === '<PUT_API_KEY_HERE>') {
      return res.status(500).send('IMMICH_API_KEY not set. Configure in code or via environment.');
    }
    if (!IMMICH_ALBUM_ID || IMMICH_ALBUM_ID === '<PUT_ALBUM_ID_HERE>') {
      return res.status(500).send('IMMICH_ALBUM_ID not set. Configure in code or via environment.');
    }

    const { width, height } = validateAndParseDims(req.query.width, req.query.height);
    // Allow forcing a specific asset via query for testing
    const forcedId = req.query.assetId;
    const assetId = forcedId && typeof forcedId === 'string' && forcedId.length > 10
      ? forcedId
      : await getRandomAssetIdFromAlbum(IMMICH_ALBUM_ID);
    await cropAssetAndSend(res, assetId, width, height);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error fetching random image: ' + err.message);
  }
});

app.get('/healthz', (req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
