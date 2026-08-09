/**
 * Social auto-post hub — powered by bundle.social.
 *
 * Flow:
 * 1. User clicks "Connect Instagram / TikTok / YouTube…"
 * 2. We create their bundle.social team (first time) + get a hosted portal link
 * 3. bundle.social handles all OAuth — user picks their accounts
 * 4. Back here → accounts show up; user toggles which ones receive clips
 *
 * No Buffer, no per-user OAuth tokens in our DB.
 * Admin's BUNDLE_API_KEY does everything via bundle.social's organization.
 */

import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation } from 'wouter';
import {
  ArrowLeft, CheckCircle2, Loader2, XCircle, Zap, RefreshCw, AlertCircle,
  LogOut as Disconnect, Plus,
} from 'lucide-react';
import { apiFetch, useAuth } from '../lib/auth';
import { AppHeader } from '../components/AppHeader';

// ── Types ─────────────────────────────────────────────────────────────────────
interface SocialAccount {
  id: string;
  type: string;     // "INSTAGRAM" | "TIKTOK" | "YOUTUBE" etc.
  name: string;
  username?: string;
  avatarUrl?: string;
  enabled: boolean;
}
interface StatusData   { hasTeam: boolean; accountCount: number; }
interface AccountsData { accounts: SocialAccount[]; }
interface ConnectData  { url: string; }

// ── Platform catalogue ────────────────────────────────────────────────────────
const PLAT: Record<string, { label: string; gradient: string; icon: string }> = {
  INSTAGRAM: { label: 'Instagram', gradient: 'from-[#f09433] via-[#dc2743] to-[#bc1888]', icon: '📸' },
  TIKTOK:    { label: 'TikTok',    gradient: 'from-[#010101] to-[#69C9D0]',               icon: '🎵' },
  YOUTUBE:   { label: 'YouTube',   gradient: 'from-[#FF0000] to-[#cc0000]',               icon: '▶️' },
  TWITTER:   { label: 'X',         gradient: 'from-[#1DA1F2] to-[#0d8fe6]',               icon: '🐦' },
  FACEBOOK:  { label: 'Facebook',  gradient: 'from-[#1877F2] to-[#0c5dcf]',               icon: '👥' },
  LINKEDIN:  { label: 'LinkedIn',  gradient: 'from-[#0077B5] to-[#005e8c]',               icon: '💼' },
  THREADS:   { label: 'Threads',   gradient: 'from-[#111] to-[#555]',                     icon: '🧵' },
  PINTEREST: { label: 'Pinterest', gradient: 'from-[#E60023] to-[#b8001c]',               icon: '📌' },
  REDDIT:    { label: 'Reddit',    gradient: 'from-[#FF4500] to-[#cc3700]',               icon: '🤖' },
  BLUESKY:   { label: 'Bluesky',  gradient: 'from-[#0085ff] to-[#005ecf]',               icon: '🦋' },
};

const PLATFORM_PREVIEW = ['INSTAGRAM','TIKTOK','YOUTUBE','TWITTER','FACEBOOK','LINKEDIN','THREADS','PINTEREST','REDDIT','BLUESKY'];

function PlatIcon({ type, size = 'sm' }: { type: string; size?: 'sm' | 'lg' }) {
  const p = PLAT[type] ?? PLAT['INSTAGRAM'];
  const cls = size === 'lg' ? 'w-12 h-12 text-xl' : 'w-10 h-10 text-base';
  return (
    <div className={`${cls} rounded-2xl bg-gradient-to-br ${p.gradient} flex items-center justify-center shrink-0`}>
      {p.icon}
    </div>
  );
}

