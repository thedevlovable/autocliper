/**
 * Social auto-post hub — per-user channel connections.
 * Uses the admin's Buffer API key; each user picks which channels to post to.
 * Requires login to manage connections; public visitors see a read-only status.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import { ArrowLeft, CheckCircle2, Loader2, XCircle, Zap } from 'lucide-react';
import { apiFetch, useAuth } from '../lib/auth';
import { AppHeader } from '../components/AppHeader';

interface UserChannel { id: string; service: string; name: string; enabled: boolean; }
interface StatusData  { connected: boolean; channels: { service: string; name: string }[]; }

// ── Platform catalogue ────────────────────────────────────────────────────────
const PLATFORMS: { key: string; label: string; subtitle: string; gradient: string; icon: string }[] = [
  { key: 'instagram', label: 'Instagram',   subtitle: 'Business, Creator, or Personal', gradient: 'from-[#f09433] via-[#e6683c] via-[#dc2743] via-[#cc2366] to-[#bc1888]', icon: '📸' },
  { key: 'tiktok',    label: 'TikTok',       subtitle: 'Profile',                        gradient: 'from-[#010101] to-[#69C9D0]',                                              icon: '🎵' },
  { key: 'youtube',   label: 'YouTube',      subtitle: 'Channel',                        gradient: 'from-[#FF0000] to-[#cc0000]',                                              icon: '▶️' },
  { key: 'twitter',   label: 'Twitter / X',  subtitle: 'Profile',                        gradient: 'from-[#1DA1F2] to-[#0d8fe6]',                                              icon: '🐦' },
  { key: 'linkedin',  label: 'LinkedIn',     subtitle: 'Page or Profile',                gradient: 'from-[#0077B5] to-[#005e8c]',                                              icon: '💼' },
  { key: 'facebook',  label: 'Facebook',     subtitle: 'Page or Group',                  gradient: 'from-[#1877F2] to-[#0c5dcf]',                                              icon: '👥' },
  { key: 'threads',   label: 'Threads',      subtitle: 'Profile',                        gradient: 'from-[#111] to-[#333]',                                                    icon: '🧵' },
  { key: 'pinterest', label: 'Pinterest',    subtitle: 'Profile',                        gradient: 'from-[#E60023] to-[#b8001c]',                                              icon: '📌' },
];

export default function BufferPage() {
  const { user } = useAuth();
  const qc = useQueryClient();

  // For logged-in users: their personal channel selection
  const userQuery = useQuery({
    queryKey: ['user-buffer-channels'],
    queryFn: () => apiFetch<{ configured: boolean; channels: UserChannel[]; hasCustomPrefs: boolean }>('/user/buffer/channels'),
    enabled: !!user,
    refetchInterval: 8000, // real-time polling every 8s
    retry: false,
  });

  // For guests: public status
  const publicQuery = useQuery({
    queryKey: ['buffer-status-public'],
    queryFn: () => apiFetch<StatusData>('/video/buffer/status'),
    enabled: !user,
    retry: false,
  });

  const toggleMut = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      apiFetch(`/user/buffer/channels/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['user-buffer-channels'] }),
  });

  const configured  = user ? (userQuery.data?.configured ?? false) : (publicQuery.data?.connected ?? false);
  const allChannels = userQuery.data?.channels ?? [];
  const connectedChannels = allChannels.filter(c => c.enabled);

  // Build a map from service → channel for quick lookup
  const channelByService = new Map(allChannels.map(c => [c.service, c]));

  if (!user) return <GuestView />;

  return (
    <div className="min-h-screen bg-[#0d0d0d] text-white font-sans">
      <AppHeader />
      <main className="max-w-2xl mx-auto px-4 sm:px-6 py-10">

        {/* Back */}
        <Link href="/" className="inline-flex items-center gap-1.5 text-sm text-white/35 hover:text-white transition-colors mb-8">
          <ArrowLeft className="w-4 h-4" /> Back to AutoCliper
        </Link>

        {/* Header */}
        <div className="mb-6">
          <h1 className="text-2xl font-black tracking-tight">Social auto-post</h1>
          <p className="text-white/40 text-sm mt-1">
            {configured
              ? `${connectedChannels.length} account${connectedChannels.length !== 1 ? 's' : ''} connected — clips post automatically after generation`
              : 'Connect your social accounts to auto-post clips'}
          </p>
        </div>

        {/* Loading state */}
        {userQuery.isLoading && (
          <div className="flex items-center gap-3 text-white/40 py-12 justify-center">
            <Loader2 className="w-5 h-5 animate-spin" /> Loading your accounts…
          </div>
        )}

        {/* Not configured by admin */}
        {!userQuery.isLoading && !configured && (
          <div className="bg-[#1a1a1a] border border-white/10 rounded-2xl p-6 text-center">
            <XCircle className="w-8 h-8 text-white/20 mx-auto mb-3" />
            <p className="text-white/50 text-sm">Social auto-post is not active yet.</p>
          </div>
        )}

        {/* Platform grid */}
        {!userQuery.isLoading && configured && (
          <>
            {/* Connected accounts */}
            {connectedChannels.length > 0 && (
              <div className="mb-6">
                <p className="text-[11px] font-black text-white/30 uppercase tracking-widest mb-3">Your connected accounts</p>
                <div className="space-y-2">
                  {connectedChannels.map(ch => {
                    const p = PLATFORMS.find(pl => pl.key === ch.service);
                    const isToggling = toggleMut.isPending && (toggleMut.variables as { id: string })?.id === ch.id;
                    return (
                      <div key={ch.id} className="flex items-center gap-3 bg-[#1a1a1a] border border-[#D1FE17]/15 rounded-2xl px-4 py-3.5">
                        <div className={`w-9 h-9 rounded-xl bg-gradient-to-br ${p?.gradient ?? 'from-white/10 to-white/5'} flex items-center justify-center text-lg shrink-0`}>
                          {p?.icon ?? '📲'}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-black">{p?.label ?? ch.service}</p>
                          <p className="text-white/35 text-xs truncate">@{ch.name}</p>
                        </div>
                        <div className="flex items-center gap-2.5">
                          <CheckCircle2 className="w-4 h-4 text-[#D1FE17] shrink-0" />
                          <button
                            onClick={() => toggleMut.mutate({ id: ch.id, enabled: false })}
                            disabled={isToggling}
                            className="text-xs text-white/30 hover:text-red-400 transition-colors font-semibold disabled:opacity-50"
                          >
                            {isToggling ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Disconnect'}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* "Connect a new account" grid */}
            <p className="text-[11px] font-black text-white/30 uppercase tracking-widest mb-3">
              {connectedChannels.length > 0 ? 'Connect more' : 'Connect an account'}
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {PLATFORMS.map(p => {
                const ch = channelByService.get(p.key);
                const isConnected = ch?.enabled ?? false;
                const isAvailable = !!ch;
                const isToggling = toggleMut.isPending && ch && (toggleMut.variables as { id: string })?.id === ch.id;

                if (isConnected) return null; // already shown above

                return (
                  <button
                    key={p.key}
                    onClick={() => ch && toggleMut.mutate({ id: ch.id, enabled: true })}
                    disabled={!isAvailable || !!isToggling}
                    className={`relative group flex flex-col items-center gap-2.5 p-5 rounded-2xl border text-center transition-all ${
                      isAvailable
                        ? 'bg-[#1a1a1a] border-white/10 hover:border-white/25 hover:bg-white/5 active:scale-95 cursor-pointer'
                        : 'bg-[#111] border-white/5 opacity-40 cursor-not-allowed'
                    }`}
                  >
                    {/* Icon */}
                    <div className={`w-12 h-12 rounded-2xl bg-gradient-to-br ${p.gradient} flex items-center justify-center text-2xl shadow-lg`}>
                      {p.icon}
                    </div>
                    <div>
                      <p className="text-sm font-black">{p.label}</p>
                      <p className="text-white/35 text-[11px] mt-0.5">{p.subtitle}</p>
                    </div>
                    {isAvailable ? (
                      <span className="text-[10px] font-black uppercase tracking-wide px-2.5 py-1 rounded-full bg-[#D1FE17]/10 text-[#D1FE17] border border-[#D1FE17]/20">
                        {isToggling ? <Loader2 className="w-3 h-3 animate-spin inline" /> : 'Connect'}
                      </span>
                    ) : (
                      <span className="text-[10px] font-black uppercase tracking-wide px-2.5 py-1 rounded-full bg-white/5 text-white/25 border border-white/8">
                        Unavailable
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Footer note */}
            <p className="text-white/20 text-xs mt-5 text-center">
              Clips auto-post to your connected accounts after generation ·{' '}
              <Link href="/account" className="underline hover:text-white/40 transition-colors">Manage in Account settings</Link>
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
    queryFn: () => apiFetch<StatusData>('/video/buffer/status'),
    retry: false,
  });
  const connected = data?.connected ?? false;
  const channels  = data?.channels ?? [];

  return (
    <div className="min-h-screen bg-[#0d0d0d] text-white font-sans">
      <AppHeader />
      <main className="max-w-xl mx-auto px-4 sm:px-6 py-12">
        <Link href="/" className="inline-flex items-center gap-1.5 text-sm text-white/35 hover:text-white transition-colors mb-8">
          <ArrowLeft className="w-4 h-4" /> Back to AutoCliper
        </Link>
        <h1 className="text-2xl font-black tracking-tight mb-2">Social auto-post</h1>
        <p className="text-white/40 text-sm mb-8">Powered by Buffer</p>

        {isLoading ? (
          <div className="flex items-center gap-3 text-white/40 py-8 justify-center">
            <Loader2 className="w-5 h-5 animate-spin" /> Checking status…
          </div>
        ) : connected ? (
          <>
            <div className="bg-[#D1FE17]/5 border border-[#D1FE17]/20 rounded-2xl p-5 flex items-start gap-3 mb-6">
              <CheckCircle2 className="w-5 h-5 text-[#D1FE17] mt-0.5 shrink-0" />
              <div>
                <p className="font-black text-sm text-[#D1FE17]">Connected</p>
                <p className="text-white/50 text-sm mt-1">Log in to manage which accounts your clips post to.</p>
              </div>
            </div>
            {channels.map((ch, i) => (
              <div key={i} className="flex items-center gap-3 bg-[#1a1a1a] border border-white/8 rounded-2xl px-4 py-3 mb-2">
                <span className="text-xl">{PLATFORMS.find(p => p.key === ch.service)?.icon ?? '📲'}</span>
                <div>
                  <p className="text-sm font-black">{PLATFORMS.find(p => p.key === ch.service)?.label ?? ch.service}</p>
                  {ch.name && <p className="text-white/35 text-xs">@{ch.name}</p>}
                </div>
                <span className="ml-auto text-[10px] font-black uppercase tracking-wide text-white/25 bg-white/5 px-2 py-0.5 rounded-full border border-white/8">Auto</span>
              </div>
            ))}
          </>
        ) : (
          <div className="bg-[#1a1a1a] border border-white/10 rounded-2xl p-6 text-center">
            <p className="text-white/40 text-sm">Social auto-post is not active right now.</p>
          </div>
        )}

        <Link
          href="/login"
          className="mt-8 w-full flex items-center justify-center gap-2 bg-white text-black text-sm font-black py-3.5 rounded-2xl hover:bg-white/90 active:scale-95 transition-all"
        >
          <Zap className="w-4 h-4" /> Log in to connect your accounts
        </Link>
      </main>
    </div>
  );
}
