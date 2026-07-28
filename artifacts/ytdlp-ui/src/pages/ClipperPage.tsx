import { useState, useRef, useEffect, useContext } from 'react';
import {
  Link2, Scissors, Download, Play, X, ChevronDown,
  Loader2, AlertCircle, Sparkles, Zap, Check, Volume2,
  History, LogOut, User
} from 'lucide-react';
import { useUser, useClerk, Show } from '@clerk/react';
import { useLocation } from 'wouter';
import { ClerkEnabledCtx } from '../clerk-context';

// In production the API lives on a separate server — point VITE_API_URL to it
// (e.g. https://api-server-xxx.replit.app/api). In dev, the Vite proxy handles /api.
const API = import.meta.env.VITE_API_URL
  ? import.meta.env.VITE_API_URL.replace(/\/$/, '')
  : import.meta.env.BASE_URL.replace(/\/$/, '') + '/api';

// ─── Types ────────────────────────────────────────────────────────────────────
interface Clip {
  id: string;
  name: string;
  label: string;
  startTime: string;
  endTime: string;
  duration: string;
  size: number;
  thumbnailDataUrl?: string; // base64 data URL — preferred
  thumbnailId?: string;       // legacy fallback
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmtBytes(b: number) {
  if (b > 1e9) return (b / 1e9).toFixed(1) + ' GB';
  if (b > 1e6) return (b / 1e6).toFixed(1) + ' MB';
  return Math.round(b / 1e3) + ' KB';
}

function thumbUrl(id: string) {
  return `${API}/video/file/${id}`;
}
function dlUrl(id: string) {
  return `${API}/video/file/${id}`;
}

// ─── Loading dots ─────────────────────────────────────────────────────────────
function Dots() {
  return (
    <span className="inline-flex gap-1 ml-1">
      {[0, 1, 2].map(i => (
        <span
          key={i}
          className="w-1.5 h-1.5 rounded-full bg-white/60 animate-bounce"
          style={{ animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </span>
  );
}

// ─── Video Player Modal ───────────────────────────────────────────────────────
function VideoModal({ clip, onClose }: { clip: Clip; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  // Close on Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // Prevent body scroll while modal open
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/90 backdrop-blur-md" />

      {/* Modal */}
      <div
        className="relative z-10 w-full max-w-sm mx-auto flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Top bar */}
        <div className="flex items-center justify-between mb-3 px-1">
          <div>
            <p className="text-white font-bold text-sm">{clip.label}</p>
            <p className="text-white/40 text-xs mt-0.5">{clip.startTime} – {clip.endTime} · {clip.duration}</p>
          </div>
          <button
            onClick={onClose}
            className="w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors"
          >
            <X className="w-5 h-5 text-white" />
          </button>
        </div>

        {/* Video */}
        <div className="relative w-full rounded-2xl overflow-hidden bg-black shadow-2xl shadow-black/50">
          <video
            ref={videoRef}
            src={`${API}/video/file/${clip.id}`}
            controls
            autoPlay
            playsInline
            className="w-full block"
            style={{ maxHeight: '75vh', objectFit: 'contain', background: '#000' }}
          />
        </div>

        {/* Bottom actions */}
        <div className="flex gap-3 mt-4 px-1">
          <a
            href={dlUrl(clip.id)}
            download={clip.name}
            className="flex-1 flex items-center justify-center gap-2 bg-[#D1FE17] text-black text-sm font-black py-3 rounded-xl hover:bg-[#c5f010] active:scale-95 transition-all"
          >
            <Download className="w-4 h-4" />
            Download Clip
          </a>
        </div>
      </div>
    </div>
  );
}

// ─── Clip Card ────────────────────────────────────────────────────────────────
function ClipCard({ clip, index, onPlay }: { clip: Clip; index: number; onPlay: () => void }) {
  const [imgError, setImgError] = useState(false);
  const [dlState, setDlState] = useState<'idle' | 'downloading' | 'done'>('idle');

  function handleDownload(e: React.MouseEvent<HTMLAnchorElement>) {
    e.stopPropagation();
    if (dlState !== 'idle') return;
    setDlState('downloading');
    setTimeout(() => {
      setDlState('done');
      setTimeout(() => setDlState('idle'), 2000);
    }, 1400);
  }

  return (
    <div className="group relative bg-[#1a1a1a] rounded-2xl overflow-hidden border border-white/5 hover:border-white/20 transition-all duration-200">
      {/* Thumbnail — tap to play */}
      <button
        type="button"
        onClick={onPlay}
        className="relative w-full aspect-[9/16] bg-[#111] overflow-hidden block focus:outline-none"
      >
        {(clip.thumbnailDataUrl || clip.thumbnailId) && !imgError ? (
          <img
            src={clip.thumbnailDataUrl || thumbUrl(clip.thumbnailId!)}
            alt={clip.label}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
            onError={() => setImgError(true)}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-[#1e1e1e] to-[#0d0d0d]">
            <Play className="w-8 h-8 text-white/20" />
          </div>
        )}

        {/* Gradient overlay */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/10 to-transparent" />

        {/* Duration badge */}
        <div className="absolute top-2 left-2 bg-black/70 backdrop-blur-sm text-white text-[11px] font-bold px-2 py-0.5 rounded-md">
          {clip.duration}
        </div>

        {/* Clip number */}
        <div className="absolute top-2 right-2 w-6 h-6 rounded-full bg-[#D1FE17] text-black text-[11px] font-black flex items-center justify-center">
          {index + 1}
        </div>

        {/* Play button — always visible on mobile, hover on desktop */}
        <div className="absolute inset-0 flex items-center justify-center md:opacity-0 md:group-hover:opacity-100 transition-opacity">
          <div className="w-12 h-12 rounded-full bg-white/25 backdrop-blur-sm flex items-center justify-center shadow-lg">
            <Play className="w-5 h-5 text-white ml-0.5" fill="currentColor" />
          </div>
        </div>

        {/* Bottom info */}
        <div className="absolute bottom-2 left-2 right-2">
          <p className="text-white/70 text-[11px] font-medium">{clip.startTime} – {clip.endTime}</p>
        </div>
      </button>

      {/* Card Footer */}
      <div className="p-3 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-white text-sm font-semibold truncate">{clip.label}</p>
          <p className="text-white/40 text-xs">{fmtBytes(clip.size)}</p>
        </div>

        <a
          href={dlUrl(clip.id)}
          download={clip.name}
          onClick={handleDownload}
          className={[
            "shrink-0 flex items-center gap-1.5 text-xs font-black px-3 py-2 rounded-xl transition-all duration-300 select-none overflow-hidden",
            dlState === 'done'
              ? "bg-white/10 text-[#D1FE17] scale-95"
              : "bg-[#D1FE17] text-black hover:bg-[#c5f010] active:scale-95",
          ].join(' ')}
          style={{ minWidth: 90, justifyContent: 'center' }}
        >
          {dlState === 'idle' && (
            <>
              <Download className="w-3.5 h-3.5" />
              Download
            </>
          )}
          {dlState === 'downloading' && (
            <>
              {/* Animated bouncing arrow */}
              <span className="inline-block animate-bounce">
                <Download className="w-3.5 h-3.5" />
              </span>
              <span className="animate-pulse">Saving…</span>
            </>
          )}
          {dlState === 'done' && (
            <>
              <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none">
                <path d="M3 8.5l3.5 3.5 6.5-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              Saved!
            </>
          )}
        </a>
      </div>
    </div>
  );
}

// ─── Platform config ──────────────────────────────────────────────────────────
const PLATFORMS = [
  { id: 'tiktok',   emoji: '🎵', label: 'TikTok',   sub: '9:16 · 60s',  maxDur: 60 },
  { id: 'reels',    emoji: '📸', label: 'Reels',    sub: '9:16 · 90s',  maxDur: 90 },
  { id: 'shorts',   emoji: '▶️', label: 'Shorts',   sub: '9:16 · 60s',  maxDur: 60 },
  { id: 'original', emoji: '🎬', label: 'Original', sub: '16:9 · No crop', maxDur: 300 },
] as const;
type PlatformId = typeof PLATFORMS[number]['id'];

// ─── Settings Panel ───────────────────────────────────────────────────────────
function SettingsPanel({
  platform, setPlatform,
  duration, setDuration,
  clipCount, setClipCount,
}: {
  platform: PlatformId; setPlatform: (v: PlatformId) => void;
  duration: number; setDuration: (v: number) => void;
  clipCount: number; setClipCount: (v: number) => void;
}) {
  const [open, setOpen] = useState(true);
  const sel = 'w-full bg-[#1e1e1e] text-white text-sm font-semibold border border-white/10 rounded-xl px-3 py-2.5 outline-none appearance-none focus:border-[#D1FE17]/50 transition-colors cursor-pointer';
  const maxDur = PLATFORMS.find(p => p.id === platform)?.maxDur ?? 300;

  // Clamp duration when platform changes
  const safeDuration = Math.min(duration, maxDur);

  return (
    <div className="w-full max-w-2xl mx-auto mt-3">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 text-white/50 hover:text-white/80 text-sm font-medium transition-colors mx-auto"
      >
        <Scissors className="w-4 h-4" />
        Clip settings
        <ChevronDown className={`w-4 h-4 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="mt-4 bg-[#161616] border border-white/8 rounded-2xl p-5 space-y-5">

          {/* Platform picker */}
          <div>
            <label className="block text-white/45 text-[11px] font-bold uppercase tracking-widest mb-3">Platform</label>
            <div className="grid grid-cols-4 gap-2">
              {PLATFORMS.map(p => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    setPlatform(p.id);
                    // auto-clamp duration
                    if (duration > p.maxDur) setDuration(p.maxDur);
                  }}
                  className={`flex flex-col items-center gap-1.5 py-3 px-2 rounded-2xl border text-center transition-all ${
                    platform === p.id
                      ? 'border-[#D1FE17]/60 bg-[#D1FE17]/8 text-white'
                      : 'border-white/8 bg-[#1a1a1a] text-white/50 hover:border-white/20 hover:text-white/80'
                  }`}
                >
                  <span className="text-xl leading-none">{p.emoji}</span>
                  <span className="text-xs font-black leading-none">{p.label}</span>
                  <span className="text-[10px] text-white/35 leading-none font-medium">{p.sub}</span>
                  {platform === p.id && (
                    <div className="w-1.5 h-1.5 rounded-full bg-[#D1FE17] mt-0.5" />
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Duration + Count row */}
          <div className="grid grid-cols-2 gap-4">
            {/* Clip duration */}
            <div>
              <label className="block text-white/45 text-[11px] font-bold uppercase tracking-widest mb-2">Clip length</label>
              <select
                className={sel}
                value={safeDuration}
                onChange={e => setDuration(Number(e.target.value))}
              >
                {[15, 30, 45, 60, 90, 120].filter(v => v <= maxDur).map(v => (
                  <option key={v} value={v}>
                    {v < 60 ? `${v} sec` : v === 60 ? '1 min' : v === 90 ? '1:30 min' : '2 min'}
                  </option>
                ))}
              </select>
            </div>

            {/* Custom clip count */}
            <div>
              <label className="block text-white/45 text-[11px] font-bold uppercase tracking-widest mb-2">No. of clips</label>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setClipCount(Math.max(1, clipCount - 1))}
                  className="w-9 h-10 rounded-xl bg-[#1e1e1e] border border-white/10 text-white/70 hover:text-white hover:border-white/30 text-lg font-black flex items-center justify-center transition-all shrink-0"
                >−</button>
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={clipCount}
                  onChange={e => {
                    const v = parseInt(e.target.value) || 1;
                    setClipCount(Math.min(10, Math.max(1, v)));
                  }}
                  className="flex-1 bg-[#1e1e1e] text-white text-sm font-black text-center border border-white/10 rounded-xl py-2.5 outline-none focus:border-[#D1FE17]/50 transition-colors min-w-0 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
                />
                <button
                  type="button"
                  onClick={() => setClipCount(Math.min(10, clipCount + 1))}
                  className="w-9 h-10 rounded-xl bg-[#1e1e1e] border border-white/10 text-white/70 hover:text-white hover:border-white/30 text-lg font-black flex items-center justify-center transition-all shrink-0"
                >+</button>
              </div>
              <p className="text-white/25 text-[10px] mt-1.5 text-center">Max 10 clips</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Stat Pills ───────────────────────────────────────────────────────────────
const STATS = [
  { label: '1M+ videos clipped', icon: '🎬' },
  { label: '10x faster creation', icon: '⚡' },
  { label: 'YouTube · TikTok · Reels', icon: '📱' },
];

// ─── History Panel ────────────────────────────────────────────────────────────
interface HistoryJob {
  id: string;
  source_url: string;
  platform: string;
  clip_duration: number;
  clip_count: number;
  total_duration: string | null;
  created_at: string;
}

function HistoryPanel({ onRerun }: { onRerun: (url: string, platform: string, clipDuration: number, clipCount: number) => void }) {
  const [jobs, setJobs] = useState<HistoryJob[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API}/history`, { credentials: 'include' })
      .then(r => r.json())
      .then(d => { setJobs(d.jobs ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const platformEmoji: Record<string, string> = { tiktok: '🎵', reels: '📸', shorts: '▶️', original: '🎬' };

  const deleteJob = async (id: string) => {
    await fetch(`${API}/history/${id}`, { method: 'DELETE', credentials: 'include' });
    setJobs(j => j.filter(x => x.id !== id));
  };

  if (loading) return (
    <div className="flex justify-center py-8">
      <Loader2 className="w-5 h-5 text-white/30 animate-spin" />
    </div>
  );

  if (jobs.length === 0) return (
    <div className="text-center py-10">
      <div className="text-3xl mb-3">🎬</div>
      <p className="text-white/40 text-sm">No clips yet. Generate your first one!</p>
    </div>
  );

  return (
    <div className="space-y-3">
      {jobs.map(job => {
        const short = job.source_url.replace(/^https?:\/\//, '').slice(0, 45) + (job.source_url.length > 50 ? '…' : '');
        const date = new Date(job.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        return (
          <div key={job.id} className="bg-[#1a1a1a] border border-white/8 rounded-xl p-4 flex items-center gap-3">
            <div className="text-2xl shrink-0">{platformEmoji[job.platform] ?? '🎬'}</div>
            <div className="flex-1 min-w-0">
              <p className="text-white/70 text-xs font-mono truncate">{short}</p>
              <p className="text-white/35 text-xs mt-0.5">{job.clip_count} clips · {job.clip_duration}s · {date}</p>
            </div>
            <button
              onClick={() => onRerun(job.source_url, job.platform, job.clip_duration, job.clip_count)}
              className="shrink-0 bg-[#D1FE17] text-black text-xs font-black px-3 py-1.5 rounded-lg hover:bg-[#c5f010] transition-colors"
            >
              Regenerate
            </button>
            <button
              onClick={() => deleteJob(job.id)}
              className="shrink-0 w-7 h-7 flex items-center justify-center text-white/20 hover:text-red-400 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ─── Clerk auth nav (only mounted when ClerkProvider is present) ───────────────
interface ClerkNavProps {
  showHistory: boolean;
  setShowHistory: React.Dispatch<React.SetStateAction<boolean>>;
  onAuthChange: (isSignedIn: boolean, user: ReturnType<typeof useUser>['user']) => void;
}

function ClerkNavButtons({ showHistory, setShowHistory, onAuthChange }: ClerkNavProps) {
  const { user, isSignedIn } = useUser();
  const { signOut } = useClerk();
  const [, setLocation] = useLocation();
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  useEffect(() => {
    onAuthChange(!!isSignedIn, user ?? null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSignedIn, user?.id]);

  useEffect(() => {
    if (!userMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('[data-user-menu]')) setUserMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [userMenuOpen]);

  return (
    <>
      <Show when="signed-out">
        <button
          onClick={() => setLocation('/sign-in')}
          className="hidden sm:block text-sm font-semibold text-white/60 hover:text-white transition-colors"
        >Sign in</button>
        <button
          onClick={() => setLocation('/sign-up')}
          className="bg-white text-black text-sm font-black px-4 py-2 rounded-xl hover:bg-white/90 active:scale-95 transition-all"
        >Get started — Free</button>
      </Show>
      <Show when="signed-in">
        <button
          onClick={() => setShowHistory(h => !h)}
          className="flex items-center gap-2 text-sm font-semibold text-white/60 hover:text-white transition-colors"
        >
          <History className="w-4 h-4" />
          <span className="hidden sm:inline">History</span>
        </button>
        <div className="relative" data-user-menu>
          <button
            onClick={() => setUserMenuOpen(o => !o)}
            className="flex items-center gap-2 bg-white/8 hover:bg-white/12 border border-white/10 rounded-xl px-3 py-2 transition-colors"
          >
            {user?.imageUrl
              ? <img src={user.imageUrl} alt="" className="w-6 h-6 rounded-full object-cover" />
              : <User className="w-4 h-4 text-white/60" />}
            <span className="hidden sm:block text-sm font-semibold text-white/80 max-w-[100px] truncate">
              {user?.firstName ?? user?.primaryEmailAddress?.emailAddress?.split('@')[0] ?? 'Account'}
            </span>
          </button>
          {userMenuOpen && (
            <div className="absolute right-0 top-full mt-2 w-52 bg-[#1a1a1a] border border-white/10 rounded-2xl shadow-2xl shadow-black/60 overflow-hidden z-50">
              <div className="px-4 py-3 border-b border-white/8">
                <p className="text-white text-sm font-bold truncate">{user?.fullName ?? user?.firstName ?? 'User'}</p>
                <p className="text-white/40 text-xs truncate mt-0.5">{user?.primaryEmailAddress?.emailAddress}</p>
              </div>
              <button
                onClick={() => { setShowHistory(true); setUserMenuOpen(false); }}
                className="w-full flex items-center gap-3 px-4 py-3 text-white/70 hover:text-white hover:bg-white/5 text-sm transition-colors"
              >
                <History className="w-4 h-4" /> My History
              </button>
              <button
                onClick={() => signOut({ redirectUrl: '/' })}
                className="w-full flex items-center gap-3 px-4 py-3 text-red-400/70 hover:text-red-400 hover:bg-red-500/5 text-sm transition-colors border-t border-white/5"
              >
                <LogOut className="w-4 h-4" /> Sign out
              </button>
            </div>
          )}
        </div>
      </Show>
    </>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────────────────
export default function ClipperPage() {
  const clerkEnabled = useContext(ClerkEnabledCtx);
  const [showHistory, setShowHistory] = useState(false);
  const [isSignedIn, setIsSignedIn] = useState(false);
  const [user, setUser] = useState<ReturnType<typeof useUser>['user']>(null);

  const [url, setUrl] = useState('');
  const [duration, setDuration] = useState(30);
  const [clipCount, setClipCount] = useState(5);
  const [platform, setPlatform] = useState<PlatformId>('shorts');

  const [phase, setPhase] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [loadMsg, setLoadMsg] = useState('');
  const [clips, setClips] = useState<Clip[]>([]);
  const [totalDuration, setTotalDuration] = useState('');
  const [error, setError] = useState('');
  const [playingClip, setPlayingClip] = useState<Clip | null>(null);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  // Sync user to DB on first sign-in (JIT provision)
  useEffect(() => {
    if (isSignedIn && user?.primaryEmailAddress?.emailAddress) {
      fetch(`${API}/history/sync-user`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email: user.primaryEmailAddress.emailAddress }),
      }).catch(() => {});
    }
  }, [isSignedIn, user?.id]);

  const canSubmit = url.trim().startsWith('http');

  const MSGS = [
    'Downloading video…',
    'Analysing content…',
    'Detecting best moments…',
    'Generating clips…',
    'Finishing up…',
  ];

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!canSubmit) return;

    setPhase('loading');
    setError('');
    setClips([]);

    let idx = 0;
    setLoadMsg(MSGS[0]);
    intervalRef.current = setInterval(() => {
      idx = Math.min(idx + 1, MSGS.length - 1);
      setLoadMsg(MSGS[idx]);
    }, 4000);

    try {
      const res = await fetch(`${API}/video/clip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, clipDuration: duration, platform, clipCount }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Error ${res.status}`);

      setClips(data.clips);
      setTotalDuration(data.totalDuration);
      setPhase('done');

      if (isSignedIn) {
        fetch(`${API}/history`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            sourceUrl: url,
            platform,
            clipDuration: duration,
            clipCount: data.clips.length,
            totalDuration: data.totalDuration,
          }),
        }).catch(() => {});
      }

      setTimeout(() => {
        resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 100);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('error');
    } finally {
      if (intervalRef.current) clearInterval(intervalRef.current);
    }
  };

  const reset = () => {
    setPhase('idle');
    setClips([]);
    setUrl('');
    setError('');
  };

  const handleRerun = (srcUrl: string, srcPlatform: string, srcDuration: number, srcCount: number) => {
    setUrl(srcUrl);
    setPlatform(srcPlatform as PlatformId);
    setDuration(srcDuration);
    setClipCount(srcCount);
    setShowHistory(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div className="min-h-screen bg-[#0d0d0d] text-white font-sans">

      {/* ── Video Player Modal ────────────────────────────────────────────── */}
      {playingClip && (
        <VideoModal clip={playingClip} onClose={() => setPlayingClip(null)} />
      )}

      {/* ── History Drawer (auth required) ───────────────────────────────── */}
      {clerkEnabled && showHistory && (
        <div className="fixed inset-0 z-50 flex" onClick={() => setShowHistory(false)}>
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
          <div
            className="relative ml-auto w-full max-w-md h-full bg-[#111] border-l border-white/8 flex flex-col shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-white/8">
              <div>
                <h3 className="text-white font-black text-lg">My History</h3>
                <p className="text-white/35 text-xs mt-0.5">Past clip sessions</p>
              </div>
              <button
                onClick={() => setShowHistory(false)}
                className="w-9 h-9 rounded-full bg-white/8 hover:bg-white/12 flex items-center justify-center transition-colors"
              >
                <X className="w-5 h-5 text-white/60" />
              </button>
            </div>
            {/* List */}
            <div className="flex-1 overflow-y-auto px-4 py-4">
              <HistoryPanel onRerun={handleRerun} />
            </div>
          </div>
        </div>
      )}

      {/* ── Navbar ────────────────────────────────────────────────────────── */}
      <nav className="sticky top-0 z-50 border-b border-white/5 bg-[#0d0d0d]/90 backdrop-blur-xl">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-4">
          {/* Logo */}
          <a href="/" className="flex items-center gap-2 shrink-0">
            <div className="w-7 h-7 rounded-lg bg-[#D1FE17] flex items-center justify-center">
              <Scissors className="w-4 h-4 text-black" strokeWidth={2.5} />
            </div>
            <span className="font-black text-lg tracking-tight">AutoCliper</span>
          </a>

          {/* Nav */}
          <div className="hidden md:flex items-center gap-6 text-sm font-medium text-white/50">
            <a href="#how" className="hover:text-white transition-colors">How it works</a>
            <a href="#features" className="hover:text-white transition-colors">Features</a>
          </div>

          {/* CTA — Clerk auth buttons (only when ClerkProvider is mounted) */}
          <div className="flex items-center gap-3 shrink-0">
            {clerkEnabled && (
              <ClerkNavButtons
                showHistory={showHistory}
                setShowHistory={setShowHistory}
                onAuthChange={(signedIn, u) => { setIsSignedIn(signedIn); setUser(u); }}
              />
            )}
          </div>
        </div>
      </nav>

      {/* ── Hero ──────────────────────────────────────────────────────────── */}
      <section className="relative pt-16 pb-12 px-4 sm:px-6 text-center overflow-hidden">
        {/* Glow */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[300px] bg-[#D1FE17]/6 rounded-full blur-[100px] pointer-events-none" />

        <div className="relative max-w-4xl mx-auto">
          {/* Badge */}
          <div className="inline-flex items-center gap-2 bg-white/5 border border-white/10 text-white/70 text-xs font-bold uppercase tracking-widest px-4 py-1.5 rounded-full mb-8">
            <Zap className="w-3 h-3 text-[#D1FE17]" />
            #1 AI Video Clipping Tool
          </div>

          {/* Headline */}
          <h1 className="text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-black leading-[1.05] tracking-tight mb-5">
            1 long video.<br />
            <span className="text-[#D1FE17]">{clipCount} viral clips.</span>
          </h1>

          <p className="text-white/50 text-base sm:text-lg max-w-xl mx-auto mb-10 leading-relaxed">
            Paste any YouTube, TikTok or Instagram link. We'll find the best moments
            and cut them into short clips — ready to post.
          </p>

          {/* ── Input bar ─────────────────────────────────────────────── */}
          <form onSubmit={handleSubmit} className="max-w-2xl mx-auto">
            <div className="relative flex items-center bg-[#1a1a1a] border border-white/10 rounded-2xl p-1.5 focus-within:border-white/30 transition-colors shadow-xl shadow-black/30">
              <Link2 className="w-5 h-5 text-white/30 ml-3 shrink-0" />
              <input
                type="url"
                value={url}
                onChange={e => setUrl(e.target.value)}
                placeholder="Paste your YouTube, TikTok or Instagram link…"
                className="flex-1 bg-transparent text-white placeholder-white/25 text-sm sm:text-base font-medium px-3 py-2.5 outline-none min-w-0"
                disabled={phase === 'loading'}
              />
              {url && (
                <button
                  type="button"
                  onClick={() => setUrl('')}
                  className="w-8 h-8 flex items-center justify-center text-white/30 hover:text-white/70 transition-colors shrink-0"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
              <button
                type="submit"
                disabled={!canSubmit || phase === 'loading'}
                className="shrink-0 bg-[#D1FE17] text-black text-sm font-black px-5 py-2.5 rounded-xl hover:bg-[#c5f010] active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {phase === 'loading' ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Sparkles className="w-4 h-4" />
                )}
                <span className="hidden sm:inline">Get Clips</span>
                <span className="sm:hidden">Go</span>
              </button>
            </div>

            {/* Settings */}
            <SettingsPanel
              platform={platform} setPlatform={setPlatform}
              duration={duration} setDuration={setDuration}
              clipCount={clipCount} setClipCount={setClipCount}
            />
          </form>

          {/* Stats */}
          <div className="flex flex-wrap items-center justify-center gap-3 mt-8">
            {STATS.map(s => (
              <div key={s.label} className="flex items-center gap-2 bg-white/5 border border-white/8 text-white/50 text-xs font-semibold px-3 py-1.5 rounded-full">
                <span>{s.icon}</span>
                {s.label}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Loading state ─────────────────────────────────────────────────── */}
      {phase === 'loading' && (
        <section className="py-12 px-4 text-center">
          <div className="max-w-md mx-auto">
            {/* Spinner ring */}
            <div className="relative w-20 h-20 mx-auto mb-6">
              <div className="absolute inset-0 rounded-full border-4 border-white/5" />
              <div className="absolute inset-0 rounded-full border-4 border-transparent border-t-[#D1FE17] animate-spin" />
              <div className="absolute inset-3 rounded-full bg-[#161616] flex items-center justify-center">
                <Scissors className="w-6 h-6 text-[#D1FE17]" />
              </div>
            </div>
            <p className="text-white/90 text-lg font-semibold">
              {loadMsg}
              <Dots />
            </p>
            <p className="text-white/35 text-sm mt-2">
              Large videos may take 1–2 minutes. Don't close this tab.
            </p>
            {/* Progress bar */}
            <div className="mt-6 h-1 bg-white/5 rounded-full overflow-hidden max-w-xs mx-auto">
              <div className="h-full bg-[#D1FE17] rounded-full animate-pulse w-2/3" />
            </div>
          </div>
        </section>
      )}

      {/* ── Error state ───────────────────────────────────────────────────── */}
      {phase === 'error' && (
        <section className="py-12 px-4 text-center">
          <div className="max-w-md mx-auto bg-red-950/40 border border-red-500/20 rounded-2xl p-8">
            <AlertCircle className="w-10 h-10 text-red-400 mx-auto mb-4" />
            <h3 className="text-white text-lg font-bold mb-2">Something went wrong</h3>
            <p className="text-white/50 text-sm leading-relaxed mb-6">{error}</p>
            <button
              onClick={reset}
              className="bg-white/10 hover:bg-white/15 text-white text-sm font-bold px-6 py-2.5 rounded-xl transition-colors"
            >
              Try again
            </button>
          </div>
        </section>
      )}

      {/* ── Results ───────────────────────────────────────────────────────── */}
      {phase === 'done' && clips.length > 0 && (
        <section ref={resultsRef} className="py-10 px-4 sm:px-6">
          <div className="max-w-6xl mx-auto">

            {/* Header */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
              <div>
                <h2 className="text-2xl sm:text-3xl font-black">
                  {clips.length} Clips Ready 🎬
                </h2>
                <p className="text-white/40 text-sm mt-1">
                  From a {totalDuration} video · Tap to play · Save to download
                </p>
              </div>
              <div className="flex items-center gap-3">
                {/* Download all */}
                <button
                  onClick={() => clips.forEach(c => {
                    const a = document.createElement('a');
                    a.href = dlUrl(c.id);
                    a.download = c.name;
                    a.click();
                  })}
                  className="flex items-center gap-2 bg-[#D1FE17] text-black text-sm font-black px-5 py-2.5 rounded-xl hover:bg-[#c5f010] active:scale-95 transition-all"
                >
                  <Download className="w-4 h-4" />
                  Download All
                </button>
                <button
                  onClick={reset}
                  className="flex items-center gap-2 bg-white/8 hover:bg-white/12 text-white/70 text-sm font-semibold px-4 py-2.5 rounded-xl transition-colors"
                >
                  New video
                </button>
              </div>
            </div>

            {/* Clips grid */}
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3 sm:gap-4">
              {clips.map((clip, i) => (
                <ClipCard key={clip.id} clip={clip} index={i} onPlay={() => setPlayingClip(clip)} />
              ))}
            </div>
          </div>
        </section>
      )}

      {/* ── How it works ──────────────────────────────────────────────────── */}
      {phase === 'idle' && (
        <section id="how" className="py-16 px-4 sm:px-6">
          <div className="max-w-5xl mx-auto">
            <p className="text-center text-white/30 text-xs font-bold uppercase tracking-widest mb-12">How it works</p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
              {[
                { step: '01', title: 'Paste a link', desc: 'YouTube, TikTok, Instagram Reels, Twitter — any public video URL works.', icon: '🔗' },
                { step: '02', title: 'AI finds moments', desc: 'Our algorithm picks the best moments spread across the whole video.', icon: '🤖' },
                { step: '03', title: 'Download clips', desc: 'Your clips are ready in seconds. Download individually or all at once.', icon: '⬇️' },
              ].map(item => (
                <div key={item.step} className="bg-[#161616] border border-white/6 rounded-2xl p-6 hover:border-white/12 transition-colors">
                  <div className="text-3xl mb-4">{item.icon}</div>
                  <div className="text-[#D1FE17] text-xs font-black uppercase tracking-widest mb-2">{item.step}</div>
                  <h3 className="text-white text-lg font-bold mb-2">{item.title}</h3>
                  <p className="text-white/40 text-sm leading-relaxed">{item.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* ── Features ──────────────────────────────────────────────────────── */}
      {phase === 'idle' && (
        <section id="features" className="py-10 pb-20 px-4 sm:px-6">
          <div className="max-w-5xl mx-auto">
            <p className="text-center text-white/30 text-xs font-bold uppercase tracking-widest mb-10">What you get</p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {[
                { emoji: '✂️', title: 'Smart trimming', desc: 'Random viral moments, not boring cuts' },
                { emoji: '📱', title: '9:16 Vertical', desc: 'Auto-crop for Shorts & TikTok' },
                { emoji: '⚡', title: 'Fast processing', desc: 'Clips ready in under 2 minutes' },
                { emoji: '🌐', title: '1000+ sites', desc: 'YouTube, IG, TikTok, Twitter & more' },
              ].map(f => (
                <div key={f.title} className="bg-[#131313] border border-white/5 rounded-2xl p-5 text-center hover:border-white/10 transition-colors">
                  <div className="text-2xl mb-3">{f.emoji}</div>
                  <div className="text-white text-sm font-bold mb-1">{f.title}</div>
                  <div className="text-white/35 text-xs">{f.desc}</div>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* ── Footer ────────────────────────────────────────────────────────── */}
      <footer className="border-t border-white/5 py-8 px-4 sm:px-6">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-white/25 text-xs font-medium">
          <div className="flex items-center gap-2">
            <div className="w-5 h-5 rounded-md bg-[#D1FE17] flex items-center justify-center">
              <Scissors className="w-3 h-3 text-black" strokeWidth={2.5} />
            </div>
            <span className="text-white/40 font-bold">AutoCliper</span>
          </div>
          <p>© 2025 AutoCliper. All rights reserved.</p>
          <div className="flex items-center gap-4">
            <a href="#" className="hover:text-white/60 transition-colors">Privacy</a>
            <a href="#" className="hover:text-white/60 transition-colors">Terms</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
