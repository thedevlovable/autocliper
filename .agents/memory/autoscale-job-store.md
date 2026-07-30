---
name: Autoscale job-store mirror
description: Why async job records must be mirrored to Object Storage on autoscale, and the write-ordering race that comes with it
---

# Autoscale job-store mirror

**Rule:** On Replit Autoscale, anything written to per-instance disk (/tmp) is invisible to other instances and dies on scale-to-zero. Async job status records MUST be mirrored to Object Storage; polling reads need a local-first + bucket-fallback path.

**Why:** Live site showed "Lost track of this job" — poll requests landed on a different/fresh instance than the one running the job. Dev never reproduces this (single server).

**How to apply:**
- Mirror writes must be ORDERED per job (promise chain per jobId). Fire-and-forget uploads race: a rapid queued→processing→done sequence (e.g. cache hit) can land out of order and leave a stale "processing" as the final bucket record.
- Local-first reads: terminal (done/error) local records are authoritative; non-terminal local records older than the heartbeat interval may be a stale re-cache — check bucket and prefer the record with newer updatedMs.
- GC mirrored records (they're tiny but unbounded otherwise).
- Autoscale containers have small scratch disks — dev-sized free-disk guards (3GB) 503 every request in prod; default low (1GB) with env override.
- **Autoscale throttles CPU outside request handling** — background ffmpeg encodes crawl at ~0.04x and die on timeout (observed live: fps=1.1 on a 30s clip). Multi-minute background video jobs need a Reserved VM deployment (`deploymentTarget: "vm"`), not autoscale. Also encode ONE clip at a time in deployments — parallel encodes starve each other on small containers.
- YouTube bot-blocks datacenter IPs far more than the dev workspace IP. Without cookies, cap yt-dlp retries (`--retries 2 --extractor-retries 1`) and skip transcript fetches after a bot-check hit, or each blocked job wastes ~4 min in doomed internal retries before reaching fallbacks.
- Proof-test pattern: run async job to done, `rm` the local job file (simulates other instance), GET status again — must return the full done record from the bucket.
