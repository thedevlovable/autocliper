/**
 * Social auto-post hub — per-user Buffer OAuth.
 * Each user connects their OWN Buffer account (Instagram, TikTok, YouTube etc.).
 * No admin involvement needed — users are fully independent.
 */
import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation } from 'wouter';
import {
  ArrowLeft, CheckCircle2, Loader2, XCircle, Zap, RefreshCw,
  LogOut as Disconnect, AlertCircle,
} from 'lucide-react';
import { apiFetch, useAuth } from '../lib/auth';
import { AppHeader } from '../components/AppHeader';

interface UserChannel { id: string; service: string; name: string; enabled: boolean; }
interface ChannelsData { configured: boolean; hasOwnBuffer: boolean; hasCustomPrefs?: boolean; channels: UserChannel[]; }
interface StatusData   { connected: boolean; connectedAt: string | null; }

// ── Platform catalogue ────────────────────────────────────────────────────────
const PLAT: Record<string, { label: string; subtitle: string; gradient: string; icon: string }> = {
  instagram: { label: 'Instagram',   subtitle: 'Business, Creator, or Personal', gradient: 'from-[#f09433] via-[#dc2743] to-[#bc1888]', icon: '📸' },
  tiktok:    { label: 'TikTok',      subtitle: 'Profile',                        gradient: 'from-[#010101] to-[#69C9D0]',               icon: '🎵' },
  youtube:   { label: 'YouTube',     subtitle: 'Channel',                        gradient: 'from-[#FF0000] to-[#cc0000]',               icon: '▶️' },
  twitter:   { label: 'X (Twitter)', subtitle: 'Profile',                        gradient: 'from-[#1DA1F2] to-[#0d8fe6]',               icon: '🐦' },
  linkedin:  { label: 'LinkedIn',    subtitle: 'Page or Profile',                gradient: 'from-[#0077B5] to-[#005e8c]',               icon: '💼' },
  facebook:  { label: 'Facebook',    subtitle: 'Page or Group',                  gradient: 'from-[#1877F2] to-[#0c5dcf]',               icon: '👥' },
  threads:   { label: 'Threads',     subtitle: 'Profile',                        gradient: 'from-[#111] to-[#555]',                     icon: '🧵' },
  pinterest: { label: 'Pinterest',   subtitle: 'Profile',                        gradient: 'from-[#E60023] to-[#b8001c]',               icon: '📌' },
  mastodon:  { label: 'Mastodon',    subtitle: 'Profile',                        gradient: 'from-[#6364FF] to-[#4b4cd6]',               icon: '🐘' },
  bluesky:   { label: 'Bluesky',     subtitle: 'Profile',                        gradient: 'from-[#0085ff] to-[#005ecf]',               icon: '🦋' },
};

const PLATFORM_PREVIEW = ['instagram','tiktok','youtube','twitter','linkedin','facebook','threads','pinterest','mastodon','bluesky'];

function ChanIcon({ service, size = 'sm' }: { service: string; size?: 'sm' | 'md' }) {
  const p = PLAT[service];
  const cls = size === 'md' ? 'w-12 h-12 text-xl' : 'w-9 h-9 text-base';
  return (
    <div className={`${cls} rounded-xl bg-gradient-to-br ${p?.gradient ?? 'from-white/10 to-white/5'} flex items-center justify-center shrink-0`}>
      {p?.icon ?? '📲'}
    </div>
  );
}

