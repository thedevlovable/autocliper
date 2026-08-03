/**
 * PricingCards — self-contained monthly/yearly toggle + plan cards + Whop
 * checkout modal. Used on both the /pricing page and the landing page.
 */
import { useState } from 'react';
import { WhopCheckoutEmbed } from '@whop/checkout/react';
import { useLocation } from 'wouter';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Zap, Clock, Loader2, Building2 } from 'lucide-react';
import { apiFetch, useAuth } from '../lib/auth';
import {
  type BillingInterval,
  type BillingRequest,
  type Catalog,
  type CatalogPlan,
  PLAN_NAMES,
} from '../lib/billingTypes';

// ─── Feature lists ───────────────────────────────────────────────────────────
function planFeatures(p: CatalogPlan, creditsPerClip: number): string[] {
  if (p.id === 'starter') {
    return [
      `${p.monthlyCredits.toLocaleString()} credits every month (= ${p.monthlyCredits / creditsPerClip} clips)`,
      '50 credits = 1 viral clip',
      'YouTube, Kick, Twitch, Vimeo & more',
      'AI picks the loudest, best moments',
      'Up to 10 clips per video',
      'Ready for Shorts, Reels & TikTok',
      'Download all clips as ZIP',
      'Clip history on every device',
    ];
  }
  return [
    'Everything in Starter',
    `${p.monthlyCredits.toLocaleString()} credits every month (= ${p.monthlyCredits / creditsPerClip} clips)`,
    'Just 4¢ per clip',
    'Best for daily posting',
    'Priority help when you need it',
  ];
}

const BUSINESS_FEATURES = [
  'Custom credit volume',
  'Multiple team accounts',
  'Dedicated support',
  'Custom requests welcome',
];

// ─── Component ───────────────────────────────────────────────────────────────
interface Props {
  /** Pre-select an interval. Defaults to 'yearly'. */
  initialInterval?: BillingInterval;
  /** Where unauthenticated users land after signup. Defaults to '/pricing'. */
  signupNext?: string;
}

