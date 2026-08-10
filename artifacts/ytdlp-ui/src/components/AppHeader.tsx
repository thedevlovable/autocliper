/**
 * Shared dark header for the secondary pages (Pricing, Account, Admin).
 * The clipper page keeps its own richer inline nav — the account dropdown
 * here mirrors its "lime card" design.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import { Scissors, Zap, LogOut, Shield, CreditCard, Share2, CalendarClock, ChevronDown } from 'lucide-react';
import { useAuth } from '../lib/auth';

/** One row of the account dropdown — icon chip that lights up lime on hover. */
function MenuRow({ icon, label, onSelect }: { icon: ReactNode; label: string; onSelect: () => void }) {
  return (
    <button
      onClick={onSelect}
      className="group w-full flex items-center gap-3 px-2.5 py-2 rounded-xl text-white/70 hover:text-white hover:bg-white/[0.05] text-sm font-semibold transition-colors"
    >
      <span className="w-7 h-7 shrink-0 rounded-lg bg-white/[0.05] border border-white/[0.07] flex items-center justify-center text-white/50 group-hover:text-[#D1FE17] group-hover:border-[#D1FE17]/25 group-hover:bg-[#D1FE17]/10 transition-colors">
        {icon}
      </span>
      <span className="flex-1 text-left truncate">{label}</span>
    </button>
  );
}

export function AppHeader() {
  const { user, logout } = useAuth();
  const [, setLocation] = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('[data-app-user-menu]')) setMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  return (
    <nav className="sticky top-0 z-50 border-b border-white/5 bg-[#0d0d0d]/90 backdrop-blur-xl">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-4">
        <Link href="/" className="flex items-center gap-2 shrink-0">
          <div className="w-7 h-7 rounded-lg bg-[#D1FE17] flex items-center justify-center">
            <Scissors className="w-4 h-4 text-black" strokeWidth={2.5} />
          </div>
          <span className="font-black text-lg tracking-tight text-white">AutoCliper</span>
        </Link>

        <div className="flex items-center gap-3 shrink-0">
          <Link href="/#pricing" className="hidden sm:block text-sm font-semibold text-white/60 hover:text-white transition-colors">
            Pricing
          </Link>
          {user ? (
            <>
              <Link
                href="/account"
                className="flex items-center gap-1.5 bg-[#D1FE17]/10 border border-[#D1FE17]/30 text-[#D1FE17] rounded-xl px-3 py-1.5 text-sm font-black hover:bg-[#D1FE17]/20 transition-colors"
                title="Your credits"
              >
                <Zap className="w-4 h-4" />
                {user.credits.total}
              </Link>
              <div className="relative" data-app-user-menu>
                <button
                  onClick={() => setMenuOpen(o => !o)}
                  className={`flex items-center gap-2 rounded-xl pl-1.5 pr-2.5 py-1.5 border transition-all ${
                    menuOpen
                      ? 'bg-[#D1FE17]/10 border-[#D1FE17]/30'
                      : 'bg-white/8 border-white/10 hover:bg-white/12'
                  }`}
                >
                  <span className="w-7 h-7 rounded-lg bg-[#D1FE17] text-black text-sm font-black flex items-center justify-center shadow-[0_0_14px_rgba(209,254,23,0.35)]">
                    {(user.name || user.email)[0].toUpperCase()}
                  </span>
                  <span className="hidden sm:block text-sm font-semibold text-white/80 max-w-[120px] truncate">
                    {user.name || user.email.split('@')[0]}
                  </span>
                  <ChevronDown className={`hidden sm:block w-3.5 h-3.5 text-white/40 transition-transform ${menuOpen ? 'rotate-180' : ''}`} />
                </button>
                {menuOpen && (
                  <div className="absolute right-0 top-full mt-2 w-[17rem] rounded-2xl border border-white/10 bg-gradient-to-b from-[#161616] to-[#0e0e0e] shadow-2xl shadow-black/70 overflow-hidden z-50">
                    {/* Lime hairline + soft glow — the card's signature */}
                    <div className="h-px bg-gradient-to-r from-transparent via-[#D1FE17]/70 to-transparent" />
                    <div className="relative px-4 pt-4 pb-3">
                      <div className="absolute -top-10 right-0 w-36 h-20 bg-[#D1FE17]/10 blur-2xl pointer-events-none" />
                      <div className="relative flex items-center gap-3">
                        <span className="w-10 h-10 shrink-0 rounded-xl bg-[#D1FE17] text-black text-lg font-black flex items-center justify-center shadow-[0_0_20px_rgba(209,254,23,0.3)]">
                          {(user.name || user.email)[0].toUpperCase()}
                        </span>
                        <div className="min-w-0">
                          <p className="text-white text-sm font-black truncate">{user.name || 'Creator'}</p>
                          <p className="text-white/35 text-[11px] truncate mt-0.5">{user.email}</p>
                        </div>
                      </div>
                      <button
                        onClick={() => { setMenuOpen(false); setLocation('/account'); }}
                        className="relative mt-3 w-full flex items-center justify-between rounded-xl border border-[#D1FE17]/20 bg-[#D1FE17]/[0.06] hover:bg-[#D1FE17]/[0.12] px-3 py-2 transition-colors"
                      >
                        <span className="flex items-center gap-1.5 text-[#D1FE17] text-sm font-black">
                          <Zap className="w-4 h-4" />{user.credits.total} credits
                        </span>
                        <span className="text-[10px] font-black uppercase tracking-wider text-[#D1FE17]/70">Top up →</span>
                      </button>
                    </div>
                    <div className="p-2 pt-0">
                      <MenuRow icon={<CreditCard className="w-4 h-4" />} label="Account & billing" onSelect={() => { setMenuOpen(false); setLocation('/account'); }} />
                      <MenuRow icon={<Share2 className="w-4 h-4" />} label="Social auto-post" onSelect={() => { setMenuOpen(false); setLocation('/social'); }} />
                      <MenuRow icon={<CalendarClock className="w-4 h-4" />} label="Schedule posts" onSelect={() => { setMenuOpen(false); setLocation('/schedule'); }} />
                      {user.role === 'admin' && (
                        <MenuRow icon={<Shield className="w-4 h-4" />} label="Admin panel" onSelect={() => { setMenuOpen(false); setLocation('/admin'); }} />
                      )}
                    </div>
                    <div className="mx-3 h-px bg-white/[0.06]" />
                    <div className="p-2">
                      <button
                        onClick={async () => { setMenuOpen(false); await logout(); setLocation('/'); }}
                        className="group w-full flex items-center gap-3 px-2.5 py-2 rounded-xl text-red-400/70 hover:text-red-400 hover:bg-red-500/[0.07] text-sm font-semibold transition-colors"
                      >
                        <span className="w-7 h-7 shrink-0 rounded-lg bg-white/[0.05] border border-white/[0.07] flex items-center justify-center group-hover:bg-red-500/10 group-hover:border-red-500/25 transition-colors">
                          <LogOut className="w-4 h-4" />
                        </span>
                        Log out
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              <Link href="/login" className="text-sm font-semibold text-white/60 hover:text-white transition-colors">
                Log in
              </Link>
              <Link href="/signup" className="bg-white text-black text-sm font-black px-4 py-2 rounded-xl hover:bg-white/90 active:scale-95 transition-all">
                Get started — Free
              </Link>
            </>
          )}
        </div>
      </div>
    </nav>
  );
}
