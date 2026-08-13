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

## Heredocs silently split `&&` chains
`cmd1 && cat > file <<'EOF' … EOF` followed by more commands: everything after the heredoc terminator runs as a NEW statement even when the chain before it failed — commits/cleanup can run despite failed tests (happened twice on 2026-08-13). Put heredoc writes FIRST (or use the file-write tool), keep verify→commit as one pure `&&` chain with no heredoc in the middle.

## Filtered `pnpm add` can break sibling packages
`pnpm --filter <pkg> add X` re-pruned the workspace and left another package's node_modules missing its test runner ("Cannot find module …/vitest/vitest.mjs", typecheck "Cannot find module 'vitest'"). After any dependency change in one package, run root `pnpm install` and re-verify the OTHER package's suite before blaming the repo.