function Toast({ kind, msg, onDone }: { kind: 'success'|'error'; msg: string; onDone: () => void }) {
  useEffect(() => { const t = setTimeout(onDone, 4500); return () => clearTimeout(t); }, [onDone]);
  return (
    <div className={`fixed bottom-6 right-6 z-50 flex items-center gap-2.5 px-4 py-3 rounded-2xl shadow-xl text-sm font-bold ${kind === 'success' ? 'bg-[#D1FE17] text-black' : 'bg-red-500 text-white'}`}>
      {kind === 'success' ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
      {msg}
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────
export default function BufferPage() {
  const { user } = useAuth();
  if (!user) return <GuestView />;
  return <LoggedInView />;
}

// ── Logged-in view ────────────────────────────────────────────────────────────
function LoggedInView() {
  const qc = useQueryClient();
  const [, setLocation] = useLocation();
  const [toast, setToast] = useState<{ kind: 'success'|'error'; msg: string }|null>(null);

  // Handle post-OAuth redirect params
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get('connected') === '1') {
      setToast({ kind: 'success', msg: 'Buffer connected! Your channels are ready.' });
      setLocation('/buffer', { replace: true });
    } else if (p.get('error')) {
      const msgs: Record<string,string> = {
        access_denied:        'Access denied — please try again.',
        invalid_state:        'Link expired — please try again.',
        no_token:             'Could not get token from Buffer — try again.',
        token_exchange_failed:'Token exchange failed — try again.',
        sync_failed:          'Connected but channel sync failed — click Sync below.',
      };
      setToast({ kind: 'error', msg: msgs[p.get('error')!] ?? 'Connection failed — please try again.' });
      setLocation('/buffer', { replace: true });
    }
  }, [setLocation]);

  const statusQ = useQuery({
    queryKey: ['user-buffer-status'],
    queryFn: () => apiFetch<StatusData>('/user/buffer/status'),
    refetchInterval: 10000,
  });
  const channelsQ = useQuery({
    queryKey: ['user-buffer-channels'],
    queryFn: () => apiFetch<ChannelsData>('/user/buffer/channels'),
    refetchInterval: 10000,
  });

  const disconnectMut = useMutation({
    mutationFn: () => apiFetch('/auth/buffer', { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['user-buffer-status'] });
      qc.invalidateQueries({ queryKey: ['user-buffer-channels'] });
      setToast({ kind: 'success', msg: 'Buffer disconnected.' });
    },
  });
  const syncMut = useMutation({
    mutationFn: () => apiFetch('/auth/buffer/sync', { method: 'POST' }),
    onSuccess: (d: any) => {
      qc.invalidateQueries({ queryKey: ['user-buffer-channels'] });
      setToast({ kind: 'success', msg: `Synced ${d.channelCount ?? 0} channel${d.channelCount !== 1 ? 's' : ''}.` });
    },
  });
  const toggleMut = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      apiFetch(`/user/buffer/channels/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['user-buffer-channels'] }),
  });

  const loading      = statusQ.isLoading || channelsQ.isLoading;
  const connected    = statusQ.data?.connected ?? false;
  const channels     = channelsQ.data?.channels ?? [];
  const active       = channels.filter(c => c.enabled);
  const inactive     = channels.filter(c => !c.enabled);

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
              {loading ? 'Loading…'
                : connected
                  ? active.length > 0
                    ? `${active.length} channel${active.length !== 1 ? 's' : ''} active — clips post automatically`
                    : 'Turn on at least one channel below'
                  : 'Connect your Buffer account to start auto-posting'}
            </p>
          </div>

          {connected && !loading && (
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => syncMut.mutate()}
                disabled={syncMut.isPending}
                title="Re-sync channels from Buffer"
                className="flex items-center gap-1.5 text-xs text-white/40 hover:text-white/70 transition-colors border border-white/10 rounded-xl px-3 py-2 font-semibold disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${syncMut.isPending ? 'animate-spin' : ''}`} />
                Sync
              </button>
              <button
                onClick={() => { if (window.confirm('Disconnect your Buffer account?')) disconnectMut.mutate(); }}
                disabled={disconnectMut.isPending}
                className="flex items-center gap-1.5 text-xs text-red-400/60 hover:text-red-400 transition-colors border border-red-400/15 rounded-xl px-3 py-2 font-semibold disabled:opacity-50"
              >
                <Disconnect className="w-3.5 h-3.5" />
                Disconnect
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

        {/* ── NOT connected → connect prompt ── */}
        {!loading && !connected && (
          <>
            {/* Big connect button */}
            <a
              href="/api/auth/buffer"
              className="w-full flex items-center justify-center gap-3 bg-white text-black text-sm font-black py-4 rounded-2xl hover:bg-white/90 active:scale-95 transition-all mb-4"
            >
              <span className="text-xl">⚡</span>
              Connect with Buffer
            </a>
            <p className="text-white/25 text-xs text-center mb-8">
              Buffer supports Instagram, TikTok, YouTube, X, LinkedIn, Facebook, Pinterest, Threads & more
            </p>

            {/* Platform preview grid */}
            <div className="grid grid-cols-5 gap-2">
              {PLATFORM_PREVIEW.map(key => {
                const p = PLAT[key];
                return (
                  <div key={key} className="flex flex-col items-center gap-1.5 bg-[#111] border border-white/6 rounded-2xl py-3 px-1 opacity-40">
                    <div className={`w-9 h-9 rounded-xl bg-gradient-to-br ${p.gradient} flex items-center justify-center text-base`}>{p.icon}</div>
                    <span className="text-[9px] font-black text-white/50 text-center leading-tight">{p.label}</span>
                  </div>
                );
              })}
            </div>

            <div className="mt-6 bg-[#111] border border-white/6 rounded-2xl p-5">
              <p className="text-white/40 text-xs font-black uppercase tracking-widest mb-3">How it works</p>
              <div className="space-y-2.5">
                {[
                  ['1️⃣', 'Click "Connect with Buffer" → log into your Buffer account'],
                  ['2️⃣', 'Buffer shows your connected social accounts (Instagram, TikTok etc.)'],
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

            <p className="text-white/20 text-xs text-center mt-4">
              Don't have Buffer?{' '}
              <a href="https://buffer.com" target="_blank" rel="noopener noreferrer" className="underline hover:text-white/40">
                Create a free account
              </a>
            </p>
          </>
        )}

        {/* ── CONNECTED → channel list ── */}
        {!loading && connected && (
          <>
            {/* Active channels */}
            {active.length > 0 && (
              <div className="mb-5">
                <p className="text-[11px] font-black text-white/30 uppercase tracking-widest mb-3">Posting to</p>
                <div className="space-y-2">
                  {active.map(ch => {
                    const p = PLAT[ch.service];
                    const isT = toggleMut.isPending && (toggleMut.variables as any)?.id === ch.id;
                    return (
                      <div key={ch.id} className="flex items-center gap-3 bg-[#1a1a1a] border border-[#D1FE17]/15 rounded-2xl px-4 py-3.5">
                        <ChanIcon service={ch.service} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-black">{p?.label ?? ch.service}</p>
                          {ch.name && <p className="text-white/35 text-xs truncate">{ch.name.startsWith('@') ? ch.name : `@${ch.name}`}</p>}
                        </div>
                        <CheckCircle2 className="w-4 h-4 text-[#D1FE17] shrink-0" />
                        <button
                          onClick={() => toggleMut.mutate({ id: ch.id, enabled: false })}
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

            {/* Inactive channels */}
            {inactive.length > 0 && (
              <div className="mb-5">
                <p className="text-[11px] font-black text-white/30 uppercase tracking-widest mb-3">
                  {active.length > 0 ? 'Also available' : 'Your channels (all paused)'}
                </p>
                <div className="space-y-2">
                  {inactive.map(ch => {
                    const p = PLAT[ch.service];
                    const isT = toggleMut.isPending && (toggleMut.variables as any)?.id === ch.id;
                    return (
                      <div key={ch.id} className="flex items-center gap-3 bg-[#111] border border-white/6 rounded-2xl px-4 py-3.5 opacity-50">
                        <ChanIcon service={ch.service} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-black">{p?.label ?? ch.service}</p>
                          {ch.name && <p className="text-white/35 text-xs truncate">{ch.name.startsWith('@') ? ch.name : `@${ch.name}`}</p>}
                        </div>
                        <button
                          onClick={() => toggleMut.mutate({ id: ch.id, enabled: true })}
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

            {/* No channels at all */}
            {channels.length === 0 && (
              <div className="bg-[#1a1a1a] border border-white/8 rounded-2xl p-6 text-center mb-5">
                <XCircle className="w-7 h-7 text-white/20 mx-auto mb-3" />
                <p className="text-white/40 text-sm">No channels found on your Buffer account.</p>
                <p className="text-white/25 text-xs mt-1">
                  Go to{' '}
                  <a href="https://publish.buffer.com/channels/connect" target="_blank" rel="noopener noreferrer" className="underline">
                    Buffer → Channels
                  </a>
                  {' '}and connect your social accounts, then click Sync.
                </p>
              </div>
            )}

            <p className="text-white/20 text-xs text-center">
              Add channels at{' '}
              <a href="https://publish.buffer.com/channels/connect" target="_blank" rel="noopener noreferrer" className="underline hover:text-white/35">
                publish.buffer.com
              </a>
              {' '}· then click Sync to refresh
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
        <h1 className="text-2xl font-black tracking-tight mb-1">Social auto-post</h1>
        <p className="text-white/40 text-sm mb-8">Connect your Buffer account — clips auto-post to your channels</p>

        <div className="grid grid-cols-5 gap-2 mb-8 opacity-40">
          {PLATFORM_PREVIEW.map(key => {
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
