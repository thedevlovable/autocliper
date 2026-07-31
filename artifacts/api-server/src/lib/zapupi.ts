/**
 * ZapUPI — Indian UPI payment gateway (GPay / PhonePe / Paytm / BHIM).
 *
 * Flow:
 *   1. POST /pay/upi/order (logged in)   → createZapupiOrder() → payment_url,
 *      browser redirects there in the SAME tab.
 *   2. User pays in any UPI app. ZapUPI then (a) POSTs our webhook and
 *      (b) redirects the buyer back to /pay/upi/return?order_id=…
 *   3. BOTH paths funnel into confirmZapupiOrder(orderId) — the single,
 *      idempotent, row-locked confirm core.
 *
 * Security model (their webhook has NO signature):
 *   • The webhook body is UNTRUSTED — we only take the order_id from it.
 *   • Before granting anything we call their order-status API server-side
 *     with our key, and require: status Success + amount matches the plan
 *     price + not a "test" environment event in production.
 *   • Grant happens inside a SELECT … FOR UPDATE transaction on the order
 *     row, transitioning pending → paid exactly once. Duplicate webhooks and
 *     webhook/return-page races can never double-grant.
 *   • Amount mismatches are marked status "review" for an admin — never granted.
 *
 * The ZapUPI key comes from the ZAPUPI_ZAP_KEY secret. It is never logged.
 */
import crypto from "crypto";
import { pool } from "./db";
import { grantSubscriptionTx, PLANS, type PlanInterval } from "./billing";
import { logger } from "./logger";

// Fixed UPI prices in INR, as chosen by the founder (monthly plans only in v1).
export const UPI_PLAN_PRICES_INR: Record<"starter" | "pro", number> = {
  starter: 500,
  pro: 1000,
};

const CREATE_ORDER_URL = "https://pay.zapupi.com/api/create-order";
const ORDER_STATUS_URL = "https://pay.zapupi.com/api/order-status";
const HTTP_TIMEOUT_MS = 15_000;

export function isZapupiConfigured(): boolean {
  return !!(process.env.ZAPUPI_ZAP_KEY ?? "").trim();
}

function zapKey(): string {
  const k = (process.env.ZAPUPI_ZAP_KEY ?? "").trim();
  if (!k) throw new Error("ZAPUPI_ZAP_KEY is not configured");
  return k;
}

/** Our order ids: acl_<24 hex>. Tight shape so the public webhook can reject junk early. */
export const UPI_ORDER_ID_RE = /^acl_[a-f0-9]{24}$/;

export function newUpiOrderId(): string {
  return `acl_${crypto.randomBytes(12).toString("hex")}`;
}

/** Where ZapUPI should send the buyer + webhook. Prod URL first, dev domain for testing. */
export function appBaseUrl(): string {
  const configured = (process.env.PUBLIC_APP_URL ?? "").trim().replace(/\/$/, "");
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") return "https://autocliper.com";
  const dev = (process.env.REPLIT_DEV_DOMAIN ?? "").trim();
  if (dev) return `https://${dev}`;
  return "http://localhost:5000";
}

// ── HTTP (mockable in tests — never hit the real gateway from the suite) ─────

type FetchLike = typeof fetch;
let zapupiFetch: FetchLike = (...args) => fetch(...args);

/** Test hook: replace the HTTP layer. Pass null to restore the real fetch. */
export function __setZapupiFetchForTests(f: FetchLike | null): void {
  zapupiFetch = f ?? ((...args) => fetch(...args));
}

// NOTE: despite their docs showing form-encoded examples, the LIVE API only
// accepts a JSON body ("Invalid JSON format" otherwise) — verified against
// the real gateway. The key travels as the `zap_key` JSON field.
async function postJson(url: string, fields: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await zapupiFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fields),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* non-JSON reply */ }
  if (!res.ok) {
    // Their error bodies look like {"status":"error","message":"Invalid Zap Key"}.
    // Surfacing the message is safe — our key never appears in responses.
    const hint = typeof json.message === "string" ? ` — ${json.message}` : "";
    throw new Error(`ZapUPI HTTP ${res.status}${hint}`);
  }
  return json;
}

// ── DB row shape ─────────────────────────────────────────────────────────────