export default function PricingCards({
  initialInterval = 'yearly',
  signupNext = '/#pricing',
}: Props) {
  const { user, loading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const qc = useQueryClient();

  const [billingInterval, setBillingInterval] = useState<BillingInterval>(initialInterval);
  const [whopCheckoutPlan, setWhopCheckoutPlan] = useState<'starter' | 'pro' | null>(null);

  const { data: catalog } = useQuery({
    queryKey: ['billing-catalog'],
    queryFn: () => apiFetch<Catalog>('/billing/catalog'),
    staleTime: 5 * 60 * 1000,
  });

  const { data: reqData } = useQuery({
    queryKey: ['billing-requests'],
    queryFn: () => apiFetch<{ requests: BillingRequest[] }>('/billing/requests'),
    enabled: !!user,
  });
  const pending = (reqData?.requests ?? []).filter(r => r.status === 'pending');
  const pendingSub = pending.find(r => r.kind === 'subscribe');

  const subscribe = useMutation({
    mutationFn: (v: { plan: string; interval: BillingInterval }) =>
      apiFetch('/billing/subscribe', { method: 'POST', body: JSON.stringify(v) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['billing-requests'] }),
  });
  const cancelReq = useMutation({
    mutationFn: (id: number) => apiFetch(`/billing/requests/${id}/cancel`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['billing-requests'] }),
  });
  const requireAccount = () => setLocation(`/signup?next=${encodeURIComponent(signupNext)}`);
  const busy = subscribe.isPending || cancelReq.isPending;
  const actionError =
    (subscribe.error as Error | null)?.message ||
    (cancelReq.error as Error | null)?.message ||
    '';

  return (
    <>
      {/* ── Monthly / Yearly toggle ── */}
      <div className="flex justify-center mb-8">
        <div className="inline-flex items-center bg-[#1a1a1a] border border-white/10 rounded-full p-1">
          {(['monthly', 'yearly'] as const).map(iv => (
            <button
              key={iv}
              onClick={() => setBillingInterval(iv)}
              className={`px-5 py-2 rounded-full text-sm font-bold transition-all ${
                billingInterval === iv ? 'bg-[#D1FE17] text-black' : 'text-white/50 hover:text-white'
              }`}
            >
              {iv === 'monthly' ? 'Monthly' : (
                <span className="flex items-center gap-2">
                  Yearly
                  <span className={`text-[10px] font-black uppercase tracking-wide px-1.5 py-0.5 rounded-full ${
                    billingInterval === 'yearly' ? 'bg-black/15 text-black' : 'bg-[#D1FE17]/15 text-[#D1FE17]'
                  }`}>
                    2 months free
                  </span>
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* ── Status banners ── */}
      {pendingSub && (
        <div className="mb-6 flex items-start gap-3 bg-[#D1FE17]/8 border border-[#D1FE17]/25 rounded-2xl px-5 py-4">
          <Clock className="w-5 h-5 text-[#D1FE17] shrink-0 mt-0.5" />
          <div className="text-sm">
            <p className="font-bold text-white">
              Your {PLAN_NAMES[pendingSub.plan ?? ''] ?? pendingSub.plan} plan request is in!
            </p>
            <p className="text-white/50 mt-0.5">
              We activate plans manually right now — usually within a few hours. Your credits will appear automatically.
            </p>
          </div>
        </div>
      )}
      {actionError && (
        <div className="mb-6 bg-red-500/10 border border-red-500/25 rounded-2xl px-5 py-3 text-sm text-red-300">
          {actionError}
        </div>
      )}

      {/* ── Plan cards ── */}
      {!catalog ? (
        <div className="flex justify-center py-20">
          <Loader2 className="w-8 h-8 text-white/30 animate-spin" />
        </div>
      ) : (
        <div className="grid md:grid-cols-3 gap-5 items-stretch">
          {catalog.plans.map(p => {
            const highlighted = p.id === 'pro';
            const isCurrent = !!user && user.plan === p.id && user.planStatus === 'active';
            const isCurrentInterval = isCurrent && user?.planInterval === billingInterval;
            const requested =
              pendingSub && pendingSub.plan === p.id && pendingSub.plan_interval === billingInterval;

            let label = user ? `Choose ${p.name}` : 'Get started';
            if (requested) label = 'Requested — activating soon';
            else if (isCurrentInterval) label = 'Your current plan';
            else if (isCurrent) label = billingInterval === 'yearly' ? 'Switch to yearly' : 'Switch to monthly';

            return (
              <div
                key={p.id}
                className={`relative flex flex-col rounded-3xl border p-7 ${
                  highlighted
                    ? 'bg-[#161a0d] border-[#D1FE17]/50 shadow-[0_0_60px_-15px_rgba(209,254,23,0.35)]'
                    : 'bg-[#1a1a1a] border-white/10'
                }`}
              >
                {highlighted && (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 bg-[#D1FE17] text-black text-[11px] font-black uppercase tracking-widest px-4 py-1 rounded-full">
                    Most popular
                  </span>
                )}
                {isCurrent && (
                  <span className="absolute top-4 right-4 bg-white/10 text-white/70 text-[10px] font-black uppercase tracking-wide px-2.5 py-1 rounded-full">
                    Current
                  </span>
                )}

                <h3 className="text-xl font-black">{p.name}</h3>
                <p className="text-white/40 text-sm mt-1">{p.tagline}</p>

                <div className="mt-5 mb-1">
                  <span className="text-5xl font-black tracking-tight">
                    ${(v => Number.isInteger(v) ? v : v.toFixed(2))(billingInterval === 'monthly' ? p.priceMonthly : p.priceYearly)}
                  </span>
                  <span className="text-white/40 text-sm font-semibold">
                    /{billingInterval === 'monthly' ? 'month' : 'year'}
                  </span>
                </div>
                <p className={`text-xs mb-6 ${billingInterval === 'yearly' ? 'text-[#D1FE17]' : 'text-white/35'}`}>
                  {billingInterval === 'yearly'
                    ? `≈ $${(p.priceYearly / 12).toFixed(2)}/mo · 2 months free`
                    : 'billed monthly'}
                </p>

                {(() => {
                  const whopEntry = catalog.whop?.[p.id as 'starter' | 'pro']?.[billingInterval as 'monthly' | 'yearly'];
                  return whopEntry ? (
                    isCurrentInterval ? (
                      <button
                        disabled
                        className="w-full py-3 rounded-xl font-black text-sm bg-white/10 border border-white/15 text-white/60 cursor-not-allowed"
                      >
                        Your current plan
                      </button>
                    ) : (
                      <>
                        <button
                          disabled={busy || authLoading}
                          onClick={() => {
                            if (!user) { requireAccount(); return; }
                            setWhopCheckoutPlan(p.id as 'starter' | 'pro');
                          }}
                          className={`w-full py-3 rounded-xl font-black text-sm transition-all disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2 ${
                            highlighted
                              ? 'bg-[#D1FE17] text-black hover:bg-[#c2ef0e] active:scale-[0.98]'
                              : 'bg-white text-black hover:bg-white/90 active:scale-[0.98]'
                          }`}
                        >
                          <Zap className="w-4 h-4" strokeWidth={3} />
                          {!user ? 'Get started' : isCurrent ? `Switch to ${billingInterval}` : `Choose ${p.name}`} — ${whopEntry.priceUsd.toFixed(2)}
                        </button>
                        <p className="text-center text-[11px] text-white/35 mt-2">
                          Secure card checkout · activates instantly
                        </p>
                        {requested ? (
                          <p className="text-center text-xs text-white/45 mt-3">
                            Manual request pending ·{' '}
                            <button
                              onClick={() => cancelReq.mutate(pendingSub!.id)}
                              className="text-white/40 underline underline-offset-2 hover:text-red-400 transition-colors"
                            >
                              cancel
                            </button>
                          </p>
                        ) : (
                          <button
                            disabled={busy || authLoading}
                            onClick={() => {
                              if (!user) { requireAccount(); return; }
                              subscribe.mutate({ plan: p.id, interval: billingInterval });
                            }}
                            className="mt-3 mx-auto block text-xs text-white/40 hover:text-white/70 transition-colors disabled:opacity-60"
                          >
                            {subscribe.isPending && subscribe.variables?.plan === p.id
                              ? 'Sending request…'
                              : 'No card? Request manual activation'}
                          </button>
                        )}
                      </>
                    )
                  ) : (
                    <>
                      <button
                        disabled={busy || authLoading || isCurrentInterval || !!requested}
                        onClick={() => {
                          if (!user) { requireAccount(); return; }
                          subscribe.mutate({ plan: p.id, interval: billingInterval });
                        }}
                        className={`w-full py-3 rounded-xl font-black text-sm transition-all disabled:opacity-60 disabled:cursor-not-allowed ${
                          highlighted
                            ? 'bg-[#D1FE17] text-black hover:bg-[#c2ef0e] active:scale-[0.98]'
                            : 'bg-white text-black hover:bg-white/90 active:scale-[0.98]'
                        }`}
                      >
                        {subscribe.isPending && subscribe.variables?.plan === p.id
                          ? <Loader2 className="w-4 h-4 animate-spin inline" />
                          : label}
                      </button>
                      {requested && (
                        <button
                          onClick={() => cancelReq.mutate(pendingSub!.id)}
                          className="mt-2 text-xs text-white/40 hover:text-red-400 transition-colors"
                        >
                          Cancel request
                        </button>
                      )}
                    </>
                  );
                })()}

                <ul className="mt-7 space-y-3 text-sm">
                  {planFeatures(p, catalog?.creditsPerClip ?? 50).map(f => (
                    <li key={f} className="flex items-start gap-2.5">
                      <Check className="w-4 h-4 text-[#D1FE17] shrink-0 mt-0.5" strokeWidth={3} />
                      <span className="text-white/70">{f}</span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}

          {/* ── Whop checkout modal ── */}
          {catalog.whop && whopCheckoutPlan && user && (() => {
            const wp = catalog.whop![whopCheckoutPlan][billingInterval as 'monthly' | 'yearly'];
            if (!wp) return null;
            const planLabel = whopCheckoutPlan === 'pro' ? 'Pro' : 'Starter';
            const intervalLabel = billingInterval === 'yearly' ? '/year' : '/month';
            return (
              <div className="fixed inset-0 z-50 bg-black/75 p-4 overflow-y-auto">
                <div className="max-w-xl mx-auto mt-8 rounded-3xl bg-[#1a1a1a] border border-[#D1FE17]/30 p-5 shadow-2xl">
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <h4 className="font-black text-lg">AutoCliper {planLabel}</h4>
                      <p className="text-white/45 text-sm">${wp.priceUsd.toFixed(2)}{intervalLabel} · secure card checkout</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setWhopCheckoutPlan(null)}
                      className="text-white/50 hover:text-white text-2xl leading-none px-2"
                      aria-label="Close checkout"
                    >
                      ×
                    </button>
                  </div>
                  <WhopCheckoutEmbed
                    planId={wp.planId}
                    themeOptions={{ backgroundColor: '#0d0d0d', accentColor: '#D1FE17', borderRadius: 0 }}
                    styles={{ container: { paddingX: 0, paddingY: 33 } }}
                    prefill={{ email: user.email }}
                    hidePrice
                    adaptivePricing
                    setupFutureUsage="off_session"
                    hideEmail
                    hideTermsAndConditions
                    returnUrl={`${window.location.origin}/pay/whop-return`}
                    onComplete={(_planId, receiptId) => {
                      setWhopCheckoutPlan(null);
                      if (receiptId) {
                        setLocation(`/pay/whop-return?receipt_id=${encodeURIComponent(receiptId)}&status=success`);
                      }
                    }}
                  />
                </div>
              </div>
            );
          })()}

          {/* ── Business card (static) ── */}
          <div className="relative flex flex-col rounded-3xl border bg-[#1a1a1a] border-white/10 p-7">
            <h3 className="text-xl font-black flex items-center gap-2">
              <Building2 className="w-5 h-5 text-white/40" /> Business
            </h3>
            <p className="text-white/40 text-sm mt-1">For agencies & big channels</p>
            <div className="mt-5 mb-1">
              <span className="text-5xl font-black tracking-tight">Custom</span>
            </div>
            <p className="text-xs text-white/35 mb-6">tailored to your volume</p>
            <a
              href="mailto:support@autocliper.com?subject=AutoCliper%20Business%20plan"
              className="w-full py-3 rounded-xl font-black text-sm text-center bg-white/10 border border-white/15 text-white hover:bg-white/15 transition-all"
            >
              Contact us
            </a>
            <ul className="mt-7 space-y-3 text-sm">
              {BUSINESS_FEATURES.map(f => (
                <li key={f} className="flex items-start gap-2.5">
                  <Check className="w-4 h-4 text-[#D1FE17] shrink-0 mt-0.5" strokeWidth={3} />
                  <span className="text-white/70">{f}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

    </>
  );
}
