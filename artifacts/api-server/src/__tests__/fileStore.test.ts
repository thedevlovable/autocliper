/**
 * Integration test: clips survive a server restart and are still playable.
 *
 * Scenario:
 *   1. storeFile() writes the clip to local disk AND uploads it to Object Storage.
 *   2. The local disk cache is deleted (simulating a server restart that wiped /tmp).
 *   3. resolveFile() has no local cache hit, so it fetches from Object Storage.
 *   4. The returned filePath exists on disk and its contents match the original fixture.
 *   5. The returned FileMeta has the correct name, mimeType, and a future expiresMs.
 *
 * The Object Storage client (@replit/object-storage) is fully mocked so the test
 * runs in CI without any live Object Storage bucket.
 */

import path from "path";
import os from "os";
import fs from "fs";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── In-memory fake Object Storage ────────────────────────────────────────────
// Simulates uploadFromFilename, uploadFromText, downloadAsText,
// and downloadToFilename using a simple Map.

type FakeStore = Map<string, Buffer>;

interface FakeStorageListItem { name: string }
interface FakeStorageListResult { ok: boolean; value: FakeStorageListItem[] }

function makeFakeStorage(store: FakeStore) {
  return {
    uploadFromFilename: vi.fn(async (key: string, filePath: string) => {
      store.set(key, fs.readFileSync(filePath));
      return { ok: true };
    }),
    uploadFromText: vi.fn(async (key: string, text: string) => {
      store.set(key, Buffer.from(text, "utf8"));
      return { ok: true };
    }),
    downloadAsText: vi.fn(async (key: string) => {
      const buf = store.get(key);
      if (!buf) return { ok: false as const, value: "" };
      return { ok: true as const, value: buf.toString("utf8") };
    }),
    downloadToFilename: vi.fn(async (key: string, destPath: string) => {
      const buf = store.get(key);
      if (!buf) return { ok: false as const };
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, buf);
      return { ok: true as const };
    }),
    list: vi.fn(async (): Promise<FakeStorageListResult> => ({ ok: true, value: [] })),
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Write a small fixture file and return its path. */
function writeFixture(dir: string, name: string, content: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, "utf8");
  return p;
}

