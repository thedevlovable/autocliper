import { useState } from 'react';
import { Link } from 'wouter';
import { Check } from 'lucide-react';
import * as Tabs from '@radix-ui/react-tabs';

export function PricingCards() {
  const [billing, setBilling] = useState<'monthly'|'annual'>('monthly');

  const plans = [
    {
      name: "Starter",
      price: billing === 'monthly' ? 29 : 19,
      was: billing === 'monthly' ? 39 : 29,
      credits: 100,
      features: [
        "20 Faceless Videos",
        "25 Auto Clips",
        "25 AI Video Gen",
        "Unlimited Voice",
        "20 Caption Removes",
        "20+ tools"
      ]
    },
    {
      name: "Creator",
      badge: "BEST VALUE",
      price: billing === 'monthly' ? 39 : 29,
      was: billing === 'monthly' ? 49 : 39,
      credits: 250,
      features: [
        "50 Faceless Videos",
        "62 Auto Clips",
        "62 AI Video Gen",
        "Unlimited Voice",
        "50 Caption Removes",
        "20+ tools"
      ],
      popular: true
    },
    {
      name: "Pro",
      badge: "MOST POWERFUL",
      price: billing === 'monthly' ? 99 : 49,
      was: billing === 'monthly' ? 129 : 99,
      credits: 700,
      features: [
        "140 Faceless Videos",
        "175 Auto Clips",
        "175 AI Video Gen",
        "Unlimited Voice",
        "140 Caption Removes",
        "20+ tools"
      ]
    }
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
              Annual <span className="bg-black text-primary text-[10px] px-2 py-0.5 rounded-full uppercase tracking-wider">Save 30%</span>
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
              <div className="mt-4 flex items-baseline text-5xl font-black">
                ${plan.price}
                <span className="ml-1 text-xl font-medium text-black/50">/mo</span>
              </div>
              <div className="mt-1 text-sm text-black/40 line-through">was ${plan.was}/mo</div>
            </div>

            <div className="mb-8 p-4 bg-black/5 rounded-2xl">
              <div className="font-bold text-lg">{plan.credits} Credits</div>
              <div className="text-sm text-black/60">Refreshes every month</div>
            </div>

            <ul className="flex-1 space-y-4 mb-8">
              {plan.features.map((feature, j) => (
                <li key={j} className="flex items-start">
                  <Check className="h-5 w-5 text-primary shrink-0 mr-3" />
                  <span className="text-black/80 font-medium">{feature}</span>
                </li>
              ))}
            </ul>

            <Link href="/sign-up" className={`w-full py-4 rounded-full text-center font-bold text-lg transition-transform hover:scale-105 active:scale-95 ${plan.popular ? 'bg-black text-white hover:bg-black/90' : 'bg-black/5 text-black hover:bg-black/10'}`}>
              Get {plan.name}
            </Link>
          </div>
        ))}
      </div>
    </div>
  );
}
