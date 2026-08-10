---
name: Clip social-post idempotency
description: Claim-before-post markers prevent double-posting clips; release policy on failure is deliberate, not a bug.
---

**Rule:** A clip may reach a platform at most once. `clip_social_posts` rows are claim markers taken atomically (INSERT … ON CONFLICT DO NOTHING RETURNING, unique on user+clip+platform) BEFORE uploading/posting. Only the posting lib writes/deletes these rows — route handlers must never insert them directly.

**Why:** User got the same clip on TikTok twice (auto-post on completion + manual "Post" click were separate uncoordinated paths) and explicitly demanded one-click-one-post. Duplicates on a public profile are unrecoverable; a false "already posted" is fixable by deleting the marker row.

**How to apply:**
- On post failure, claims are released ONLY when the provider definitely did not create the post (typed 4xx). Ambiguous outcomes (5xx/network/timeout) KEEP the claim — do not "fix" this as a lost-post bug; it's the chosen tradeoff.
- Release is retried 3×; final failure logs `FAILED to release posted-markers` (grep-able) with manual cleanup hint.
- Boot-time dedupe + unique-index creation is gated on index existence (one-time full-table scan, keeps oldest row).
- Auto-post toggle failures now surface as toasts with the server error; if a user reports the toggle "not working", ask what the toast says — backend PATCH was verified working on prod (tested with fresh account).
