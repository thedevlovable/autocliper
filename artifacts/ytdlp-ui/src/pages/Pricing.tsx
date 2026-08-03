/**
 * Pricing page — hero heading + PricingCards + FAQ.
 */
import { useLocation } from 'wouter';
import { Link } from 'wouter';
import { AppHeader } from '../components/AppHeader';
import { Footer } from '../components/Footer';
import { useAuth } from '../lib/auth';
import PricingCards from '../components/PricingCards';
import type { BillingInterval } from '../lib/billingTypes';

const FAQS: Array<{ q: string; a: string }> = [
  {
    q: 'What is a credit?',
    a: 'Every clip costs 50 credits — ask for 5 clips and that is 250 credits. If a video is too short and you get fewer clips, the difference is refunded automatically.',
  },
  {
    q: 'How do I pay?',
    a: 'Pay by card instantly using secure Whop checkout — your plan activates automatically within seconds. Prefer not to pay online? Send a manual request and we activate it for you, usually within a few hours.',
  },
  {
    q: 'What happens when my plan month ends?',
    a: 'On a monthly plan you renew each month. On a yearly plan your credits refill automatically every month for 12 months — with 2 months free.',
  },
  {
    q: 'Can I try it for free?',
    a: 'Yes — every new account gets free clips on signup, no card needed.',
  },
];

export default function Pricing() {
  const { user } = useAuth();
  // Deep-linkable: /pricing?interval=monthly opens the monthly view.
  const initialInterval: BillingInterval = (() => {
    const q = new URLSearchParams(window.location.search).get('interval');
    return q === 'monthly' || q === 'yearly' ? q : 'yearly';
  })();

  return (
    <div className="min-h-screen bg-[#0d0d0d] text-white font-sans">
      <AppHeader />

      {/* ── Hero ── */}
      <section className="relative pt-16 pb-10 px-4 sm:px-6 text-center overflow-hidden">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[300px] bg-[#D1FE17]/6 rounded-full blur-[100px] pointer-events-none" />
        <div className="relative max-w-3xl mx-auto">
          <h1 className="text-4xl sm:text-5xl md:text-6xl font-black tracking-tight leading-[1.05] mb-4">
            Simple pricing.<br /><span className="text-[#D1FE17]">Viral results.</span>
          </h1>
          <p className="text-white/50 text-lg mb-2">50 credits = 1 clip. Pick a plan, top up any time.</p>
          {!user && (
            <p className="text-sm text-white/40">
              New here?{' '}
              <Link href="/signup" className="text-[#D1FE17] font-bold hover:underline">
                Sign up free
              </Link>{' '}
              and get 3 free clips — no card needed.
            </p>
          )}
        </div>
      </section>

      {/* ── Pricing cards (toggle + cards + Whop modal) ── */}
      <section className="max-w-5xl mx-auto px-4 sm:px-6 pb-16">
        <PricingCards initialInterval={initialInterval} signupNext="/pricing" />
      </section>

      {/* ── FAQ ── */}
      <section className="max-w-3xl mx-auto px-4 sm:px-6 pb-20">
        <h2 className="text-2xl font-black tracking-tight text-center mb-6">Quick questions</h2>
        <div className="space-y-3">
          {FAQS.map(f => (
            <details key={f.q} className="group bg-[#1a1a1a] border border-white/8 rounded-2xl px-5 py-4">
              <summary className="cursor-pointer list-none flex items-center justify-between gap-4 text-sm font-bold text-white/85">
                {f.q}
                <span className="text-white/30 group-open:rotate-45 transition-transform text-lg leading-none">+</span>
              </summary>
              <p className="text-sm text-white/50 mt-3 leading-relaxed">{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      <Footer />
    </div>
  );
}
