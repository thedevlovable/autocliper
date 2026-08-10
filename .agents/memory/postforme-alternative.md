---
name: Post for Me as bundle.social alternative
description: User bought postforme.dev Pro (Aug 2026) as possible bundle.social replacement — key API facts if we ever port the social-posting stack.
---

**Fact:** User purchased Post for Me (postforme.dev) Pro 2.5K — $25/mo, 2,500 posts — in Aug 2026 while bundle.social was still the integrated provider. Evaluated as a cheaper alternative (bundle Pro is $100/mo; bundle also bills X per-post from prepaid credits starting 2026-08-16, PFM lists no X surcharge).

**Key API facts (verified from their OpenAPI spec):**
- Base `https://api.postforme.dev/v1`, Bearer API key. 9 platforms incl. TikTok/IG/YT/X.
- Media by URL directly in post create (`media:[{url}]`) — provider fetches, satisfies the "no load on my VPS" rule; also signed-URL upload via `/media/create-upload-url`.
- `POST /social-posts` with `scheduled_at` (scheduling), `social_accounts: [ids]` (per-account ids, NOT platform types like bundle).
- Status model: post `status` enum `draft|scheduled|processing|processed` + per-account `GET /social-post-results` rows (`success`, `error`, `platform_data`) — maps cleanly onto our marker lifecycle + status mirror.
- Has webhooks (`/v1/webhooks`, event_types) — could replace polling.
- Accounts connect via `POST /social-accounts/auth-url` redirect or their dashboard.

**How to apply:** If user says go, port push-clip + bulk scheduler + status mirror behind the same marker rules (claim lifecycle, conditional sweeps, unknown escalation are provider-agnostic). Request the PFM API key via the secrets flow. Keep bundle.social working until PFM is proven with real posts; accounts must be re-connected on PFM (none connected as of purchase).
