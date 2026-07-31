/**
 * Shared shapes + tiny formatters for the billing / account / admin pages.
 * Mirrors the API's /billing and /admin response shapes (pg rows are snake_case).
 */

export interface CatalogPlan {
  id: 'starter' | 'pro';
  name: string;
  tagline: string;
  monthlyCredits: number;
  priceMonthly: number;
  priceYearly: number;
}

export interface CatalogPack {
  id: string;
  name: string;
  credits: number;
  priceUsd: number;
}

export interface Catalog {
  plans: CatalogPlan[];
  packs: CatalogPack[];
  signupBonus: number;
  creditsPerClip: number;
  manualActivation: boolean;
  /** Instant UPI payments (India) — null until the gateway is configured. */
  upi: {
    currency: 'INR';
    interval: 'monthly';
    prices: Record<'starter' | 'pro', number>;
  } | null;
}

export interface UpiOrder {
  orderId: string;
  plan: 'starter' | 'pro';
  planInterval: 'monthly' | 'yearly';
  amountInr: number;
  status: 'pending' | 'paid' | 'failed' | 'review';
  paymentUrl: string | null;
  utr: string | null;
  txnId: string | null;
  failReason: string | null;
  createdAt: string;
  paidAt: string | null;
  // present on admin endpoints only
  user_email?: string;
  user_name?: string | null;
}

export type BillingInterval = 'monthly' | 'yearly';

export interface BillingRequest {
  id: number;
  kind: 'subscribe' | 'topup';
  plan: string | null;
  plan_interval: string | null;
  pack_id: string | null;
  credits: number;
  amount_usd: string | number; // NUMERIC comes back as a string from pg
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  admin_note: string | null;
  created_at: string;
  // present on admin endpoints only
  user_email?: string;
  user_name?: string | null;
}

export interface LedgerEntry {
  id: number;
  delta: number;
  bucket: string;
  reason: string;
  meta: Record<string, unknown> | null;
  created_at: string;
}

export const PLAN_NAMES: Record<string, string> = { starter: 'Starter', pro: 'Pro', none: 'Free' };

const REASON_LABELS: Record<string, string> = {
  clip_reserve: 'Clips created',
  clip_refund: 'Credits refunded',
  signup_bonus: 'Welcome bonus',
  subscription_grant: 'Plan activated',
  monthly_refill: 'Monthly credit refill',
  plan_expired: 'Plan expired',
  plan_removed: 'Plan removed',
  admin_adjust: 'Balance adjustment',
  topup_grant: 'Credit pack added',
};

export function reasonLabel(reason: string): string {
  return REASON_LABELS[reason] ?? reason.replace(/_/g, ' ');
}

export function requestLabel(r: BillingRequest): string {
  if (r.kind === 'subscribe') {
    const plan = PLAN_NAMES[r.plan ?? ''] ?? r.plan ?? 'Plan';
    return `${plan} plan · ${r.plan_interval === 'yearly' ? 'Yearly' : 'Monthly'}`;
  }
  return `Credit pack · +${r.credits} credits`;
}

export function fmtUsd(v: string | number): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return '$—';
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

export function fmtInr(v: string | number): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return '₹—';
  return `₹${n.toLocaleString('en-IN')}`;
}

export function fmtDate(s: string | null | undefined): string {
  if (!s) return '—';
  const d = new Date(s);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function fmtDateTime(s: string | null | undefined): string {
  if (!s) return '—';
  const d = new Date(s);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
