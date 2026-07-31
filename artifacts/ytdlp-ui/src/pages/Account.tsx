/**
 * Account & billing — plan status, credit balances, pending billing requests
 * and recent credit activity for the signed-in user.
 */
import { useEffect } from 'react';
import { Link, useLocation } from 'wouter';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Zap, Loader2, LogOut, Clock, CreditCard, ArrowUpRight, User as UserIcon } from 'lucide-react';
import { AppHeader } from '../components/AppHeader';
import { apiFetch, useAuth } from '../lib/auth';
import {
  type BillingRequest,
  type LedgerEntry,
  fmtDate,
  fmtDateTime,
  fmtUsd,
  PLAN_NAMES,
  reasonLabel,
  requestLabel,
} from '../lib/billingTypes';

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-amber-400/10 text-amber-300 border-amber-400/25',
  approved: 'bg-[#D1FE17]/10 text-[#D1FE17] border-[#D1FE17]/25',
  rejected: 'bg-red-500/10 text-red-400 border-red-500/25',
  cancelled: 'bg-white/5 text-white/40 border-white/10',
};

function StatusChip({ status }: { status: string }) {
  return (
    <span className={`text-[10px] font-black uppercase tracking-wide px-2 py-0.5 rounded-full border ${STATUS_STYLES[status] ?? STATUS_STYLES.cancelled}`}>
      {status}
    </span>
  );
}

