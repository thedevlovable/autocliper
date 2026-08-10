/**
 * Double-post protection — posted-marker claims + release classification.
 *
 * Users reported the same clip landing twice on TikTok (auto-post on clip
 * completion + a manual "Post" click). The fix: autoPostClipsWithBundle
 * atomically claims a (user, clip, platform) row BEFORE posting; the unique
 * index guarantees only one caller ever wins. These tests pin:
 *   1. shouldReleaseClaimOnPostError — claims are released only when the
 *      provider definitely did NOT create the post (4xx), never on ambiguous
 *      outcomes (5xx / network) where releasing could allow a duplicate.
 *   2. The exact claim INSERT the code uses, against the real dev database
 *      (unique index built by ensureSchema at boot).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import request from "supertest";
import { BundleApiError, shouldReleaseClaimOnPostError } from "../lib/bundle";

const HAS_DB = !!process.env.DATABASE_URL;
const { pool } = await import("../lib/db");
const app = (await import("../app")).default;

afterAll(async () => {
  await pool?.end();
});

describe("shouldReleaseClaimOnPostError — release only when the post definitely does not exist", () => {
  it("releases on provider 4xx (rejection — nothing was created)", () => {
    expect(shouldReleaseClaimOnPostError(new BundleApiError("bundle.social POST /post/ → 400: bad payload", 400))).toBe(true);
    expect(shouldReleaseClaimOnPostError(new BundleApiError("bundle.social POST /post/ → 422: validation", 422))).toBe(true);
    expect(shouldReleaseClaimOnPostError(new BundleApiError("bundle.social POST /post/ → 401: bad key", 401))).toBe(true);
  });

  it("keeps the claim on ambiguous outcomes (5xx / network / unknown errors)", () => {
    expect(shouldReleaseClaimOnPostError(new BundleApiError("bundle.social POST /post/ → 500: oops", 500))).toBe(false);
    expect(shouldReleaseClaimOnPostError(new BundleApiError("bundle.social POST /post/ → 503: down", 503))).toBe(false);
    expect(shouldReleaseClaimOnPostError(new TypeError("fetch failed"))).toBe(false);
    expect(shouldReleaseClaimOnPostError(new Error("socket hang up"))).toBe(false);
    expect(shouldReleaseClaimOnPostError(undefined)).toBe(false);
  });
});

describe.skipIf(!HAS_DB)("posted-marker claims (real DB)", () => {
  const clipId = `claim-test-${crypto.randomBytes(5).toString("hex")}`;
  const userId = `usr_claimtest_${crypto.randomBytes(4).toString("hex")}`;

  beforeAll(async () => {
    await pool!.query(
      `INSERT INTO users (id, email) VALUES ($1, $2)`,
      [userId, `${userId}@it-test.clipai.dev`],
    );
  });

  afterAll(async () => {
    // FK cascades clean up any leftover clip_social_posts rows
    await pool?.query(`DELETE FROM users WHERE id = $1`, [userId]);
  });

  const claim = (platform: string) =>
    pool!.query<{ id: number }>(
      `INSERT INTO clip_social_posts (user_id, clip_id, platform) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, clip_id, platform) DO NOTHING RETURNING id`,
      [userId, clipId, platform],
    );

  it("first claim wins; a second claim for the same platform is blocked", async () => {
    expect((await claim("TIKTOK")).rows.length).toBe(1);   // auto-post claims
    expect((await claim("TIKTOK")).rows.length).toBe(0);   // manual click blocked
  });

  it("a different platform for the same clip claims independently", async () => {
    expect((await claim("INSTAGRAM")).rows.length).toBe(1);
  });

  it("released claims (failed post) can be claimed again", async () => {
    await pool!.query(
      `DELETE FROM clip_social_posts WHERE user_id = $1 AND clip_id = $2 AND platform = ANY($3)`,
      [userId, clipId, ["TIKTOK"]],
    );
    expect((await claim("TIKTOK")).rows.length).toBe(1);
  });
});

describe.skipIf(!HAS_DB)("push-clip route — an empty outcome must be an explicit error, never a silent 'Posted!'", () => {
  const email = `pushprobe-${crypto.randomBytes(4).toString("hex")}@it-test.clipai.dev`;
  const agent = request.agent(app);

  beforeAll(async () => {
    const r = await agent
      .post("/api/auth/signup")
      .send({ email, password: "Test12345!x", name: "Push Probe" });
    expect([200, 201]).toContain(r.status);
  });

  afterAll(async () => {
    await pool?.query(`DELETE FROM users WHERE email = $1`, [email]);
  });

  it("a user with no connected social accounts gets an explicit error, not ok:true", async () => {
    const r = await agent
      .post("/api/user/social/push-clip")
      .send({ clipId: "fake-clip-id-123", label: "probe" });
    // Bundle configured → 400 (no accounts); not configured → 503. Either way:
    // a real error body and NO ok:true (the UI turned that into "Posted!").
    expect([400, 503]).toContain(r.status);
    expect(r.body.error).toBeTruthy();
    expect(r.body.ok).toBeUndefined();
  });
});
