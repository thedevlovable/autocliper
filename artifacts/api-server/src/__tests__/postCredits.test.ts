/**
 * Posting credits — Drive/Instagram/link media pays CREDITS_PER_POST at
 * provider hand-off; platform clips post free (they paid at generation).
 *
 * Pure tests cover the charge decision. The integration block runs against
 * the REAL dev database (same pattern as authBilling.test.ts): unique
 * throwaway user, rows cleaned up in afterAll, suite skipped without
 * DATABASE_URL.
 *
 * The money-critical paths exercised here:
 *   • double-charge guard: a second concurrent charge of the same row must
 *     lose (zero-marker predicate), not overwrite the first split;
 *   • ambiguous terminal rows (no pfm_post_id) are NEVER refunded blind —
 *     they wait for provider verification (found+failed → heal & keep charge;
 *     found+cancelled → provider delete THEN refund; definite not-found →
 *     refund; lookup error / no provider → keep the charge);
 *   • rows with pfm_post_id refund without any provider call (works while
 *     the provider is down).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";
import { needsPostCharge, chargePostRow, sweepPostCreditRefunds } from "../lib/postCredits";
import { CREDITS_PER_POST } from "../lib/billing";
import { pool } from "../lib/db";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => crypto.randomBytes(5).toString("hex");
const TEST_DOMAIN = "postcredits-test.clipai.dev";

describe("needsPostCharge", () => {
  const base = { id: "r1", user_id: "u1", clip_id: null, media_url: null };
  it("charges Drive/Dropbox/link media on schedule rows", () => {
    expect(needsPostCharge({ ...base, source: "schedule", media_url: "https://cdn.example.com/v.mp4" })).toBe(true);
  });
  it("charges Instagram campaign media", () => {
    expect(needsPostCharge({ ...base, source: "campaign", media_url: "ig:someuser:reel:DAbc123xyz" })).toBe(true);
  });
  it("does NOT charge campaign clip refs (paid at generation)", () => {
    expect(needsPostCharge({ ...base, source: "campaign", media_url: "clip:abc123" })).toBe(false);
  });
  it("does NOT charge rows with a clip_id", () => {
    expect(needsPostCharge({ ...base, source: "schedule", clip_id: "c1", media_url: "https://x.com/v.mp4" })).toBe(false);
  });
  it("does NOT charge manual clip rows (source=clip)", () => {
    expect(needsPostCharge({ ...base, source: "clip", media_url: "https://x.com/v.mp4" })).toBe(false);
  });
  it("does NOT re-charge a row already carrying a split (retry safety)", () => {
    expect(needsPostCharge({
      ...base, source: "campaign", media_url: "https://x.com/v.mp4",
      credit_sub_spent: 0, credit_topup_spent: CREDITS_PER_POST,
    })).toBe(false);
  });
});

describe.skipIf(!HAS_DB)("posting credits integration", () => {
  const userId = `pc-user-${uniq()}`;
  const userEmail = `pc-${uniq()}@${TEST_DOMAIN}`;
  const rowA = `pc-row-a-${uniq()}`;
  const rowB = `pc-row-b-${uniq()}`;

  const balance = async () => {
    const { rows } = await pool!.query<{ sub: number; topup: number }>(
      `SELECT sub_credits AS sub, topup_credits AS topup FROM users WHERE id=$1`, [userId],
    );
    return rows[0];
  };
  const rowCols = async (id: string) => {
    const { rows } = await pool!.query<{ s: number; t: number; status: string; pfm: string | null }>(
      `SELECT credit_sub_spent AS s, credit_topup_spent AS t, status, pfm_post_id AS pfm
       FROM social_posts WHERE id=$1`, [id],
    );
    return rows[0];
  };
  const fetchRow = async (id: string) => {
    const { rows } = await pool!.query(`SELECT * FROM social_posts WHERE id=$1`, [id]);
    return rows[0];
  };

  beforeAll(async () => {
    // Dev DB may predate the new columns (the API server heals them at boot,
    // but this test process must not depend on a restart having happened).
    await pool!.query(`
      ALTER TABLE social_posts
        ADD COLUMN IF NOT EXISTS credit_sub_spent   INT NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS credit_topup_spent INT NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS hold_until         TIMESTAMPTZ`);
    await pool!.query(
      `INSERT INTO users (id, email, topup_credits) VALUES ($1, $2, $3)`,
      [userId, userEmail, CREDITS_PER_POST + 10],
    );
    await pool!.query(
      `INSERT INTO social_posts (id, user_id, source, media_url, file_name, scheduled_at, status)
       VALUES ($1, $2, 'schedule', 'https://cdn.example.com/a.mp4', 'a.mp4', NOW() + INTERVAL '1 hour', 'creating'),
              ($2 || '-never', $2, 'schedule', 'https://cdn.example.com/x.mp4', 'x.mp4', NOW() + INTERVAL '1 hour', 'queued')`,
      [rowA, userId],
    );
    await pool!.query(
      `INSERT INTO social_posts (id, user_id, source, media_url, file_name, scheduled_at, status)
       VALUES ($1, $2, 'campaign', 'ig:tester:reel:DAbc123xyz', 'b.mp4', NOW() + INTERVAL '2 hours', 'creating')`,
      [rowB, userId],
    );
  });

  afterAll(async () => {
    if (pool) {
      await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`%@${TEST_DOMAIN}`]);
      await pool.end();
    }
  });

  it("charges a creating row once: balance down, split stamped on the row", async () => {
    const res = await chargePostRow(pool!, (await fetchRow(rowA)) as never);
    expect(res).toEqual({ ok: true });
    expect(await balance()).toEqual({ sub: 0, topup: 10 });
    const c = await rowCols(rowA);
    expect(c.s + c.t).toBe(CREDITS_PER_POST);
    // Retry of the same row must NOT charge again
    expect(needsPostCharge((await fetchRow(rowA)) as never)).toBe(false);
  });

  it("blocks the next post when the balance can't cover it", async () => {
    const res = await chargePostRow(pool!, (await fetchRow(rowB)) as never);
    expect(res).toEqual({ ok: false, available: 10, needed: CREDITS_PER_POST });
    expect(await balance()).toEqual({ sub: 0, topup: 10 }); // untouched
    const c = await rowCols(rowB);
    expect(c.s + c.t).toBe(0);
  });

  it("rolls the whole charge back when the row is no longer 'creating' (cancel race)", async () => {
    // Give the user enough again so only the race can stop the charge
    await pool!.query(`UPDATE users SET topup_credits = topup_credits + $2 WHERE id=$1`, [userId, CREDITS_PER_POST]);
    const staleRow = await fetchRow(`${userId}-never`); // status=queued, not creating
    const res = await chargePostRow(pool!, staleRow as never);
    expect(res).toEqual({ lostRace: true });
    expect(await balance()).toEqual({ sub: 0, topup: 10 + CREDITS_PER_POST }); // reservation rolled back
    const c = await rowCols(`${userId}-never`);
    expect(c.s + c.t).toBe(0);
  });

  it("a second charge of the SAME creating row loses (stale-reclaim double-charge guard)", async () => {
    // First charge lands (row is 'creating' again with a real balance)…
    const before = await fetchRow(rowB); // markers still zero — the stale view a reclaimed worker would hold
    expect(await chargePostRow(pool!, before as never)).toEqual({ ok: true });
    expect(await balance()).toEqual({ sub: 0, topup: 10 });
    // …then a concurrent worker with the STALE row object (markers=0, so
    // needsPostCharge would say yes) charges again — WITH plenty of balance,
    // so only the zero-marker SQL predicate can stop it: it must lose and
    // roll back its reservation, not overwrite the first split.
    await pool!.query(`UPDATE users SET topup_credits = topup_credits + $2 WHERE id=$1`, [userId, CREDITS_PER_POST]);
    expect(await chargePostRow(pool!, before as never)).toEqual({ lostRace: true });
    expect(await balance()).toEqual({ sub: 0, topup: 10 + CREDITS_PER_POST }); // charged exactly once
    const c = await rowCols(rowB);
    expect(c.s + c.t).toBe(CREDITS_PER_POST); // one split, not overwritten
    const { rows } = await pool!.query(
      `SELECT COUNT(*)::int AS n FROM credit_ledger WHERE user_id=$1 AND reason='post_reserve'`, [userId],
    );
    expect(rows[0].n).toBe(2); // rowA + rowB — no third reservation
  });

  it("sweep does NOT refund an ambiguous terminal row (no pfm_post_id) without provider verification", async () => {
    await pool!.query(`UPDATE social_posts SET status='failed', updated_at=NOW() WHERE id=$1`, [rowA]);
    await sweepPostCreditRefunds(pool!); // no provider ops (PFM unconfigured)
    expect(await balance()).toEqual({ sub: 0, topup: 10 + CREDITS_PER_POST }); // charge kept
    const c = await rowCols(rowA);
    expect(c.s + c.t).toBe(CREDITS_PER_POST);
  });

  it("sweep keeps the charge when the provider lookup errors (still ambiguous)", async () => {
    await sweepPostCreditRefunds(pool!, {
      find: async () => { throw new Error("PFM 502"); },
      remove: async () => {},
    });
    expect(await balance()).toEqual({ sub: 0, topup: 10 + CREDITS_PER_POST });
    expect((await rowCols(rowA)).status).toBe("failed"); // untouched
  });

  it("heals a 'failed' row whose ambiguous create actually landed — keeps the charge", async () => {
    const findCalls: string[] = [];
    let removeCalled = false;
    await sweepPostCreditRefunds(pool!, {
      find: async (externalId) => { findCalls.push(externalId); return { id: "pfm-healed-1" }; },
      remove: async () => { removeCalled = true; },
    });
    expect(findCalls).toContain(rowA);
    expect(removeCalled).toBe(false);
    const c = await rowCols(rowA);
    expect(c.status).toBe("scheduled");       // back in the normal lifecycle
    expect(c.pfm).toBe("pfm-healed-1");
    expect(c.s + c.t).toBe(CREDITS_PER_POST); // service delivered → charge kept
    expect(await balance()).toEqual({ sub: 0, topup: 10 + CREDITS_PER_POST }); // no refund
  });

  it("refunds a terminal row WITH pfm_post_id without any provider call (definite outcome)", async () => {
    // Webhook later reports the healed post failed → definite, refundable
    await pool!.query(`UPDATE social_posts SET status='failed', updated_at=NOW() WHERE id=$1`, [rowA]);
    const n = await sweepPostCreditRefunds(pool!); // NO provider — must still refund
    expect(n).toBeGreaterThanOrEqual(1);
    expect(await balance()).toEqual({ sub: 0, topup: 10 + 2 * CREDITS_PER_POST });
    const c = await rowCols(rowA);
    expect(c.s + c.t).toBe(0);
  });

  it("cancelled ambiguous row: provider post is deleted BEFORE the refund; delete failure keeps the charge", async () => {
    await pool!.query(`UPDATE social_posts SET status='cancelled', updated_at=NOW() WHERE id=$1`, [rowB]);
    // Delete fails → still ambiguous → charge kept
    await sweepPostCreditRefunds(pool!, {
      find: async () => ({ id: "pfm-x" }),
      remove: async () => { throw new Error("PFM delete 500"); },
    });
    expect(await balance()).toEqual({ sub: 0, topup: 10 + 2 * CREDITS_PER_POST });
    expect((await rowCols(rowB)).s + (await rowCols(rowB)).t).toBe(CREDITS_PER_POST);
    // Delete succeeds → refund lands
    const removed: string[] = [];
    await sweepPostCreditRefunds(pool!, {
      find: async () => ({ id: "pfm-x" }),
      remove: async (pfmId) => { removed.push(pfmId); },
    });
    expect(removed).toEqual(["pfm-x"]);
    expect(await balance()).toEqual({ sub: 0, topup: 10 + 3 * CREDITS_PER_POST });
    const c = await rowCols(rowB);
    expect(c.s + c.t).toBe(0);
    // Idempotent: nothing left to refund
    await sweepPostCreditRefunds(pool!);
    expect(await balance()).toEqual({ sub: 0, topup: 10 + 3 * CREDITS_PER_POST });
  });

  it("writes an auditable ledger trail (reserve/refund pairs, topup bucket)", async () => {
    const { rows } = await pool!.query<{ delta: number; reason: string; bucket: string }>(
      `SELECT delta, reason, bucket FROM credit_ledger WHERE user_id=$1 AND reason LIKE 'post_%' ORDER BY id`,
      [userId],
    );
    expect(rows).toEqual([
      { delta: -CREDITS_PER_POST, reason: "post_reserve", bucket: "topup" }, // rowA
      { delta: -CREDITS_PER_POST, reason: "post_reserve", bucket: "topup" }, // rowB
      { delta: CREDITS_PER_POST, reason: "post_refund", bucket: "topup" },   // rowA (webhook-failed)
      { delta: CREDITS_PER_POST, reason: "post_refund", bucket: "topup" },   // rowB (cancelled)
    ]);
  });
});