export default function Account() {
  const { user, loading, logout, refresh } = useAuth();
  const [, setLocation] = useLocation();
  const qc = useQueryClient();

  // Latest balances every time the page opens
  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (!loading && !user) setLocation('/login?next=/account');
  }, [loading, user, setLocation]);

  const { data: reqData } = useQuery({
    queryKey: ['billing-requests'],
    queryFn: () => apiFetch<{ requests: BillingRequest[] }>('/billing/requests'),
    enabled: !!user,
  });
  const { data: ledgerData } = useQuery({
    queryKey: ['billing-ledger'],
    queryFn: () => apiFetch<{ entries: LedgerEntry[] }>('/billing/ledger'),
    enabled: !!user,
  });

  const cancelReq = useMutation({
    mutationFn: (id: number) => apiFetch(`/billing/requests/${id}/cancel`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['billing-requests'] }),
  });

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0d0d0d] flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-white/30 animate-spin" />
      </div>
    );
  }
  if (!user) return null;

  const requests = (reqData?.requests ?? []).slice(0, 6);
  const entries = (ledgerData?.entries ?? []).slice(0, 12);
  const planActive = user.planStatus === 'active' && user.plan !== 'none';

  return (
    <div className="min-h-screen bg-[#0d0d0d] text-white font-sans">
      <AppHeader />

      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-10 space-y-5">
        <div>
          <h1 className="text-3xl font-black tracking-tight">Account &amp; billing</h1>
          <p className="text-white/40 text-sm mt-1">{user.email}</p>
        </div>

        {/* ── Credits ── */}
        <section className="bg-[#1a1a1a] border border-white/10 rounded-3xl p-6">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <p className="text-white/40 text-xs font-bold uppercase tracking-widest mb-1">Credits left</p>
              <p className="text-5xl font-black text-[#D1FE17] flex items-center gap-2">
                <Zap className="w-8 h-8" /> {user.credits.total}
              </p>
            </div>
            <div className="flex gap-2">
              <Link
                href="/pricing#topups"
                className="bg-[#D1FE17] text-black text-sm font-black px-4 py-2.5 rounded-xl hover:bg-[#c2ef0e] active:scale-95 transition-all"
              >
                Get more credits
              </Link>
              <Link
                href="/pricing"
                className="bg-white/8 border border-white/10 text-white text-sm font-black px-4 py-2.5 rounded-xl hover:bg-white/12 transition-all"
              >
                View plans
              </Link>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 mt-6">
            <div className="bg-[#111] border border-white/8 rounded-2xl px-4 py-3">
              <p className="text-2xl font-black">{user.credits.sub}</p>
              <p className="text-white/35 text-xs mt-0.5">Plan credits — refill monthly</p>
            </div>
            <div className="bg-[#111] border border-white/8 rounded-2xl px-4 py-3">
              <p className="text-2xl font-black">{user.credits.topup}</p>
              <p className="text-white/35 text-xs mt-0.5">Top-up credits — never expire</p>
            </div>
          </div>
        </section>

        {/* ── Plan ── */}
        <section className="bg-[#1a1a1a] border border-white/10 rounded-3xl p-6">
          <p className="text-white/40 text-xs font-bold uppercase tracking-widest mb-3">Your plan</p>
          {planActive ? (
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div>
                <p className="text-2xl font-black">
                  {PLAN_NAMES[user.plan]}{' '}
                  <span className="text-white/40 text-sm font-bold">
                    · {user.planInterval === 'yearly' ? 'Yearly' : 'Monthly'}
                  </span>
                </p>
                <p className="text-white/45 text-sm mt-1">
                  Active until <span className="text-white font-bold">{fmtDate(user.paidUntil)}</span>
                  {user.planInterval === 'yearly' && ' — credits refill every month'}
                </p>
              </div>
              <span className="bg-[#D1FE17]/10 border border-[#D1FE17]/25 text-[#D1FE17] text-xs font-black uppercase tracking-wide px-3 py-1.5 rounded-full">
                Active
              </span>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div>
                <p className="text-2xl font-black">{user.planStatus === 'expired' ? 'Plan expired' : 'Free account'}</p>
                <p className="text-white/45 text-sm mt-1">
                  {user.planStatus === 'expired'
                    ? 'Renew to keep getting monthly credits.'
                    : 'Get a plan for monthly credits at the best price.'}
                </p>
              </div>
              <Link
                href="/pricing"
                className="flex items-center gap-1.5 bg-white text-black text-sm font-black px-4 py-2.5 rounded-xl hover:bg-white/90 active:scale-95 transition-all"
              >
                See plans <ArrowUpRight className="w-4 h-4" />
              </Link>
            </div>
          )}
        </section>

        {/* ── Requests ── */}
        {requests.length > 0 && (
          <section className="bg-[#1a1a1a] border border-white/10 rounded-3xl p-6">
            <p className="text-white/40 text-xs font-bold uppercase tracking-widest mb-1">Billing requests</p>
            <p className="text-white/35 text-xs mb-4 flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5" /> We activate requests manually — usually within a few hours.
            </p>
            <div className="divide-y divide-white/5">
              {requests.map(r => (
                <div key={r.id} className="py-3 flex items-center justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <p className="text-sm font-bold truncate">{requestLabel(r)}</p>
                    <p className="text-white/35 text-xs mt-0.5">{fmtUsd(r.amount_usd)} · {fmtDateTime(r.created_at)}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusChip status={r.status} />
                    {r.status === 'pending' && (
                      <button
                        onClick={() => cancelReq.mutate(r.id)}
                        disabled={cancelReq.isPending}
                        className="text-xs text-white/40 hover:text-red-400 transition-colors disabled:opacity-50"
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* ── Activity ── */}
        <section className="bg-[#1a1a1a] border border-white/10 rounded-3xl p-6">
          <p className="text-white/40 text-xs font-bold uppercase tracking-widest mb-4">Recent activity</p>
          {entries.length === 0 ? (
            <p className="text-white/35 text-sm">Nothing yet — make your first clips!</p>
          ) : (
            <div className="divide-y divide-white/5">
              {entries.map(e => (
                <div key={e.id} className="py-2.5 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-white/80 capitalize truncate">{reasonLabel(e.reason)}</p>
                    <p className="text-white/30 text-xs">{fmtDateTime(e.created_at)}</p>
                  </div>
                  <span className={`text-sm font-black shrink-0 ${e.delta >= 0 ? 'text-[#D1FE17]' : 'text-white/60'}`}>
                    {e.delta >= 0 ? '+' : ''}{e.delta}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* ── Profile ── */}
        <section className="bg-[#1a1a1a] border border-white/10 rounded-3xl p-6">
          <p className="text-white/40 text-xs font-bold uppercase tracking-widest mb-4">Profile</p>
          <div className="space-y-2 text-sm">
            <p className="flex items-center gap-2 text-white/70">
              <UserIcon className="w-4 h-4 text-white/30" /> {user.name || '—'}
            </p>
            <p className="flex items-center gap-2 text-white/70">
              <CreditCard className="w-4 h-4 text-white/30" /> {user.email}
            </p>
            <p className="text-white/35 text-xs">Member since {fmtDate(user.createdAt)}</p>
          </div>
          <button
            onClick={async () => { await logout(); setLocation('/'); }}
            className="mt-5 flex items-center gap-2 text-sm font-bold text-red-400/70 hover:text-red-400 transition-colors"
          >
            <LogOut className="w-4 h-4" /> Log out
          </button>
        </section>
      </main>
    </div>
  );
}
