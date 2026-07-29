/**
 * Persistent file store backed by Replit Object Storage.
 *
 * Files are uploaded to Object Storage (persists across restarts/redeploys) and
 * also cached locally in SERVE_DIR so range requests work without re-downloading.
 *
 * Object key layout:
 *   clips/{id}{ext}          — the media file
 *   clips/{id}.meta.json     — JSON sidecar with name/mimeType/ext/expiresMs
 *
 * TTL is 2 hours.
 */

import path from "path";
import os from "os";
import fs from "fs";
import crypto from "crypto";
import { Client as StorageClient } from "@replit/object-storage";

export const SERVE_DIR = path.join(os.tmpdir(), "clipai-serve");
try { fs.mkdirSync(SERVE_DIR, { recursive: true }); } catch { /* exists */ }

export interface FileMeta {
  name: string;
  mimeType: string;
  ext: string;
  expiresMs: number; // Unix ms
  sizeBytes?: number; // approximate size of the media file, written at upload time
}

// Maximum total Object Storage usage before the cleanup cycle forcibly evicts the
// oldest-expiring clips.  Configurable via STORAGE_SIZE_CAP_GB (default: 5 GB).
export const STORAGE_SIZE_CAP_BYTES =
  parseFloat(process.env.STORAGE_SIZE_CAP_GB ?? "5") * 1024 ** 3;

// Lazy singleton — avoids crashing at import time when sidecar is unreachable
let _storageClient: StorageClient | null = null;
export function getStorageClient(): StorageClient {
  if (!_storageClient) _storageClient = new StorageClient();
  return _storageClient;
}

/** FOR TESTING ONLY — inject a mock storage client. */
export function _setStorageClientForTest(client: StorageClient | null): void {
  _storageClient = client;
}

/**
 * Retry an async operation up to maxAttempts times with exponential backoff.
 * Rethrows the last error if all attempts fail.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number,
  baseDelayMs: number,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, baseDelayMs * Math.pow(2, attempt - 1)));
      }
    }
  }
  throw lastErr;
}

// ── Object Storage upload circuit breaker ─────────────────────────────────────
// States: CLOSED (normal) → OPEN (failing fast) → HALF_OPEN (probing)
// Opens after FAILURE_THRESHOLD consecutive upload failures.
// After COOLDOWN_MS the breaker moves to HALF_OPEN and allows one probe.
// A successful probe resets to CLOSED; a failed probe re-opens the circuit.

const CB_FAILURE_THRESHOLD = 3;   // consecutive failures before opening
const CB_COOLDOWN_MS = 30_000;    // how long to stay open before probing

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export const _cb = {
  state: "CLOSED" as CircuitState,
  consecutiveFailures: 0,
  openedAt: 0,          // timestamp when the circuit opened
};

/** Called after a successful Object Storage upload attempt. */
export function cbSuccess(): void {
  _cb.state = "CLOSED";
  _cb.consecutiveFailures = 0;
}

/** Called after a failed Object Storage upload attempt. */
export function cbFailure(): void {
  _cb.consecutiveFailures++;
  if (_cb.consecutiveFailures >= CB_FAILURE_THRESHOLD) {
    if (_cb.state !== "OPEN") {
      _cb.openedAt = Date.now();
      console.warn(
        `[storage] Circuit breaker OPENED after ${_cb.consecutiveFailures} consecutive upload failures.`,
      );
    }
    _cb.state = "OPEN";
  }
}

/**
 * Returns false when the circuit is CLOSED or HALF_OPEN (call allowed).
 * Returns true when the circuit is OPEN and the cool-down has NOT elapsed.
 * If the cool-down HAS elapsed, transitions to HALF_OPEN and returns false,
 * letting one probe request through.
 */
export function cbIsOpen(): boolean {
  if (_cb.state === "CLOSED") return false;
  if (_cb.state === "HALF_OPEN") return false; // probe already in flight
  // OPEN — check cool-down
  if (Date.now() - _cb.openedAt >= CB_COOLDOWN_MS) {
    _cb.state = "HALF_OPEN";
    console.info("[storage] Circuit breaker HALF_OPEN — probing Object Storage.");
    return false;
  }
  return true; // still open, reject immediately
}

/** Reset circuit breaker — FOR TESTING ONLY. */
export function _resetCircuitBreakerForTest(): void {
  _cb.state = "CLOSED";
  _cb.consecutiveFailures = 0;
  _cb.openedAt = 0;
}

/** Current circuit-breaker snapshot for health/status reporting. */
export function getStorageCircuitState(): {
  state: CircuitState;
  consecutiveFailures: number;
  openedAt: number;
} {
  return { ..._cb };
}