/** Delete every file in SERVE_DIR that starts with the given id prefix. */
function evictLocalCache(serveDir: string, id: string): void {
  for (const f of fs.readdirSync(serveDir)) {
    if (f.startsWith(id)) {
      fs.unlinkSync(path.join(serveDir, f));
    }
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("fileStore — restart survival", () => {
  let tmpDir: string;
  let fakeStore: FakeStore;

  beforeEach(async () => {
    // Each test gets its own temp directory so tests don't interfere
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "filestore-test-"));
    fakeStore = new Map();

    // Override SERVE_DIR for this test by pointing the module at our tmpDir.
    // We do this by injecting the mock client *and* patching the module-level
    // SERVE_DIR — the easiest approach without a full DI container is to use
    // the test-only escape hatch exported from fileStore.
    const mod = await import("../lib/fileStore.js");
    mod._setStorageClientForTest(makeFakeStorage(fakeStore) as never);
    mod._resetCircuitBreakerForTest();
  });

  afterEach(() => {
    // Restore the singleton so other test files start clean
    (async () => {
      const mod = await import("../lib/fileStore.js");
      mod._setStorageClientForTest(null);
      mod._resetCircuitBreakerForTest();
    })();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("storeFile uploads both the media file and meta to Object Storage", async () => {
    const { storeFile } = await import("../lib/fileStore.js");

    const fixturePath = writeFixture(tmpDir, "clip.mp4", "fake-mp4-bytes");
    const id = await storeFile(fixturePath, "clip.mp4", "video/mp4");

    // Both keys must have been written to the fake store
    expect(fakeStore.has(`clips/${id}.mp4`)).toBe(true);
    expect(fakeStore.has(`clips/${id}.meta.json`)).toBe(true);

    // Meta JSON must be parseable and correct
    const meta = JSON.parse(fakeStore.get(`clips/${id}.meta.json`)!.toString("utf8"));
    expect(meta.name).toBe("clip.mp4");
    expect(meta.mimeType).toBe("video/mp4");
    expect(meta.ext).toBe(".mp4");
    expect(meta.sizeBytes).toBeGreaterThan(0);
    expect(meta.expiresMs).toBeGreaterThan(Date.now());
  });

  it("resolveFile returns null for an unknown id (nothing in cache or Object Storage)", async () => {
    const { resolveFile } = await import("../lib/fileStore.js");

    const result = await resolveFile("00000000-0000-0000-0000-000000000000");
    expect(result).toBeNull();
  });

  it("resolveFile serves from local disk cache when it exists", async () => {
    const { storeFile, resolveFile, SERVE_DIR } = await import("../lib/fileStore.js");

    const fixturePath = writeFixture(tmpDir, "cached.mp4", "cached-content");
    const id = await storeFile(fixturePath, "cached.mp4", "video/mp4");

    // Local cache should still be present — resolve should use it directly
    const result = await resolveFile(id);
    expect(result).not.toBeNull();
    expect(fs.existsSync(result!.filePath)).toBe(true);
    expect(fs.readFileSync(result!.filePath, "utf8")).toBe("cached-content");
    expect(result!.meta.name).toBe("cached.mp4");
    expect(result!.meta.mimeType).toBe("video/mp4");
  });

  it("resolveFile fetches from Object Storage after local cache is evicted (restart simulation)", async () => {
    const { storeFile, resolveFile, SERVE_DIR } = await import("../lib/fileStore.js");

    const originalContent = "this-is-a-fake-video-file";
    const fixturePath = writeFixture(tmpDir, "restart.mp4", originalContent);
    const id = await storeFile(fixturePath, "restart.mp4", "video/mp4");

    // Verify the file was uploaded
    expect(fakeStore.has(`clips/${id}.mp4`)).toBe(true);

    // Simulate a server restart: delete all local cache entries for this id
    evictLocalCache(SERVE_DIR, id);
    expect(fs.existsSync(path.join(SERVE_DIR, `${id}.mp4`))).toBe(false);
    expect(fs.existsSync(path.join(SERVE_DIR, `${id}.meta.json`))).toBe(false);

    // resolveFile must now go to Object Storage and restore the file
    const result = await resolveFile(id);
    expect(result).not.toBeNull();

    // The restored file must exist on disk and match the original bytes
    expect(fs.existsSync(result!.filePath)).toBe(true);
    const restored = fs.readFileSync(result!.filePath, "utf8");
    expect(restored).toBe(originalContent);

    // Metadata must be correct and not expired
    expect(result!.meta.name).toBe("restart.mp4");
    expect(result!.meta.mimeType).toBe("video/mp4");
    expect(result!.meta.ext).toBe(".mp4");
    expect(result!.meta.expiresMs).toBeGreaterThan(Date.now());
  });

  it("resolveFile re-writes the local meta sidecar after a cache-miss restore", async () => {
    const { storeFile, resolveFile, SERVE_DIR } = await import("../lib/fileStore.js");

    const fixturePath = writeFixture(tmpDir, "sidecar.mp4", "sidecar-test");
    const id = await storeFile(fixturePath, "sidecar.mp4", "video/mp4");

    evictLocalCache(SERVE_DIR, id);

    await resolveFile(id);

    // The meta sidecar must have been written back to the disk cache
    const metaPath = path.join(SERVE_DIR, `${id}.meta.json`);
    expect(fs.existsSync(metaPath)).toBe(true);
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    expect(meta.name).toBe("sidecar.mp4");
  });

  it("a second resolveFile call after restore hits local disk (no extra Object Storage downloads)", async () => {
    const { storeFile, resolveFile, SERVE_DIR } = await import("../lib/fileStore.js");
    const storage = makeFakeStorage(fakeStore);
    const mod = await import("../lib/fileStore.js");
    mod._setStorageClientForTest(storage as never);

    const fixturePath = writeFixture(tmpDir, "double.mp4", "double-resolve");
    const id = await storeFile(fixturePath, "double.mp4", "video/mp4");
    evictLocalCache(SERVE_DIR, id);

    // First resolve — fetches from Object Storage
    await resolveFile(id);
    const firstDownloadCount = (storage.downloadToFilename as ReturnType<typeof vi.fn>).mock.calls.length;

    // Second resolve — must hit local disk, no additional Object Storage download
    await resolveFile(id);
    const secondDownloadCount = (storage.downloadToFilename as ReturnType<typeof vi.fn>).mock.calls.length;

    expect(secondDownloadCount).toBe(firstDownloadCount);
  });

  it("resolveFile returns null for an expired clip (both in cache and Object Storage)", async () => {
    const { storeFile, SERVE_DIR } = await import("../lib/fileStore.js");
    // Import resolveFile fresh — use a dynamic import so we can patch meta after store
    const { resolveFile } = await import("../lib/fileStore.js");

    const fixturePath = writeFixture(tmpDir, "expired.mp4", "expired-content");
    const id = await storeFile(fixturePath, "expired.mp4", "video/mp4");

    // Backdate the meta in Object Storage to simulate an expired clip
    const metaKey = `clips/${id}.meta.json`;
    const meta = JSON.parse(fakeStore.get(metaKey)!.toString("utf8"));
    meta.expiresMs = Date.now() - 1000; // already expired
    fakeStore.set(metaKey, Buffer.from(JSON.stringify(meta), "utf8"));

    // Evict local cache so resolveFile falls through to Object Storage
    evictLocalCache(SERVE_DIR, id);

    const result = await resolveFile(id);
    expect(result).toBeNull();
  });

  it("resolveFile sanitizes malformed ids and returns null", async () => {
    const { resolveFile } = await import("../lib/fileStore.js");

    expect(await resolveFile("../../../etc/passwd")).toBeNull();
    expect(await resolveFile("")).toBeNull();
    expect(await resolveFile("ok-id-but-" + "a".repeat(65))).toBeNull(); // too long
  });
});

// ── Headroom counter tests ─────────────────────────────────────────────────────

describe("fileStore — headroom counter", () => {
  let tmpDir: string;
  let fakeStore: FakeStore;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "filestore-headroom-"));
    fakeStore = new Map();
    const mod = await import("../lib/fileStore.js");
    mod._setStorageClientForTest(makeFakeStorage(fakeStore) as never);
    mod._resetCircuitBreakerForTest();
    mod._resetBucketCounterForTest();
  });

  afterEach(async () => {
    const mod = await import("../lib/fileStore.js");
    mod._setStorageClientForTest(null);
    mod._resetCircuitBreakerForTest();
    mod._resetBucketCounterForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("getBucketBytes starts at -1 (uninitialised)", async () => {
    const { getBucketBytes } = await import("../lib/fileStore.js");
    expect(getBucketBytes()).toBe(-1);
  });

  it("setBucketBytes / getBucketBytes round-trip", async () => {
    const { getBucketBytes, setBucketBytes } = await import("../lib/fileStore.js");
    setBucketBytes(1_234_567);
    expect(getBucketBytes()).toBe(1_234_567);
  });

  it("storeFile increments the counter by the file size", async () => {
    const { storeFile, getBucketBytes, setBucketBytes } = await import("../lib/fileStore.js");
    setBucketBytes(0);

    const fixturePath = writeFixture(tmpDir, "clip.mp4", "hello-world");
    const fileSize = fs.statSync(fixturePath).size;

    await storeFile(fixturePath, "clip.mp4", "video/mp4");

    expect(getBucketBytes()).toBe(fileSize);
  });

  it("storeFile accumulates size across multiple uploads", async () => {
    const { storeFile, getBucketBytes, setBucketBytes } = await import("../lib/fileStore.js");
    setBucketBytes(0);

    const p1 = writeFixture(tmpDir, "a.mp4", "content-a");
    const p2 = writeFixture(tmpDir, "b.mp4", "content-bb");
    const s1 = fs.statSync(p1).size;
    const s2 = fs.statSync(p2).size;

    await storeFile(p1, "a.mp4", "video/mp4");
    await storeFile(p2, "b.mp4", "video/mp4");

    expect(getBucketBytes()).toBe(s1 + s2);
  });

  it("storeFile rejects when counter shows bucket is full", async () => {
    const { storeFile, STORAGE_SIZE_CAP_BYTES, setBucketBytes } = await import("../lib/fileStore.js");
    // Pretend the bucket is 1 byte below capacity
    setBucketBytes(STORAGE_SIZE_CAP_BYTES - 1);

    const fixturePath = writeFixture(tmpDir, "big.mp4", "two-bytes!"); // size > 1 byte
    await expect(storeFile(fixturePath, "big.mp4", "video/mp4")).rejects.toThrow(
      /Storage is full/,
    );
  });

  it("counter is NOT decremented after a rejection from the headroom check (nothing was incremented)", async () => {
    const { storeFile, getBucketBytes, setBucketBytes, STORAGE_SIZE_CAP_BYTES } = await import("../lib/fileStore.js");
    setBucketBytes(STORAGE_SIZE_CAP_BYTES - 1);
    const before = getBucketBytes();

    const fixturePath = writeFixture(tmpDir, "big.mp4", "two-bytes!!");
    await expect(storeFile(fixturePath, "big.mp4", "video/mp4")).rejects.toThrow(/Storage is full/);

    // Counter must be unchanged — the headroom check fires before any increment
    expect(getBucketBytes()).toBe(before);
  });

  it("storeFile rolls back the counter when the Object Storage upload fails", async () => {
    const { storeFile, getBucketBytes, setBucketBytes } = await import("../lib/fileStore.js");
    setBucketBytes(0);

    // Make uploadFromFilename always fail
    const failingStorage = {
      ...makeFakeStorage(fakeStore),
      uploadFromFilename: vi.fn(async () => { throw new Error("upload boom"); }),
    };
    const mod = await import("../lib/fileStore.js");
    mod._setStorageClientForTest(failingStorage as never);

    const fixturePath = writeFixture(tmpDir, "fail.mp4", "doomed");
    await expect(storeFile(fixturePath, "fail.mp4", "video/mp4")).rejects.toThrow();

    // Counter must be rolled back to its pre-upload value
    expect(getBucketBytes()).toBe(0);
  });

  it("storeFile does not check headroom when counter is uninitialised (-1)", async () => {
    const { storeFile, getBucketBytes } = await import("../lib/fileStore.js");
    // Counter starts at -1 — storeFile must proceed without throwing
    expect(getBucketBytes()).toBe(-1);

    const fixturePath = writeFixture(tmpDir, "ok.mp4", "fine");
    // Should NOT throw even though we haven't set a counter
    await expect(storeFile(fixturePath, "ok.mp4", "video/mp4")).resolves.toBeTypeOf("string");
  });

  it("initBucketCounter sums live clip sizes from Object Storage", async () => {
    const { initBucketCounter, getBucketBytes } = await import("../lib/fileStore.js");

    // Pre-populate the fake store with two live meta files
    const nowMs = Date.now();
    const meta1 = JSON.stringify({ name: "a.mp4", mimeType: "video/mp4", ext: ".mp4", expiresMs: nowMs + 3_600_000, sizeBytes: 1000 });
    const meta2 = JSON.stringify({ name: "b.mp4", mimeType: "video/mp4", ext: ".mp4", expiresMs: nowMs + 3_600_000, sizeBytes: 2500 });
    fakeStore.set("clips/aaa.meta.json", Buffer.from(meta1));
    fakeStore.set("clips/bbb.meta.json", Buffer.from(meta2));

    // Override list to return our two meta files
    const storage = makeFakeStorage(fakeStore);
    storage.list = vi.fn(async () => ({
      ok: true,
      value: [{ name: "clips/aaa.meta.json" }, { name: "clips/bbb.meta.json" }],
    }));
    const mod = await import("../lib/fileStore.js");
    mod._setStorageClientForTest(storage as never);

    await initBucketCounter();
    expect(getBucketBytes()).toBe(3500);
  });

  it("initBucketCounter skips expired clips", async () => {
    const { initBucketCounter, getBucketBytes } = await import("../lib/fileStore.js");

    const nowMs = Date.now();
    const liveMs = JSON.stringify({ name: "live.mp4", mimeType: "video/mp4", ext: ".mp4", expiresMs: nowMs + 3_600_000, sizeBytes: 800 });
    const deadMs = JSON.stringify({ name: "dead.mp4", mimeType: "video/mp4", ext: ".mp4", expiresMs: nowMs - 1000, sizeBytes: 9999 });
    fakeStore.set("clips/live.meta.json", Buffer.from(liveMs));
    fakeStore.set("clips/dead.meta.json", Buffer.from(deadMs));

    const storage = makeFakeStorage(fakeStore);
    storage.list = vi.fn(async () => ({
      ok: true,
      value: [{ name: "clips/live.meta.json" }, { name: "clips/dead.meta.json" }],
    }));
    const mod = await import("../lib/fileStore.js");
    mod._setStorageClientForTest(storage as never);

    await initBucketCounter();
    // Only the live clip's 800 bytes should be counted
    expect(getBucketBytes()).toBe(800);
  });
});
