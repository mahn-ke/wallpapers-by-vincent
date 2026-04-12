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
import { createHash } from 'node:crypto';

const IMMICH_API_KEY = process.env.IMMICH_API_KEY;
const IMMICH_BASE_URL = process.env.IMMICH_BASE_URL;
const IMMICH_ALBUM_ID = process.env.IMMICH_ALBUM_ID;

const PORT = process.env.PORT || 3000;

const app = express();

const DAILY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DAILY_CACHE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const imageCacheByDate = new Map();
const BERLIN_TIME_ZONE = 'Europe/Berlin';

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

// Return YYYY-MM-DD string from either query `date` or Europe/Berlin current date
function getDateSeedString(dateParam) {
  if (typeof dateParam === 'string' && dateParam.trim().length) {
    // Basic normalization; assume YYYY-MM-DD or similar
    return dateParam.trim();
  }
  // Use Europe/Berlin current date
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BERLIN_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
  // en-CA yields YYYY-MM-DD
  return parts;
}

// Deterministic, well-distributed seeded index to avoid sequential-looking picks.
function seededIndex(seed, length) {
  const digest = createHash('sha256').update(seed).digest();
  const value = digest.readUInt32BE(0);
  return value % length;
}

function normalizedQueryValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }
  if (value === undefined || value === null) {
    return '';
  }
  return String(value);
}

function buildRestQueryHash(query) {
  const keys = Object.keys(query || {})
    .filter((key) => key !== 'date')
    .sort((a, b) => a.localeCompare(b));

  const canonical = keys.map((key) => [key, normalizedQueryValue(query[key])]);
  const serialized = JSON.stringify(canonical);
  return createHash('sha256').update(serialized).digest('hex');
}

function getOrCreateDateCache(dateKey) {
  const existing = imageCacheByDate.get(dateKey);
  if (existing) {
    return existing;
  }

  const created = { createdAt: Date.now(), images: new Map() };
  imageCacheByDate.set(dateKey, created);
  return created;
}

function parseGmtOffsetToMs(gmtOffset) {
  const normalized = String(gmtOffset || '').trim();
  const match = normalized.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/i);
  if (!match) {
    throw new Error(`Unexpected time zone offset format: ${normalized}`);
  }

  const sign = match[1] === '-' ? -1 : 1;
  const hours = Number.parseInt(match[2], 10);
  const minutes = Number.parseInt(match[3] || '0', 10);
  return sign * ((hours * 60) + minutes) * 60 * 1000;
}

function getTimeZoneOffsetMs(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'shortOffset',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(date);

  const tzPart = parts.find((part) => part.type === 'timeZoneName');
  if (!tzPart) {
    throw new Error(`Unable to resolve time zone offset for ${timeZone}`);
  }

  return parseGmtOffsetToMs(tzPart.value);
}

function zonedDateTimeToUtcMs(year, month, day, hour, minute, second, millisecond, timeZone) {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  const offset1 = getTimeZoneOffsetMs(new Date(utcGuess), timeZone);
  const adjusted = utcGuess - offset1;
  const offset2 = getTimeZoneOffsetMs(new Date(adjusted), timeZone);

  if (offset1 === offset2) {
    return adjusted;
  }

  return utcGuess - offset2;
}

function getDatePartsInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);

  const year = Number.parseInt(parts.find((part) => part.type === 'year')?.value || '', 10);
  const month = Number.parseInt(parts.find((part) => part.type === 'month')?.value || '', 10);
  const day = Number.parseInt(parts.find((part) => part.type === 'day')?.value || '', 10);

  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    throw new Error(`Unable to resolve date parts in timezone ${timeZone}`);
  }

  return { year, month, day };
}

function getMsUntilNextBerlinMidnight(now = new Date()) {
  const berlinToday = getDatePartsInTimeZone(now, BERLIN_TIME_ZONE);
  const utcForTomorrowDate = new Date(Date.UTC(berlinToday.year, berlinToday.month - 1, berlinToday.day) + DAILY_CACHE_TTL_MS);
  const tomorrowYear = utcForTomorrowDate.getUTCFullYear();
  const tomorrowMonth = utcForTomorrowDate.getUTCMonth() + 1;
  const tomorrowDay = utcForTomorrowDate.getUTCDate();

  const nextMidnightUtcMs = zonedDateTimeToUtcMs(
    tomorrowYear,
    tomorrowMonth,
    tomorrowDay,
    0,
    0,
    0,
    0,
    BERLIN_TIME_ZONE
  );

  return Math.max(0, nextMidnightUtcMs - now.getTime());
}