// ── In-process bucket-size counter ───────────────────────────────────────────
// Tracks the total live bytes currently stored in Object Storage.
// Initialised once at startup (initBucketCounter) by listing all live clips.
// Kept current by the cleanup cycle in videoTools.ts (setBucketBytes) and
// incremented/decremented optimistically inside storeFile so every upload is
// checked against remaining headroom before it hits Object Storage.

let _bucketBytes = -1; // -1 = not yet initialised
let _bucketInitPromise: Promise<void> | null = null;

/** Return the current tracked bucket usage in bytes (-1 if not yet initialised). */
export function getBucketBytes(): number { return _bucketBytes; }

/** Overwrite the counter — called by the cleanup cycle after a full scan. */
export function setBucketBytes(n: number): void { _bucketBytes = n; }

/** FOR TESTING ONLY — reset the counter back to uninitialised. */
export function _resetBucketCounterForTest(): void {
  _bucketBytes = -1;
  _bucketInitPromise = null;
}

/**
 * Initialise the bucket counter by listing all live clips from Object Storage.
 * Called once at startup; the cleanup cycle keeps the value current afterwards.
 * Idempotent — subsequent calls while initialisation is in flight await the same
 * promise; calls after it completes return immediately.
 */
export async function initBucketCounter(): Promise<void> {
  if (_bucketBytes >= 0) return; // already initialised
  if (_bucketInitPromise) return _bucketInitPromise;
  _bucketInitPromise = (async () => {
    try {
      const storage = getStorageClient();
      const listResult = await storage.list({ prefix: "clips/", matchGlob: "clips/*.meta.json" });
      if (!listResult.ok) { _bucketBytes = 0; return; }
      const now = Date.now();
      let total = 0;
      for (const obj of listResult.value) {
        try {
          const metaResult = await storage.downloadAsText(obj.name);
          if (!metaResult.ok) continue;
          const meta: FileMeta = JSON.parse(metaResult.value);
          if (now > meta.expiresMs) continue; // expired clip; cleanup will delete it
          total += meta.sizeBytes ?? 0;
        } catch { /* skip individual failures */ }
      }
      _bucketBytes = total;
      console.log(
        `[storage] Bucket counter initialised: ${(total / (1024 ** 2)).toFixed(1)} MB ` +
        `(cap: ${(STORAGE_SIZE_CAP_BYTES / (1024 ** 3)).toFixed(1)} GB)`,
      );
    } catch (err) {
      console.warn('[storage] initBucketCounter failed, defaulting to 0:', (err as Error).message);
      _bucketBytes = 0;
    }
  })();
  return _bucketInitPromise;
}

// Track in-progress object-storage downloads to avoid duplicate fetches
export const _downloadingFromStorage = new Map<string, Promise<{ filePath: string; meta: FileMeta } | null>>();

/**
 * Copy file into SERVE_DIR, persist to Object Storage, return UUID id.
 * Awaiting ensures the object is safely in Object Storage before the id
 * is returned, so cold-start resolves never race a still-uploading object.
 */
export async function storeFile(filePath: string, name: string, mimeType: string): Promise<string> {
  const id = crypto.randomUUID();
  const ext = path.extname(name) || "";
  const dest = path.join(SERVE_DIR, `${id}${ext}`);

  const fileStat = fs.statSync(filePath);

  // ── Headroom check ────────────────────────────────────────────────────────
  // If the counter is initialised, verify there is enough remaining capacity
  // before uploading.  This closes the window between cleanup cycles where a
  // single large upload could push the bucket over its size cap.
  if (_bucketBytes >= 0 && _bucketBytes + fileStat.size > STORAGE_SIZE_CAP_BYTES) {
    const usedGB  = (_bucketBytes / (1024 ** 3)).toFixed(2);
    const capGB   = (STORAGE_SIZE_CAP_BYTES / (1024 ** 3)).toFixed(1);
    const fileMB  = (fileStat.size / (1024 ** 2)).toFixed(1);
    throw new Error(
      `Storage is full (${usedGB} GB used of ${capGB} GB cap; ` +
      `this clip is ${fileMB} MB). ` +
      `Clips are auto-cleaned every 15 minutes — please try again shortly.`,
    );
  }

  // Optimistically increment before the upload so concurrent storeFile calls
  // also see updated headroom and don't all squeeze through simultaneously.
  if (_bucketBytes >= 0) _bucketBytes += fileStat.size;

  fs.copyFileSync(filePath, dest);

  const meta: FileMeta = {
    name,
    mimeType,
    ext,
    expiresMs: Date.now() + 2 * 60 * 60 * 1000, // 2 hours
    sizeBytes: fileStat.size,
  };
  const metaJson = JSON.stringify(meta);
  fs.writeFileSync(path.join(SERVE_DIR, `${id}.meta.json`), metaJson);

  // Upload to Object Storage when available — optional, non-fatal.
  // If the circuit is OPEN or the upload fails, clips are still served from
  // local disk for the lifetime of this process. They won't survive a restart,
  // but the request succeeds and the user gets their clips.
  if (!cbIsOpen()) {
    try {
      const storage = getStorageClient();
      await withRetry(
        () => Promise.all([
          storage.uploadFromFilename(`clips/${id}${ext}`, dest, { compress: false }),
          storage.uploadFromText(`clips/${id}.meta.json`, metaJson),
        ]),
        3,
        500, // 500 ms → 1 s → 2 s
      );
      cbSuccess();
    } catch (err) {
      cbFailure();
      // Roll back the optimistic size increment — not persisted to Object Storage.
      if (_bucketBytes >= 0) _bucketBytes -= fileStat.size;
      console.warn(
        '[storage] Object Storage upload failed — clip will be served from local disk only:',
        (err as Error).message,
      );
    }
  } else {
    // Roll back the optimistic size increment — upload skipped.
    if (_bucketBytes >= 0) _bucketBytes -= fileStat.size;
    console.warn('[storage] Circuit breaker open — skipping Object Storage upload, serving from local disk.');
  }

  return id;
}

