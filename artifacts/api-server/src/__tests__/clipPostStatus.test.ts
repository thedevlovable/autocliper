/**
 * Live post-status sync with bundle.social.
 *
 * Users saw "Post to social" do nothing: posts they deleted on the platform
 * left dead posted-markers behind, so every retry was skipped as "already
 * posted" — and the UI showed a fake instant "Posted!". The fix mirrors the
 * provider's real state:
 *   - mapBundlePostToState → single source of truth for a bundle post's state
 *   - getClipPostStatuses  → what the UI polls; self-heals dead markers
 *   - reconcileBlockedMarkers → frees markers whose provider post is gone, so
 *     a repost works on the FIRST tap instead of the hidden force dance
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import crypto from "crypto";
import request from "supertest";
import {
  mapBundlePostToState,
  fetchBundlePostState,
  getClipPostStatuses,
  reconcileBlockedMarkers,
  __resetBundlePostStateCache,
} from "../lib/bundle";

const HAS_DB = !!process.env.DATABASE_URL;
// bundleApi refuses to run without a key; tests stub global fetch, so a dummy
// key never reaches the network. Never overwrite a real key.
if (!process.env.BUNDLE_API_KEY) process.env.BUNDLE_API_KEY = "test-key-never-used";
const { pool } = await import("../lib/db");
const app = (await import("../app")).default;

afterAll(async () => {
  await pool?.end();
});

// ── mapBundlePostToState — provider truth table ───────────────────────────────

describe("mapBundlePostToState", () => {
  it("missing / deleted posts are 'gone'", () => {
    expect(mapBundlePostToState(null).kind).toBe("gone");
    expect(mapBundlePostToState({ status: "POSTED", deletedAt: "2026-08-10T00:00:00Z" }).kind).toBe("gone");
    expect(mapBundlePostToState({ status: "DELETED" }).kind).toBe("gone");
  });

  it("POSTED / PUBLISHED are 'posted'", () => {
    expect(mapBundlePostToState({ status: "POSTED" }).kind).toBe("posted");
    expect(mapBundlePostToState({ status: "published" }).kind).toBe("posted");
  });

  it("ERROR / FAILED are 'error' with the provider's text", () => {
    const st = mapBundlePostToState({ status: "ERROR", error: "TikTok rejected the video" });
    expect(st.kind).toBe("error");
    expect(st.error).toContain("TikTok rejected");
    expect(mapBundlePostToState({ status: "FAILED" }).error).toBeTruthy();
  });

  it("DRAFT / SCHEDULED / PROCESSING / unknown statuses are 'processing'", () => {
    for (const status of ["DRAFT", "SCHEDULED", "PROCESSING", "SOME_NEW_STATE"]) {
      expect(mapBundlePostToState({ status }).kind).toBe("processing");
    }
  });

  it("per-platform errors surface keyed UPPERCASE even when the post is live", () => {
    const st = mapBundlePostToState({
      status: "POSTED",
      errors: { tiktok: "audio muted by rights holder", INSTAGRAM: { code: 190 } },
    });
    expect(st.kind).toBe("posted");
    expect(st.perPlatformError?.TIKTOK).toContain("audio muted");
    expect(st.perPlatformError?.INSTAGRAM).toBeTruthy();
  });
});

// ── fetch stubbing helper ─────────────────────────────────────────────────────

/** Stub global fetch for bundle.social calls; returns a restore function. */
function stubBundleFetch(handler: (url: string) => { status: number; body: unknown } | Error) {
  __resetBundlePostStateCache();
  const mock = vi.fn(async (input: unknown) => {
    const url = String(input);
    const r = handler(url);
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", mock);
  return () => { vi.unstubAllGlobals(); __resetBundlePostStateCache(); };
}

describe("fetchBundlePostState", () => {
  it("404 → gone; 5xx → unknown (never guesses)", async () => {
    let restore = stubBundleFetch(() => ({ status: 404, body: { message: "not found" } }));
    try { expect((await fetchBundlePostState("p-404")).kind).toBe("gone"); } finally { restore(); }
    restore = stubBundleFetch(() => ({ status: 503, body: { message: "down" } }));
    try { expect((await fetchBundlePostState("p-503")).kind).toBe("unknown"); } finally { restore(); }
  });
});

// ── DB-backed status + reconciliation ─────────────────────────────────────────

describe.skipIf(!HAS_DB)("getClipPostStatuses / reconcileBlockedMarkers (real DB)", () => {
  const userId = `usr_statustest_${crypto.randomBytes(4).toString("hex")}`;
  const clipId = (n: string) => `status-test-${n}-${userId.slice(-4)}`;

  beforeAll(async () => {
    await pool!.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [
      userId, `${userId}@it-test.clipai.dev`,
    ]);
  });

  afterAll(async () => {
    await pool?.query(`DELETE FROM users WHERE id = $1`, [userId]); // FK cascades markers
  });

  const insertMarker = (clip: string, platform: string, status: string, postId: string | null, ageMinutes = 0) =>
    pool!.query(
      `INSERT INTO clip_social_posts (user_id, clip_id, platform, status, bundle_post_id, posted_at)
       VALUES ($1, $2, $3, $4, $5, now() - ($6 || ' minutes')::interval)`,
      [userId, clip, platform, status, postId, String(ageMinutes)],
    );
  const markerRows = (clip: string) =>
    pool!.query<{ platform: string; status: string }>(
      `SELECT platform, status FROM clip_social_posts WHERE user_id = $1 AND clip_id = $2`,
      [userId, clip],
    );

  it("fresh 'pending' (no post id) → processing; row kept", async () => {
    const c = clipId("fresh");
    await insertMarker(c, "TIKTOK", "pending", null, 1);
    const out = await getClipPostStatuses(userId, [c]);
    expect(out[c]).toEqual([{ platform: "TIKTOK", status: "processing" }]);
    expect((await markerRows(c)).rows.length).toBe(1);
  });

  it("stale 'pending' (crashed push) → reported deleted, row removed, re-claimable", async () => {
    const c = clipId("stale");
    await insertMarker(c, "TIKTOK", "pending", null, 20);
    const out = await getClipPostStatuses(userId, [c]);
    expect(out[c]?.[0]?.status).toBe("deleted");
    expect((await markerRows(c)).rows.length).toBe(0);
  });

  it("legacy 'posted' row without a post id → posted (kept, force-only unlock)", async () => {
    const c = clipId("legacy");
    await insertMarker(c, "INSTAGRAM", "posted", null, 60);
    const out = await getClipPostStatuses(userId, [c]);
    expect(out[c]?.[0]).toMatchObject({ platform: "INSTAGRAM", status: "posted" });
    expect((await markerRows(c)).rows.length).toBe(1);
  });

  it("'submitted' whose provider post went live → posted + row promoted", async () => {
    const c = clipId("live");
    await insertMarker(c, "TIKTOK", "submitted", "bp-live-1", 2);
    const restore = stubBundleFetch(() => ({ status: 200, body: { id: "bp-live-1", status: "POSTED" } }));
    try {
      const out = await getClipPostStatuses(userId, [c]);
      expect(out[c]?.[0]?.status).toBe("posted");
    } finally { restore(); }
    expect((await markerRows(c)).rows[0]?.status).toBe("posted");
  });

  it("provider post deleted on the platform → reported deleted, marker freed", async () => {
    const c = clipId("gonepost");
    await insertMarker(c, "TIKTOK", "posted", "bp-gone-1", 2);
    const restore = stubBundleFetch(() => ({ status: 404, body: { message: "not found" } }));
    try {
      const out = await getClipPostStatuses(userId, [c]);
      expect(out[c]?.[0]?.status).toBe("deleted");
    } finally { restore(); }
    expect((await markerRows(c)).rows.length).toBe(0); // next post goes out first tap
  });

  it("provider post failed → real error surfaced, marker freed for retry", async () => {
    const c = clipId("failed");
    await insertMarker(c, "TIKTOK", "submitted", "bp-err-1", 2);
    const restore = stubBundleFetch(() => ({
      status: 200, body: { id: "bp-err-1", status: "ERROR", error: "video too long for TikTok" },
    }));
    try {
      const out = await getClipPostStatuses(userId, [c]);
      expect(out[c]?.[0]?.status).toBe("error");
      expect(out[c]?.[0]?.error).toContain("too long");
    } finally { restore(); }
    expect((await markerRows(c)).rows.length).toBe(0);
  });

  it("provider unreachable → last known state reported, rows untouched", async () => {
    const c = clipId("unreach");
    await insertMarker(c, "TIKTOK", "posted", "bp-unreach-1", 2);
    const restore = stubBundleFetch(() => new TypeError("fetch failed"));
    try {
      const out = await getClipPostStatuses(userId, [c]);
      expect(out[c]?.[0]?.status).toBe("posted"); // never flips state on ambiguity
    } finally { restore(); }
    expect((await markerRows(c)).rows.length).toBe(1);
  });

  it("a stale-AGED row that already recorded its post id is NEVER swept (duplicate-post race guard)", async () => {
    const c = clipId("race");
    // The dangerous interleave: a claim sat 'pending' past the stale window,
    // but the push then landed and saved the provider post id. Sweeping it
    // would free the marker while the post is live → duplicate public post.
    await insertMarker(c, "TIKTOK", "submitted", "bp-race-1", 20);
    const restore = stubBundleFetch(() => ({ status: 200, body: { status: "PROCESSING" } }));
    try {
      expect(await reconcileBlockedMarkers(userId, c, ["TIKTOK"])).toEqual([]);
      const out = await getClipPostStatuses(userId, [c]);
      expect(out[c]?.[0]?.status).toBe("processing");
    } finally { restore(); }
    expect((await markerRows(c)).rows.length).toBe(1);
  });

  it("reconcileBlockedMarkers frees dead posts but keeps live and ambiguous ones", async () => {
    const c = clipId("reconcile");
    await insertMarker(c, "TIKTOK", "posted", "bp-dead-2", 2);      // deleted on provider
    await insertMarker(c, "INSTAGRAM", "posted", "bp-live-2", 2);   // still live
    await insertMarker(c, "YOUTUBE", "posted", "bp-amb-2", 2);      // provider unreachable
    const restore = stubBundleFetch((url) => {
      if (url.includes("bp-dead-2")) return { status: 404, body: { message: "not found" } };
      if (url.includes("bp-live-2")) return { status: 200, body: { status: "POSTED" } };
      return new TypeError("fetch failed"); // ambiguous → unknown → keep
    });
    try {
      const freed = await reconcileBlockedMarkers(userId, c, ["TIKTOK", "INSTAGRAM", "YOUTUBE"]);
      expect(freed).toEqual(["TIKTOK"]);
    } finally { restore(); }
    const left = (await markerRows(c)).rows.map((r) => r.platform).sort();
    expect(left).toEqual(["INSTAGRAM", "YOUTUBE"]);
  });
});

// ── Route: POST /api/user/social/clip-status ──────────────────────────────────

describe.skipIf(!HAS_DB)("clip-status route", () => {
  const email = `statusprobe-${crypto.randomBytes(4).toString("hex")}@it-test.clipai.dev`;
  const agent = request.agent(app);

  beforeAll(async () => {
    const r = await agent
      .post("/api/auth/signup")
      .send({ email, password: "Test12345!x", name: "Status Probe" });
    expect([200, 201]).toContain(r.status);
  });

  afterAll(async () => {
    await pool?.query(`DELETE FROM users WHERE email = $1`, [email]);
  });

  it("requires auth", async () => {
    const r = await request(app).post("/api/user/social/clip-status").send({ clipIds: ["x"] });
    expect(r.status).toBe(401);
  });

  it("empty / malformed ids → empty map (never an error)", async () => {
    for (const body of [{}, { clipIds: [] }, { clipIds: "nope" }]) {
      const r = await agent.post("/api/user/social/clip-status").send(body);
      expect(r.status).toBe(200);
      expect(r.body.clips).toEqual({});
    }
  });

  it("ids the user never posted → empty map", async () => {
    const r = await agent.post("/api/user/social/clip-status").send({ clipIds: ["never-posted-1"] });
    expect(r.status).toBe(200);
    expect(r.body.clips).toEqual({});
  });
});
