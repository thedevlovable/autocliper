/**
 * Social auto-post hub — per-user Buffer OAuth connections.
 * Each user connects their own Buffer account (any platform they have on Buffer).
 * The admin's shared channels are a fallback if the user hasn't connected their own.
 */
import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation } from 'wouter';
import {
  ArrowLeft, CheckCircle2, Loader2, XCircle, Zap,
  RefreshCw, LogOut as Disconnect, AlertCircle,
} from 'lucide-react';
import { apiFetch, useAuth } from '../lib/auth';
import { AppHeader } from '../components/AppHeader';

interface UserChannel { id: string; service: string; name: string; enabled: boolean; }
interface ChannelsData {
  configured: boolean;
  hasOwnBuffer: boolean;
  hasCustomPrefs?: boolean;
  channels: UserChannel[];
}
interface StatusData  { connected: boolean; connectedAt: string | null; adminConfigured: boolean; }

// ── Platform catalogue ────────────────────────────────────────────────────────
const PLATFORMS: Record<string, { label: string; subtitle: string; gradient: string; icon: string }> = {
  instagram: { label: 'Instagram',  subtitle: 'Business, Creator, or Personal', gradient: 'from-[#f09433] via-[#dc2743] to-[#bc1888]', icon: '📸' },
  tiktok:    { label: 'TikTok',     subtitle: 'Profile',                        gradient: 'from-[#010101] to-[#69C9D0]',               icon: '🎵' },
  youtube:   { label: 'YouTube',    subtitle: 'Channel',                        gradient: 'from-[#FF0000] to-[#cc0000]',               icon: '▶️' },
  twitter:   { label: 'X (Twitter)',subtitle: 'Profile',                        gradient: 'from-[#1DA1F2] to-[#0d8fe6]',               icon: '🐦' },
  linkedin:  { label: 'LinkedIn',   subtitle: 'Page or Profile',                gradient: 'from-[#0077B5] to-[#005e8c]',               icon: '💼' },
  facebook:  { label: 'Facebook',   subtitle: 'Page or Group',                  gradient: 'from-[#1877F2] to-[#0c5dcf]',               icon: '👥' },
  threads:   { label: 'Threads',    subtitle: 'Profile',                        gradient: 'from-[#111] to-[#555]',                     icon: '🧵' },
  pinterest: { label: 'Pinterest',  subtitle: 'Profile',                        gradient: 'from-[#E60023] to-[#b8001c]',               icon: '📌' },
  mastodon:  { label: 'Mastodon',   subtitle: 'Profile',                        gradient: 'from-[#6364FF] to-[#4b4cd6]',               icon: '🐘' },
  bluesky:   { label: 'Bluesky',    subtitle: 'Profile',                        gradient: 'from-[#0085ff] to-[#005ecf]',               icon: '🦋' },
};

function PlatformIcon({ service }: { service: string }) {
  const p = PLATFORMS[service];
  return (
    <div className={`w-9 h-9 rounded-xl bg-gradient-to-br ${p?.gradient ?? 'from-white/10 to-white/5'} flex items-center justify-center text-base shrink-0`}>
      {p?.icon ?? '📲'}
    </div>
  );
}

// ── Toast helper ──────────────────────────────────────────────────────────────
function Toast({ kind, msg, onDone }: { kind: 'success' | 'error'; msg: string; onDone: () => void }) {
  useEffect(() => { const t = setTimeout(onDone, 4000); return () => clearTimeout(t); }, [onDone]);
  return (
    <div className={`fixed bottom-6 right-6 z-50 flex items-center gap-2.5 px-4 py-3 rounded-2xl shadow-lg text-sm font-semibold ${kind === 'success' ? 'bg-[#D1FE17] text-black' : 'bg-red-500 text-white'}`}>
      {kind === 'success' ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
      {msg}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function BufferPage() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const [toast, setToast] = useState<{ kind: 'success' | 'error'; msg: string } | null>(null);
  const qc = useQueryClient();

  // Read URL params for post-OAuth feedback
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get('connected') === '1') {
      setToast({ kind: 'success', msg: 'Buffer connected! Your channels are ready.' });
      setLocation('/buffer', { replace: true });
    } else if (p.get('error')) {
      const msgs: Record<string, string> = {
        access_denied: 'Access denied — please try again.',
        invalid_state: 'Link expired — please try again.',
        no_token: 'Could not get token from Buffer — try again.',
        token_exchange_failed: 'Token exchange failed — try again.',
        sync_failed: 'Connected but channel sync failed — try Sync below.',
      };
      setToast({ kind: 'error', msg: msgs[p.get('error')!] ?? 'Connection failed — try again.' });
      setLocation('/buffer', { replace: true });
    }
  }, [setLocation]);

  if (!user) return <GuestView />;

  return <LoggedInView userId={user.id} toast={toast} setToast={setToast} qc={qc} />;
}

