/**
 * Integration tests — accounts, credits, and manual billing approval.
 *
 * These run against the REAL dev database through the full express app
 * (sessions, auth routes, billing routes, admin panel). Every test user gets
 * a unique @it-test.clipai.dev email and is deleted afterwards (FKs cascade
 * to ledger/requests/history). The whole suite is skipped when DATABASE_URL
 * is not configured so unit-only environments stay green.
 *
 * Flow covered:
 *   signup (3-credit bonus, session cookie) → login → guest 401s →
 *   subscribe/topup pending requests + cancel → admin lockout →
 *   admin approve (plan active, credits granted) → admin credit adjust →
 *   reserve/refund math (sub-first) → plan expiry zeroes sub credits.
 */
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import crypto from "crypto";

const HAS_DB = !!process.env.DATABASE_URL;

const app = (await import("../app")).default;
const { pool } = await import("../lib/db");
const billing = await import("../lib/billing");

const TEST_DOMAIN = "it-test.clipai.dev";
const uniq = () => crypto.randomBytes(5).toString("hex");
const email = (tag: string) => `${tag}-${uniq()}@${TEST_DOMAIN}`;

afterAll(async () => {
  if (pool) {
    await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`%@${TEST_DOMAIN}`]);
    await pool.end();
  }
});

describe.skipIf(!HAS_DB)("accounts + billing integration", () => {
  const userAgent = request.agent(app);
  const adminAgent = request.agent(app);
  const userEmail = email("user");
  const PASSWORD = "hunter2222!";
  let userId = "";
  let subRequestId: number | string = 0;

  it("signup grants the 3-credit bonus and starts a session", async () => {
    const res = await userAgent
      .post("/api/auth/signup")
      .send({ email: userEmail, password: PASSWORD, name: "Integration Tester" });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(userEmail);
    expect(res.body.user.credits).toEqual({ sub: 0, topup: 3, total: 3 });
    userId = res.body.user.id;

    const me = await userAgent.get("/api/auth/me");
    expect(me.body.user?.id).toBe(userId);
  });

  it("rejects duplicate emails and short passwords", async () => {
    const dup = await request(app)
      .post("/api/auth/signup")
      .send({ email: userEmail, password: PASSWORD });
    expect(dup.status).toBe(409);

    const short = await request(app)
      .post("/api/auth/signup")
      .send({ email: email("short"), password: "tiny" });
    expect(short.status).toBe(400);
  });

  it("login rejects a wrong password and accepts the right one", async () => {
    const bad = await request(app)
      .post("/api/auth/login")
      .send({ email: userEmail, password: "wrong-password-1" });
    expect(bad.status).toBe(401);

    const fresh = request.agent(app);
    const good = await fresh.post("/api/auth/login").send({ email: userEmail, password: PASSWORD });
    expect(good.status).toBe(200);
    expect(good.body.user.id).toBe(userId);
  });

  it("guests see user:null and get 401 from account-only endpoints", async () => {
    const anon = await request(app).get("/api/auth/me");
    expect(anon.status).toBe(200);
    expect(anon.body.user).toBeNull();

    const reqs = await request(app).get("/api/billing/requests");
    expect(reqs.status).toBe(401);
  });

  it("subscribe and topup create pending requests; cancel works", async () => {
    const sub = await userAgent
      .post("/api/billing/subscribe")
      .send({ plan: "starter", interval: "yearly" });
    expect(sub.status).toBe(200);
    expect(sub.body.request.status).toBe("pending");
    subRequestId = sub.body.request.id;

    const top = await userAgent.post("/api/billing/topup").send({ packId: "boost50" });
    expect(top.status).toBe(200);
    expect(top.body.request.status).toBe("pending");

    const list = await userAgent.get("/api/billing/requests");
    const pending = (list.body.requests as Array<{ status: string }>).filter(
      (r) => r.status === "pending",
    );
    expect(pending).toHaveLength(2);

    const cancel = await userAgent.post(`/api/billing/requests/${top.body.request.id}/cancel`);
    expect(cancel.status).toBe(200);
    expect(cancel.body.ok).toBe(true);
  });

  it("non-admins and guests are locked out of the admin API", async () => {
    const asUser = await userAgent.get("/api/admin/stats");
    expect(asUser.status).toBe(403);

    const asGuest = await request(app).get("/api/admin/stats");
    expect([401, 403]).toContain(asGuest.status);
  });

  it("admin approval activates the plan and grants monthly credits", async () => {
    const adminEmail = email("admin");
    const created = await adminAgent
      .post("/api/auth/signup")
      .send({ email: adminEmail, password: PASSWORD, name: "Admin Tester" });
    expect(created.status).toBe(200);
    await pool!.query(`UPDATE users SET role = 'admin' WHERE lower(email) = $1`, [adminEmail]);

    const approve = await adminAgent.post(`/api/admin/requests/${subRequestId}/approve`).send({});
    expect(approve.status).toBe(200);

    const me = await userAgent.get("/api/auth/me");
    expect(me.body.user.plan).toBe("starter");
    expect(me.body.user.planStatus).toBe("active");
    expect(me.body.user.planInterval).toBe("yearly");
    expect(me.body.user.credits.sub).toBe(100);
    expect(me.body.user.credits.total).toBe(103);
  });

  it("admin credit adjustments land in the balance and the ledger", async () => {
    const adj = await adminAgent
      .post(`/api/admin/users/${userId}/credits`)
      .send({ delta: 7, note: "integration test grant" });
    expect(adj.status).toBe(200);

    const me = await userAgent.get("/api/auth/me");
    expect(me.body.user.credits.total).toBe(110);

    const ledger = await userAgent.get("/api/billing/ledger");
    const reasons = (ledger.body.entries as Array<{ reason: string }>).map((e) => e.reason);
    expect(reasons).toContain("admin_adjust");
    expect(reasons).toContain("subscription_grant");
    expect(reasons).toContain("signup_bonus");
  });

  it("reserveCredits spends subscription credits first and refunds cleanly", async () => {
    // Balance here: sub 100, topup 10 (3 bonus + 7 admin adjust).
    const r1 = await billing.reserveCredits(userId, 102, { test: "authBilling" });
    expect(r1).toEqual({ ok: true, fromSub: 100, fromTopup: 2 });

    const r2 = await billing.reserveCredits(userId, 99, { test: "authBilling" });
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.available).toBe(8);
      expect(r2.needed).toBe(99);
    }

    await billing.refundCredits(userId, 100, 2, "clip_refund", { test: "authBilling" });
    const me = await userAgent.get("/api/auth/me");
    expect(me.body.user.credits).toEqual({ sub: 100, topup: 10, total: 110 });
  });

  it("an expired plan zeroes subscription credits but keeps top-ups", async () => {
    await pool!.query(`UPDATE users SET paid_until = NOW() - INTERVAL '1 day' WHERE id = $1`, [
      userId,
    ]);
    const row = await billing.refreshPlanState(userId);
    expect(row?.plan_status).toBe("expired");
    expect(row?.sub_credits).toBe(0);

    const me = await userAgent.get("/api/auth/me");
    expect(me.body.user.credits).toEqual({ sub: 0, topup: 10, total: 10 });
    expect(me.body.user.planStatus).toBe("expired");
  });
});
