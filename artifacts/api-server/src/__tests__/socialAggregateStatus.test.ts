/**
 * Provider-truth aggregate status: PFM 'processed' is NEVER success by
 * itself — per-account results decide. Covers the live incident where every
 * account failed ("All media failed to process") yet the campaign UI showed
 * POSTED ✓ and the user thought their videos were live.
 *
 * Provider HTTP calls are stubbed at the fetch level — these tests must never
 * talk to the real Post for Me API.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import crypto from "crypto";

const HAS_DB = !!process.env.DATABASE_URL;
if (!process.env.POSTFORME_API_KEY) process.env.POSTFORME_API_KEY = "test-key-never-used";

const {
  aggregateProcessedOutcome, refreshAggregateRows, processWebhookEvent, _clearPostStateCache,
} = await import("../lib/postforme");
const { pool } = await import("../lib/db");

type R = { social_account_id: string; success: boolean; error?: string };
const fail = (acc: string, err = "All media failed to process, please check media URLS"): R =>
  ({ social_account_id: acc, success: false, error: err });
const ok = (acc: string): R => ({ social_account_id: acc, success: true });

// ── fetch stub ────────────────────────────────────────────────────────────────
const realFetch = globalThis.fetch;
function stubPfm(post: { id: string; status: string }, results: R[]): void {
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.includes("/social-post-results")) {
      return new Response(JSON.stringify({ data: results }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/social-posts/")) {
      return new Response(JSON.stringify(post), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: "unexpected call in test" }), { status: 500 });
  }) as typeof fetch;
}
afterEach(() => {
  globalThis.fetch = realFetch;
  _clearPostStateCache();
});

afterAll(async () => {
  await pool?.end();
});

// ── Pure mapping ──────────────────────────────────────────────────────────────

describe("aggregateProcessedOutcome (pure)", () => {
  it("no results yet, young → keep processing", () => {
    expect(aggregateProcessedOutcome([], 60_000).status).toBe("processing");
  });

  it("no results after 15 min → optimistic posted (never stranded)", () => {
    expect(aggregateProcessedOutcome([], 16 * 60_000).status).toBe("posted");
  });

  it("every account failed → failed, with the platform error", () => {
    const out = aggregateProcessedOutcome([fail("a"), fail("b")], 0);
    expect(out.status).toBe("failed");
    expect(out.error).toContain("All media failed");
  });

  it("partial success → posted, but the failures are surfaced", () => {
    const out = aggregateProcessedOutcome([ok("a"), fail("b"), fail("c")], 0);
    expect(out.status).toBe("posted");
    expect(out.error).toContain("1/3");
  });

  it("all success → posted, stale error cleared", () => {
    const out = aggregateProcessedOutcome([ok("a"), ok("b")], 0);
    expect(out.status).toBe("posted");
    expect(out.error).toBeNull();
  });
});

// ── DB + webhook integration ──────────────────────────────────────────────────

describe.skipIf(!HAS_DB)("aggregate rows heal against provider truth", () => {
  const userId = `usr_aggtest_${crypto.randomBytes(4).toString("hex")}`;
  const PFM_ID = `pfm-post-agg-${userId.slice(-4)}`;
  const rowId = crypto.randomUUID();

  beforeAll(async () => {
    await pool!.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [
      userId, `${userId}@it-test.clipai.dev`,
    ]);
    await pool!.query(
      `INSERT INTO social_posts
         (id, user_id, source, batch_id, file_name, caption, account_ids, platforms,
          scheduled_at, status, pfm_post_id, error)
       VALUES ($1, $2, 'campaign', 'camp-agg-test', 'v.mp4', 'cap',
               ARRAY['acc-1','acc-2'], ARRAY['tiktok','youtube'],
               NOW() - INTERVAL '1 hour', 'posted', $3, 'some platform error')`,
      [rowId, userId, PFM_ID],
    );
  });

  afterAll(async () => {
    await pool?.query(`DELETE FROM users WHERE id = $1`, [userId]); // cascades posts
  });

  const rowNow = async () =>
    (await pool!.query<{ status: string; error: string | null }>(
      `SELECT status, error FROM social_posts WHERE id = $1`, [rowId],
    )).rows[0];

  it("blind-promoted 'posted' row with all-failed results flips to failed", async () => {
    stubPfm({ id: PFM_ID, status: "processed" }, [fail("acc-1"), fail("acc-2")]);
    const rows = [{
      id: rowId, pfm_post_id: PFM_ID, status: "posted",
      error: "some platform error",
      scheduled_at: new Date(Date.now() - 3_600_000).toISOString(),
    }];
    await refreshAggregateRows(rows);
    expect(rows[0].status).toBe("failed");
    const db = await rowNow();
    expect(db.status).toBe("failed");
    expect(db.error).toContain("All media failed");
  });

  it("failure webhook flips the aggregate once every account has failed (idempotent)", async () => {
    await pool!.query(`UPDATE social_posts SET status='posted', error=NULL WHERE id=$1`, [rowId]);
    stubPfm({ id: PFM_ID, status: "processed" }, [fail("acc-1"), fail("acc-2")]);
    const evt = {
      type: "social.post.result.created",
      data: { post_id: PFM_ID, social_account_id: "acc-2", success: false, error: "boom" },
    };
    await processWebhookEvent(evt);
    expect((await rowNow()).status).toBe("failed");
    await processWebhookEvent(evt); // PFM retry → same final state
    expect((await rowNow()).status).toBe("failed");
  });

  it("processed webhook with real successes promotes to posted and clears the error", async () => {
    await pool!.query(`UPDATE social_posts SET status='scheduled', error='old' WHERE id=$1`, [rowId]);
    stubPfm({ id: PFM_ID, status: "processed" }, [ok("acc-1"), ok("acc-2")]);
    await processWebhookEvent({ type: "social.post.updated", data: { id: PFM_ID, status: "processed" } });
    const db = await rowNow();
    expect(db.status).toBe("posted");
    expect(db.error).toBeNull();
  });

  it("refresh loses the race to a status that changed underneath it (CAS)", async () => {
    await pool!.query(`UPDATE social_posts SET status='scheduled', error=NULL WHERE id=$1`, [rowId]);
    const rows = [{
      id: rowId, pfm_post_id: PFM_ID, status: "scheduled",
      error: null as string | null,
      scheduled_at: new Date(Date.now() - 3_600_000).toISOString(),
    }];
    // Interleave: a failure webhook applies newer truth AFTER the rows were read…
    await pool!.query(`UPDATE social_posts SET status='failed', error='all accounts failed' WHERE id=$1`, [rowId]);
    // …then the refresh tries to write its now-stale provider view.
    stubPfm({ id: PFM_ID, status: "processed" }, [ok("acc-1"), ok("acc-2")]);
    await refreshAggregateRows(rows);
    const db = await rowNow();
    expect(db.status).toBe("failed");         // stale write lost the CAS
    expect(rows[0].status).toBe("scheduled"); // in-memory row not lied about either
  });

  it("a single success result alone promotes the aggregate row (no provider call)", async () => {
    await pool!.query(`UPDATE social_posts SET status='processing', error=NULL WHERE id=$1`, [rowId]);
    // No stub on purpose: the success path must not need any provider call.
    globalThis.fetch = (async () => {
      throw new Error("provider must not be called on a success result");
    }) as typeof fetch;
    await processWebhookEvent({
      type: "social.post.result.created",
      data: { post_id: PFM_ID, social_account_id: "acc-1", success: true },
    });
    expect((await rowNow()).status).toBe("posted");
  });
});
