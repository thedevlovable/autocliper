/**
 * Social auto-post hub — powered by bundle.social.
 *
 * Flow:
 * 1. User clicks "Connect Instagram / TikTok / YouTube…"
 * 2. We create their bundle.social team (first time) + get a hosted portal link
 * 3. bundle.social handles all OAuth — user picks their accounts
 * 4. Back here → accounts show up; user toggles which ones receive clips
 */

import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation } from 'wouter';
import {
  ArrowLeft, CheckCircle2, Loader2, XCircle, Zap, AlertCircle,
  LogOut as Disconnect, Plus, Share2,
} from 'lucide-react';
import { apiFetch, useAuth } from '../lib/auth';
import { AppHeader } from '../components/AppHeader';

// ── Types ─────────────────────────────────────────────────────────────────────
interface SocialAccount {
  id: string;
  type: string;
  name: string;
  username?: string;
  avatarUrl?: string;
  enabled: boolean;
}
interface StatusData   { hasTeam: boolean; accountCount: number; activeCount: number; autoPostEnabled: boolean; }
interface AccountsData { accounts: SocialAccount[]; }
interface ConnectData  { url: string; }
interface PrefsData    { autoPostEnabled: boolean; }

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
  BLUESKY:   { label: 'Bluesky',   gradient: 'from-[#0085ff] to-[#005ecf]',               icon: '🦋' },
};
const PLATFORM_PREVIEW = ['INSTAGRAM','TIKTOK','YOUTUBE','TWITTER','FACEBOOK','LINKEDIN','THREADS','PINTEREST','REDDIT','BLUESKY'];

