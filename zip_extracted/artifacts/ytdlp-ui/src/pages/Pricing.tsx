import { Navbar } from '../components/Navbar';
import { Footer } from '../components/Footer';
import { CountdownBanner } from '../components/CountdownBanner';
import { PricingCards } from '../components/PricingCards';
import { ShieldCheck, Zap, Clock } from 'lucide-react';

export default function Pricing() {
  return (
    <div className="min-h-screen bg-white">
      <CountdownBanner />
      <Navbar />

      <main className="py-20 px-4">
        <div className="text-center mb-16">
          <h1 className="text-5xl md:text-6xl font-black tracking-tight mb-6">Simple, transparent pricing</h1>
          <p className="text-xl text-black/60 max-w-2xl mx-auto font-medium">
            Everything you need to go viral and make money, for less than the cost of one individual tool.
          </p>
        </div>

        <PricingCards />

        <div className="max-w-4xl mx-auto mt-20 flex flex-wrap justify-center gap-8 text-black/60 font-medium">
          <div className="flex items-center gap-2">
            <Zap className="w-5 h-5 text-primary" /> Instant access
          </div>
          <div className="flex items-center gap-2">
            <Clock className="w-5 h-5 text-primary" /> Cancel anytime
          </div>
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-primary" /> Secure checkout
          </div>
        </div>
      </main>

      <Footer />
    </div>
  );
}
