---
name: Clip social-post idempotency & live status mirror
description: Claim-before-post markers prevent double-posting clips; marker lifecycle + bundle.social status mirroring rules; release policy on failure is deliberate, not a bug.
---

**Rule:** A clip may reach a platform at most once. `clip_social_posts` rows are claim markers taken atomically (INSERT … ON CONFLICT DO NOTHING RETURNING, unique on user+clip+platform) BEFORE uploading/posting. Only the posting lib writes/deletes these rows — route handlers must never insert them directly.

**Why:** User got the same clip on TikTok twice (auto-post on completion + manual "Post" click were separate uncoordinated paths) and explicitly demanded one-click-one-post. Duplicates on a public profile are unrecoverable; a false "already posted" is fixable by deleting the marker row.

**How to apply:**
- On post failure, claims are released ONLY when the provider definitely did not create the post (typed 4xx). Ambiguous outcomes (5xx/network/timeout) KEEP the claim — do not "fix" this as a lost-post bug; it's the chosen tradeoff.
- Release is retried 3×; final failure logs `FAILED to release posted-markers` (grep-able) with manual cleanup hint.
- Boot-time dedupe + unique-index creation is gated on index existence (one-time full-table scan, keeps oldest row).
- Auto-post toggle failures now surface as toasts with the server error; if a user reports the toggle "not working", ask what the toast says — backend PATCH was verified working on prod (tested with fresh account).
- User-facing unblock: push-clip accepts `force` — second tap on "Posted before — tap to repost" clears that clip's markers (only for the pushed platforms) then posts. Never auto-force; only after the UI showed the already-posted state. Force remains the ONLY unlock for legacy/`unknown` markers (no provider post id — unverifiable).
- "Push not reaching bundle.social" report (2026-08-10) was expected marker-blocking of previously-posted clips; also fixed the clip button lying "Not connected" on every error — it now shows the real server message (first 90 chars).

## Status mirror (added after users deleted posts on the platform and got stuck)
**Rule:** Markers carry a lifecycle (`pending` → `submitted` → `posted`; `unknown` = ambiguous post-create) plus the provider post id. The UI never invents a state — it polls a status endpoint that mirrors bundle.social's answer (short cache), and shows "Publishing…" until the provider says POSTED.
**Why:** Deleting a post on TikTok/bundle.social does NOT clear our marker; users tapped "Post" forever and nothing went out. Also the old UI showed instant fake "Posted!".
**How to apply:**
- A blocked push first verifies markers against the provider: post gone (404/deletedAt)/ERROR/per-platform error → marker freed → repost succeeds on the FIRST tap. Ambiguous fetch (5xx/network) → never free.
- Stale-`pending` sweeps (crashed pushes, >15 min, no post id) MUST be conditional deletes (`status='pending' AND bundle_post_id IS NULL`, RETURNING to confirm) — a plain by-id delete races the in-flight push saving its post id and re-opens the duplicate-post hole (caught in review).
- If saving the post id after a successful create fails, escalate the marker to `unknown` immediately (never auto-freed) rather than leaving it `pending` (sweepable).
- Status responses self-heal: gone → row deleted (repostable), provider error → row deleted + real error surfaced once, submitted-and-live → promoted to `posted`.