function Toast({ kind, msg, onDone }: { kind: 'success' | 'error'; msg: string; onDone: () => void }) {
  useEffect(() => { const t = setTimeout(onDone, 4500); return () => clearTimeout(t); }, [onDone]);
  return (
    <div className={`fixed bottom-6 right-6 z-50 flex items-center gap-2.5 px-4 py-3 rounded-2xl shadow-xl text-sm font-black ${kind === 'success' ? 'bg-[#D1FE17] text-black' : 'bg-red-500 text-white'}`}>
      {kind === 'success' ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
      {msg}
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────
export default function SocialPage() {
  const { user } = useAuth();
  if (!user) return <GuestView />;
  return <LoggedInView />;
}

// ── Logged-in view ────────────────────────────────────────────────────────────
function LoggedInView() {
  const qc = useQueryClient();
  const [, setLocation] = useLocation();
  const [toast, setToast] = useState<{ kind: 'success' | 'error'; msg: string } | null>(null);
  const [connecting, setConnecting] = useState(false);

  // Handle post-connect redirect
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get('connected') === '1') {
      setToast({ kind: 'success', msg: 'Accounts connected! Ready to auto-post.' });
      setLocation('/social', { replace: true });
    } else if (p.get('error')) {
      setToast({ kind: 'error', msg: 'Connection failed — please try again.' });
      setLocation('/social', { replace: true });
    }
  }, [setLocation]);

  const statusQ = useQuery({
    queryKey: ['social-status'],
    queryFn: () => apiFetch<StatusData>('/user/social/status'),
    refetchInterval: 10_000,
  });
  const accountsQ = useQuery({
    queryKey: ['social-accounts'],
    queryFn: () => apiFetch<AccountsData>('/user/social/accounts'),
    refetchInterval: 10_000,
    enabled: statusQ.data?.hasTeam ?? false,
  });

  const toggleMut = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      apiFetch(`/user/social/accounts/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['social-accounts'] }),
  });
  const disconnectMut = useMutation({
    mutationFn: () => apiFetch('/user/social/team', { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['social-status'] });
      qc.invalidateQueries({ queryKey: ['social-accounts'] });
      setToast({ kind: 'success', msg: 'All accounts disconnected.' });
    },
  });

  async function handleConnect() {
    setConnecting(true);
    try {
      const d = await apiFetch<ConnectData>('/user/social/connect-url');
      // Open in new tab so AutoCliper stays open behind it.
      // bundle.social will redirect back to /social?connected=1 when user clicks "Go back".
      window.open(d.url, '_blank', 'noopener,noreferrer');
    } catch {
      setToast({ kind: 'error', msg: 'Could not create connect link — try again.' });
    } finally {
      setConnecting(false);
    }
  }

  const loading    = statusQ.isLoading;
  const hasTeam    = statusQ.data?.hasTeam ?? false;
  const accounts   = accountsQ.data?.accounts ?? [];
  const active     = accounts.filter((a) => a.enabled);
  const inactive   = accounts.filter((a) => !a.enabled);

  return (
    <div className="min-h-screen bg-[#0d0d0d] text-white font-sans">
      <AppHeader />
      {toast && <Toast kind={toast.kind} msg={toast.msg} onDone={() => setToast(null)} />}

      <main className="max-w-xl mx-auto px-4 sm:px-6 py-10">
        <Link href="/" className="inline-flex items-center gap-1.5 text-sm text-white/35 hover:text-white transition-colors mb-8">
          <ArrowLeft className="w-4 h-4" /> Back to AutoCliper
        </Link>

        {/* ── Header ── */}
        <div className="mb-7 flex items-start justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-2xl font-black tracking-tight">Social auto-post</h1>
            <p className="text-white/40 text-sm mt-1">
              {loading
                ? 'Loading…'
                : active.length > 0
                  ? `${active.length} channel${active.length !== 1 ? 's' : ''} active — clips post automatically`
                  : hasTeam
                    ? 'No active channels — connect or enable below'
                    : 'Connect your accounts to start auto-posting'}
            </p>
          </div>

          {hasTeam && !loading && (
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={handleConnect}
                disabled={connecting}
                className="flex items-center gap-1.5 text-xs text-white/40 hover:text-white/70 border border-white/10 rounded-xl px-3 py-2 font-semibold disabled:opacity-50 transition-colors"
              >
                <Plus className={`w-3.5 h-3.5 ${connecting ? 'animate-spin' : ''}`} />
                Add more
              </button>
              <button
                onClick={() => { if (window.confirm('Disconnect ALL social accounts?')) disconnectMut.mutate(); }}
                disabled={disconnectMut.isPending}
                className="flex items-center gap-1.5 text-xs text-red-400/60 hover:text-red-400 border border-red-400/15 rounded-xl px-3 py-2 font-semibold disabled:opacity-50 transition-colors"
              >
                <Disconnect className="w-3.5 h-3.5" /> Disconnect all
              </button>
            </div>
          )}
        </div>

        {/* ── Loading ── */}
        {loading && (
          <div className="flex items-center gap-3 text-white/40 py-12 justify-center">
            <Loader2 className="w-5 h-5 animate-spin" /> Loading…
          </div>
        )}

        {/* ── NOT connected → big platform grid ── */}
        {!loading && !hasTeam && (
          <>
            {/* Main connect button */}
            <button
              onClick={handleConnect}
              disabled={connecting}
              className="w-full flex items-center justify-center gap-3 bg-white text-black text-sm font-black py-4 rounded-2xl hover:bg-white/90 active:scale-95 transition-all mb-4 disabled:opacity-60"
            >
              {connecting ? <Loader2 className="w-5 h-5 animate-spin" /> : <Zap className="w-5 h-5" />}
              {connecting ? 'Opening…' : 'Connect your social accounts'}
            </button>
            <p className="text-white/25 text-xs text-center mb-8">
              Instagram · TikTok · YouTube · X · LinkedIn · Facebook · Pinterest · Threads & more
            </p>

            {/* Platform icon grid */}
            <div className="grid grid-cols-5 gap-2">
              {PLATFORM_PREVIEW.map((key) => {
                const p = PLAT[key];
                return (
                  <button
                    key={key}
                    onClick={handleConnect}
                    disabled={connecting}
                    className="flex flex-col items-center gap-1.5 bg-[#111] border border-white/6 rounded-2xl py-3 px-1 opacity-50 hover:opacity-80 active:scale-95 transition-all disabled:cursor-wait"
                  >
                    <div className={`w-9 h-9 rounded-xl bg-gradient-to-br ${p.gradient} flex items-center justify-center text-base`}>{p.icon}</div>
                    <span className="text-[9px] font-black text-white/50 text-center leading-tight">{p.label}</span>
                  </button>
                );
              })}
            </div>

            <div className="mt-6 bg-[#111] border border-white/6 rounded-2xl p-5">
              <p className="text-white/40 text-xs font-black uppercase tracking-widest mb-3">How it works</p>
              <div className="space-y-2.5">
                {[
                  ['1️⃣', 'Click any platform or "Connect your social accounts"'],
                  ['2️⃣', 'Log into your Instagram / TikTok / YouTube — no extra account needed'],
                  ['3️⃣', 'Choose which channels to post to — done!'],
                  ['4️⃣', 'Every clip you generate auto-posts to your active channels'],
                ].map(([n, t]) => (
                  <div key={t} className="flex items-start gap-2.5">
                    <span className="text-sm mt-0.5">{n}</span>
                    <p className="text-white/35 text-sm">{t}</p>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {/* ── HAS TEAM → accounts list ── */}
        {!loading && hasTeam && (
          <>
            {accountsQ.isLoading && (
              <div className="flex items-center gap-3 text-white/40 py-6 justify-center">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading accounts…
              </div>
            )}

            {/* Active accounts */}
            {active.length > 0 && (
              <div className="mb-5">
                <p className="text-[11px] font-black text-white/30 uppercase tracking-widest mb-3">Posting to</p>
                <div className="space-y-2">
                  {active.map((acc) => {
                    const p = PLAT[acc.type];
                    const isT = toggleMut.isPending && (toggleMut.variables as any)?.id === acc.id;
                    return (
                      <div key={acc.id} className="flex items-center gap-3 bg-[#1a1a1a] border border-[#D1FE17]/15 rounded-2xl px-4 py-3.5">
                        <PlatIcon type={acc.type} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-black">{p?.label ?? acc.type}</p>
                          <p className="text-white/35 text-xs truncate">
                            {acc.username ? (acc.username.startsWith('@') ? acc.username : `@${acc.username}`) : acc.name}
                          </p>
                        </div>
                        <CheckCircle2 className="w-4 h-4 text-[#D1FE17] shrink-0" />
                        <button
                          onClick={() => toggleMut.mutate({ id: acc.id, enabled: false })}
                          disabled={isT}
                          className={`relative shrink-0 w-10 h-5 rounded-full bg-[#D1FE17] ${isT ? 'opacity-50' : ''}`}
                        >
                          <span className="absolute top-0.5 translate-x-[22px] w-4 h-4 rounded-full bg-white shadow-sm" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Inactive accounts */}
            {inactive.length > 0 && (
              <div className="mb-5">
                <p className="text-[11px] font-black text-white/30 uppercase tracking-widest mb-3">
                  {active.length > 0 ? 'Also available' : 'Your accounts (all paused)'}
                </p>
                <div className="space-y-2">
                  {inactive.map((acc) => {
                    const p = PLAT[acc.type];
                    const isT = toggleMut.isPending && (toggleMut.variables as any)?.id === acc.id;
                    return (
                      <div key={acc.id} className="flex items-center gap-3 bg-[#111] border border-white/6 rounded-2xl px-4 py-3.5 opacity-50">
                        <PlatIcon type={acc.type} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-black">{p?.label ?? acc.type}</p>
                          <p className="text-white/35 text-xs truncate">
                            {acc.username ? (acc.username.startsWith('@') ? acc.username : `@${acc.username}`) : acc.name}
                          </p>
                        </div>
                        <button
                          onClick={() => toggleMut.mutate({ id: acc.id, enabled: true })}
                          disabled={isT}
                          className={`relative shrink-0 w-10 h-5 rounded-full bg-white/15 ${isT ? 'opacity-50' : ''}`}
                        >
                          <span className="absolute top-0.5 translate-x-0.5 w-4 h-4 rounded-full bg-white shadow-sm" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* No accounts yet */}
            {!accountsQ.isLoading && accounts.length === 0 && (
              <div className="bg-[#1a1a1a] border border-white/8 rounded-2xl p-6 text-center mb-4">
                <XCircle className="w-7 h-7 text-white/20 mx-auto mb-3" />
                <p className="text-white/40 text-sm mb-3">No accounts connected yet.</p>
                <button
                  onClick={handleConnect}
                  disabled={connecting}
                  className="inline-flex items-center gap-2 bg-white text-black text-sm font-black px-5 py-2.5 rounded-xl hover:bg-white/90 active:scale-95 transition-all disabled:opacity-50"
                >
                  {connecting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                  Connect accounts
                </button>
              </div>
            )}

            <p className="text-white/20 text-xs text-center">
              Clips auto-post after generation · Toggle to pause any channel
            </p>
          </>
        )}
      </main>
    </div>
  );
}

// ── Guest view ────────────────────────────────────────────────────────────────
function GuestView() {
  return (
    <div className="min-h-screen bg-[#0d0d0d] text-white font-sans">
      <AppHeader />
      <main className="max-w-xl mx-auto px-4 sm:px-6 py-12">
        <Link href="/" className="inline-flex items-center gap-1.5 text-sm text-white/35 hover:text-white transition-colors mb-8">
          <ArrowLeft className="w-4 h-4" /> Back to AutoCliper
        </Link>
        <h1 className="text-2xl font-black tracking-tight mb-1">Social auto-post</h1>
        <p className="text-white/40 text-sm mb-8">
          Connect Instagram, TikTok, YouTube and more — clips auto-post after generation.
          No extra accounts needed.
        </p>

        <div className="grid grid-cols-5 gap-2 mb-8 opacity-40">
          {PLATFORM_PREVIEW.map((key) => {
            const p = PLAT[key];
            return (
              <div key={key} className="flex flex-col items-center gap-1.5 bg-[#111] border border-white/6 rounded-2xl py-3 px-1">
                <div className={`w-9 h-9 rounded-xl bg-gradient-to-br ${p.gradient} flex items-center justify-center text-base`}>{p.icon}</div>
                <span className="text-[9px] font-black text-white/50 text-center leading-tight">{p.label}</span>
              </div>
            );
          })}
        </div>

        <Link href="/login" className="w-full flex items-center justify-center gap-2 bg-white text-black text-sm font-black py-4 rounded-2xl hover:bg-white/90 active:scale-95 transition-all">
          <Zap className="w-4 h-4" /> Log in to connect your accounts
        </Link>
      </main>
    </div>
  );
}
