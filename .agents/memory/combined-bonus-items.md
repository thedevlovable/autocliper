---
name: Combined "full edit" item in the clips array
description: The merged full-edit video rides in the same clips[] as normal clips — billing includes it, distribution excludes it; every consumer must decide explicitly.
---

# The merged "full edit" inside a shared clips array

The "full edit" (combine flag on POST /video/clip) unshifts one merged video into the SAME `clips` array every subsystem consumes, marked only by `combined: true`.

**Current product decision (owner, 2026-08-25):** it is NOT opt-in and NOT free. The clipper UI always sends `combine: true` + `combineOnly: true` when the AI prompt is non-empty (no toggle), and the full edit bills like one extra clip: reserve = (clipCount+1)×50 when combine is on; settle = PRODUCED count on ALL FOUR settle paths — primary, cache-hit, async settleJob, in-flight join. Failed/skipped merge → item absent → settle refunds the hold automatically; result notes say the full edit wasn't charged.

**Full-edit-only delivery (combineOnly, owner 2026-08-25):** production, billing, and delivery are now THREE separate axes. With `combineOnly` the individual moments are still produced and billed (they're the work the merge is made of) but only the merged video ships. Mechanics that must stay in lockstep: result + job record + `CachedClipResult` carry `billableCount` (produced count) whenever delivered < produced, and `billableClipCount()` prefers it; restart-recovery refunds (`refundHoldOnce`) must read `rec.billableCount ?? clips.length` or they over-refund the hidden pieces; hidden piece files are deleted from storage right after a successful merge (nothing references them — no history row, no job record) but NEVER when the merge fails or a single clip ships (`deliveredClips === clips` guard); cache key splits three ways (`|cmb:only` / `|cmb:1` / empty); UI hides Post All and shows "Full edit" labels when zero non-combined clips; history regenerate falls back to `clips.length` when the non-combined count is 0.

**Distribution stays excluded:** campaign ingestion AND the lazy campaign reconciler, server auto-post, and the UI "Post All" all filter `!c.combined` — the same content must never double-post. `forCampaign:true` + `combine:true` is rejected 400 server-side (campaigns filter the full edit, so it must never bill).

**Why the split matters:** the first (free-bonus) implementation leaked in three reachable places — the in-flight join settle path, the campaign reconciler rebuilding clips from persisted job records, and history saving `clipCount: clips.length` so Regenerate over-requested. Billing and distribution are separate axes; flipping one (free → billed) must not flip the other.

**How to apply:** when adding any derived item to a shared collection, walk EVERY consumer (all billing settle paths, reserve amount, campaign ingestion + reconcilers, auto-post, history save/count/regenerate, UI counts, Post All, ZIP, credits chip estimate) and decide include/exclude per consumer. Field-whitelisting sanitizers (history sanitizeClips) must explicitly carry the `combined` marker or it silently vanishes. Strict-boolean validate the flag (null = 400) and split the cache key (`|cmb:1`) only when on.

Merge mechanics: ffmpeg concat demuxer, stream-copy pass then re-encode fallback with the job's encode profile, never-throw → honest note instead of a failed job.
