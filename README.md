# Immich Random Album Image Server

A minimal Node.js Express server that fetches a random image from an Immich album, smart-crops it to the requested aspect ratio, and serves it at [wallpapers.by.vincent.mahn.ke](https://wallpapers.by.vincent.mahn.ke).

## Configuration

- API base: `https://photos.by.vincent.mahn.ke` (configured in code)
- Set the following either in code (src/server.js) or via environment variables:
  - `IMMICH_BASE_URL` - Immich server base URL with no trailing slash
  - `IMMICH_API_KEY` – Immich API key
  - `IMMICH_ALBUM_ID` – Album ID to sample from
  - `APP_ACCESS_TOKEN` (optional) – if set, requests must include `token=...` matching this value

### API Key Permissions

Minimum required permissions for the API key:
- album:read – to list assets in the album
- asset:download – to fetch the image (original/thumbnail)

Create a read-only key in Immich with these scopes.

## Install & Run

```bash
npm install
npm run start
```

Alternatively, with environment variables:

```bash
export IMMICH_API_KEY="<your_key>"
export IMMICH_BASE_URL="https://your.immich.server"
export IMMICH_ALBUM_ID="<album_id>"
export APP_ACCESS_TOKEN="<optional_token>"
npm run start
```

Then open: http://localhost:3000/?width=800&height=600&token=<optional_token>

## Usage

- Required query params: `width` and `height` (positive integers).
- The server calculates the aspect ratio `width:height`, determines the largest possible crop within the image that respects this ratio, and uses `smartcrop` to pick the best region.
- The output is the cropped image (no upscaling; it never exceeds the original dimensions).

Examples:

```bash
# Start the server with an access token configured
APP_ACCESS_TOKEN=secret npm run start

# Valid request (allowed)
curl -I "http://localhost:3000/?width=800&height=600&token=secret"

# Invalid token (rejected)
curl -I "http://localhost:3000/?width=800&height=600&token=bad"

# No token (rejected)
curl -I "http://localhost:3000/?width=800&height=600"
```
