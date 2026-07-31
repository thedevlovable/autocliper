/**
 * Integration tests — instant UPI payments via ZapUPI.
 *
 * Runs against the REAL dev database through the full express app, exactly
 * like authBilling.test.ts. Every ZapUPI HTTP call is mocked — the suite
 * never touches the real gateway and never needs (or logs) a real key.
 *
 * Covered:
 *   create order (auth, validation, unconfigured 503) →
 *   webhook Success → plan active + credits granted EXACTLY once →
 *   duplicate webhook is a no-op →
 *   forged/failed/mismatched-amount/test-env events never grant →
 *   ownership on the status endpoint → poll-before-webhook race.
 */
import { describe, it, expect, afterAll, afterEach } from "vitest";
import request from "supertest";
import crypto from "crypto";

const HAS_DB = !!process.env.DATABASE_URL;

// A fake key so isZapupiConfigured() is true; the HTTP layer is mocked below,
// so this value never leaves the process (and any REAL key is never used).
process.env.ZAPUPI_ZAP_KEY = "test-zap-key-never-real";

const app = (await import("../app")).default;
const { pool } = await import("../lib/db");
const zapupi = await import("../lib/zapupi");

const TEST_DOMAIN = "upi-test.clipai.dev";
const uniq = () => crypto.randomBytes(5).toString("hex");
const email = (tag: string) => `${tag}-${uniq()}@${TEST_DOMAIN}`;
const PASSWORD = "hunter2222!";

type Json = Record<string, unknown>;
interface MockOpts {
  createOrder?: (fields: URLSearchParams) => Json;
  orderStatus?: (fields: URLSearchParams) => Json;
}
const calls: { createOrder: number; orderStatus: number } = { createOrder: 0, orderStatus: 0 };

