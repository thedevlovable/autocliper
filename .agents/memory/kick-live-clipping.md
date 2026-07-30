---
name: Kick live-stream clipping
description: How to clip a Kick stream that is still live — yt-dlp metadata quirks and Cloudflare blocking of Node fetch.
---

# Kick live-stream clipping

- yt-dlp on a live `kick.com/{channel}` URL reports `is_live: true`, `live_status: "is_live"`, `duration: null` — the sealed-window math can never run on the channel URL itself.
- The recorded (in-progress) part IS clippable: Kick channel API `GET /api/v2/channels/{slug}/videos` has an `is_live` entry with a `source` IVS m3u8 (`stream.kick.com/.../master.m3u8`). yt-dlp probes that playlist as a *generic* URL and returns the sealed recorded duration; `--download-sections` works on it directly.
- **Kick's Cloudflare blocks Node's `fetch` with HTTP 403 (TLS fingerprint) but allows curl** — all Kick API calls from the server must shell out to curl (see `kickApiJson` in videoTools.ts). Same headers via fetch still 403.

**Why:** clipping a live Kick stream would otherwise throw a misleading "stream just started" error or fall into a 20-min full-download of an endless stream.

**How to apply:** any new Kick API call must go through the curl helper, and live handling must clip from the resolved IVS m3u8, not the channel URL.
