---
name: Zyla YouTube downloader engine
description: Operational facts about the paid ZylaLabs download engine that sources YouTube video for the clip pipeline
---

- The clip pipeline sources YouTube video through the user's PAID ZylaLabs "YouTube Download and Info API" (`ZYLA_API_KEY` secret): resolve a direct R2 mirror URL first, then probe/loudness/section-download all read from that mirror; any failure falls back to the yt-dlp → Railway → Vercel → Cobalt chain. Only start calls consume monthly quota; progress polls and R2 links are free.
- **Zyla's `progress_url` is NOT on zylalabs.com** — live responses point at third-party infra (observed `youtube-api-progress-*.up.railway.app`). Host-pinning it to zylalabs.com broke every real start while unit tests stayed green (fixtures matched the pin, not reality). Validate SSRF properties only (https, public host); never pin their unstable hostnames. After hardening external-API validation, always re-run one LIVE call.
- **Unit tests must never see the real key**: the workspace env exports ZYLA_API_KEY, and queue/clip tests post fake YouTube URLs by the dozen — without the vitest setup file stripping the key, tests fire real paid starts and get flaky from network latency.
- Live testing burns quota — prefer already-finished url+format pairs (6-day in-memory cache, `cached:true`, zero cost). Demo video `LXb3EKWsInQ` finishes in ~5s on Zyla's side. Cache and job records are in-memory only: every restart/republish empties them (fine on single-instance Reserved VM; revisit for autoscale).
- Cookie tests + the dev server share `/tmp/clipai-cookies` unless `CLIPAI_COOKIES_DIR` is set — parallel vitest workers raced each other and wiped the server's live cookies.txt until the setup file gave each worker its own dir.
- User explicitly cancelled a proposed quota-usage warning feature (July 2026) — do not re-propose quota monitoring unprompted.
