function enforceToken(req, res, next) {
    const expected = process.env.APP_ACCESS_TOKEN;
    const provided = req.query?.token;

    // if request path is /healthz, skip token check
    if (req.path === '/healthz') {
        return next();
    }

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

// Return YYYY-MM-DD string from either query `date` or Europe/Berlin current date
function getDateSeedString(dateParam) {
  if (typeof dateParam === 'string' && dateParam.trim().length) {
    // Basic normalization; assume YYYY-MM-DD or similar
    return dateParam.trim();
  }
  // Use Europe/Berlin current date
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
  // en-CA yields YYYY-MM-DD
  return parts;
}

// Simple deterministic hash for strings (djb2 variant)
function hashStringToInt(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash |= 0; // force 32-bit
  }
  return Math.abs(hash);
}

// Seeded deterministic selection: picks asset by hashing a date string
async function getSeededAssetIdFromAlbum(albumId, seedStr) {
  // Fetch album assets same as above
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
  const assets = data?.assets || [];
  if (!assets.length) {
    throw new Error('Album has no assets or response format unexpected');
  }

  const seed = seedStr && seedStr.length ? seedStr : 'default-seed';
  const h = hashStringToInt(seed);
  const idx = h % assets.length;
  const chosen = assets[idx];
  return chosen.id || chosen.assetId || chosen.uuid;
}

async function cropAssetAndSend(res, assetId, reqW, reqH, darken) {
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

  // Build the cropped image first
  const image = sharp(orientedBuffer)
    .extract({ left, top: topPx, width: extW, height: extH });

  // Determine how dark the original image is
  const stats = await image.stats();
  const avgBrightness = (stats.channels[0].mean + stats.channels[1].mean + stats.channels[2].mean) / 3;
  const originalDarkness = 100 - Math.round((avgBrightness / 255) * 100);

  // Compare original darkness to `darken`
  const darkenVal = Number.isFinite(darken) ? Math.max(0, Math.min(100, Math.floor(darken))) : null;
  console.log(`Original darkness: ${originalDarkness}, requested darken: ${darkenVal}`);
  if (darkenVal !== null && originalDarkness < darkenVal) {
    const alpha = (darkenVal - originalDarkness) / 100;
    if (alpha > 0) {
      image.composite([
        {
          input: {
            create: {
              width: extW,
              height: extH,
              channels: 4,
              background: { r: 0, g: 0, b: 0, alpha }
            }
          }
        }
      ]);
    }
  }

  const outBuffer = await image
    .png()
    .toBuffer();

  const mime = 'image/png';

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
    // Optional darken param: 0..100, where 100 => no overlay, 0 => fully black overlay
    const darkenRaw = req.query.darken;
    const darken = darkenRaw !== undefined ? Number.parseInt(darkenRaw, 10) : undefined;
    // Allow forcing a specific asset via query for testing
    const forcedId = req.query.assetId;
    const dateSeed = getDateSeedString(req.query.date);
    const assetId = forcedId && typeof forcedId === 'string' && forcedId.length > 10
      ? forcedId
      : await getSeededAssetIdFromAlbum(IMMICH_ALBUM_ID, dateSeed);
    await cropAssetAndSend(res, assetId, width, height, darken);
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