/**
 * Resolve a stored file.
 * 1. Check local disk cache first (fast, supports range requests).
 * 2. On cache miss, fetch from Object Storage and cache locally.
 * Returns null if not found in either location or if the TTL has expired.
 */
export async function resolveFile(id: string): Promise<{ filePath: string; meta: FileMeta } | null> {
  // Sanitize id — must be a UUID-like string (no path traversal)
  if (!/^[\w-]{8,64}$/.test(id)) return null;

  // ── 1. Local disk hit ────────────────────────────────────────────────────
  const metaPath = path.join(SERVE_DIR, `${id}.meta.json`);
  if (fs.existsSync(metaPath)) {
    let meta: FileMeta;
    try { meta = JSON.parse(fs.readFileSync(metaPath, "utf8")); }
    catch { return null; }
    if (Date.now() > meta.expiresMs) {
      try { fs.unlinkSync(metaPath); } catch { /* ignore */ }
      try { fs.unlinkSync(path.join(SERVE_DIR, `${id}${meta.ext}`)); } catch { /* ignore */ }
      return null;
    }
    const filePath = path.join(SERVE_DIR, `${id}${meta.ext}`);
    if (fs.existsSync(filePath)) return { filePath, meta };
  }

  // ── 2. Object Storage fallback (deduplicated) ────────────────────────────
  if (_downloadingFromStorage.has(id)) {
    return _downloadingFromStorage.get(id)!;
  }

  const fetchPromise = (async (): Promise<{ filePath: string; meta: FileMeta } | null> => {
    try {
      const storage = getStorageClient();

      // Fetch meta first — cheap and tells us the ext + expiry
      const metaResult = await storage.downloadAsText(`clips/${id}.meta.json`);
      if (!metaResult.ok) return null;

      let meta: FileMeta;
      try { meta = JSON.parse(metaResult.value); }
      catch { return null; }

      if (Date.now() > meta.expiresMs) return null;

      // Fetch the media file to local disk so we can serve range requests
      const filePath = path.join(SERVE_DIR, `${id}${meta.ext}`);
      const dlResult = await storage.downloadToFilename(`clips/${id}${meta.ext}`, filePath);
      if (!dlResult.ok) return null;

      // Write the meta sidecar so subsequent hits use the fast disk path
      fs.writeFileSync(path.join(SERVE_DIR, `${id}.meta.json`), JSON.stringify(meta));

      return { filePath, meta };
    } catch (err) {
      console.warn('[storage] Object Storage resolve failed:', (err as Error).message);
      return null;
    } finally {
      _downloadingFromStorage.delete(id);
    }
  })();

  _downloadingFromStorage.set(id, fetchPromise);
  return fetchPromise;
}

/**
 * Check whether Object Storage is reachable.
 * Used by the health endpoint and the startup probe.
 * Also reports the current circuit-breaker state.
 */
export async function checkStorageHealth(): Promise<{
  ok: boolean;
  error?: string;
  circuit: CircuitState;
  consecutiveFailures: number;
}> {
  const { state: circuit, consecutiveFailures } = getStorageCircuitState();
  try {
    const storage = getStorageClient();
    // list is a lightweight read-only call; empty results are fine — we only care it doesn't throw.
    const result = await storage.list({ prefix: "__health__" });
    if (!result.ok) {
      const detail = (result as { error?: unknown }).error;
      return {
        ok: false,
        error: `list returned not-ok: ${String(detail ?? 'unknown')}`,
        circuit,
        consecutiveFailures,
      };
    }
    return { ok: true, circuit, consecutiveFailures };
  } catch (err) {
    return { ok: false, error: (err as Error).message, circuit, consecutiveFailures };
  }
}