// ── Logged-in view ────────────────────────────────────────────────────────────
function LoggedInView({
  toast, setToast, qc,
}: { userId: string; toast: { kind: 'success' | 'error'; msg: string } | null; setToast: (t: any) => void; qc: any }) {
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

  const loading = statusQ.isLoading || channelsQ.isLoading;
  const status = statusQ.data;
  const chanData = channelsQ.data;
  const hasOwnBuffer = status?.connected ?? false;
  const channels = chanData?.channels ?? [];
  const enabled = channels.filter(c => c.enabled);
  const disabled = channels.filter(c => !c.enabled);

  return (
    <div className="min-h-screen bg-[#0d0d0d] text-white font-sans">
      <AppHeader />
      {toast && <Toast kind={toast.kind} msg={toast.msg} onDone={() => setToast(null)} />}

      <main className="max-w-xl mx-auto px-4 sm:px-6 py-10">
        <Link href="/" className="inline-flex items-center gap-1.5 text-sm text-white/35 hover:text-white transition-colors mb-8">
          <ArrowLeft className="w-4 h-4" /> Back to AutoCliper
        </Link>

        <div className="mb-7 flex items-start justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-2xl font-black tracking-tight">Social auto-post</h1>
            <p className="text-white/40 text-sm mt-1">
              {loading ? 'Loading…' : hasOwnBuffer
                ? `${enabled.length} channel${enabled.length !== 1 ? 's' : ''} active — clips post automatically`
                : 'Connect your Buffer account to auto-post clips'}
            </p>
          </div>

          {/* Reconnect / Disconnect buttons when connected */}
          {hasOwnBuffer && !loading && (
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
                onClick={() => { if (confirm('Disconnect your Buffer account?')) disconnectMut.mutate(); }}
                disabled={disconnectMut.isPending}
                className="flex items-center gap-1.5 text-xs text-red-400/70 hover:text-red-400 transition-colors border border-red-400/15 rounded-xl px-3 py-2 font-semibold disabled:opacity-50"
              >
                <Disconnect className="w-3.5 h-3.5" />
                Disconnect
              </button>
            </div>
          )}
        </div>

        {loading && (
          <div className="flex items-center gap-3 text-white/40 py-12 justify-center">
            <Loader2 className="w-5 h-5 animate-spin" /> Loading…
          </div>
        )}

        {!loading && !hasOwnBuffer && (
          <>
            {/* ── Connect Buffer button ── */}
            <a
              href="/api/auth/buffer"
              className="w-full flex items-center justify-center gap-3 bg-white text-black text-sm font-black py-4 rounded-2xl hover:bg-white/90 active:scale-95 transition-all mb-6"
            >
              <span className="text-xl">⚡</span>
              Connect with Buffer
            </a>
            <p className="text-white/25 text-xs text-center mb-8">
              Buffer supports Instagram, TikTok, YouTube, LinkedIn, X, Facebook, Pinterest, Threads, Bluesky & more
            </p>
            {/* Platform preview grid */}
            <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
              {Object.entries(PLATFORMS).slice(0, 10).map(([key, p]) => (
                <div key={key} className="flex flex-col items-center gap-1.5 bg-[#111] border border-white/6 rounded-2xl py-4 px-2 opacity-40">
                  <div className={`w-10 h-10 rounded-xl bg-gradient-to-br ${p.gradient} flex items-center justify-center text-xl`}>
                    {p.icon}
                  </div>
                  <span className="text-[10px] font-black text-white/50 text-center leading-tight">{p.label}</span>
                </div>
              ))}
            </div>
            <p className="text-white/20 text-xs text-center mt-4">
              After connecting Buffer, all your linked accounts appear here automatically.
            </p>
          </>
        )}

        {!loading && hasOwnBuffer && (
          <>
            {/* ── Active channels ── */}
            {enabled.length > 0 && (
              <div className="mb-5">
                <p className="text-[11px] font-black text-white/30 uppercase tracking-widest mb-3">Posting to</p>
                <div className="space-y-2">
                  {enabled.map(ch => {
                    const p = PLATFORMS[ch.service];
                    const isToggling = toggleMut.isPending && (toggleMut.variables as any)?.id === ch.id;
                    return (
                      <div key={ch.id} className="flex items-center gap-3 bg-[#1a1a1a] border border-[#D1FE17]/15 rounded-2xl px-4 py-3.5">
                        <PlatformIcon service={ch.service} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-black">{p?.label ?? ch.service}</p>
                          {ch.name && <p className="text-white/35 text-xs truncate">{ch.name.startsWith('@') ? ch.name : `@${ch.name}`}</p>}
                        </div>
                        <CheckCircle2 className="w-4 h-4 text-[#D1FE17] shrink-0" />
                        <button
                          onClick={() => toggleMut.mutate({ id: ch.id, enabled: false })}
                          disabled={isToggling}
                          className="text-xs text-white/25 hover:text-red-400 transition-colors font-semibold disabled:opacity-50 ml-1"
                        >
                          {isToggling ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Off'}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ── Inactive channels ── */}
            {disabled.length > 0 && (
              <div className="mb-5">
                <p className="text-[11px] font-black text-white/30 uppercase tracking-widest mb-3">
                  {enabled.length > 0 ? 'Also available' : 'Your channels (all paused)'}
                </p>
                <div className="space-y-2">
                  {disabled.map(ch => {
                    const p = PLATFORMS[ch.service];
                    const isToggling = toggleMut.isPending && (toggleMut.variables as any)?.id === ch.id;
                    return (
                      <div key={ch.id} className="flex items-center gap-3 bg-[#111] border border-white/6 rounded-2xl px-4 py-3.5 opacity-50">
                        <PlatformIcon service={ch.service} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-black">{p?.label ?? ch.service}</p>
                          {ch.name && <p className="text-white/35 text-xs truncate">{ch.name.startsWith('@') ? ch.name : `@${ch.name}`}</p>}
                        </div>
                        <button
                          onClick={() => toggleMut.mutate({ id: ch.id, enabled: true })}
                          disabled={isToggling}
                          className="text-xs text-[#D1FE17]/60 hover:text-[#D1FE17] transition-colors font-semibold border border-[#D1FE17]/20 px-2.5 py-1 rounded-lg disabled:opacity-50"
                        >
                          {isToggling ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Turn on'}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {channels.length === 0 && (
              <div className="bg-[#1a1a1a] border border-white/8 rounded-2xl p-6 text-center mb-5">
                <XCircle className="w-8 h-8 text-white/20 mx-auto mb-3" />
                <p className="text-white/40 text-sm">No channels found on your Buffer account.</p>
                <p className="text-white/25 text-xs mt-1">Connect social accounts on Buffer, then click Sync.</p>
              </div>
            )}

            <p className="text-white/20 text-xs text-center">
              Manage channels on{' '}
              <a href="https://publish.buffer.com" target="_blank" rel="noopener noreferrer" className="underline hover:text-white/40 transition-colors">
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
  const { data, isLoading } = useQuery({
    queryKey: ['buffer-status-public'],
    queryFn: () => apiFetch<{ connected: boolean; channels: { service: string; name: string }[] }>('/video/buffer/status'),
    retry: false,
  });
  return (
    <div className="min-h-screen bg-[#0d0d0d] text-white font-sans">
      <AppHeader />
      <main className="max-w-xl mx-auto px-4 sm:px-6 py-12">
        <Link href="/" className="inline-flex items-center gap-1.5 text-sm text-white/35 hover:text-white transition-colors mb-8">
          <ArrowLeft className="w-4 h-4" /> Back
        </Link>
        <h1 className="text-2xl font-black tracking-tight mb-1">Social auto-post</h1>
        <p className="text-white/40 text-sm mb-8">Powered by Buffer</p>

        {isLoading
          ? <div className="flex items-center gap-3 text-white/40 py-8 justify-center"><Loader2 className="w-5 h-5 animate-spin" /> Loading…</div>
          : data?.connected && (
            <div className="bg-[#D1FE17]/5 border border-[#D1FE17]/20 rounded-2xl p-4 flex items-center gap-3 mb-6">
              <CheckCircle2 className="w-5 h-5 text-[#D1FE17] shrink-0" />
              <p className="text-white/60 text-sm">Social auto-post is active. Log in to manage your channels.</p>
            </div>
          )}

        <Link
          href="/login"
          className="w-full flex items-center justify-center gap-2 bg-white text-black text-sm font-black py-4 rounded-2xl hover:bg-white/90 active:scale-95 transition-all"
        >
          <Zap className="w-4 h-4" /> Log in to connect your accounts
        </Link>
      </main>
    </div>
  );
}
