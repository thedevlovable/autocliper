---
name: Instagram viewer/downloader (Zyla IG API)
description: Zyla Instagram Profile & Media Data API integration — key split from YT engine, quota protections, CDN streaming proxy rules
---

# Instagram profile viewer + downloader

Backend `/api/ig/*` (profile, media posts|reels|stories, resolve for pasted post/reel links, download/view streaming proxy) on Zyla API #12390; UI page at `/instagram`.

## Key split from the YouTube engine
- The account's existing `ZYLA_API_KEY` returned 401 "not authorized / please subscribe" for API #12390 — Zyla subscriptions are per-account, and the user may buy different APIs on different Zyla accounts.
- **Rule:** IG routes read `ZYLA_IG_API_KEY ?? ZYLA_API_KEY`. Never overwrite `ZYLA_API_KEY` with a second account's key — that silently breaks the YT downloader (API #11016) whose subscription lives on the first account.
- 401/403 from Zyla = key's account lacks the subscription. Map to a clear "ask admin to update key" error and NEVER cache it (a fixed key must work immediately).

## Paid-quota protections (every upstream call bills)
- 30-min in-memory success cache + in-flight dedupe per endpoint+param; 404/400 negative-cached ~10 min (bad usernames bill too).
- Tests must stub global fetch; `__tests__/setup.ts` deletes real Zyla keys so unit runs can never spend quota.
- Response shapes were built from docs samples only (dev key can't call the API) — the harvest/normalize layer walks arbitrary JSON for downloadUrl/mediaType variants instead of trusting exact paths. Verify with 1-2 real calls once a subscribed key lands.

## Streaming proxy rules (learned via architect review)
- `/ig/view` renders bytes inline under OUR origin → MIME-gate to image/* (never svg+xml) or video/*; everything else 415. `X-Content-Type-Options: nosniff` alone is not protection when upstream declares text/html.
- Every fetch Response NOT piped to the client must have its body cancelled (invalid redirect hops, !ok upstreams, MIME rejections) or sockets leak under normal expired-signed-URL traffic.
- Host allowlist `*.cdninstagram.com` / `*.fbcdn.net`, https only, redirects re-validated hop by hop (max 3), plus `urlResolvesPublic` DNS check.
- IG signed URLs expire (`oe=` param) → map upstream 4xx to "link expired, search again", never stream a corrupt/HTML body as a download.

## Frontend race rule
- Search results/tabs use a generation counter (`genRef`); any await checks its generation before committing state so an old account's media can't bleed into a new search. Per-kind loading map, not one global flag.