function mockZapupi(opts: MockOpts = {}): void {
  zapupi.__setZapupiFetchForTests(async (url, init) => {
    const u = String(url);
    const fields = new URLSearchParams(String(init?.body ?? ""));
    expect(fields.get("zap_key")).toBe("test-zap-key-never-real");
    let json: Json;
    if (u.includes("create-order")) {
      calls.createOrder += 1;
      json = opts.createOrder
        ? opts.createOrder(fields)
        : { status: "success", payment_url: `https://pay.zapupi.com/mock/${fields.get("order_id")}` };
    } else if (u.includes("order-status")) {
      calls.orderStatus += 1;
      json = opts.orderStatus ? opts.orderStatus(fields) : { status: "Pending" };
    } else {
      throw new Error(`unexpected zapupi url ${u}`);
    }
    return new Response(JSON.stringify(json), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

afterEach(() => {
  zapupi.__setZapupiFetchForTests(null);
});

afterAll(async () => {
  if (pool) {
    await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`%@${TEST_DOMAIN}`]);
    await pool.end();
  }
});

async function signup(agent: ReturnType<typeof request.agent>, tag: string) {
  const res = await agent
    .post("/api/auth/signup")
    .send({ email: email(tag), password: PASSWORD, name: `UPI ${tag}` });
  expect(res.status).toBe(200);
  return res.body.user as { id: string; email: string };
}

describe.skipIf(!HAS_DB)("ZapUPI instant payments", () => {
  it("guests get 401, bad plans get 400, unconfigured gateway gets 503", async () => {
    mockZapupi();
    const anon = await request(app).post("/api/pay/upi/order").send({ plan: "starter" });
    expect(anon.status).toBe(401);

    const agent = request.agent(app);
    await signup(agent, "validation");
    const bad = await agent.post("/api/pay/upi/order").send({ plan: "mega" });
    expect(bad.status).toBe(400);

    const saved = process.env.ZAPUPI_ZAP_KEY;
    delete process.env.ZAPUPI_ZAP_KEY;
    try {
      const off = await agent.post("/api/pay/upi/order").send({ plan: "starter" });
      expect(off.status).toBe(503);
    } finally {
      process.env.ZAPUPI_ZAP_KEY = saved;
    }
  });

  it("catalog advertises UPI prices when configured", async () => {
    const res = await request(app).get("/api/billing/catalog");
    expect(res.status).toBe(200);
    expect(res.body.upi).toEqual({
      currency: "INR",
      interval: "monthly",
      prices: { starter: 500, pro: 1000 },
    });
  });

  it("create → webhook Success activates the plan exactly once (idempotent)", async () => {
    const agent = request.agent(app);
    const user = await signup(agent, "happy");

    mockZapupi({
      orderStatus: () => ({
        status: "Success",
        amount: "500",
        pay_amount: "500",
        txn_id: "TXN123",
        utr: "UTR456",
        environment: "cashier",
      }),
    });

    const created = await agent.post("/api/pay/upi/order").send({ plan: "starter" });
    expect(created.status).toBe(200);
    const { orderId, paymentUrl, amountInr } = created.body as {
      orderId: string; paymentUrl: string; amountInr: number;
    };
    expect(orderId).toMatch(/^acl_[a-f0-9]{24}$/);
    expect(paymentUrl).toContain(orderId);
    expect(amountInr).toBe(500);

    // Public webhook — no session, untrusted body except the order id.
    const hook = await request(app).post("/api/pay/zapupi/webhook").send({ order_id: orderId, status: "Success" });
    expect(hook.status).toBe(200);

    const me = await agent.get("/api/auth/me");
    expect(me.body.user.plan).toBe("starter");
    expect(me.body.user.planStatus).toBe("active");
    expect(me.body.user.credits.sub).toBe(5000);

    // Duplicate webhook → no double grant.
    const dup = await request(app).post("/api/pay/zapupi/webhook").send({ order_id: orderId });
    expect(dup.status).toBe(200);
    const me2 = await agent.get("/api/auth/me");
    expect(me2.body.user.credits.sub).toBe(5000);

    const grants = await pool!.query(
      `SELECT * FROM credit_ledger WHERE user_id = $1 AND reason = 'subscription_grant'`,
      [user.id],
    );
    expect(grants.rowCount).toBe(1);
    expect((grants.rows[0].meta as Json).orderId).toBe(orderId);

    const row = await pool!.query(`SELECT * FROM upi_orders WHERE order_id = $1`, [orderId]);
    expect(row.rows[0].status).toBe("paid");
    expect(row.rows[0].utr).toBe("UTR456");

    // Owner sees the paid order; a stranger gets 404.
    const mine = await agent.get(`/api/pay/upi/order/${orderId}`);
    expect(mine.status).toBe(200);
    expect(mine.body.order.status).toBe("paid");

    const stranger = request.agent(app);
    await signup(stranger, "stranger");
    const theirs = await stranger.get(`/api/pay/upi/order/${orderId}`);
    expect(theirs.status).toBe(404);
  });

  it("webhook with an unknown or junk order id is a quiet no-op", async () => {
    mockZapupi();
    const unknown = await request(app)
      .post("/api/pay/zapupi/webhook")
      .send({ order_id: `acl_${"0".repeat(24)}` });
    expect(unknown.status).toBe(200);

    const junk = await request(app)
      .post("/api/pay/zapupi/webhook")
      .send({ order_id: "../../etc/passwd" });
    expect(junk.status).toBe(200);
  });

  it("a webhook claiming Success grants nothing when the gateway says Failed", async () => {
    const agent = request.agent(app);
    const user = await signup(agent, "forged");
    mockZapupi({ orderStatus: () => ({ status: "Failed" }) });

    const created = await agent.post("/api/pay/upi/order").send({ plan: "pro" });
    const orderId = created.body.orderId as string;

    // Attacker posts a fake Success — we double-check server-side and see Failed.
    await request(app).post("/api/pay/zapupi/webhook").send({ order_id: orderId, status: "Success" });

    const me = await agent.get("/api/auth/me");
    expect(me.body.user.plan).toBe("none");
    const row = await pool!.query(`SELECT status FROM upi_orders WHERE order_id = $1`, [orderId]);
    expect(row.rows[0].status).toBe("failed");

    const grants = await pool!.query(
      `SELECT count(*)::int AS n FROM credit_ledger WHERE user_id = $1 AND reason = 'subscription_grant'`,
      [user.id],
    );
    expect(grants.rows[0].n).toBe(0);
  });

  it("an amount mismatch goes to review — never granted", async () => {
    const agent = request.agent(app);
    const user = await signup(agent, "mismatch");
    mockZapupi({
      orderStatus: () => ({ status: "Success", amount: "10", txn_id: "T", utr: "U", environment: "cashier" }),
    });

    const created = await agent.post("/api/pay/upi/order").send({ plan: "pro" });
    const orderId = created.body.orderId as string;
    await request(app).post("/api/pay/zapupi/webhook").send({ order_id: orderId });

    const row = await pool!.query(`SELECT status, fail_reason FROM upi_orders WHERE order_id = $1`, [orderId]);
    expect(row.rows[0].status).toBe("review");
    expect(row.rows[0].fail_reason).toContain("does not match");

    const me = await agent.get("/api/auth/me");
    expect(me.body.user.plan).toBe("none");

    // Even repeated webhooks can't move a review row to paid.
    await request(app).post("/api/pay/zapupi/webhook").send({ order_id: orderId });
    const again = await pool!.query(`SELECT status FROM upi_orders WHERE order_id = $1`, [orderId]);
    expect(again.rows[0].status).toBe("review");
    const grants = await pool!.query(
      `SELECT count(*)::int AS n FROM credit_ledger WHERE user_id = $1 AND reason = 'subscription_grant'`,
      [user.id],
    );
    expect(grants.rows[0].n).toBe(0);
  });

  it("test-environment events are quarantined in production mode", async () => {
    const agent = request.agent(app);
    await signup(agent, "testenv");
    mockZapupi({
      orderStatus: () => ({ status: "Success", amount: "500", environment: "test" }),
    });
    const created = await agent.post("/api/pay/upi/order").send({ plan: "starter" });
    const orderId = created.body.orderId as string;

    const savedEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const result = await zapupi.confirmZapupiOrder(orderId);
      expect(result.state).toBe("review");
    } finally {
      process.env.NODE_ENV = savedEnv;
    }
    const row = await pool!.query(`SELECT status FROM upi_orders WHERE order_id = $1`, [orderId]);
    expect(row.rows[0].status).toBe("review");
  });

  it("the return-page poll confirms a payment even when no webhook ever arrives", async () => {
    const agent = request.agent(app);
    await signup(agent, "pollrace");
    mockZapupi({
      orderStatus: () => ({ status: "Success", amount: "1000", txn_id: "T2", utr: "U2", environment: "zappay" }),
    });

    const created = await agent.post("/api/pay/upi/order").send({ plan: "pro" });
    const orderId = created.body.orderId as string;

    // No webhook — the success page's poll does the whole job.
    const poll = await agent.get(`/api/pay/upi/order/${orderId}`);
    expect(poll.status).toBe(200);
    expect(poll.body.order.status).toBe("paid");

    const me = await agent.get("/api/auth/me");
    expect(me.body.user.plan).toBe("pro");
    expect(me.body.user.credits.sub).toBe(12500);

    // A late webhook after the poll already granted → still exactly one grant.
    await request(app).post("/api/pay/zapupi/webhook").send({ order_id: orderId });
    const me2 = await agent.get("/api/auth/me");
    expect(me2.body.user.credits.sub).toBe(12500);
  });

  it("gateway rejection at create time fails the order with a friendly error", async () => {
    const agent = request.agent(app);
    await signup(agent, "reject");
    mockZapupi({ createOrder: () => ({ status: "error", message: "Invalid token" }) });

    const res = await agent.post("/api/pay/upi/order").send({ plan: "starter" });
    expect(res.status).toBe(502);
    expect(String(res.body.error)).toContain("try again");
  });
});