function setResponseCacheHeaders(res, ttlMs, etag) {
  const ttlSeconds = Math.max(0, Math.floor(ttlMs / 1000));
  const expiresAt = new Date(Date.now() + (ttlSeconds * 1000));

  res.setHeader('Cache-Control', `public, max-age=${ttlSeconds}, s-maxage=${ttlSeconds}, must-revalidate`);
  res.setHeader('Expires', expiresAt.toUTCString());
  res.setHeader('ETag', etag);
}

function clearExpiredDailyCaches() {
  const now = Date.now();
  for (const [dateKey, bucket] of imageCacheByDate.entries()) {
    if (now - bucket.createdAt < DAILY_CACHE_TTL_MS) {
      continue;
    }
    console.log(`Clearing cache for date ${dateKey} with ${bucket.images.size} images`);
    imageCacheByDate.delete(dateKey);
  }
}

setInterval(clearExpiredDailyCaches, DAILY_CACHE_CLEANUP_INTERVAL_MS).unref();

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
  const idx = seededIndex(`${albumId}:${seed}`, assets.length);
  const chosen = assets[idx];
  return chosen.id || chosen.assetId || chosen.uuid;
}

import { Vibrant } from "node-vibrant/node";

async function cropAssetToBuffer(assetId, reqW, reqH, darken, borderSize, topOffset, sharpen) {
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
  const orientedBuffer = await sharp(inputBuffer).rotate().toBuffer();

  const meta = await sharp(orientedBuffer).metadata();
  const imgW = meta.width || 0;
  const imgH = meta.height || 0;
  if (!imgW || !imgH) {
    throw new Error('Unable to read image dimensions');
  }

  const { width: cropW, height: cropH } = maxCropForAspect(imgW, imgH, reqW, reqH);

  async function cropToBuffer(orientedBuffer, imgW, imgH, darken) {
    const result = await SmartCrop.crop(orientedBuffer, { width: cropW, height: cropH });
    const top = result.topCrop;
    const left = Math.max(0, Math.floor(top.x));
    const topPx = Math.max(0, Math.floor(top.y));
    const extW = Math.min(imgW - left, Math.floor(top.width));
    const extH = Math.min(imgH - topPx, Math.floor(top.height));

    let image = sharp(orientedBuffer)
      .extract({ left, top: topPx, width: extW, height: extH });

    if (sharpen > 0) {
      const extracted = await image.toBuffer();
      image = sharp(extracted).sharpen({ sigma: 1, m1: sharpen * 4, m2: sharpen * 8 });
    }

    const stats = await image.stats();
    const avgBrightness = (stats.channels[0].mean + stats.channels[1].mean + stats.channels[2].mean) / 3;
    const originalDarkness = 100 - Math.round((avgBrightness / 255) * 100);

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

    return image
      .png()
      .toBuffer();
  }

  const cropArea = cropH;
  const originalArea = imgH;
  const cropRatio = cropArea / originalArea;

  if (cropRatio < 0.6) {
    const topHalf = await sharp(orientedBuffer)
      .extract({ left: 0, top: 0, width: imgW, height: Math.floor(imgH / 2) });
    const bottomHalf = await sharp(orientedBuffer)
      .extract({ left: 0, top: Math.floor(imgH / 2), width: imgW, height: Math.ceil(imgH / 2) });

    const topColor = await Vibrant.from(await topHalf.png().toBuffer())
      .getPalette()
      .then(palette => palette.LightMuted?.hex || '#000000');
    const bottomColor = await Vibrant.from(await bottomHalf.png().toBuffer())
      .getPalette()
      .then(palette => palette.Muted?.hex || '#000000');

    console.log(`Top color: ${topColor}, Bottom color: ${bottomColor}`);

    const gradientBuffer = await sharp({
      create: {
      width: cropW,
      height: cropH,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
      }
    })
      .composite([
      {
        input: Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${cropW}" height="${cropH}">
          <linearGradient id="grad" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" style="stop-color:${topColor};stop-opacity:1" />
          <stop offset="100%" style="stop-color:${bottomColor};stop-opacity:1" />
          </linearGradient>
          <rect width="100%" height="100%" fill="url(#grad)" />
        </svg>`
        ),
        blend: 'over'
      }
      ])
      .png()
      .toBuffer();

    

    let resizedOrientedBuffer = null;
    let border = null;
    if (borderSize > 0) {
      const aspectRatio = cropW / cropH;
      border = Math.round(cropH * borderSize);

      resizedOrientedBuffer = await sharp(orientedBuffer)
        .resize({ width: Math.round(cropW - aspectRatio * border), height: cropH - border, fit: 'inside' })
        .toBuffer();
    } else {
      resizedOrientedBuffer = await sharp(orientedBuffer)
        .resize({ width: cropW, height: cropH, fit: 'inside' })
        .toBuffer();
    }

    if (sharpen > 0) {
      resizedOrientedBuffer = await sharp(resizedOrientedBuffer)
        .sharpen({ sigma: 1, m1: sharpen * 4, m2: sharpen * 8 })
        .toBuffer();
    }

    let settings = { input: resizedOrientedBuffer, blend: 'over', gravity: 'center' };
    const topOffsetParameter = topOffset ? parseFloat(topOffset, 10) : 0;
    if (borderSize > 0) {
      settings = { input: resizedOrientedBuffer, blend: 'over', top: Math.round((border/2)+(border * topOffsetParameter)), left: Math.floor((cropW - (await sharp(resizedOrientedBuffer).metadata()).width) / 2) };
    }


    const centeredImage = await sharp({
      create: {
        width: cropW,
        height: cropH,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      }
    })
      .composite([
        { input: gradientBuffer, blend: 'over' },
        settings
      ])
      .png()
      .toBuffer();

    return centeredImage;
  } else {
    return cropToBuffer(orientedBuffer, imgW, imgH, darken);
  }
}

app.get('/', async (req, res) => {
  try {
    if (!IMMICH_API_KEY) {
      return res.status(500).send('IMMICH_API_KEY not set. Configure in code or via environment.');
    }
    if (!IMMICH_ALBUM_ID) {
      return res.status(500).send('IMMICH_ALBUM_ID not set. Configure in code or via environment.');
    }

    const dateSeed = getDateSeedString(req.query.date);
    const restQueryHash = buildRestQueryHash(req.query);
    const dateBucket = getOrCreateDateCache(dateSeed);
    const cacheTtlMs = getMsUntilNextBerlinMidnight();
    const cachedImage = dateBucket.images.get(restQueryHash);

    if (cachedImage) {
      setResponseCacheHeaders(res, cacheTtlMs, cachedImage.etag);
      if (req.headers['if-none-match'] === cachedImage.etag) {
        return res.status(304).end();
      }

      res.status(200);
      res.setHeader('Content-Type', 'image/png');
      return res.send(cachedImage.buffer);
    }

    const { width, height } = validateAndParseDims(req.query.width, req.query.height);
    // Optional darken param: 0..100, where 100 => no overlay, 0 => fully black overlay
    const darkenRaw = req.query.darken;
    const darken = darkenRaw !== undefined ? Number.parseInt(darkenRaw, 10) : undefined;
    // Allow forcing a specific asset via query for testing
    const forcedId = req.query.assetId;
    const assetId = forcedId && typeof forcedId === 'string' && forcedId.length > 10
      ? forcedId
      : await getSeededAssetIdFromAlbum(IMMICH_ALBUM_ID, dateSeed);
    const sharpenRaw = req.query.sharpen;
    const sharpen = sharpenRaw !== undefined ? Math.max(0, Math.min(1, parseFloat(sharpenRaw))) : 0;

    const imageBuffer = await cropAssetToBuffer(assetId, width, height, darken, req.query.border, req.query.topOffset, sharpen);
    const imageEtag = `"${createHash('sha256').update(imageBuffer).digest('hex')}"`;
    dateBucket.images.set(restQueryHash, { buffer: imageBuffer, etag: imageEtag });

    setResponseCacheHeaders(res, cacheTtlMs, imageEtag);
    if (req.headers['if-none-match'] === imageEtag) {
      return res.status(304).end();
    }

    res.status(200);
    res.setHeader('Content-Type', 'image/png');
    return res.send(imageBuffer);
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
