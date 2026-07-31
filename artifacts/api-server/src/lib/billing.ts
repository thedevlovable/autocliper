/**
 * Billing core — plan catalog, credit buckets and all credit movements.
 *
 * Credits model (50 credits = 1 generated clip — see CREDITS_PER_CLIP):
 *   • sub_credits    — granted by an active subscription; RESET to the plan
 *                      amount on activation and on every monthly refill
 *                      (yearly plans refill monthly until paid_until).
 *   • topup_credits  — bought as one-time packs (or signup bonus / admin
 *                      grants). Never expire, roll over forever.
 *   Spending order: sub bucket first, then topup.
 *
 * There is no payment gateway yet — subscriptions/top-ups are requested by
 * the user and activated manually by an admin (billing_requests table).
 * When Stripe lands later, its webhook should simply call
 * grantSubscription() / grantTopup() the same way the admin approval does.
 *
 * Every movement writes a row to credit_ledger so the admin panel has a
 * complete audit trail.
 */
import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "./db";

// ── Catalog ───────────────────────────────────────────────────────────────────

/**
 * How many credits one generated clip costs. The four one-shot tools
 * (download / trim / crop / extract-audio) cost the same — each triggers one
 * paid engine download, the same cost driver as a clip.
 */
export const CREDITS_PER_CLIP = 50;

export interface PlanDef {
  id: "starter" | "pro";
  name: string;
  tagline: string;
  monthlyCredits: number;
  priceMonthly: number; // USD
  priceYearly: number;  // USD (2 months free)
}

export const PLANS: Record<"starter" | "pro", PlanDef> = {
  starter: {
    id: "starter",
    name: "Starter",
    tagline: "For individual creators",
    monthlyCredits: 5000,
    priceMonthly: 5,
    priceYearly: 50,
  },
  pro: {
    id: "pro",
    name: "Pro",
    tagline: "For serious creators & teams",
    monthlyCredits: 12500,
    priceMonthly: 10,
    priceYearly: 100,
  },
};

export interface TopupPack {
  id: string;
  name: string;
  credits: number;
  priceUsd: number;
}

export const TOPUP_PACKS: TopupPack[] = [
  { id: "boost2500", name: "Boost 2500", credits: 2500, priceUsd: 3 },
  { id: "boost5000", name: "Boost 5000", credits: 5000, priceUsd: 5 },
  { id: "boost12500", name: "Boost 12500", credits: 12500, priceUsd: 12 },
];

export const SIGNUP_BONUS_CREDITS = 150; // = 3 free clips at 50 credits each

export type PlanInterval = "monthly" | "yearly";

export function planPrice(plan: PlanDef, interval: PlanInterval): number {
  return interval === "yearly" ? plan.priceYearly : plan.priceMonthly;
}

// ── DB row shape ─────────────────────────────────────────────────────────────

export interface DbUser {
  id: string;
  email: string;
  password_hash: string | null;
  name: string | null;
  role: "user" | "admin";
  status: "active" | "disabled";
  plan: "none" | "starter" | "pro";
  plan_interval: PlanInterval | null;
  plan_status: "none" | "active" | "cancelled" | "expired";
  paid_until: Date | null;
  next_refill_at: Date | null;
  sub_credits: number;
  topup_credits: number;
  created_at: Date;
}

export interface PublicUser {
  id: string;
  email: string;
  name: string | null;
  role: "user" | "admin";
  status: "active" | "disabled";
  plan: "none" | "starter" | "pro";
  planInterval: PlanInterval | null;
  planStatus: "none" | "active" | "cancelled" | "expired";
  paidUntil: string | null;
  credits: { sub: number; topup: number; total: number };
  createdAt: string;
}

export function toPublicUser(row: DbUser): PublicUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    status: row.status,
    plan: row.plan,
    planInterval: row.plan_interval,
    planStatus: row.plan_status,
    paidUntil: row.paid_until ? new Date(row.paid_until).toISOString() : null,
    credits: {
      sub: row.sub_credits,
      topup: row.topup_credits,
      total: row.sub_credits + row.topup_credits,
    },
    createdAt: new Date(row.created_at).toISOString(),
  };
}

// ── Small utils ──────────────────────────────────────────────────────────────

export function addMonths(d: Date, n: number): Date {
  const x = new Date(d);
  x.setUTCMonth(x.getUTCMonth() + n);
  return x;
}

