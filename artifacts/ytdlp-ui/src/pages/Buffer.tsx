/**
 * Public Buffer integration page — visible to all signed-in users.
 * Shows which social channels clips are auto-posted to after generation.
 */
import { useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import { Share2, Scissors, CheckCircle2, ArrowLeft, Loader2, XCircle } from 'lucide-react';
import { apiFetch } from '../lib/auth';
import { AppHeader } from '../components/AppHeader';

interface BufferStatus {
  connected: boolean;
  channels: { service: string; name: string }[];
}

const SERVICE_META: Record<string, { label: string; color: string; bg: string; emoji: string }> = {
  instagram: { label: 'Instagram',   color: 'text-pink-400',   bg: 'bg-pink-500/10 border-pink-400/20',  emoji: '📸' },
  tiktok:    { label: 'TikTok',      color: 'text-white',      bg: 'bg-white/5 border-white/10',          emoji: '🎵' },
  youtube:   { label: 'YouTube',     color: 'text-red-400',    bg: 'bg-red-500/10 border-red-400/20',     emoji: '▶️' },
  twitter:   { label: 'Twitter / X', color: 'text-sky-400',    bg: 'bg-sky-500/10 border-sky-400/20',    emoji: '🐦' },
  linkedin:  { label: 'LinkedIn',    color: 'text-blue-400',   bg: 'bg-blue-500/10 border-blue-400/20',  emoji: '💼' },
  facebook:  { label: 'Facebook',    color: 'text-blue-500',   bg: 'bg-blue-600/10 border-blue-500/20',  emoji: '👥' },
};

export default function BufferPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['buffer-status-public'],
    queryFn: () => apiFetch<BufferStatus>('/video/buffer/status'),
    retry: false,
  });

  const connected = data?.connected ?? false;
  const channels  = data?.channels ?? [];

  return (
    <div className="min-h-screen bg-[#0d0d0d] text-white font-sans">
      <AppHeader />

      <main className="max-w-xl mx-auto px-4 sm:px-6 py-12">
        {/* Back */}
        <Link href="/" className="inline-flex items-center gap-1.5 text-sm text-white/35 hover:text-white transition-colors mb-8">
          <ArrowLeft className="w-4 h-4" /> Back to AutoCliper
        </Link>

        {/* Header */}
        <div className="flex items-center gap-4 mb-8">
          <div className="w-12 h-12 rounded-2xl bg-[#D1FE17]/10 flex items-center justify-center shrink-0">
            <Share2 className="w-6 h-6 text-[#D1FE17]" />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight">Social auto-post</h1>
            <p className="text-white/40 text-sm mt-0.5">Powered by Buffer</p>
          </div>
        </div>

        {/* Status card */}
        {isLoading ? (
          <div className="bg-[#1a1a1a] border border-white/10 rounded-2xl p-6 flex items-center gap-3">
            <Loader2 className="w-5 h-5 text-white/30 animate-spin" />
            <p className="text-white/40 text-sm">Checking connection…</p>
          </div>
        ) : error ? (
          <div className="bg-red-500/5 border border-red-400/15 rounded-2xl p-6 flex items-center gap-3">
            <XCircle className="w-5 h-5 text-red-400/60" />
            <p className="text-red-400/80 text-sm">Could not load status</p>
          </div>
        ) : connected ? (
          <div className="bg-[#D1FE17]/5 border border-[#D1FE17]/20 rounded-2xl p-5 flex items-start gap-4">
            <CheckCircle2 className="w-5 h-5 text-[#D1FE17] mt-0.5 shrink-0" />
            <div>
              <p className="font-black text-sm text-[#D1FE17]">Connected</p>
              <p className="text-white/50 text-sm mt-1">
                Every clip you generate is automatically posted to our social channels via Buffer after it's ready.
              </p>
            </div>
          </div>
        ) : (
          <div className="bg-[#1a1a1a] border border-white/10 rounded-2xl p-5 flex items-start gap-4">
            <XCircle className="w-5 h-5 text-white/20 mt-0.5 shrink-0" />
            <div>
              <p className="font-black text-sm">Not connected</p>
              <p className="text-white/40 text-sm mt-1">Auto-posting is not active right now.</p>
            </div>
          </div>
        )}

        {/* Channels */}
        {connected && channels.length > 0 && (
          <div className="mt-6">
            <p className="text-[11px] font-black text-white/30 uppercase tracking-widest mb-3">
              Posting to
            </p>
            <div className="space-y-2">
              {channels.map((ch, i) => {
                const m = SERVICE_META[ch.service] ?? { label: ch.service, color: 'text-white/50', bg: 'bg-white/5 border-white/10', emoji: '📲' };
                return (
                  <div key={i} className={`border rounded-2xl px-4 py-3.5 flex items-center gap-3 ${m.bg}`}>
                    <span className="text-xl leading-none">{m.emoji}</span>
                    <div>
                      <p className={`text-sm font-black ${m.color}`}>{m.label}</p>
                      {ch.name && <p className="text-white/35 text-xs mt-0.5">@{ch.name}</p>}
                    </div>
                    <span className="ml-auto text-[10px] font-black uppercase tracking-wide text-white/25 bg-white/5 px-2 py-0.5 rounded-full border border-white/8">Auto</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* How it works */}
        <div className="mt-6 bg-[#1a1a1a] border border-white/8 rounded-2xl p-5">
          <p className="font-black text-sm mb-4">How it works</p>
          <div className="space-y-4">
            {[
              { icon: <Scissors className="w-4 h-4" />, text: 'You generate clips from any video on AutoCliper' },
              { icon: <CheckCircle2 className="w-4 h-4" />, text: 'Clips are cut, captioned, and saved to your account' },
              { icon: <Share2 className="w-4 h-4" />, text: 'Each clip is automatically queued to Buffer and posted to social media' },
            ].map((step, i) => (
              <div key={i} className="flex items-start gap-3">
                <div className="w-7 h-7 rounded-xl bg-[#D1FE17]/10 flex items-center justify-center shrink-0 text-[#D1FE17]">
                  {step.icon}
                </div>
                <p className="text-sm text-white/55 pt-1">{step.text}</p>
              </div>
            ))}
          </div>
        </div>

        {/* CTA */}
        <Link
          href="/"
          className="mt-6 w-full flex items-center justify-center gap-2 bg-[#D1FE17] text-black text-sm font-black py-3.5 rounded-2xl hover:bg-[#D1FE17]/90 active:scale-95 transition-all"
        >
          <Scissors className="w-4 h-4" /> Generate clips now
        </Link>
      </main>
    </div>
  );
}
