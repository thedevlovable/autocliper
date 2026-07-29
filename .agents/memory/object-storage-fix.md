---
name: Object Storage sidecar empty bucket fix
description: Why Replit Object Storage fails at startup and how to fix it
---

# Replit Object Storage — sidecar returns empty bucketId

## The rule
When creating the `@replit/object-storage` `Client`, always pass `bucketId` explicitly from `process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID` rather than letting the SDK fetch it from the sidecar.

**Why:** The Replit sidecar at `http://127.0.0.1:1106` returns `{"bucketId":""}` (empty string) in the dev container. The SDK then calls `gcsClient.bucket("")` which throws "A bucket name is needed to use Cloud Storage." The `DEFAULT_OBJECT_STORAGE_BUCKET_ID` secret is set correctly in the environment — the sidecar just doesn't reflect it.

**How to apply:** In `artifacts/api-server/src/lib/fileStore.ts`, `createReplitAdapter()`:
```ts
const bucketId = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
_client = new Client(bucketId ? { bucketId } : undefined);
```

## yt-dlp path in dev

`YTDLP_PATH` env var points to `/home/runner/workspace/bin/yt-dlp` which doesn't exist after a fresh import. Fix: symlink the Nix binary there:
```bash
ln -sf /nix/store/.../bin/yt-dlp /home/runner/workspace/bin/yt-dlp
```
The deployment build step downloads a fresh binary to that path, so the symlink is only needed for dev.