export interface UpiOrderRow {
  order_id: string;
  user_id: string;
  plan: "starter" | "pro";
  plan_interval: PlanInterval;
  amount_inr: number;
  status: "pending" | "paid" | "failed" | "review";
  payment_url: string | null;
  txn_id: string | null;
  utr: string | null;
  provider_env: string | null;
  fail_reason: string | null;
  paid_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export function toPublicUpiOrder(row: UpiOrderRow): Record<string, unknown> {
  return {
    orderId: row.order_id,
    plan: row.plan,
    planInterval: row.plan_interval,
    amountInr: row.amount_inr,
    status: row.status,
    paymentUrl: row.status === "pending" ? row.payment_url : null,
    utr: row.utr,
    txnId: row.txn_id,
    failReason: row.fail_reason,
    createdAt: new Date(row.created_at).toISOString(),
    paidAt: row.paid_at ? new Date(row.paid_at).toISOString() : null,
  };
}

// ── Create order ─────────────────────────────────────────────────────────────

export async function createZapupiOrder(opts: {
  userId: string;
  plan: "starter" | "pro";
}): Promise<{ orderId: string; paymentUrl: string; amountInr: number }> {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  const amountInr = UPI_PLAN_PRICES_INR[opts.plan];
  const orderId = newUpiOrderId();

  await pool.query(
    `INSERT INTO upi_orders (order_id, user_id, plan, plan_interval, amount_inr)
     VALUES ($1, $2, $3, 'monthly', $4)`,
    [orderId, opts.userId, opts.plan, amountInr],
  );

  const base = appBaseUrl();
  let json: Record<string, unknown>;
  try {
    json = await postJson(CREATE_ORDER_URL, {
      zap_key: zapKey(),
      order_id: orderId,
      amount: String(amountInr),
      remark: `${opts.plan}|${opts.userId}`,
      webhook_url: `${base}/api/pay/zapupi/webhook`,
      // MUST be query-free: the gateway appends `?order_id=<id>` itself, and a
      // URL that already contains `?` gets dropped — buyers then strand on
      // ZapUPI's panel 404 instead of coming back to us (root-caused from a
      // real payment). If they ever stop appending, the return page still
      // recovers the order id from localStorage.
      redirect_url: `${base}/pay/upi/return`,
    });
  } catch (err) {
    await pool.query(
      `UPDATE upi_orders SET status = 'failed', fail_reason = 'Could not reach the payment gateway', updated_at = NOW()
       WHERE order_id = $1 AND status = 'pending'`,
      [orderId],
    );
    logger.error({ err: (err as Error).message, orderId }, "zapupi create-order failed");
    throw new Error("Could not start the UPI payment — please try again in a moment.");
  }

  const paymentUrl =
    (typeof json.payment_url === "string" && json.payment_url) ||
    (typeof (json.data as Record<string, unknown> | undefined)?.payment_url === "string" &&
      ((json.data as Record<string, unknown>).payment_url as string)) ||
    "";
  const status = String(json.status ?? "").toLowerCase();

  if (!paymentUrl || (status && status !== "success" && status !== "ok")) {
    const reason = String(json.message ?? json.msg ?? "gateway rejected the order").slice(0, 200);
    await pool.query(
      `UPDATE upi_orders SET status = 'failed', fail_reason = $2, updated_at = NOW()
       WHERE order_id = $1 AND status = 'pending'`,
      [orderId, reason],
    );
    logger.error({ orderId, status, reason }, "zapupi create-order rejected");
    throw new Error("The payment gateway rejected the order — please try again.");
  }

  await pool.query(
    `UPDATE upi_orders SET payment_url = $2, updated_at = NOW() WHERE order_id = $1`,
    [orderId, paymentUrl],
  );
  return { orderId, paymentUrl, amountInr };
}

// ── Provider status ──────────────────────────────────────────────────────────

interface ProviderStatus {
  status: "success" | "failed" | "pending" | "unknown";
  amount: number | null;
  txnId: string | null;
  utr: string | null;
  environment: string | null;
}

export async function getZapupiOrderStatus(orderId: string): Promise<ProviderStatus> {
  const json = await postJson(ORDER_STATUS_URL, { zap_key: zapKey(), order_id: orderId });
  const data = (json.data as Record<string, unknown> | undefined) ?? json;
  const raw = String(data.status ?? json.status ?? "").toLowerCase();
  const status: ProviderStatus["status"] =
    raw === "success" ? "success" : raw === "failed" ? "failed" : raw ? "pending" : "unknown";
  const amountRaw = data.pay_amount ?? data.amount ?? null;
  const amount = amountRaw == null ? null : Number(amountRaw);
  return {
    status,
    amount: Number.isFinite(amount as number) ? (amount as number) : null,
    txnId: data.txn_id != null ? String(data.txn_id) : null,
    utr: data.utr != null ? String(data.utr) : null,
    environment: data.environment != null ? String(data.environment).toLowerCase() : null,
  };
}

// ── Confirm core (idempotent, race-safe) ─────────────────────────────────────

export type ConfirmResult =
  | { state: "unknown" }
  | { state: "pending" }
  | { state: "paid"; alreadyPaid: boolean }
  | { state: "failed"; reason: string | null }
  | { state: "review"; reason: string | null };

/**
 * Check with ZapUPI and, if genuinely paid, activate the plan — exactly once.
 * Safe to call from the webhook, the return-page poll, or both at once.
 */
export async function confirmZapupiOrder(orderId: string): Promise<ConfirmResult> {
  if (!pool) return { state: "unknown" };

  // Cheap peek — terminal rows never need another provider call.
  const peek = await pool.query<UpiOrderRow>(
    `SELECT * FROM upi_orders WHERE order_id = $1`,
    [orderId],
  );
  const existing = peek.rows[0];
  if (!existing) return { state: "unknown" };
  if (existing.status === "paid") return { state: "paid", alreadyPaid: true };
  if (existing.status === "failed") return { state: "failed", reason: existing.fail_reason };
  if (existing.status === "review") return { state: "review", reason: existing.fail_reason };

  // Ask the gateway BEFORE taking the row lock (HTTP can be slow).
  const st = await getZapupiOrderStatus(orderId);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<UpiOrderRow>(
      `SELECT * FROM upi_orders WHERE order_id = $1 FOR UPDATE`,
      [orderId],
    );
    const row = rows[0];
    if (!row) { await client.query("ROLLBACK"); return { state: "unknown" }; }
    if (row.status === "paid") { await client.query("COMMIT"); return { state: "paid", alreadyPaid: true }; }
    if (row.status === "failed") { await client.query("COMMIT"); return { state: "failed", reason: row.fail_reason }; }
    if (row.status === "review") { await client.query("COMMIT"); return { state: "review", reason: row.fail_reason }; }

    if (st.status === "success") {
      const isProd = process.env.NODE_ENV === "production";
      if (isProd && st.environment === "test") {
        const reason = "Test-environment payment event received in production";
        await client.query(
          `UPDATE upi_orders SET status = 'review', fail_reason = $2, provider_env = $3, updated_at = NOW()
           WHERE order_id = $1`,
          [orderId, reason, st.environment],
        );
        await client.query("COMMIT");
        logger.warn({ orderId }, "zapupi test-env event blocked in production");
        return { state: "review", reason };
      }
      if (st.amount == null || Math.round(st.amount) !== row.amount_inr) {
        const reason = `Paid amount ₹${st.amount ?? "?"} does not match plan price ₹${row.amount_inr}`;
        await client.query(
          `UPDATE upi_orders SET status = 'review', fail_reason = $2, txn_id = $3, utr = $4, provider_env = $5, updated_at = NOW()
           WHERE order_id = $1`,
          [orderId, reason, st.txnId, st.utr, st.environment],
        );
        await client.query("COMMIT");
        logger.warn({ orderId, paid: st.amount, expected: row.amount_inr }, "zapupi amount mismatch → review");
        return { state: "review", reason };
      }

      // Genuine, verified payment — activate the plan (same grant path as admin approval).
      await grantSubscriptionTx(client, row.user_id, row.plan, row.plan_interval, {
        via: "zapupi",
        orderId,
        txnId: st.txnId,
        utr: st.utr,
        amountInr: row.amount_inr,
      });
      await client.query(
        `UPDATE upi_orders SET status = 'paid', txn_id = $2, utr = $3, provider_env = $4, paid_at = NOW(), updated_at = NOW()
         WHERE order_id = $1`,
        [orderId, st.txnId, st.utr, st.environment],
      );
      await client.query("COMMIT");
      logger.info(
        { orderId, userId: row.user_id, plan: row.plan, amountInr: row.amount_inr },
        "zapupi payment confirmed — plan activated",
      );
      return { state: "paid", alreadyPaid: false };
    }

    if (st.status === "failed") {
      const reason = "Payment failed or was cancelled in the UPI app";
      await client.query(
        `UPDATE upi_orders SET status = 'failed', fail_reason = $2, updated_at = NOW() WHERE order_id = $1`,
        [orderId, reason],
      );
      await client.query("COMMIT");
      return { state: "failed", reason };
    }

    // Still pending at the gateway.
    await client.query("COMMIT");
    return { state: "pending" };
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

/** Sanity: plan ids we sell over UPI (keeps PLANS import used + guards drift). */
export function isUpiPlan(plan: string): plan is "starter" | "pro" {
  return (plan === "starter" || plan === "pro") && !!PLANS[plan];
}