function PlatIcon({ type, size = 'sm' }: { type: string; size?: 'sm' | 'lg' }) {
  const p = PLAT[type] ?? PLAT['INSTAGRAM'];
  const cls = size === 'lg' ? 'w-12 h-12 text-xl' : 'w-10 h-10 text-base';
  return (
    <div className={`${cls} rounded-2xl bg-gradient-to-br ${p.gradient} flex items-center justify-center shrink-0 shadow-lg`}>
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

  // Master auto-post preference
  const prefsQ = useQuery({
    queryKey: ['social-prefs'],
    queryFn: () => apiFetch<PrefsData>('/user/social/prefs'),
  });
  const prefsMut = useMutation({
    mutationFn: (autoPostEnabled: boolean) =>
      apiFetch('/user/social/prefs', { method: 'PATCH', body: JSON.stringify({ autoPostEnabled }) }),
    onMutate: async (autoPostEnabled) => {
      await qc.cancelQueries({ queryKey: ['social-prefs'] });
      qc.setQueryData(['social-prefs'], { autoPostEnabled });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['social-prefs'] }),
  });
  const autoPostEnabled = prefsQ.data?.autoPostEnabled ?? true;

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
      window.open(d.url, '_blank', 'noopener,noreferrer');
    } catch {
      setToast({ kind: 'error', msg: 'Could not create connect link — try again.' });
    } finally {
      setConnecting(false);
    }
  }

  const loading  = statusQ.isLoading;
  const hasTeam  = statusQ.data?.hasTeam ?? false;
  const accounts = accountsQ.data?.accounts ?? [];
  const active   = accounts.filter((a) => a.enabled);
  const inactive = accounts.filter((a) => !a.enabled);

  return (
    <div className="min-h-screen bg-[#0d0d0d] text-white font-sans">
      <AppHeader />
      {toast && <Toast kind={toast.kind} msg={toast.msg} onDone={() => setToast(null)} />}

      <main className="max-w-xl mx-auto px-4 sm:px-6 py-10">
        {/* Back */}
        <Link href="/" className="inline-flex items-center gap-1.5 text-sm text-white/35 hover:text-white transition-colors mb-8">
          <ArrowLeft className="w-4 h-4" /> Back to AutoCliper
        </Link>

        {/* ── Page header ── */}
        <div className="mb-6 flex items-start justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-2xl font-black tracking-tight">Social auto-post</h1>
            <p className="text-white/40 text-sm mt-1">
              {loading
                ? 'Loading…'
                : active.length > 0
                  ? `${active.length} channel${active.length !== 1 ? 's' : ''} active — clips post automatically`
                  : hasTeam
                    ? 'Connect or enable a channel to start auto-posting'
                    : 'Connect your accounts to start auto-posting'}
            </p>
          </div>
          {hasTeam && !loading && (
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={handleConnect} disabled={connecting}
                className="flex items-center gap-1.5 text-xs text-white/40 hover:text-white/70 border border-white/10 rounded-xl px-3 py-2 font-semibold disabled:opacity-50 transition-colors"
              >
                <Plus className={`w-3.5 h-3.5 ${connecting ? 'animate-spin' : ''}`} /> Add more
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

        {/* ── NOT CONNECTED → full pitch ── */}
        {!loading && !hasTeam && (
          <>
            {/* Hero card */}
            <div className="relative overflow-hidden rounded-3xl border border-white/8 bg-gradient-to-br from-[#141414] to-[#0d0d0d] p-7 mb-5">
              <div className="absolute -top-24 -right-24 w-72 h-72 rounded-full bg-[#D1FE17]/6 blur-3xl pointer-events-none" />
              <div className="absolute -bottom-16 -left-16 w-48 h-48 rounded-full bg-[#D1FE17]/4 blur-3xl pointer-events-none" />
              <div className="relative">
                <span className="inline-flex items-center gap-1.5 bg-[#D1FE17]/10 border border-[#D1FE17]/25 text-[#D1FE17] text-[10px] font-black uppercase tracking-widest px-3 py-1 rounded-full mb-5">
                  <Zap className="w-3 h-3" /> Free with all plans
                </span>
                <h2 className="text-2xl sm:text-3xl font-black leading-tight mb-3">
                  Aapke clips.<br />
                  <span className="text-[#D1FE17]">Har platform par.</span><br />
                  Zero extra clicks.
                </h2>
                <p className="text-white/45 text-sm leading-relaxed max-w-sm">
                  Ek baar connect karo — uske baad, jo bhi clip generate karo, woh automatically Instagram,
                  TikTok, YouTube aur 7 aur platforms par post ho jaayegi. Manually kuch karne ki zaroorat nahi.
                </p>
              </div>
            </div>

            {/* Platform grid */}
            <div className="grid grid-cols-5 gap-2 mb-5">
              {PLATFORM_PREVIEW.map((key) => {
                const p = PLAT[key];
                return (
                  <button
                    key={key} onClick={handleConnect} disabled={connecting}
                    className="group flex flex-col items-center gap-1.5 bg-[#111] border border-white/6 rounded-2xl py-3.5 px-1 hover:border-[#D1FE17]/30 hover:bg-[#1a1a1a] hover:-translate-y-1 transition-all active:scale-95 disabled:cursor-wait"
                  >
                    <div className={`w-9 h-9 rounded-xl bg-gradient-to-br ${p.gradient} flex items-center justify-center text-base shadow-lg`}>{p.icon}</div>
                    <span className="text-[9px] font-black text-white/40 group-hover:text-white/60 text-center leading-tight transition-colors">{p.label}</span>
                  </button>
                );
              })}
            </div>

            {/* Main CTA */}
            <button
              onClick={handleConnect} disabled={connecting}
              className="w-full flex items-center justify-center gap-3 bg-[#D1FE17] text-black text-sm font-black py-4 rounded-2xl hover:bg-[#c5f010] active:scale-95 transition-all mb-5 shadow-[0_0_40px_rgba(209,254,23,0.25)] disabled:opacity-60"
            >
              {connecting ? <Loader2 className="w-5 h-5 animate-spin" /> : <Share2 className="w-5 h-5" />}
              {connecting ? 'Opening connect portal…' : 'Connect your social accounts'}
            </button>

            {/* USPs */}
            <div className="grid grid-cols-2 gap-2.5 mb-5">
              {[
                { icon: '🏆', title: 'India ka pehla', desc: 'AI clipper jo 10+ platforms par ek saath post karta hai' },
                { icon: '⚡', title: 'Instant posting',  desc: 'Clip bante hi — 0 extra clicks, automatic' },
                { icon: '📝', title: 'AI captions',      desc: 'Har platform ke liye viral captions auto-write' },
                { icon: '🔐', title: '100% private',     desc: 'Aapka password kabhi hamare server par nahi aata' },
              ].map(u => (
                <div key={u.title} className="flex items-start gap-2.5 bg-[#111] border border-white/6 rounded-2xl p-3.5">
                  <span className="text-lg shrink-0">{u.icon}</span>
                  <div>
                    <p className="text-white text-xs font-black mb-0.5">{u.title}</p>
                    <p className="text-white/35 text-[11px] leading-snug">{u.desc}</p>
                  </div>
                </div>
              ))}
            </div>

            {/* How it works steps */}
            <div className="bg-[#111] border border-white/6 rounded-2xl p-5">
              <p className="text-white/30 text-[10px] font-black uppercase tracking-widest mb-4">Kaise kaam karta hai</p>
              <div className="space-y-4">
                {[
                  { icon: '🔗', title: '"Connect" dabao',       desc: 'bundle.social ka secure portal khulega — koi naya account nahi banana' },
                  { icon: '📲', title: 'Apne accounts choose karo', desc: 'Instagram / TikTok / YouTube par seedha unki site par login karo' },
                  { icon: '✅', title: 'Ho gaya!',              desc: 'Channels select karo jo auto-post karein — clips generate karo, woh khud spread ho jaayenge' },
                ].map((step, i) => (
                  <div key={step.title} className="flex items-start gap-3">
                    <div className="relative">
                      <div className="w-8 h-8 shrink-0 rounded-xl bg-[#D1FE17]/10 border border-[#D1FE17]/20 flex items-center justify-center text-sm">{step.icon}</div>
                      {i < 2 && <div className="absolute top-8 left-1/2 -translate-x-1/2 w-px h-4 bg-[#D1FE17]/20" />}
                    </div>
                    <div className="pt-1">
                      <p className="text-white text-sm font-black">{step.title}</p>
                      <p className="text-white/35 text-xs mt-0.5 leading-relaxed">{step.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {/* ── HAS TEAM → accounts dashboard ── */}
        {!loading && hasTeam && (
          <>
            {accountsQ.isLoading && (
              <div className="flex items-center gap-3 text-white/40 py-6 justify-center">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading accounts…
              </div>
            )}

            {/* Stats row */}
            {!accountsQ.isLoading && accounts.length > 0 && (
              <div className="grid grid-cols-3 gap-2.5 mb-5">
                {[
                  { value: active.length,   label: 'Auto-posting', color: active.length > 0 ? 'text-[#D1FE17]' : 'text-white/40' },
                  { value: accounts.length, label: 'Connected',    color: 'text-white' },
                  { value: inactive.length, label: 'Paused',       color: 'text-white/40' },
                ].map(s => (
                  <div key={s.label} className="bg-[#1a1a1a] border border-white/8 rounded-2xl py-3.5 px-2 text-center">
                    <p className={`text-2xl font-black ${s.color}`}>{s.value}</p>
                    <p className="text-white/30 text-[10px] font-bold mt-0.5">{s.label}</p>
                  </div>
                ))}
              </div>
            )}

            {/* Master auto-post toggle */}
            <div className="mb-5 flex items-center justify-between gap-3 bg-[#1a1a1a] border border-white/8 rounded-2xl px-4 py-4">
              <div>
                <p className="text-sm font-black">Auto-post new clips</p>
                <p className="text-white/40 text-xs mt-0.5">Clips generate hote hi active channels par post ho jaayenge</p>
              </div>
              <button
                onClick={() => prefsMut.mutate(!autoPostEnabled)}
                disabled={prefsMut.isPending}
                title={autoPostEnabled ? 'Click to disable' : 'Click to enable'}
                className={`relative shrink-0 w-11 h-6 rounded-full transition-colors disabled:opacity-50 ${autoPostEnabled ? 'bg-[#D1FE17]' : 'bg-white/15'}`}
              >
                <span className={`absolute top-1 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${autoPostEnabled ? 'translate-x-[26px]' : 'translate-x-1'}`} />
              </button>
            </div>

            {/* Active accounts */}
            {active.length > 0 && (
              <div className="mb-5">
                <p className="text-[10px] font-black text-white/30 uppercase tracking-widest mb-3">Posting to</p>
                <div className="space-y-2">
                  {active.map((acc) => {
                    const p = PLAT[acc.type];
                    const isT = toggleMut.isPending && (toggleMut.variables as { id: string })?.id === acc.id;
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
                          className={`relative shrink-0 w-11 h-6 rounded-full bg-[#D1FE17] ${isT ? 'opacity-50' : ''}`}
                        >
                          <span className="absolute top-1 translate-x-[26px] w-4 h-4 rounded-full bg-white shadow-sm" />
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
                <p className="text-[10px] font-black text-white/30 uppercase tracking-widest mb-3">
                  {active.length > 0 ? 'Also available (paused)' : 'Your accounts — all paused'}
                </p>
                <div className="space-y-2">
                  {inactive.map((acc) => {
                    const p = PLAT[acc.type];
                    const isT = toggleMut.isPending && (toggleMut.variables as { id: string })?.id === acc.id;
                    return (
                      <div key={acc.id} className="flex items-center gap-3 bg-[#111] border border-white/6 rounded-2xl px-4 py-3.5 opacity-55">
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
                          className={`relative shrink-0 w-11 h-6 rounded-full bg-white/15 ${isT ? 'opacity-50' : ''}`}
                        >
                          <span className="absolute top-1 translate-x-1 w-4 h-4 rounded-full bg-white shadow-sm" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* No accounts yet */}
            {!accountsQ.isLoading && accounts.length === 0 && (
              <div className="bg-[#1a1a1a] border border-white/8 rounded-2xl p-8 text-center mb-4">
                <XCircle className="w-8 h-8 text-white/20 mx-auto mb-3" />
                <p className="text-white font-black mb-1">No accounts connected yet</p>
                <p className="text-white/40 text-sm mb-5">Connect Instagram, TikTok, YouTube to start auto-posting</p>
                <button
                  onClick={handleConnect} disabled={connecting}
                  className="inline-flex items-center gap-2 bg-[#D1FE17] text-black text-sm font-black px-6 py-3 rounded-xl hover:bg-[#c5f010] active:scale-95 transition-all disabled:opacity-50"
                >
                  {connecting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Share2 className="w-4 h-4" />}
                  Connect accounts
                </button>
              </div>
            )}

            <p className="text-white/20 text-xs text-center mt-2">
              Clips generate hote hi auto-post · Toggle se koi bhi channel pause karo
            </p>
          </>
        )}
      </main>
    </div>
  );
}

// ── Guest view (not logged in) ────────────────────────────────────────────────
function GuestView() {
  return (
    <div className="min-h-screen bg-[#0d0d0d] text-white font-sans">
      <AppHeader />
      <main className="max-w-xl mx-auto px-4 sm:px-6 py-12">
        <Link href="/" className="inline-flex items-center gap-1.5 text-sm text-white/35 hover:text-white transition-colors mb-8">
          <ArrowLeft className="w-4 h-4" /> Back to AutoCliper
        </Link>

        {/* Hero card */}
        <div className="relative overflow-hidden rounded-3xl border border-white/8 bg-gradient-to-br from-[#141414] to-[#0d0d0d] p-7 mb-5">
          <div className="absolute -top-24 -right-24 w-72 h-72 rounded-full bg-[#D1FE17]/6 blur-3xl pointer-events-none" />
          <div className="absolute -bottom-16 -left-16 w-48 h-48 rounded-full bg-[#D1FE17]/4 blur-3xl pointer-events-none" />
          <div className="relative">
            <span className="inline-flex items-center gap-1.5 bg-[#D1FE17]/10 border border-[#D1FE17]/25 text-[#D1FE17] text-[10px] font-black uppercase tracking-widest px-3 py-1 rounded-full mb-5">
              <Zap className="w-3 h-3" /> Sabhi plans mein free
            </span>
            <h1 className="text-2xl sm:text-3xl font-black leading-tight mb-3">
              Clip karo.<br />
              <span className="text-[#D1FE17]">Har jagah post ho.</span><br />
              Automatic.
            </h1>
            <p className="text-white/45 text-sm leading-relaxed max-w-sm">
              India ka pehla AI video clipper jo automatically aapke clips ko Instagram, TikTok,
              YouTube aur 7 aur platforms par post karta hai — bina kisi extra click ke.
            </p>
          </div>
        </div>

        {/* Platform grid */}
        <div className="grid grid-cols-5 gap-2 mb-5">
          {PLATFORM_PREVIEW.map((key) => {
            const p = PLAT[key];
            return (
              <div key={key} className="flex flex-col items-center gap-1.5 bg-[#111] border border-white/6 rounded-2xl py-3.5 px-1">
                <div className={`w-9 h-9 rounded-xl bg-gradient-to-br ${p.gradient} flex items-center justify-center text-base shadow-lg`}>{p.icon}</div>
                <span className="text-[9px] font-black text-white/40 text-center leading-tight">{p.label}</span>
              </div>
            );
          })}
        </div>

        {/* USPs */}
        <div className="grid grid-cols-2 gap-2.5 mb-6">
          {[
            { icon: '🏆', title: 'India ka pehla',  desc: 'AI clipper + 10 platforms auto-post in one' },
            { icon: '⚡', title: 'Instant posting', desc: 'Clip bante hi — 0 extra clicks' },
            { icon: '📝', title: 'AI captions',     desc: 'Har platform ke liye viral captions' },
            { icon: '🔐', title: '100% private',    desc: 'Password kabhi hamare server par nahi' },
          ].map(u => (
            <div key={u.title} className="flex items-start gap-2.5 bg-[#111] border border-white/6 rounded-2xl p-3.5">
              <span className="text-lg shrink-0">{u.icon}</span>
              <div>
                <p className="text-white text-xs font-black mb-0.5">{u.title}</p>
                <p className="text-white/35 text-[11px] leading-snug">{u.desc}</p>
              </div>
            </div>
          ))}
        </div>

        <Link
          href="/login?next=/social"
          className="w-full flex items-center justify-center gap-2 bg-[#D1FE17] text-black text-sm font-black py-4 rounded-2xl hover:bg-[#c5f010] active:scale-95 transition-all shadow-[0_0_30px_rgba(209,254,23,0.2)]"
        >
          <Zap className="w-4 h-4" /> Log in to connect accounts
        </Link>
        <p className="text-white/20 text-xs text-center mt-3">Sabhi plans ke saath free · Koi extra charge nahi</p>
      </main>
    </div>
  );
}
