/**
 * Auto-Pilot "schedule ahead" (handoff_lead_minutes) — integration tests.
 *
 * A campaign can ask for its posts to be handed to the provider only N
 * minutes before their slot instead of as soon as the day is planned:
 *   - the drain must NOT claim campaign rows whose slot is further away than
 *     the lead window,
 *   - once inside the window it hands off with the ORIGINAL slot time, so the
 *     post still publishes exactly on time,
 *   - legacy campaigns (NULL lead) and manual 'schedule' rows keep the
 *     hand-off-immediately behavior,
 *   - editing the window applies to rows still waiting locally.
 *
 * Runs against the real dev database (skipped without DATABASE_URL). The
 * drain is scoped to this suite's test user (__setClaimScopeForTests) so a
 * run can never claim or mutate other rows in the shared DB. PFM, credits and
 * vertical padding are mocked — no network, no charges.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import crypto from "crypto";

const pfmCreates: { externalId?: string; scheduledAt?: Date | string }[] = [];

vi.mock("../lib/postforme", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../lib/postforme")>();
  return {
    ...mod,
    isPfmConfigured: () => true,
    verifyAccountOwnership: async (_userId: string, ids: string[]) => ({
      owned: ids.map((id) => ({ pfmAccountId: id, platform: "youtube" })),
      foreign: [] as string[],
    }),
    createPfmPost: async (input: { externalId?: string; scheduledAt?: Date | string }) => {
      pfmCreates.push(input);
      return { id: `pfm_test_${pfmCreates.length}`, status: "scheduled" };
    },
    deletePfmPost: async () => {},
    findPfmPostByExternalId: async () => null,
  };
});

// Posting credits: these campaign rows would be charged as non-clip media —
// keep the drain path pure (no ledger writes) and deterministic.
vi.mock("../lib/postCredits", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../lib/postCredits")>();
  return { ...mod, needsPostCharge: () => false, sweepPostCreditRefunds: async () => 0 };
});

// Vertical padding probes/transcodes real media — skip it (null = fall back
// to the direct URL untouched).
vi.mock("../lib/verticalPad", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../lib/verticalPad")>();
  return { ...mod, ensurePaddedVertical: async () => null };
});

// Skip real DNS on media URLs — the literal-host checks stay real.
vi.mock("../lib/ssrfGuard", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../lib/ssrfGuard")>();
  return { ...mod, urlResolvesPublic: vi.fn(async () => true) };
});

const HAS_DB = !!process.env.DATABASE_URL;
process.env["SESSION_SECRET"] ||= "test-session-secret";

const app = (await import("../app")).default;
const { pool } = await import("../lib/db");
const { drainScheduleQueue, __setClaimScopeForTests } = await import("../routes/social");

const uniq = () => crypto.randomBytes(5).toString("hex");
const TEST_DOMAIN = "lead-autopilot.clipai.dev";
const isoDay = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

describe.skipIf(!HAS_DB)("campaign schedule-ahead hand-off", () => {
  const agent = request.agent(app);
  let userId = "";
  const campaignIds: string[] = [];
  const rowIds: string[] = [];

  beforeAll(async () => {
    const email = `lead-${uniq()}@${TEST_DOMAIN}`;
    const r = await agent.post("/api/auth/signup").send({ email, password: "hunter2222!" });
    expect(r.status).toBeLessThan(400);
    const { rows } = await pool!.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email]);
    userId = rows[0]!.id;
    __setClaimScopeForTests(userId);
  });

  afterAll(async () => {
    __setClaimScopeForTests(null);
    if (pool) {
      if (rowIds.length) await pool.query(`DELETE FROM social_posts WHERE id = ANY($1)`, [rowIds]);
      if (campaignIds.length) {
        await pool.query(`DELETE FROM social_campaign_items WHERE campaign_id = ANY($1)`, [campaignIds]);
        await pool.query(`DELETE FROM social_campaigns WHERE id = ANY($1)`, [campaignIds]);
      }
      if (userId) await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    }
  });

  async function mkCampaign(lead: number | null): Promise<string> {
    const id = crypto.randomUUID();
    await pool!.query(
      `INSERT INTO social_campaigns
         (id, user_id, name, source_url, account_ids, times, per_slot, start_date, end_date,
          timezone, caption, source_kind, handoff_lead_minutes, enabled, status)
       VALUES ($1,$2,'lead-test','https://drive.google.com/drive/folders/lead-test',$3,$4,1,$5,$6,
               'UTC','','folder',$7,TRUE,'active')`,
      [id, userId, ["acc_lead_1"], ["12:00"], isoDay(-1), isoDay(365), lead],
    );
    campaignIds.push(id);
    return id;
  }

  async function mkRow(campaignId: string | null, minutesFromNow: number): Promise<string> {
    const id = crypto.randomUUID();
    await pool!.query(
      `INSERT INTO social_posts
         (id, user_id, source, batch_id, media_url, file_name, caption, account_ids, scheduled_at, status)
       VALUES ($1,$2,$3,$4,'https://cdn.example.com/lead-test.mp4','lead-test.mp4','',$5,
               NOW() + make_interval(mins => $6), 'queued')`,
      [id, userId, campaignId ? "campaign" : "schedule", campaignId, ["acc_lead_1"], minutesFromNow],
    );
    rowIds.push(id);
    return id;
  }

  async function rowState(id: string): Promise<{ status: string; pfm_post_id: string | null; scheduled_at: string }> {
    const { rows } = await pool!.query<{ status: string; pfm_post_id: string | null; scheduled_at: string }>(
      `SELECT status, pfm_post_id, scheduled_at FROM social_posts WHERE id = $1`, [id]);
    return rows[0]!;
  }

  /** Drain with self-healing retries: the dev server's own scheduler shares
   *  this DB and can briefly claim a row first (its hand-off then fails on
   *  real account ownership and re-queues with attempts=1, which blocks
   *  claims for 2 minutes) — reset and drain again instead of flaking. */
  async function drainUntil(id: string, want: string, tries = 15): Promise<string> {
    for (let i = 0; i < tries; i++) {
      await drainScheduleQueue();
      const s = await rowState(id);
      if (s.status === want) return s.status;
      await pool!.query(
        `UPDATE social_posts SET attempts = 0, updated_at = NOW() - INTERVAL '3 minutes'
         WHERE id = $1 AND status = 'queued'`, [id]);
      await new Promise((r) => setTimeout(r, 150));
    }
    return (await rowState(id)).status;
  }

  it("holds campaign rows until the window opens, then hands off with the original slot time", async () => {
    const cid = await mkCampaign(60);
    const near = await mkRow(cid, 30);   // inside the 60-min window → goes out
    const far = await mkRow(cid, 180);   // outside → must wait locally
    expect(await drainUntil(near, "scheduled")).toBe("scheduled");
    const nearRow = await rowState(near);
    expect(nearRow.pfm_post_id).toMatch(/^pfm_test_/);
    // The provider got the ORIGINAL slot time, not "now + 2 min".
    const call = pfmCreates.find((c) => c.externalId === near);
    expect(call).toBeTruthy();
    const slotMs = new Date(nearRow.scheduled_at).getTime();
    expect(Math.abs(new Date(call!.scheduledAt as string | Date).getTime() - slotMs)).toBeLessThan(5_000);
    // Far row: still waiting here, never sent to the provider.
    expect((await rowState(far)).status).toBe("queued");
    expect((await rowState(far)).pfm_post_id).toBeNull();
    expect(pfmCreates.some((c) => c.externalId === far)).toBe(false);
  });

  it("hands off immediately when the campaign has no schedule-ahead window (legacy)", async () => {
    const cid = await mkCampaign(null);
    const row = await mkRow(cid, 180);
    expect(await drainUntil(row, "scheduled")).toBe("scheduled");
  });

  it("never delays manual schedule rows", async () => {
    const row = await mkRow(null, 180);
    expect(await drainUntil(row, "scheduled")).toBe("scheduled");
  });

  it("editing the window applies to rows still waiting locally", async () => {
    const cid = await mkCampaign(10);
    const row = await mkRow(cid, 120);
    await drainScheduleQueue();
    expect((await rowState(row)).status).toBe("queued"); // 10-min window, slot 2h away
    await pool!.query(`UPDATE social_campaigns SET handoff_lead_minutes = 240 WHERE id = $1`, [cid]);
    expect(await drainUntil(row, "scheduled")).toBe("scheduled");
  });

  it("create validates leadMinutes before doing any work", async () => {
    const r = await agent.post("/api/social/campaigns").send({
      source: "https://drive.google.com/drive/folders/lead-test",
      accountIds: ["acc_lead_1"], times: ["12:00"],
      startDate: isoDay(0), endDate: isoDay(10), timezone: "UTC",
      leadMinutes: 2,
    });
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(/Schedule-ahead/);
  });

  it("PATCH stores, returns and clears the schedule-ahead window", async () => {
    const cid = await mkCampaign(null);
    let r = await agent.patch(`/api/social/campaigns/${cid}`).send({ leadMinutes: 90 });
    expect(r.status).toBe(200);
    r = await agent.get("/api/social/campaigns");
    const mine = (r.body.campaigns as { id: string; leadMinutes: number | null }[]).find((c) => c.id === cid);
    expect(mine?.leadMinutes).toBe(90);

    r = await agent.patch(`/api/social/campaigns/${cid}`).send({ leadMinutes: 3 });
    expect(r.status).toBe(400);
    r = await agent.patch(`/api/social/campaigns/${cid}`).send({ leadMinutes: "abc" });
    expect(r.status).toBe(400);

    r = await agent.patch(`/api/social/campaigns/${cid}`).send({ leadMinutes: null });
    expect(r.status).toBe(200);
    const { rows } = await pool!.query<{ handoff_lead_minutes: number | null }>(
      `SELECT handoff_lead_minutes FROM social_campaigns WHERE id = $1`, [cid]);
    expect(rows[0]!.handoff_lead_minutes).toBeNull();
  });
});
