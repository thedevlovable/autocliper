---
name: Workspace environment quirks
description: Replit workspace behaviors that break naive testing/automation approaches
---

# Background processes get reaped

Long-running background node scripts (`setsid nohup node x.cjs &`) are killed by
the environment within roughly a minute of the launching shell exiting — twice
observed: an e2e script died mid-poll, a smoke script died right after its first
request. Logs just stop; no error line.

**Why:** the shell-exec harness reaps orphaned process groups; setsid does not
protect against it.

**How to apply:** run long e2e/smoke scripts in a FOREGROUND shell command with
an adequate timeout (≤300s per call). For jobs longer than that, poll durable
state (e.g. `/tmp/clipai-jobs/*.json` job records, DB rows) from fresh shell
calls instead of keeping one script alive. The environment can also restart
spontaneously, wiping /tmp and stopping workflows — restart workflows and
re-verify after any suspicious silence.

- **Editing ClipperPage while the user runs a clip job in dev orphans their screen.** Vite HMR invalidate kills the in-flight polling loop; the server still finishes the job. Diagnose via `/tmp/clipai-jobs/*.json` (status often `done` while the UI sits frozen) before assuming the pipeline hung. UI now stores the active job id in localStorage and reconnects on load — but old tabs opened before that code won't self-heal; user must refresh and use History.

## Parallel vitest runs share the dev DB
Running the api suite in a shell while the `api-server-test` workflow is also running → cross-run flakes in unrelated files (e.g. fileAuth, uploads). If untouched files fail, re-run alone before debugging.
