/**
 * Shared dark header for the secondary pages (Pricing, Account, Admin).
 * The clipper page keeps its own richer inline nav.
 */
import { useEffect, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { Scissors, Zap, LogOut, User, Shield, CreditCard } from 'lucide-react';
import { useAuth } from '../lib/auth';

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
          <Link href="/pricing" className="hidden sm:block text-sm font-semibold text-white/60 hover:text-white transition-colors">
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
                  className="flex items-center gap-2 bg-white/8 hover:bg-white/12 border border-white/10 rounded-xl px-3 py-2 transition-colors"
                >
                  <User className="w-4 h-4 text-white/60" />
                  <span className="hidden sm:block text-sm font-semibold text-white/80 max-w-[120px] truncate">
                    {user.name || user.email.split('@')[0]}
                  </span>
                </button>
                {menuOpen && (
                  <div className="absolute right-0 top-full mt-2 w-56 bg-[#1a1a1a] border border-white/10 rounded-2xl shadow-2xl shadow-black/60 overflow-hidden z-50">
                    <div className="px-4 py-3 border-b border-white/8">
                      <p className="text-white text-sm font-bold truncate">{user.name || 'Creator'}</p>
                      <p className="text-white/40 text-xs truncate mt-0.5">{user.email}</p>
                    </div>
                    <button
                      onClick={() => { setMenuOpen(false); setLocation('/account'); }}
                      className="w-full flex items-center gap-3 px-4 py-3 text-white/70 hover:text-white hover:bg-white/5 text-sm transition-colors"
                    >
                      <CreditCard className="w-4 h-4" /> Account & billing
                    </button>
                    {user.role === 'admin' && (
                      <button
                        onClick={() => { setMenuOpen(false); setLocation('/admin'); }}
                        className="w-full flex items-center gap-3 px-4 py-3 text-white/70 hover:text-white hover:bg-white/5 text-sm transition-colors"
                      >
                        <Shield className="w-4 h-4" /> Admin panel
                      </button>
                    )}
                    <button
                      onClick={async () => { setMenuOpen(false); await logout(); setLocation('/'); }}
                      className="w-full flex items-center gap-3 px-4 py-3 text-red-400/70 hover:text-red-400 hover:bg-red-500/5 text-sm transition-colors border-t border-white/5"
                    >
                      <LogOut className="w-4 h-4" /> Log out
                    </button>
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
