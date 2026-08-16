---
name: Auto-Pilot campaign materializer invariants
description: Race-safety rules for the social campaign materializer (folder → daily social_posts) and the clip-link retry flow — keep these when editing campaigns/scheduling code.
---

# Auto-Pilot campaign invariants

Campaigns materialize one campaign-day at a time into ordinary `social_posts`
rows (`source='campaign'`, `batch_id=campaign id`); the existing scheduler
drain does all posting. The materializer holds `FOR UPDATE SKIP LOCKED` on the
campaign row and advances `last_planned_date` under that lock.

**Rules (review-found races — keep them):**

1. **Disable-first teardown.** Pause/delete must first commit `enabled=FALSE`
   on the campaign row (a plain UPDATE waits out an in-flight materializer's
   row lock), and only THEN cancel queued rows / delete. Cancel-then-delete
   without disabling lets a concurrent materializer commit a post nobody
   cancels.
   **Why:** the materializer runs on a timer on every instance; the row lock is
   the only serialization point.

2. **Never reset the planning cursor on edits.** `last_planned_date` must NOT
   be nulled when dates/times/etc. change — `nextMaterializeDate` clamps into
   the edited range on its own, and a reset re-plans a day whose posts are
   already queued → double-posting. The ONLY reset is resume-after-pause,
   because pause already cancelled the queued rows.

3. **Partial PATCH from the UI.** The edit form sends only changed fields and
   never sends `timezone` on edit (times were entered relative to the original
   zone; a browser in another zone would silently shift every slot).

4. Missed whole DAYS are skipped, never backfilled (`nextMaterializeDate`
   clamps up to today). But TODAY's already-passed slots are caught up, not
   dropped: `planDaySlots` reschedules them at now+5min staggered 10min apart
   (user expectation: a campaign created/edited mid-day still posts today's
   quota). `nextRunAt` mirrors this only when `last_planned_date < today` —
   once today is consumed it must NOT advertise a catch-up. Item consumed =
   `post_row_id` set, freed only when its post row is `cancelled`.

5. **Clip retry ("Try clips again").** Failed clip-link campaigns retry by the
   FRONTEND starting a replacement `/video/clip` job (job params are not
   reconstructable server-side; the campaign's `clip_params` JSONB stores
   {clipCount, quality} for replay — legacy rows null → UI defaults), then a
   retry route attaches the new jobId. The failed→clipping flip must be a
   CONDITIONAL update (`WHERE clip_status='failed'`) so concurrent retries
   can't double-attach — the loser's job stays a harmless orphan because
   forCampaign jobs never auto-post. Reject retry when end_date < today in the
   campaign tz (a paid job could never post). Job-attach ownership checks
   deliberately mirror create: own job, not error/cancelled; attaching your
   own older job is allowed (clips are yours either way).

**How to apply:** any new campaign teardown path, bulk edit, or "re-plan"
feature must go through disable-first + cancel + (optional) cursor reset, in
that order, and prove no day can be planned twice. Any new clip_status
transition must be a conditional UPDATE, and any flow that starts a paid job
on a campaign's behalf must check the campaign can still post first.
