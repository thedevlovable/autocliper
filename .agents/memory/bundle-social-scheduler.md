---
name: Bundle.social bulk scheduler
description: Provider-side media storage + scheduled posting via bundle.social — key API behaviors and worker patterns for the bulk Drive/Dropbox scheduler.
---

# bundle.social bulk scheduler

**Rule:** All media storage and timed publishing must happen on bundle.social, never on our server (user's hard requirement — "no load on my website").
**Why:** User self-hosts on a small VPS; 1000-video batches would kill disk/bandwidth.
**How to apply:** `POST /upload/from-url` (`{url, teamId}`) makes bundle's servers fetch the file from a public URL; a post created with future `postDate` + `status:"SCHEDULED"` is published by bundle itself. Our side keeps only metadata rows + a light claim worker.

## Durable API facts
- Post targeting granularity is **platform types** (`socialAccountTypes`), not account ids — one account per platform per team, so per-type == per-account.
- Upload status enum is undocumented; wait loops must match loosely (UPLOADED/READY/DONE/…) and on timeout return anyway, letting post creation be the arbiter.
- Google Drive public folders can be enumerated with no API key via `https://drive.google.com/embeddedfolderview?id=<folderId>` HTML (entry-ID + title scrape).
- Google Drive download confirm tokens are **one-time** — resolve them at upload time in the worker, never at enqueue time.
- Dropbox `www.dropbox.com` share links → swap host to `dl.dropboxusercontent.com` (drop `dl` param); folder links only work with `?preview=<file>`.

## Worker patterns that matter
- Lease = `status='uploading'` + `updated_at`; claim query also reclaims stale uploading rows (15 min > the 4-min upload wait cap) with `attempts < 3`, and a sweeper fails poisoned ones. Without this, a mid-upload crash leaves rows stuck "Uploading…" forever.
- Every state transition is CAS (`WHERE status='uploading'`); cancel-during-upload is undone by deleting the just-created provider post (retry ×3, "404/not found" = already gone = success), and persistent undo failure is written to the row's `error` — never swallowed.
- Direct video URLs go through a private-host blocklist (localhost/RFC1918/link-local/CGNAT/IPv6 literals) before being handed to bundle — delegated-SSRF hygiene.

**Prod debugging from dev:** dev and the VPS share the same BUNDLE_API_KEY/workspace, so `GET /team/`, `/post/?teamId=`, `/upload/?teamId=` from here inspect the real prod user's activity (first team in the list = the main prod user). Zero recent uploads = pushes blocked server-side (markers/file) before ever reaching the provider; an upload without a matching post = post-create failed after upload (claims kept on ambiguous).
