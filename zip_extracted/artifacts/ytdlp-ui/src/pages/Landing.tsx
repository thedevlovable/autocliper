import { Link } from 'wouter';
import { motion } from 'framer-motion';
import { Wand2, Check, X, PlayCircle, Star } from 'lucide-react';
import * as Accordion from '@radix-ui/react-accordion';
import { Navbar } from '../components/Navbar';
import { Footer } from '../components/Footer';
import { CountdownBanner } from '../components/CountdownBanner';
import { PricingCards } from '../components/PricingCards';
import { tools } from '../lib/data';

export default function Landing() {
  const showcase = [
    { views: "3.7M", tool: "AI Video Generator", color: "from-blue-500 to-cyan-400" },
    { views: "8.9M", tool: "Faceless Video", color: "from-purple-500 to-pink-500" },
    { views: "2.4M", tool: "Rant Video", color: "from-orange-500 to-red-500" },
    { views: "780K", tool: "Auto Subtitle", color: "from-green-400 to-emerald-600" },
    { views: "5.1M", tool: "Difference Explainer", color: "from-indigo-500 to-blue-600" },
    { views: "1.3M", tool: "Auto Clip", color: "from-yellow-400 to-orange-500" },
    { views: "640K", tool: "Caption Remover", color: "from-pink-500 to-rose-500" },
  ];

  const creators = ["Yoav 180M+ Views", "Rozi 245M+ Views", "Dylan 320M+ Views", "Aidenyta 92M+ Views", "emzy 410M+ Views"];

  const testimonials = [
    { name: "david", role: "switched from another tool", text: "switching to viralai was the best decision i've made this year. one tab, one bill, every tool i actually use." },
    { name: "arneri", role: "running 5 faceless channels", text: "im running 5 faceless channels on autopilot. one credit pool, same effort as running one." },
    { name: "alestioo", role: "scaling shorts", text: "auto clip is insane. im clipping 5 videos a day from one podcast while i sleep." },
    { name: "spofe", role: "improved hook with viral engine", text: "viral engine told me the hook was weak. fixed it. that video became the most popular on my channel." },
    { name: "yami", role: "faceless creator", text: "faceless video is insane. ai voice + captions + memes + gameplay, all stitched in one shot." },
    { name: "kael", role: "making $10k+ monthly", text: "i've never seen a tool like viralai before, it helps me improve every part of my videos." },
    { name: "milo", role: "new channel, week 2", text: "started a faceless channel two weeks ago using only viralai, it's become my entire workflow." },
    { name: "dax", role: "tiktok editor", text: "the unlimited voices are amazing, i've never seen another tool offer this. saved me so much money." },
    { name: "robin", role: "started YT journey with viralai", text: "features like viral engine and shorts audit helped me grow my channel from 0." },
    { name: "aeon", role: "automation operator", text: "im running 10+ faceless channels because of viralai, it helps with hooks, thumbnails, and scripts." }
  ];

  const faqs = [
    { q: "What is VIRALAI?", a: "VIRALAI is one video studio for short videos. Faceless videos, character explainers, difference explainers, fake text dramas, auto clipped shorts, unlimited AI voices, and viral analysis — all in one place." },
    { q: "How does VIRALAI work?", a: "Pick a template, describe your idea. VIRALAI writes the script, picks visuals, adds voiceover and captions, exports a finished short. Never touch a timeline." },
    { q: "Can I earn from VIRALAI videos?", a: "Yes. Everything you create is yours to monetize on YouTube, TikTok, Instagram. Many creators run fully monetized channels built entirely on VIRALAI." },
    { q: "Is AI content monetizable?", a: "Yes. YouTube, TikTok, and Instagram all allow AI content as long as it's not spam. Every VIRALAI video is fresh original content." },
    { q: "What are credits?", a: "Credits are what you spend to use tools. Different tools cost different amounts. Credits refresh every 30 days when your plan renews." },
    { q: "Can I cancel anytime?", a: "Yes. Upgrade, downgrade, or cancel anytime from your billing page. No long-term contracts." }
  ];

  return (
    <div className="min-h-screen bg-white selection:bg-primary selection:text-black">
      <CountdownBanner />
      <Navbar />

      {/* Hero Section */}
      <section className="pt-20 pb-32 px-4 overflow-hidden relative">
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-primary/20 blur-[120px] rounded-full pointer-events-none" />
        
        <div className="max-w-5xl mx-auto text-center relative z-10">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
          >
            <div className="inline-flex items-center gap-2 bg-primary/10 border border-primary/30 text-black px-4 py-1.5 rounded-full text-sm font-bold mb-8">
              <span className="bg-primary text-black text-[10px] uppercase px-2 py-0.5 rounded-full tracking-wider">NEW</span>
              The Laziest way to earn in 2026
            </div>
            
            <h1 className="text-6xl md:text-8xl font-black tracking-tighter leading-[0.9] mb-8">
              Make Money with Shorts<br />
              <span className="text-primary [-webkit-text-stroke:2px_black] drop-shadow-sm">in 30 seconds</span>
            </h1>
            
            <p className="text-xl md:text-2xl text-black/60 font-medium mb-10 max-w-2xl mx-auto leading-relaxed">
              Your all-in-one tool for making money from viral videos with the power of AI.
            </p>
            
            <div className="flex flex-col items-center gap-4">
              <Link href="/sign-up" className="bg-primary text-black px-8 py-5 rounded-full text-xl font-black tracking-wide hover:bg-[#bbf00e] transition-all hover:scale-105 active:scale-95 shadow-[0_0_40px_-10px_rgba(209,254,23,0.5)]">
                MAKE MY FIRST VIDEO &rarr;
              </Link>
              <div className="flex items-center gap-2 text-sm font-semibold text-black/60">
                <div className="flex text-yellow-400">
                  <Star fill="currentColor" className="w-4 h-4" />
                  <Star fill="currentColor" className="w-4 h-4" />
                  <Star fill="currentColor" className="w-4 h-4" />
                  <Star fill="currentColor" className="w-4 h-4" />
                  <Star fill="currentColor" className="w-4 h-4" />
                </div>
                4.9/5 &middot; verified by Proof
              </div>
            </div>
          </motion.div>
        </div>
      </section>

      {/* Video Showcase Infinite Scroll */}
      <section className="py-10 bg-black overflow-hidden border-y border-white/10 relative">
        <div className="flex w-[200%] animate-scroll-left">
          {[...showcase, ...showcase].map((item, i) => (
            <div key={i} className="w-[280px] shrink-0 mx-4">
              <div className="relative aspect-[9/16] rounded-3xl overflow-hidden border border-white/10 p-4 flex flex-col justify-between">
                <div className={`absolute inset-0 bg-gradient-to-br ${item.color} opacity-80`} />
                <div className="absolute inset-0 bg-black/20" />
                
                <div className="relative z-10 flex justify-end">
                  <span className="bg-red-500 text-white text-xs font-black px-3 py-1 rounded-full shadow-lg">
                    {item.views} Views
                  </span>
                </div>
                
                <div className="relative z-10">
                  <div className="bg-black/50 backdrop-blur-md border border-white/20 text-white p-3 rounded-2xl">
                    <div className="font-bold text-lg leading-tight">{item.tool}</div>
                    <div className="text-xs text-white/60 mt-1 flex items-center gap-1">
                      <PlayCircle className="w-3 h-3" /> Generated by AI
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Features Grid */}
      <section id="features" className="py-32 px-4 bg-black/5">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-20">
            <h2 className="text-4xl md:text-5xl font-black tracking-tight mb-4">Every AI tool you need to<br/>go viral and make money</h2>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {tools.slice(0, 12).map((tool, i) => (
              <div key={i} className="bg-white p-6 rounded-3xl border border-black/10 hover:border-primary hover:shadow-xl transition-all group">
                <div className="w-12 h-12 bg-black/5 rounded-2xl flex items-center justify-center mb-6 group-hover:bg-primary/20 transition-colors">
                  <Wand2 className="w-6 h-6 text-black" />
                </div>
                <h3 className="text-xl font-bold mb-2">{tool.name}</h3>
                <p className="text-black/60 mb-6 line-clamp-2 h-12">{tool.description}</p>
                <Link href="/sign-up" className="font-bold text-sm inline-flex items-center group-hover:text-primary transition-colors">
                  Try {tool.name} &rarr;
                </Link>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Creator Ticker */}
      <section className="bg-primary py-4 overflow-hidden border-y border-black">
        <div className="flex w-[200%] animate-scroll-fast items-center">
          {[...creators, ...creators, ...creators].map((creator, i) => (
            <div key={i} className="text-black font-black text-2xl uppercase tracking-wider whitespace-nowrap mx-8 flex items-center gap-8">
              {creator} <span className="text-black/20 text-4xl">&bull;</span>
            </div>
          ))}
        </div>
        <div className="text-center mt-2 font-bold text-sm text-black/60 uppercase tracking-widest">
          Trusted by 50k+ creators
        </div>
      </section>

      {/* Testimonials */}
      <section className="py-32 overflow-hidden bg-white">
        <div className="text-center mb-16">
          <h2 className="text-4xl md:text-5xl font-black tracking-tight">Creators making bank</h2>
        </div>
        
        <div className="flex flex-col gap-6 w-[200%] md:w-[150%] lg:w-[120%] -ml-[10%]">
          {/* Row 1 */}
          <div className="flex gap-6 animate-scroll-left">
            {[...testimonials.slice(0,5), ...testimonials.slice(0,5)].map((t, i) => (
              <div key={i} className="w-[350px] shrink-0 bg-white border border-black/10 p-6 rounded-3xl shadow-sm hover:shadow-md transition-shadow">
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center font-bold uppercase border border-primary text-black">
                    {t.name.slice(0,2)}
                  </div>
                  <div>
                    <div className="font-bold leading-none">{t.name}</div>
                    <div className="text-xs text-black/50 mt-1">{t.role}</div>
                  </div>
                </div>
                <p className="text-black/80 font-medium">"{t.text}"</p>
              </div>
            ))}
          </div>
          
          {/* Row 2 */}
          <div className="flex gap-6 animate-scroll-right">
            {[...testimonials.slice(5), ...testimonials.slice(5)].map((t, i) => (
              <div key={i} className="w-[350px] shrink-0 bg-white border border-black/10 p-6 rounded-3xl shadow-sm hover:shadow-md transition-shadow">
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-10 h-10 rounded-full bg-black flex items-center justify-center font-bold uppercase text-white">
                    {t.name.slice(0,2)}
                  </div>
                  <div>
                    <div className="font-bold leading-none">{t.name}</div>
                    <div className="text-xs text-black/50 mt-1">{t.role}</div>
                  </div>
                </div>
                <p className="text-black/80 font-medium">"{t.text}"</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section id="templates" className="py-32 px-4 bg-black text-white">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-20">
            <h2 className="text-4xl md:text-5xl font-black tracking-tight">How it works</h2>
          </div>
          
          <div className="space-y-16">
            {[
              { num: "01", title: "Pick a template", desc: "Browse 20+ video formats. Rant, explainer, fake texts, auto clip." },
              { num: "02", title: "Describe your idea", desc: "Type a prompt or paste a script. VIRALAI writes, voices, and assembles the video." },
              { num: "03", title: "Analyze and improve", desc: "Get predicted views, failure points, rewrites, and which tool to run next." }
            ].map((step, i) => (
              <div key={i} className="flex flex-col md:flex-row gap-8 items-start">
                <div className="text-6xl md:text-8xl font-black text-white/10 leading-none">{step.num}</div>
                <div className="pt-2">
                  <h3 className="text-3xl font-bold mb-4">{step.title}</h3>
                  <p className="text-xl text-white/60 max-w-xl">{step.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Comparison */}
      <section id="compare" className="py-32 px-4 bg-white">
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-4xl md:text-5xl font-black tracking-tight">Why VIRALAI?</h2>
            <p className="mt-4 text-xl text-black/60 max-w-2xl mx-auto font-medium">
              No single tool does all of this. VIRALAI does, and for a fraction of the price.
            </p>
          </div>
          
          <div className="border border-black/10 rounded-3xl overflow-hidden shadow-xl">
            <div className="grid grid-cols-3 bg-black/5 p-6 border-b border-black/10 text-center font-bold text-lg">
              <div className="text-left">Feature</div>
              <div className="text-black/40">Other tools</div>
              <div className="text-primary bg-black px-4 py-1 rounded-full inline-block mx-auto">VIRALAI</div>
            </div>
            
            <div className="bg-white">
              {[
                "Unlimited ElevenLabs voiceovers",
                "Video analyzer that tells you what to fix",
                "Full channel audit (Viral Engine)",
                "Live automation coach on a call",
                "Strategy chat to help you grow faster",
                "Thumbnail analyzer for more clicks",
                "Scriptwriter that knows your channel style",
                "Video enhancer up to 4K",
                "Caption remover",
                "Stem splitter for drums, vocals, and music",
                "Every tool in one dashboard"
              ].map((feature, i) => (
                <div key={i} className="grid grid-cols-3 p-6 border-b border-black/5 hover:bg-black/[0.02] transition-colors items-center text-center">
                  <div className="text-left font-medium">{feature}</div>
                  <div className="flex justify-center"><X className="text-black/20 w-6 h-6" /></div>
                  <div className="flex justify-center"><Check className="text-primary bg-black rounded-full p-1 w-6 h-6" /></div>
                </div>
              ))}
              
              <div className="grid grid-cols-3 p-8 bg-black/5 items-center text-center font-black text-xl">
                <div className="text-left">Total Cost</div>
                <div className="text-black/40 line-through">$150+/mo &middot; 10+ logins</div>
                <div className="text-2xl">from $19/mo <br/><span className="text-sm font-medium text-black/60">one login</span></div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section className="py-32 px-4 bg-black/5">
        <div className="text-center mb-8">
          <h2 className="text-4xl md:text-5xl font-black tracking-tight">Pick your plan and start creating</h2>
        </div>
        <PricingCards />
      </section>

      {/* FAQ */}
      <section className="py-32 px-4 bg-white">
        <div className="max-w-3xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-4xl md:text-5xl font-black tracking-tight">Got Questions?<br/>We've Got Answers.</h2>
          </div>
          
          <Accordion.Root type="single" collapsible className="space-y-4">
            {faqs.map((faq, i) => (
              <Accordion.Item key={i} value={`item-${i}`} className="border border-black/10 rounded-2xl overflow-hidden data-[state=open]:border-primary transition-colors bg-white">
                <Accordion.Header>
                  <Accordion.Trigger className="w-full text-left p-6 font-bold text-lg flex justify-between items-center group">
                    {faq.q}
                    <div className="w-8 h-8 rounded-full bg-black/5 flex items-center justify-center group-data-[state=open]:bg-primary group-data-[state=open]:rotate-45 transition-all">
                      +
                    </div>
                  </Accordion.Trigger>
                </Accordion.Header>
                <Accordion.Content className="px-6 pb-6 text-black/70 leading-relaxed text-lg">
                  {faq.a}
                </Accordion.Content>
              </Accordion.Item>
            ))}
          </Accordion.Root>
        </div>
      </section>

      {/* Final CTA */}
      <section className="py-32 px-4 bg-black text-white text-center">
        <div className="max-w-4xl mx-auto">
          <h2 className="text-5xl md:text-7xl font-black tracking-tighter mb-8">Ready to make your first short?</h2>
          <Link href="/sign-up" className="inline-block bg-primary text-black px-10 py-6 rounded-full text-2xl font-black tracking-wide hover:scale-105 transition-transform">
            MAKE MY FIRST VIDEO &rarr;
          </Link>
        </div>
      </section>

      <Footer />
    </div>
  );
}
