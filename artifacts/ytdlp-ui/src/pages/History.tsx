/**
 * My videos — full-screen history page (replaces the old slide-in drawer).
 *
 * Section 1: clips saved on this device (localStorage) — always-open big grid,
 *            playable + downloadable immediately.
 * Section 2: sessions saved to the account (server history) — reuses the same
 *            HistoryPanel the drawer used (dedupes twins of section 1,
 *            regenerate / delete / expired states).
 *
 * "Regenerate" hands the job settings back to the clipper via sessionStorage
 * (`autocliper_rerun`) and navigates home — ClipperPage picks it up on mount.
 */
import { useState } from 'react';
import { Link, useLocation } from 'wouter';
import { ArrowLeft, Download, History as HistoryIcon, Plus, Scissors, X, Zap } from 'lucide-react';
import { useAuth } from '../lib/auth';
import {
  API,
  ClipCard,
  HistoryPanel,
  SourceBadge,
  VideoModal,
  clearRecentJobs,
  deleteRecentJob,
  fmtDateTime,
  loadRecentJobs,
  sourceInfo,
} from './ClipperPage';
import type { Clip, RecentJob } from './ClipperPage';

export default function HistoryPage() {
  const { user, loading } = useAuth();
  const [, setLocation] = useLocation();
  const [recentJobs, setRecentJobs] = useState<RecentJob[]>(() => loadRecentJobs());
  const [playingClip, setPlayingClip] = useState<Clip | null>(null);

  const totalDeviceClips = recentJobs.reduce((n, j) => n + j.clips.length, 0);

  const handleRerun = (url: string, platform: string, clipDuration: number, clipCount: number) => {
    try {
      sessionStorage.setItem('autocliper_rerun', JSON.stringify({ url, platform, clipDuration, clipCount }));
    } catch { /* storage full/blocked — user just lands on an empty form */ }
    setLocation('/');
    window.scrollTo({ top: 0 });
  };

  return (
    <div className="min-h-screen bg-[#0d0d0d] text-white font-sans">
      {playingClip && (
        <VideoModal clip={playingClip} onClose={() => setPlayingClip(null)} />
      )}

      {/* ── Top bar ───────────────────────────────────────────────────────── */}
      <nav className="sticky top-0 z-40 border-b border-white/5 bg-[#0d0d0d]/90 backdrop-blur-xl">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <Link
              href="/"
              className="flex items-center gap-2 text-sm font-semibold text-white/60 hover:text-white transition-colors shrink-0"
            >
              <ArrowLeft className="w-4 h-4" />
              <span className="hidden sm:inline">Back</span>
            </Link>
            <span className="w-px h-5 bg-white/10 shrink-0" />
            <Link href="/" className="flex items-center gap-2 min-w-0">
              <div className="w-7 h-7 rounded-lg bg-[#D1FE17] flex items-center justify-center shrink-0">
                <Scissors className="w-4 h-4 text-black" strokeWidth={2.5} />
              </div>
              <span className="font-black text-lg tracking-tight truncate">AutoCliper</span>
            </Link>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {user ? (
              <Link
                href="/account"
                className="flex items-center gap-1.5 bg-[#D1FE17]/10 border border-[#D1FE17]/30 text-[#D1FE17] rounded-xl px-3 py-1.5 text-sm font-black hover:bg-[#D1FE17]/20 transition-colors"
                title="Your credits"
              >
                <Zap className="w-4 h-4" />
                {user.credits.total}
              </Link>
            ) : !loading && (
              <Link
                href="/login"
                className="text-sm font-semibold text-white/60 hover:text-white transition-colors"
              >Sign in</Link>
            )}
          </div>
        </div>
      </nav>

      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-8 sm:py-10">
        {/* ── Page header ─────────────────────────────────────────────────── */}
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-8">
          <div>
            <h1 className="text-3xl sm:text-4xl font-black tracking-tight">My videos</h1>
            <p className="text-white/40 text-sm mt-2">
              {user
                ? 'Saved on this device & to your account · clips never expire'
                : 'Saved in this browser · sign in to keep them on your account'}
            </p>
          </div>
          <Link
            href="/"
            className="inline-flex items-center justify-center gap-2 bg-[#D1FE17] text-black text-sm font-black px-4 py-2.5 rounded-xl hover:bg-[#c5f010] active:scale-95 transition-all shrink-0"
          >
            <Plus className="w-4 h-4" strokeWidth={3} />
            New clips
          </Link>
        </div>

        {/* ── Section 1: clips on this device ─────────────────────────────── */}
        {recentJobs.length > 0 && (
          <section className="mb-10">
            <div className="flex items-center justify-between mb-3 px-1">
              <p className="text-white/40 text-[11px] font-black uppercase tracking-widest">
                On this device · ready to download
                {totalDeviceClips > 0 && <span className="ml-2 text-[#D1FE17]">{totalDeviceClips} clips</span>}
              </p>
              <button
                onClick={() => { clearRecentJobs(); setRecentJobs([]); }}
                className="text-white/30 hover:text-red-400 text-xs font-semibold transition-colors"
              >Clear all</button>
            </div>

            <div className="space-y-8">
              {recentJobs.map(job => {
                const info = sourceInfo(job.url);
                const meta = [
                  `${job.clips.length} ${job.clips.length === 1 ? 'clip' : 'clips'}`,
                  job.totalDuration ? `${job.totalDuration} video` : undefined,
                  job.date > 0 ? fmtDateTime(job.date) : undefined,
                  info.sub ?? undefined,
                ].filter(Boolean).join(' · ');
                return (
                  <div key={job.id}>
                    {/* Job header row */}
                    <div className="flex items-center gap-3 mb-3">
                      <SourceBadge kind={info.kind} />
                      <div className="flex-1 min-w-0">
                        <p className="text-white/90 text-sm font-bold truncate">{info.label}</p>
                        <p className="text-white/35 text-xs mt-0.5 truncate">{meta}</p>
                      </div>
                      <a
                        href={`${API}/video/zip?ids=${job.clips.map(c => c.id).join(',')}`}
                        download="clips.zip"
                        className="shrink-0 flex items-center gap-2 bg-[#D1FE17] text-black text-xs font-black px-3.5 py-2 rounded-xl hover:bg-[#c5f010] active:scale-95 transition-all"
                      >
                        <Download className="w-3.5 h-3.5" />
                        <span className="hidden sm:inline">Download all</span> ({job.clips.length})
                      </a>
                      <button
                        onClick={() => setRecentJobs(deleteRecentJob(job.id))}
                        className="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg text-white/20 hover:text-red-400 hover:bg-white/5 transition-colors"
                        aria-label="Delete this video's clips"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                    {/* Big clip grid */}
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4">
                      {job.clips.map((clip, i) => (
                        <ClipCard key={clip.id} clip={clip} index={i} onPlay={() => setPlayingClip(clip)} />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* ── Sign-in nudge (device clips exist but no account) ───────────── */}
        {!user && !loading && recentJobs.length > 0 && (
          <div className="mb-10 bg-[#161616] border border-[#D1FE17]/20 rounded-2xl p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center gap-3">
            <div className="flex-1">
              <p className="text-white/90 text-sm font-bold">These clips live only in this browser</p>
              <p className="text-white/40 text-xs mt-1">Create a free account to save your history and open it from any device.</p>
            </div>
            <Link
              href="/signup"
              className="shrink-0 inline-flex items-center justify-center bg-[#D1FE17] text-black text-xs font-black px-4 py-2.5 rounded-xl hover:bg-[#c5f010] transition-colors"
            >Sign up free</Link>
          </div>
        )}

        {/* ── Section 2: account history ──────────────────────────────────── */}
        {user && (
          <section>
            <HistoryPanel
              onRerun={handleRerun}
              onPlay={clip => setPlayingClip(clip)}
              localJobs={recentJobs}
            />
          </section>
        )}

        {/* ── Empty state ─────────────────────────────────────────────────── */}
        {!user && recentJobs.length === 0 && (
          <div className="text-center py-20">
            <div className="w-14 h-14 mx-auto mb-4 rounded-2xl bg-white/[0.05] border border-white/10 flex items-center justify-center">
              <HistoryIcon className="w-6 h-6 text-white/30" />
            </div>
            <p className="text-white/70 font-bold">No clips yet</p>
            <p className="text-white/40 text-sm mt-1 mb-6">Paste a video link and your clips will show up here.</p>
            <Link
              href="/"
              className="inline-flex items-center gap-2 bg-[#D1FE17] text-black text-sm font-black px-5 py-3 rounded-xl hover:bg-[#c5f010] active:scale-95 transition-all"
            >
              <Plus className="w-4 h-4" strokeWidth={3} />
              Make your first clip
            </Link>
          </div>
        )}
      </main>
    </div>
  );
}
