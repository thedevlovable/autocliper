/**
 * Whop payment verification and idempotent subscription activation.
 *
 * Whop is the payment processor of record. A browser receipt, redirect, or
 * webhook payload is never enough on its own: every activation retrieves the
 * payment from Whop and checks the plan, amount, status, and buyer email.
 */
import Whop from "@whop/sdk";
import { ReplitConnectors } from "@replit/connectors-sdk";
import type { PoolClient } from "pg";
import { pool } from "./db";
import { grantSubscriptionTx } from "./billing";

export const WHOP_PRO_PLAN_ID = "plan_931U08SzaPCTO";
export const WHOP_PRO_PRICE_USD = 7.99;
export const WHOP_PRO_INTERVAL = "monthly" as const;
export const WHOP_RECEIPT_ID_RE = /^[a-z][a-z0-9]*_[A-Za-z0-9_-]{6,160}$/;

/**
 * Use the VPS API key in production. In Replit, route the SDK's requests
 * through the attached Whop connector so credentials and token refresh stay
 * inside Replit's connector boundary.
 */
async function getWhopClient(): Promise<Whop> {
  const apiKey = process.env.WHOP_API_KEY?.trim();
  const webhookSecret = process.env.WHOP_WEBHOOK_SECRET?.trim();
  if (apiKey) {
    return new Whop({
      apiKey,
      webhookKey: webhookSecret
        ? Buffer.from(webhookSecret).toString("base64")
        : undefined,
    });
  }

  if (process.env.REPLIT_CONNECTORS_HOSTNAME) {
    const connectors = new ReplitConnectors();
    const proxyFetch = connectors.createProxyFetch("whop");
    return new Whop({
      // The connector proxy supplies the real Authorization header. The SDK
      // still requires a non-empty key to construct its client.
      apiKey: "replit-connector-proxy",
      // Remove the SDK's placeholder bearer token before the connector SDK
      // adds its refreshed Replit identity headers.
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        headers.delete("authorization");
        return proxyFetch(input, { ...init, headers });
      },
      webhookKey: webhookSecret
        ? Buffer.from(webhookSecret).toString("base64")
        : undefined,
    });
  }

  if (!apiKey) {
    throw new Error("Whop is not configured. Set WHOP_API_KEY on the VPS.");
  }
  throw new Error("Whop is not configured. Set WHOP_API_KEY on the VPS.");
}

export interface WhopPaymentSnapshot {
  id: string;
  planId: string | null;
  email: string | null;
  currency: string | null;
  subtotal: number | null;
  status: string | null;
  substatus: string | null;
  paidAt: string | null;
  membershipStatus: string | null;
}

export async function retrieveWhopPayment(paymentId: string): Promise<WhopPaymentSnapshot> {
  const client = await getWhopClient();
  const payment = await client.payments.retrieve(paymentId) as unknown as Record<string, any>;
  return {
    id: String(payment.id ?? paymentId),
    planId: payment.plan?.id ? String(payment.plan.id) : null,
    email: payment.user?.email ? String(payment.user.email).trim().toLowerCase() : null,
    currency: payment.currency ? String(payment.currency).toLowerCase() : null,
    subtotal: typeof payment.subtotal === "number"
      ? payment.subtotal
      : payment.subtotal != null
        ? Number(payment.subtotal)
        : null,
    status: payment.status ? String(payment.status) : null,
    substatus: payment.substatus ? String(payment.substatus) : null,
    paidAt: payment.paid_at ? String(payment.paid_at) : null,
    membershipStatus: payment.membership?.status ? String(payment.membership.status) : null,
  };
}

export function isWhopPaymentPaid(payment: WhopPaymentSnapshot): boolean {
  return (
    payment.planId === WHOP_PRO_PLAN_ID &&
    payment.currency === "usd" &&
    payment.subtotal != null &&
    Math.round(payment.subtotal * 100) === Math.round(WHOP_PRO_PRICE_USD * 100) &&
    payment.status === "paid" &&
    payment.substatus === "succeeded"
  );
}

/**
 * Claim a payment and grant exactly once in one database transaction.
 * A replayed webhook or a second return-page poll gets no second grant.
 */
export async function grantWhopProOnce(
  paymentId: string,
  userId: string,
  payment: WhopPaymentSnapshot,
): Promise<"granted" | "already_granted"> {
  if (!pool) throw new Error("DATABASE_URL is not configured");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const claimed = await client.query(
      `INSERT INTO whop_payments
         (payment_id, user_id, plan_id, payment_status, paid_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (payment_id) DO NOTHING
       RETURNING payment_id`,
      [paymentId, userId, payment.planId, payment.substatus, payment.paidAt ? new Date(payment.paidAt) : new Date()],
    );
    if (!claimed.rowCount) {
      await client.query("COMMIT");
      return "already_granted";
    }
    await grantSubscriptionTx(client, userId, "pro", "monthly", {
      provider: "whop",
      paymentId,
      planId: WHOP_PRO_PLAN_ID,
    });
    await client.query("COMMIT");
    return "granted";
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* preserve original error */ }
    throw err;
  } finally {
    client.release();
  }
}

/** Used by the signed webhook handler. The SDK throws on a bad signature. */
export async function unwrapWhopWebhook(rawBody: string, headers: Record<string, string>): Promise<any> {
  const client = await getWhopClient();
  if (!process.env.WHOP_WEBHOOK_SECRET) {
    throw new Error("WHOP_WEBHOOK_SECRET is not configured.");
  }
  return client.webhooks.unwrap(rawBody, { headers });
}
