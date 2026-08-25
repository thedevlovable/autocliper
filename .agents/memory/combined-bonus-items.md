---
name: Combined bonus items in the clips array
description: The free "full edit" merged video rides in the same clips[] as paid clips — every consumer must explicitly filter it.
---

# Bonus items inside a shared clips array

The opt-in "full edit" (combine flag on POST /video/clip) unshifts one merged video into the SAME `clips` array that every other subsystem consumes, marked only by `combined: true`.

**Rule:** any code that treats `clips.length` as "paid clips" or iterates clips as postable inventory MUST filter `!c.combined`.

**Why:** review of the first implementation found three reachable leaks even after the obvious spots were handled:
1. Billing — the in-flight **join** branch settled `r.clips.length` (overcharge). There are FOUR settle paths: primary, cache-hit, async settleJob, and in-flight join; all must use the shared `billableClipCount()` helper.
2. Campaigns — the settle hook filtered, but the **lazy reconciler** in campaigns list GET rebuilds clips from persisted job records and would have scheduled the full edit as inventory.
3. History — the client-side save posted `clipCount: clips.length`, so **Regenerate** would re-request N+1 paid clips; and `sanitizeClips` whitelists fields, so the `combined` marker silently vanished unless explicitly carried.

**How to apply:** when adding any future bonus/derived item to a shared collection, grep for every consumer of that collection (billing settles, campaign ingestion AND reconcilers, auto-post, history save/count/regenerate, UI counts, Post All, ZIP) and decide per-consumer include/exclude. Field-whitelisting sanitizers must be updated or markers get dropped. Strict-boolean validate the flag (reject null too) and split the cache key only when the flag is on so old cache entries stay valid.

Merge itself: ffmpeg concat demuxer, stream-copy first then re-encode fallback with the job's encode profile, never-throw → honest note instead of failing the job.
