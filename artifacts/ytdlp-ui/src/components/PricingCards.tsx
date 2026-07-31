import { useState } from 'react';
import { Link } from 'wouter';
import { Check } from 'lucide-react';
import * as Tabs from '@radix-ui/react-tabs';

/**
 * Landing-page pricing section. Numbers must stay in sync with the real
 * catalog served by /api/billing/catalog (api-server src/lib/billing.ts):
 * 50 credits = 1 clip · Starter $5/mo = 5,000 credits · Pro $10/mo = 12,500.
 */
interface LandingPlan {
  name: string;
  badge?: string;
  popular?: boolean;
  price: number | null; // null = custom pricing
  credits: string;
  creditsNote: string;
  features: string[];
  cta: string;
}

export function PricingCards() {
  const [billing, setBilling] = useState<'monthly'|'annual'>('monthly');
  const annual = billing === 'annual';

  const plans: LandingPlan[] = [
    {
      name: "Starter",
      price: annual ? 50 : 5,
      credits: "5,000",
      creditsNote: "100 viral clips · refreshes monthly",
      features: [
        "50 credits = 1 viral clip",
        "YouTube, Kick, Twitch, Vimeo & more",
        "AI picks the loudest, best moments",
        "Ready for Shorts, Reels & TikTok",
        "Download all clips as ZIP",
      ],
      cta: "Get Starter",
    },
    {
      name: "Pro",
      badge: "BEST VALUE",
      popular: true,
      price: annual ? 100 : 10,
      credits: "12,500",
      creditsNote: "250 viral clips · refreshes monthly",
      features: [
        "Everything in Starter",
        "Just 4¢ per clip",
        "Best for daily posting",
        "Clip history on every device",
        "Priority help when you need it",
      ],
      cta: "Get Pro",
    },
    {
      name: "Business",
      badge: "CUSTOM",
      price: null,
      credits: "Custom",
      creditsNote: "Whatever volume your team needs",
      features: [
        "Custom credit volume",
        "Multiple team accounts",
        "Dedicated support",
        "Custom requests welcome",
      ],
      cta: "Talk to us",
    },
  ];

  return (
    <div className="w-full max-w-6xl mx-auto">
      <div className="flex justify-center mb-12">
        <Tabs.Root value={billing} onValueChange={(v: any) => setBilling(v)} className="bg-black/5 p-1 rounded-full inline-flex">
          <Tabs.List className="flex space-x-1">
            <Tabs.Trigger
              value="monthly"
              className={`px-6 py-2.5 rounded-full text-sm font-semibold transition-all ${billing === 'monthly' ? 'bg-white shadow-sm text-black' : 'text-black/60 hover:text-black'}`}
            >
              Monthly
            </Tabs.Trigger>
            <Tabs.Trigger
              value="annual"
              className={`px-6 py-2.5 rounded-full text-sm font-semibold transition-all flex items-center gap-2 ${billing === 'annual' ? 'bg-primary shadow-sm text-black' : 'text-black/60 hover:text-black'}`}
            >
              Yearly <span className="bg-black text-primary text-[10px] px-2 py-0.5 rounded-full uppercase tracking-wider">2 months free</span>
            </Tabs.Trigger>
          </Tabs.List>
        </Tabs.Root>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
        {plans.map((plan, i) => (
          <div key={i} className={`relative flex flex-col p-8 rounded-3xl bg-white ${plan.popular ? 'ring-4 ring-primary shadow-2xl scale-105 z-10' : 'border border-black/10 shadow-lg'}`}>
            {plan.badge && (
              <div className="absolute -top-4 left-0 right-0 flex justify-center">
                <span className={`px-4 py-1 rounded-full text-xs font-black tracking-widest uppercase ${plan.popular ? 'bg-primary text-black' : 'bg-black text-white'}`}>
                  {plan.badge}
                </span>
              </div>
            )}

            <div className="mb-6 mt-4">
              <h3 className="text-2xl font-bold">{plan.name}</h3>
              <div className="mt-4 flex items-baseline font-black">
                {plan.price === null ? (
                  <span className="text-4xl">Let's talk</span>
                ) : (
                  <>
                    <span className="text-5xl">${plan.price}</span>
                    <span className="ml-1 text-xl font-medium text-black/50">{annual ? '/yr' : '/mo'}</span>
                  </>
                )}
              </div>
              {plan.price !== null && annual && (
                <div className="mt-1 text-sm font-semibold text-black/50">12 months for the price of 10</div>
              )}
            </div>

            <div className="mb-8 p-4 bg-black/5 rounded-2xl">
              <div className="font-bold text-lg">{plan.credits} Credits</div>
              <div className="text-sm text-black/60">{plan.creditsNote}</div>
            </div>

            <ul className="flex-1 space-y-4 mb-8">
              {plan.features.map((feature, j) => (
                <li key={j} className="flex items-start">
                  <Check className="h-5 w-5 text-primary shrink-0 mr-3" />
                  <span className="text-black/80 font-medium">{feature}</span>
                </li>
              ))}
            </ul>

            <Link href="/pricing" className={`w-full py-4 rounded-full text-center font-bold text-lg transition-transform hover:scale-105 active:scale-95 ${plan.popular ? 'bg-black text-white hover:bg-black/90' : 'bg-black/5 text-black hover:bg-black/10'}`}>
              {plan.cta}
            </Link>
          </div>
        ))}
      </div>
    </div>
  );
}