async function withTx<T>(db: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

async function ledger(
  client: PoolClient,
  userId: string,
  delta: number,
  bucket: "sub" | "topup",
  reason: string,
  meta?: Record<string, unknown>,
): Promise<void> {
  if (delta === 0) return;
  await client.query(
    `INSERT INTO credit_ledger (user_id, delta, bucket, reason, meta) VALUES ($1, $2, $3, $4, $5)`,
    [userId, delta, bucket, reason, meta ?? null],
  );
}

async function lockUser(client: PoolClient, userId: string): Promise<DbUser | null> {
  const { rows } = await client.query<DbUser>(
    `SELECT * FROM users WHERE id = $1 FOR UPDATE`,
    [userId],
  );
  return rows[0] ?? null;
}

// ── Plan lifecycle ───────────────────────────────────────────────────────────

/**
 * Applies any due monthly refills (yearly plans) and expiry, in-place on a
 * locked row. Mutates + persists; returns the fresh row values.
 */
async function refreshLocked(client: PoolClient, row: DbUser): Promise<DbUser> {
  if (row.plan_status !== "active") return row;
  const now = new Date();
  const planDef = row.plan !== "none" ? PLANS[row.plan] : null;
  let { sub_credits } = row;
  let nextRefill = row.next_refill_at ? new Date(row.next_refill_at) : null;
  const paidUntil = row.paid_until ? new Date(row.paid_until) : null;
  let changed = false;

  // Monthly refills inside a yearly subscription
  if (planDef && nextRefill && paidUntil) {
    while (nextRefill.getTime() <= now.getTime() && nextRefill.getTime() < paidUntil.getTime()) {
      const delta = planDef.monthlyCredits - sub_credits;
      sub_credits = planDef.monthlyCredits;
      await ledger(client, row.id, delta, "sub", "monthly_refill", {
        refillAt: nextRefill.toISOString(),
      });
      nextRefill = addMonths(nextRefill, 1);
      changed = true;
    }
  }

  // Expiry — subscription ran out (manual payments: no auto-renew)
  let plan_status: DbUser["plan_status"] = row.plan_status;
  if (paidUntil && paidUntil.getTime() <= now.getTime()) {
    if (sub_credits > 0) {
      await ledger(client, row.id, -sub_credits, "sub", "plan_expired", {
        paidUntil: paidUntil.toISOString(),
      });
    }
    sub_credits = 0;
    plan_status = "expired";
    nextRefill = null;
    changed = true;
  }

  if (changed) {
    const { rows } = await client.query<DbUser>(
      `UPDATE users SET sub_credits = $2, plan_status = $3, next_refill_at = $4 WHERE id = $1 RETURNING *`,
      [row.id, sub_credits, plan_status, nextRefill],
    );
    return rows[0];
  }
  return row;
}

/** Public wrapper — refresh a user's plan state (refills/expiry) and return the row. */
export async function refreshPlanState(userId: string, db: Pool | null = defaultPool): Promise<DbUser | null> {
  if (!db) return null;
  return withTx(db, async (client) => {
    const row = await lockUser(client, userId);
    if (!row) return null;
    return refreshLocked(client, row);
  });
}

/** Activate (or renew) a subscription. Used by admin approval — and later by Stripe webhooks. */
export async function grantSubscriptionTx(
  client: PoolClient,
  userId: string,
  planId: "starter" | "pro",
  interval: PlanInterval,
  meta?: Record<string, unknown>,
): Promise<DbUser> {
  const row = await lockUser(client, userId);
  if (!row) throw new Error("user not found");
  const planDef = PLANS[planId];
  const now = new Date();
  const paidUntil = addMonths(now, interval === "yearly" ? 12 : 1);
  const nextRefill = interval === "yearly" ? addMonths(now, 1) : null;
  const delta = planDef.monthlyCredits - row.sub_credits;
  const { rows } = await client.query<DbUser>(
    `UPDATE users SET plan = $2, plan_interval = $3, plan_status = 'active',
       paid_until = $4, next_refill_at = $5, sub_credits = $6
     WHERE id = $1 RETURNING *`,
    [userId, planId, interval, paidUntil, nextRefill, planDef.monthlyCredits],
  );
  await ledger(client, userId, delta, "sub", "subscription_grant", {
    plan: planId,
    interval,
    ...meta,
  });
  return rows[0];
}

export async function grantSubscription(
  userId: string,
  planId: "starter" | "pro",
  interval: PlanInterval,
  meta?: Record<string, unknown>,
  db: Pool | null = defaultPool,
): Promise<DbUser> {
  if (!db) throw new Error("DATABASE_URL is not configured");
  return withTx(db, (client) => grantSubscriptionTx(client, userId, planId, interval, meta));
}

/** Remove a subscription immediately (admin action). Top-up credits are kept. */
export async function removePlan(
  userId: string,
  meta?: Record<string, unknown>,
  db: Pool | null = defaultPool,
): Promise<DbUser | null> {
  if (!db) throw new Error("DATABASE_URL is not configured");
  return withTx(db, async (client) => {
    const row = await lockUser(client, userId);
    if (!row) return null;
    if (row.sub_credits > 0) {
      await ledger(client, userId, -row.sub_credits, "sub", "plan_removed", meta);
    }
    const { rows } = await client.query<DbUser>(
      `UPDATE users SET plan = 'none', plan_interval = NULL, plan_status = 'none',
         paid_until = NULL, next_refill_at = NULL, sub_credits = 0
       WHERE id = $1 RETURNING *`,
      [userId],
    );
    return rows[0];
  });
}

/** Add top-up credits (pack purchase approval, signup bonus, Stripe later). */
export async function grantTopupTx(
  client: PoolClient,
  userId: string,
  credits: number,
  reason: string,
  meta?: Record<string, unknown>,
): Promise<DbUser> {
  const row = await lockUser(client, userId);
  if (!row) throw new Error("user not found");
  const { rows } = await client.query<DbUser>(
    `UPDATE users SET topup_credits = topup_credits + $2 WHERE id = $1 RETURNING *`,
    [userId, credits],
  );
  await ledger(client, userId, credits, "topup", reason, meta);
  return rows[0];
}

export async function grantTopup(
  userId: string,
  credits: number,
  reason: string,
  meta?: Record<string, unknown>,
  db: Pool | null = defaultPool,
): Promise<DbUser> {
  if (!db) throw new Error("DATABASE_URL is not configured");
  return withTx(db, (client) => grantTopupTx(client, userId, credits, reason, meta));
}

// ── Spending ─────────────────────────────────────────────────────────────────

export interface Reservation {
  ok: true;
  fromSub: number;
  fromTopup: number;
}
export interface ReservationFailed {
  ok: false;
  available: number;
  needed: number;
}

/**
 * Atomically hold `count` credits for a clip job (sub bucket first).
 * Runs refills/expiry first so users are never charged from a stale state.
 */
export async function reserveCredits(
  userId: string,
  count: number,
  meta?: Record<string, unknown>,
  db: Pool | null = defaultPool,
): Promise<Reservation | ReservationFailed> {
  if (!db) throw new Error("DATABASE_URL is not configured");
  return withTx(db, async (client) => {
    let row = await lockUser(client, userId);
    if (!row) return { ok: false as const, available: 0, needed: count };
    row = await refreshLocked(client, row);
    const total = row.sub_credits + row.topup_credits;
    if (total < count) return { ok: false as const, available: total, needed: count };
    const fromSub = Math.min(row.sub_credits, count);
    const fromTopup = count - fromSub;
    await client.query(
      `UPDATE users SET sub_credits = sub_credits - $2, topup_credits = topup_credits - $3 WHERE id = $1`,
      [userId, fromSub, fromTopup],
    );
    await ledger(client, userId, -fromSub, "sub", "clip_reserve", meta);
    await ledger(client, userId, -fromTopup, "topup", "clip_reserve", meta);
    return { ok: true as const, fromSub, fromTopup };
  });
}

/**
 * Return held credits (job failed / produced fewer clips than requested).
 * If the subscription is no longer active, sub-bucket refunds are credited to
 * the topup bucket so the user never loses them to an expiry race.
 */
export async function refundCredits(
  userId: string,
  fromSub: number,
  fromTopup: number,
  reason: string,
  meta?: Record<string, unknown>,
  db: Pool | null = defaultPool,
): Promise<void> {
  if (fromSub <= 0 && fromTopup <= 0) return;
  if (!db) throw new Error("DATABASE_URL is not configured");
  await withTx(db, async (client) => {
    const row = await lockUser(client, userId);
    if (!row) return;
    const active = row.plan_status === "active";
    const subAdd = active ? fromSub : 0;
    const topupAdd = fromTopup + (active ? 0 : fromSub);
    await client.query(
      `UPDATE users SET sub_credits = sub_credits + $2, topup_credits = topup_credits + $3 WHERE id = $1`,
      [userId, subAdd, topupAdd],
    );
    if (subAdd > 0) await ledger(client, userId, subAdd, "sub", reason, meta);
    if (topupAdd > 0) await ledger(client, userId, topupAdd, "topup", reason, meta);
  });
}

/** Admin manual adjustment. Positive → topup bucket. Negative → topup first, then sub. */
export async function adminAdjustCredits(
  userId: string,
  delta: number,
  meta?: Record<string, unknown>,
  db: Pool | null = defaultPool,
): Promise<DbUser> {
  if (!db) throw new Error("DATABASE_URL is not configured");
  return withTx(db, async (client) => {
    const row = await lockUser(client, userId);
    if (!row) throw new Error("user not found");
    if (delta >= 0) {
      const { rows } = await client.query<DbUser>(
        `UPDATE users SET topup_credits = topup_credits + $2 WHERE id = $1 RETURNING *`,
        [userId, delta],
      );
      await ledger(client, userId, delta, "topup", "admin_adjust", meta);
      return rows[0];
    }
    const remove = -delta;
    const fromTopup = Math.min(row.topup_credits, remove);
    const fromSub = remove - fromTopup;
    if (fromSub > row.sub_credits) throw new Error("insufficient credits to remove");
    const { rows } = await client.query<DbUser>(
      `UPDATE users SET topup_credits = topup_credits - $2, sub_credits = sub_credits - $3 WHERE id = $1 RETURNING *`,
      [userId, fromTopup, fromSub],
    );
    await ledger(client, userId, -fromTopup, "topup", "admin_adjust", meta);
    await ledger(client, userId, -fromSub, "sub", "admin_adjust", meta);
    return rows[0];
  });
}
