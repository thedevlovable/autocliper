/**
 * Social auto-post hub — powered by bundle.social.
 *
 * Flow:
 * 1. User clicks "Connect accounts"
 * 2. We create their bundle.social team (first time) + get a hosted portal link
 * 3. bundle.social handles all OAuth — user picks their accounts
 * 4. Back here → accounts show up; user toggles which ones receive clips
 */

import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation } from 'wouter';
import {
  ArrowLeft, CalendarClock, CheckCircle2, Loader2, XCircle, Zap, AlertCircle,
  LogOut as Disconnect, Plus, Share2,
  Trophy, Lock, PenLine, Link2, Smartphone, ShieldCheck,
} from 'lucide-react';
import { apiFetch, useAuth } from '../lib/auth';
import { AppHeader } from '../components/AppHeader';
import {
  PlatformIcon, ALL_PLATFORM_KEYS, PLATFORM_META,
} from '../components/PlatformIcons';

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

// ── Toast ─────────────────────────────────────────────────────────────────────
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
      const prev = qc.getQueryData<PrefsData>(['social-prefs']);
      qc.setQueryData(['social-prefs'], { autoPostEnabled });
      return { prev };
    },
    onSuccess: (_d, autoPostEnabled) => {
      setToast({
        kind: 'success',
        msg: autoPostEnabled
          ? 'Auto-post is ON — new clips will be posted automatically.'
          : 'Auto-post is OFF — clips only post when you tap Post.',
      });
    },
    onError: (err, _v, ctx) => {
      if (ctx?.prev !== undefined) qc.setQueryData(['social-prefs'], ctx.prev);
      setToast({ kind: 'error', msg: err instanceof Error ? err.message : 'Could not save — try again.' });
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not create connect link — try again.';
      setToast({ kind: 'error', msg });
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
                  The only AI clipper<br />
                  that posts everywhere<br />
                  <span className="text-[#D1FE17]">automatically.</span>
                </h2>
                <p className="text-white/45 text-sm leading-relaxed max-w-sm">
                  Connect once — every clip you generate auto-posts to Instagram, TikTok,
                  YouTube and 7 more platforms simultaneously. No manual uploads, no switching apps, no extra clicks.
                </p>
              </div>
            </div>

            {/* Platform grid — real brand icons */}
            <div className="grid grid-cols-5 gap-2 mb-5">
              {ALL_PLATFORM_KEYS.map((key) => (
                <button
                  key={key} onClick={handleConnect} disabled={connecting}
                  className="group flex flex-col items-center gap-1.5 bg-[#111] border border-white/6 rounded-2xl py-3.5 px-1 hover:border-[#D1FE17]/30 hover:bg-[#1a1a1a] hover:-translate-y-1 transition-all active:scale-95 disabled:cursor-wait"
                >
                  <PlatformIcon type={key} size={36} />
                  <span className="text-[9px] font-black text-white/40 group-hover:text-white/60 text-center leading-tight transition-colors">
                    {PLATFORM_META[key]?.label ?? key}
                  </span>
                </button>
              ))}
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
              {([
                { icon: <Trophy className="w-4 h-4" />,     title: "India's first",   desc: 'The only AI clipper with built-in 10-platform social auto-post' },
                { icon: <Zap className="w-4 h-4" />,        title: 'Instant posting', desc: 'Your clip goes live the moment it is generated — 0 extra steps' },
                { icon: <PenLine className="w-4 h-4" />,    title: 'AI captions',     desc: 'Platform-specific viral captions written automatically per clip' },
                { icon: <ShieldCheck className="w-4 h-4" />, title: '100% private',   desc: 'Your passwords never touch our servers — OAuth only' },
              ]).map(u => (
                <div key={u.title} className="flex items-start gap-2.5 bg-[#111] border border-white/6 rounded-2xl p-3.5">
                  <div className="w-7 h-7 rounded-xl bg-[#D1FE17]/10 border border-[#D1FE17]/15 flex items-center justify-center shrink-0 text-[#D1FE17]">
                    {u.icon}
                  </div>
                  <div>
                    <p className="text-white text-xs font-black mb-0.5">{u.title}</p>
                    <p className="text-white/35 text-[11px] leading-snug">{u.desc}</p>
                  </div>
                </div>
              ))}
            </div>

            {/* How it works */}
            <div className="bg-[#111] border border-white/6 rounded-2xl p-5">
              <p className="text-white/30 text-[10px] font-black uppercase tracking-widest mb-4">How it works</p>
              <div className="space-y-4">
                {([
                  { icon: <Link2 className="w-4 h-4" />,       title: 'Click "Connect"',    desc: "Opens bundle.social's secure portal — no new account needed from you." },
                  { icon: <Smartphone className="w-4 h-4" />,  title: 'Pick your accounts', desc: 'Log into your platforms directly on their own site — Instagram, TikTok, YouTube, etc.' },
                  { icon: <CheckCircle2 className="w-4 h-4" />, title: "You're live!",       desc: 'Choose which channels auto-post, then generate a clip and watch it spread automatically.' },
                ]).map((step, i) => (
                  <div key={step.title} className="flex items-start gap-3">
                    <div className="relative shrink-0">
                      <div className="w-8 h-8 rounded-xl bg-[#D1FE17]/10 border border-[#D1FE17]/20 flex items-center justify-center text-[#D1FE17]">{step.icon}</div>
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
                <p className="text-white/40 text-xs mt-0.5">Post to active channels right when each clip is generated</p>
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

            {/* Bulk scheduler */}
            <Link
              href="/schedule"
              className="flex items-center gap-3 bg-[#1a1a1a] border border-white/10 hover:border-[#D1FE17]/40 rounded-2xl px-4 py-3.5 mb-5 transition-colors group"
            >
              <div className="w-10 h-10 rounded-xl bg-[#D1FE17]/10 flex items-center justify-center shrink-0">
                <CalendarClock className="w-5 h-5 text-[#D1FE17]" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-black">Bulk scheduler</p>
                <p className="text-white/40 text-xs mt-0.5">Schedule videos straight from Google Drive / Dropbox — they post themselves daily</p>
              </div>
              <span className="text-white/30 group-hover:text-[#D1FE17] text-lg shrink-0">→</span>
            </Link>

            {/* Active accounts */}
            {active.length > 0 && (
              <div className="mb-5">
                <p className="text-[10px] font-black text-white/30 uppercase tracking-widest mb-3">Posting to</p>
                <div className="space-y-2">
                  {active.map((acc) => {
                    const meta = PLATFORM_META[acc.type];
                    const isT  = toggleMut.isPending && (toggleMut.variables as { id: string })?.id === acc.id;
                    return (
                      <div key={acc.id} className="flex items-center gap-3 bg-[#1a1a1a] border border-[#D1FE17]/15 rounded-2xl px-4 py-3.5">
                        <PlatformIcon type={acc.type} size={40} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-black">{meta?.label ?? acc.type}</p>
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
                    const meta = PLATFORM_META[acc.type];
                    const isT  = toggleMut.isPending && (toggleMut.variables as { id: string })?.id === acc.id;
                    return (
                      <div key={acc.id} className="flex items-center gap-3 bg-[#111] border border-white/6 rounded-2xl px-4 py-3.5 opacity-55">
                        <PlatformIcon type={acc.type} size={40} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-black">{meta?.label ?? acc.type}</p>
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
              Clips auto-post after generation · Toggle any channel to pause it
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

        {/* Hero card */}
        <div className="relative overflow-hidden rounded-3xl border border-white/8 bg-gradient-to-br from-[#141414] to-[#0d0d0d] p-7 mb-5">
          <div className="absolute -top-24 -right-24 w-72 h-72 rounded-full bg-[#D1FE17]/6 blur-3xl pointer-events-none" />
          <div className="absolute -bottom-16 -left-16 w-48 h-48 rounded-full bg-[#D1FE17]/4 blur-3xl pointer-events-none" />
          <div className="relative">
            <span className="inline-flex items-center gap-1.5 bg-[#D1FE17]/10 border border-[#D1FE17]/25 text-[#D1FE17] text-[10px] font-black uppercase tracking-widest px-3 py-1 rounded-full mb-5">
              <Zap className="w-3 h-3" /> Free with all plans
            </span>
            <h1 className="text-2xl sm:text-3xl font-black leading-tight mb-3">
              The only AI clipper<br />
              that posts everywhere<br />
              <span className="text-[#D1FE17]">automatically.</span>
            </h1>
            <p className="text-white/45 text-sm leading-relaxed max-w-sm">
              India's first AI video clipper with built-in social auto-post. Connect once —
              your clips go live on Instagram, TikTok, YouTube and 7 more platforms the
              moment they're generated. Zero manual uploads.
            </p>
          </div>
        </div>

        {/* Platform grid — real brand icons */}
        <div className="grid grid-cols-5 gap-2 mb-5">
          {ALL_PLATFORM_KEYS.map((key) => (
            <div key={key} className="flex flex-col items-center gap-1.5 bg-[#111] border border-white/6 rounded-2xl py-3.5 px-1">
              <PlatformIcon type={key} size={36} />
              <span className="text-[9px] font-black text-white/40 text-center leading-tight">
                {PLATFORM_META[key]?.label ?? key}
              </span>
            </div>
          ))}
        </div>

        {/* USPs */}
        <div className="grid grid-cols-2 gap-2.5 mb-6">
          {([
            { icon: <Trophy className="w-4 h-4" />,      title: "India's first",    desc: 'AI clipper + 10-platform auto-post in one tool' },
            { icon: <Zap className="w-4 h-4" />,         title: 'Zero extra clicks', desc: 'Posts automatically when your clip is ready' },
            { icon: <PenLine className="w-4 h-4" />,     title: 'AI captions',      desc: 'Viral captions written per platform, per clip' },
            { icon: <ShieldCheck className="w-4 h-4" />, title: '100% private',     desc: 'Passwords never stored — OAuth only' },
          ]).map(u => (
            <div key={u.title} className="flex items-start gap-2.5 bg-[#111] border border-white/6 rounded-2xl p-3.5">
              <div className="w-7 h-7 rounded-xl bg-[#D1FE17]/10 border border-[#D1FE17]/15 flex items-center justify-center shrink-0 text-[#D1FE17]">
                {u.icon}
              </div>
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
          <Zap className="w-4 h-4" /> Log in to connect your accounts
        </Link>
        <p className="text-white/20 text-xs text-center mt-3">Free with all plans · No extra charge</p>
      </main>
    </div>
  );
}
