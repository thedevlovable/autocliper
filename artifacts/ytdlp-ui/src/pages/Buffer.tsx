/**
 * Social auto-post hub — admin's Buffer API key, per-user channel selection.
 * Admin adds channels to their Buffer account; each user picks which ones they post to.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import { ArrowLeft, CheckCircle2, Loader2, XCircle, Zap } from 'lucide-react';
import { apiFetch, useAuth } from '../lib/auth';
import { AppHeader } from '../components/AppHeader';

interface UserChannel { id: string; service: string; name: string; enabled: boolean; }
interface ChannelsData {
  configured: boolean;
  hasCustomPrefs?: boolean;
  channels: UserChannel[];
}

// ── Platform metadata ─────────────────────────────────────────────────────────
const PLAT: Record<string, { label: string; subtitle: string; gradient: string; icon: string }> = {
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

function ChannelIcon({ service }: { service: string }) {
  const p = PLAT[service];
  return (
    <div className={`w-9 h-9 rounded-xl bg-gradient-to-br ${p?.gradient ?? 'from-white/10 to-white/5'} flex items-center justify-center text-base shrink-0`}>
      {p?.icon ?? '📲'}
    </div>
  );
}

export default function BufferPage() {
  const { user } = useAuth();
  if (!user) return <GuestView />;
  return <LoggedInView />;
}

// ── Logged-in view ────────────────────────────────────────────────────────────
function LoggedInView() {
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['user-buffer-channels'],
    queryFn: () => apiFetch<ChannelsData>('/user/buffer/channels'),
    refetchInterval: 8000,
  });

  const toggleMut = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      apiFetch(`/user/buffer/channels/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['user-buffer-channels'] }),
  });

  const channels  = data?.channels ?? [];
  const active    = channels.filter(c => c.enabled);
  const inactive  = channels.filter(c => !c.enabled);

  return (
    <div className="min-h-screen bg-[#0d0d0d] text-white font-sans">
      <AppHeader />
      <main className="max-w-xl mx-auto px-4 sm:px-6 py-10">

        <Link href="/" className="inline-flex items-center gap-1.5 text-sm text-white/35 hover:text-white transition-colors mb-8">
          <ArrowLeft className="w-4 h-4" /> Back to AutoCliper
        </Link>

        {/* Header */}
        <div className="mb-7">
          <h1 className="text-2xl font-black tracking-tight">Social auto-post</h1>
          <p className="text-white/40 text-sm mt-1">
            {isLoading ? 'Loading…'
              : !data?.configured ? 'Not connected yet'
              : active.length > 0
                ? `${active.length} channel${active.length !== 1 ? 's' : ''} active — clips post automatically after generation`
                : 'Turn on at least one channel below'}
          </p>
        </div>

        {/* Loading */}
        {isLoading && (
          <div className="flex items-center gap-3 text-white/40 py-12 justify-center">
            <Loader2 className="w-5 h-5 animate-spin" /> Loading channels…
          </div>
        )}

        {/* Not configured */}
        {!isLoading && !data?.configured && (
          <div className="bg-[#1a1a1a] border border-white/10 rounded-2xl p-6 text-center">
            <XCircle className="w-7 h-7 text-white/20 mx-auto mb-3" />
            <p className="text-white/40 text-sm">Social auto-post hasn't been set up yet.</p>
            <p className="text-white/25 text-xs mt-1">Contact the admin to enable this feature.</p>
          </div>
        )}

        {/* Channels */}
        {!isLoading && data?.configured && (
          <>
            {/* ── Active (posting to) ── */}
            {active.length > 0 && (
              <div className="mb-5">
                <p className="text-[11px] font-black text-white/30 uppercase tracking-widest mb-3">Posting to</p>
                <div className="space-y-2">
                  {active.map(ch => {
                    const p = PLAT[ch.service];
                    const isToggling = toggleMut.isPending && (toggleMut.variables as { id: string })?.id === ch.id;
                    return (
                      <div key={ch.id} className="flex items-center gap-3 bg-[#1a1a1a] border border-[#D1FE17]/15 rounded-2xl px-4 py-3.5">
                        <ChannelIcon service={ch.service} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-black">{p?.label ?? ch.service}</p>
                          {ch.name && <p className="text-white/35 text-xs truncate">{ch.name.startsWith('@') ? ch.name : `@${ch.name}`}</p>}
                        </div>
                        <CheckCircle2 className="w-4 h-4 text-[#D1FE17] shrink-0" />
                        {/* Toggle */}
                        <button
                          onClick={() => toggleMut.mutate({ id: ch.id, enabled: false })}
                          disabled={isToggling}
                          title="Turn off"
                          className={`relative shrink-0 w-10 h-5 rounded-full bg-[#D1FE17] ${isToggling ? 'opacity-50' : ''}`}
                        >
                          <span className="absolute top-0.5 translate-x-[22px] w-4 h-4 rounded-full bg-white shadow-sm transition-transform" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ── Inactive (turn on) ── */}
            {inactive.length > 0 && (
              <div className="mb-5">
                <p className="text-[11px] font-black text-white/30 uppercase tracking-widest mb-3">
                  {active.length > 0 ? 'Also available' : 'Available channels'}
                </p>
                <div className="space-y-2">
                  {inactive.map(ch => {
                    const p = PLAT[ch.service];
                    const isToggling = toggleMut.isPending && (toggleMut.variables as { id: string })?.id === ch.id;
                    return (
                      <div key={ch.id} className="flex items-center gap-3 bg-[#111] border border-white/6 rounded-2xl px-4 py-3.5 opacity-50">
                        <ChannelIcon service={ch.service} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-black">{p?.label ?? ch.service}</p>
                          {ch.name && <p className="text-white/35 text-xs truncate">{ch.name.startsWith('@') ? ch.name : `@${ch.name}`}</p>}
                        </div>
                        {/* Toggle */}
                        <button
                          onClick={() => toggleMut.mutate({ id: ch.id, enabled: true })}
                          disabled={isToggling}
                          title="Turn on"
                          className={`relative shrink-0 w-10 h-5 rounded-full bg-white/15 ${isToggling ? 'opacity-50' : ''}`}
                        >
                          <span className="absolute top-0.5 translate-x-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Empty state */}
            {channels.length === 0 && (
              <div className="bg-[#1a1a1a] border border-white/8 rounded-2xl p-6 text-center">
                <p className="text-white/40 text-sm">No channels available yet.</p>
                <p className="text-white/25 text-xs mt-1">Admin needs to sync channels from Buffer.</p>
              </div>
            )}

            {/* Footer */}
            {!data?.hasCustomPrefs && channels.length > 0 && (
              <p className="text-white/20 text-xs text-center mt-4">
                All channels are on by default. Turn off any you don't want.
              </p>
            )}
          </>
        )}

        {/* How it works */}
        {!isLoading && data?.configured && (
          <div className="mt-8 bg-[#111] border border-white/6 rounded-2xl p-5">
            <p className="text-white/40 text-xs font-black uppercase tracking-widest mb-3">How it works</p>
            <div className="space-y-2.5">
              {[
                ['📹', 'You generate clips from any video on AutoCliper'],
                ['✂️', 'Clips are cut, captioned, and saved to your account'],
                ['📤', 'Each clip is automatically posted to your active channels'],
              ].map(([icon, text]) => (
                <div key={text} className="flex items-start gap-2.5">
                  <span className="text-sm mt-0.5">{icon}</span>
                  <p className="text-white/40 text-sm">{text}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mt-5 text-center">
          <Link href="/" className="inline-flex items-center gap-2 bg-[#D1FE17] text-black text-sm font-black px-6 py-3 rounded-2xl hover:bg-[#D1FE17]/90 active:scale-95 transition-all">
            <Zap className="w-4 h-4" /> Generate clips now
          </Link>
        </div>
      </main>
    </div>
  );
}

// ── Guest view ────────────────────────────────────────────────────────────────
function GuestView() {
  const { data, isLoading } = useQuery({
    queryKey: ['buffer-status-public'],
    queryFn: () => apiFetch<{ connected: boolean; channels: { service: string; name: string }[] }>('/video/buffer/status'),
    retry: false,
  });
  const channels = data?.channels ?? [];

  return (
    <div className="min-h-screen bg-[#0d0d0d] text-white font-sans">
      <AppHeader />
      <main className="max-w-xl mx-auto px-4 sm:px-6 py-12">
        <Link href="/" className="inline-flex items-center gap-1.5 text-sm text-white/35 hover:text-white transition-colors mb-8">
          <ArrowLeft className="w-4 h-4" /> Back to AutoCliper
        </Link>
        <h1 className="text-2xl font-black tracking-tight mb-1">Social auto-post</h1>
        <p className="text-white/40 text-sm mb-8">Powered by Buffer</p>

        {isLoading
          ? <div className="flex items-center gap-3 text-white/40 py-8 justify-center"><Loader2 className="w-5 h-5 animate-spin" /></div>
          : data?.connected && (
            <>
              <div className="bg-[#D1FE17]/5 border border-[#D1FE17]/20 rounded-2xl p-4 flex items-center gap-3 mb-4">
                <CheckCircle2 className="w-5 h-5 text-[#D1FE17] shrink-0" />
                <p className="text-white/60 text-sm">Connected — clips post automatically to your active channels.</p>
              </div>
              <div className="space-y-2 mb-6">
                {channels.map((ch, i) => {
                  const p = PLAT[ch.service];
                  return (
                    <div key={i} className="flex items-center gap-3 bg-[#1a1a1a] border border-white/8 rounded-2xl px-4 py-3">
                      <div className={`w-8 h-8 rounded-xl bg-gradient-to-br ${p?.gradient ?? 'from-white/10 to-white/5'} flex items-center justify-center text-sm shrink-0`}>{p?.icon ?? '📲'}</div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-black">{p?.label ?? ch.service}</p>
                        {ch.name && <p className="text-white/35 text-xs truncate">@{ch.name}</p>}
                      </div>
                      <span className="text-[10px] font-black uppercase tracking-wide text-white/25 bg-white/5 px-2 py-0.5 rounded-full border border-white/8">Auto</span>
                    </div>
                  );
                })}
              </div>
            </>
          )
        }

        <Link href="/login" className="w-full flex items-center justify-center gap-2 bg-white text-black text-sm font-black py-4 rounded-2xl hover:bg-white/90 active:scale-95 transition-all">
          <Zap className="w-4 h-4" /> Log in to choose your channels
        </Link>
      </main>
    </div>
  );
}
