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
      if (!buf) return { ok: false };
      return { ok: true, value: buf.toString("utf8") };
    }),
    downloadToFilename: vi.fn(async (key: string, destPath: string) => {
      const buf = store.get(key);
      if (!buf) return { ok: false };
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, buf);
      return { ok: true };
    }),
    list: vi.fn(async () => ({ ok: true, value: [] })),
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
