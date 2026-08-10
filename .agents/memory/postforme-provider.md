---
name: Post for Me posting provider
description: Active social auto-posting provider (replaced bundle.social, Aug 2026) — API quirks, Quickstart project limits, ownership and webhook rules
---

Post for Me (postforme.dev, user's Pro plan) is the ONLY posting provider. bundle.social is fully removed.

**API basics.** Base `https://api.postforme.dev/v1`, `Authorization: Bearer POSTFORME_API_KEY` (server-only secret — never in client code or logs). Platform slugs lowercase: facebook, instagram, x, tiktok, youtube, pinterest, linkedin, bluesky, threads, tiktok_business. Post status enum `draft|scheduled|processing|processed`; per-account outcomes ONLY via `GET /social-post-results?post_id=` (`success` flag + error). `DELETE /social-posts/:id` cancels (404 = already gone). `GET /social-posts?external_id=` recovers ambiguous creates.

**Ownership.** Accounts/posts are tagged `external_id = user_<id>`, but PFM dedupes the same physical account project-wide — the local connections table is the ownership authority. Every route taking account ids must verify locally and 403 on foreign ids; never trust PFM's external_id alone.

**Quickstart project limits (user's current plan tier).**
- Platforms must be ENABLED per-platform in PFM dashboard → Project Setup, else auth-url returns 404 "Social provider app credentials not found". This is user-side config, not code.
- `redirect_url_override` is REJECTED ("Redirect URL Override is not allowed for Quickstart Projects") — the dashboard's single Project Redirect URL is used. Code sends the override first and auto-falls back without it on that error, so it works on both project tiers.
- Consequence: OAuth always lands on the dashboard-configured (prod) callback even when initiated from dev; dev still picks the account up via external_id sync on the next accounts load.

**Why:** all three discovered by live smoke against the real key; the error precedence (override-check vs credentials-check) differs per platform, so don't infer enablement from which error comes back.

**Webhooks.** Deliveries carry plain-compare header `Post-For-Me-Webhook-Secret`; must 2xx within ~1s (PFM retries ~8x/24h). Verify via cached DB secrets: primed at boot, stale-served on DB error, sub-second race → 401 fail-closed on timeout. Ack first, process async + idempotent (replays and late events must be no-ops; never demote a posted marker).

**Media.** PFM fetches media by URL at/near publish time. User-supplied URL scheduling must pass a DNS-resolving SSRF check (`urlResolvesPublic`) at enqueue AND again at handoff; Drive confirm tokens are one-time so direct-URL resolution happens at handoff, not enqueue. Scheduler drain: `FOR UPDATE SKIP LOCKED` lease + attempts cap + never schedule in the past.

**How to apply:** any new posting feature goes through the local ownership check + claim markers (see clip-post-idempotency.md); any new user-URL intake needs the DNS-level SSRF check; platform enablement problems are dashboard config, surface them honestly (409) instead of retrying.
