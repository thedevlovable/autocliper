import { useState, useRef, useEffect } from 'react';
import {
  Link2, Scissors, Download, Play, X, ChevronDown,
  Loader2, AlertCircle, Sparkles, Zap, Check, Volume2,
  History, LogOut, User, Menu, CreditCard, Shield, Copy,
  Youtube, Globe, Radio, Box
} from 'lucide-react';
import { Link, useLocation } from 'wouter';
import { useAuth, apiFetch } from '../lib/auth';

// In production the API lives on a separate server — point VITE_API_URL to it
// (e.g. https://api-server-xxx.replit.app/api). In dev, the Vite proxy handles /api.
import { requestClips, cancelClipJob, ClipJobCancelledError } from '../lib/clipJob';
import { Footer } from '../components/Footer';
import { Upload as UploadIcon, FileVideo, Gift, Film, Plus, ArrowRight, Smartphone } from 'lucide-react';
import { uploadVideoFile } from '../lib/clipJob';

export const API = import.meta.env.VITE_API_URL
  ? import.meta.env.VITE_API_URL.replace(/\/$/, '')
  : import.meta.env.BASE_URL.replace(/\/$/, '') + '/api';

// ─── Types ────────────────────────────────────────────────────────────────────
export interface Clip {
  id: string;
  name: string;
  label: string;
  startTime: string;
  endTime: string;
  duration: string;
  size: number;
  thumbnailDataUrl?: string; // base64 data URL — preferred
  thumbnailId?: string;       // legacy fallback
  caption?: string;           // ready-to-paste viral caption (older jobs lack it)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmtBytes(b: number) {
  if (b > 1e9) return (b / 1e9).toFixed(1) + ' GB';
  if (b > 1e6) return (b / 1e6).toFixed(1) + ' MB';
  return Math.round(b / 1e3) + ' KB';
}

/** Copy to clipboard with a fallback for older mobile browsers. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Non-secure contexts / older iOS Safari: hidden readonly textarea with
    // an explicit selection range (iOS ignores plain select()).
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '0';
      ta.style.left = '0';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function thumbUrl(id: string) {
  return `${API}/video/file/${id}`;
}
function dlUrl(id: string) {
  return `${API}/video/file/${id}`;
}

// ─── Recent clips — saved locally in this browser, no sign-in needed ──────────
export interface RecentJob {
  id: string;
  url: string;
  platform: string;
  date: number;
  totalDuration: string;
  clips: Clip[];
  /** Server clip_jobs row id — links this device copy to account history. */
  historyId?: string;
}

export const RECENT_KEY = 'autocliper_recent_jobs';
export const RECENT_MAX = 8;

// Stored data can come from older app versions or get corrupted — never trust
// its shape. Discard entries that would crash the drawer render or save paths.
function sanitizeRecentJob(j: unknown): RecentJob | null {
  if (!j || typeof j !== 'object') return null;
  const job = j as Record<string, unknown>;
  if (typeof job.id !== 'string' || typeof job.url !== 'string' || !Array.isArray(job.clips)) return null;
  const clips = (job.clips as unknown[])
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object' && typeof (c as Record<string, unknown>).id === 'string')
    .map(c => ({ ...(c as unknown as Clip), size: typeof c.size === 'number' ? c.size : 0 }));
  if (clips.length === 0) return null;
  return {
    id: job.id,
    url: job.url,
    platform: typeof job.platform === 'string' ? job.platform : 'shorts',
    date: typeof job.date === 'number' ? job.date : 0,
    totalDuration: typeof job.totalDuration === 'string' ? job.totalDuration : '',
    clips,
    historyId: typeof job.historyId === 'string' ? job.historyId : undefined,
  };
}

export function loadRecentJobs(): RecentJob[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.map(sanitizeRecentJob).filter((x): x is RecentJob => x !== null);
  } catch {
    return [];
  }
}

function persistRecentJobs(jobs: RecentJob[]): void {
  // Thumbnails are base64 data URLs — a few jobs can blow the ~5MB localStorage
  // quota. On quota errors, retry with thumbnails stripped from older jobs,
  // then with all thumbnails stripped, then with fewer jobs. History is
  // best-effort: if it still fails, give up silently.
  let list = jobs.slice(0, RECENT_MAX);
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(list));
      return;
    } catch {
      const stripThumbs = (j: RecentJob): RecentJob =>
        ({ ...j, clips: Array.isArray(j.clips) ? j.clips.map(c => ({ ...c, thumbnailDataUrl: undefined })) : [] });
      if (attempt === 0) {
        list = list.map((j, i) => i === 0 ? j : stripThumbs(j));
      } else if (attempt === 1) {
        list = list.map(stripThumbs);
      } else {
        list = list.slice(0, Math.max(1, Math.floor(list.length / 2)));
      }
    }
  }
}

export function saveRecentJob(job: RecentJob): RecentJob[] {
  persistRecentJobs([job, ...loadRecentJobs().filter(j => j.id !== job.id)]);
  return loadRecentJobs();
}

export function deleteRecentJob(id: string): RecentJob[] {
  const next = loadRecentJobs().filter(j => j.id !== id);
  persistRecentJobs(next);
  return next;
}

export function clearRecentJobs(): void {
  try { localStorage.removeItem(RECENT_KEY); } catch { /* best-effort */ }
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

// ─── Back-button support for overlays ─────────────────────────────────────────
// Mobile users press the phone's Back button expecting the overlay to close —
// not to leave the site. Push a history entry when the overlay mounts; popstate
// closes it. If it's closed another way (X / backdrop / Escape), consume the
// entry we pushed so a later Back doesn't need a double-press.
export function useCloseOnBack(onClose: () => void) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const poppedRef = useRef(false);
  useEffect(() => {
    poppedRef.current = false;
    window.history.pushState({ overlay: true }, '');
    const onPop = () => { poppedRef.current = true; onCloseRef.current(); };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      if (!poppedRef.current) window.history.back();
    };
  }, []);
}

// ─── Video Player Modal ───────────────────────────────────────────────────────
export function VideoModal({ clip, onClose }: { clip: Clip; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [loadError, setLoadError] = useState(false);

  useCloseOnBack(onClose);

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
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/90 backdrop-blur-md" />

      {/* Modal — width follows the 9:16 video so header/buttons stay aligned */}
      <div
        className="relative z-10 w-full max-w-sm mx-auto flex flex-col"
        style={{ width: 'min(24rem, calc(100vw - 2rem), calc((100dvh - 170px) * 9 / 16))' }}
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

        {/* Video — fixed 9:16 box so the player always matches the modal width */}
        <div className="relative w-full aspect-[9/16] rounded-2xl overflow-hidden bg-black shadow-2xl shadow-black/50">
          <video
            ref={videoRef}
            src={`${API}/video/file/${clip.id}`}
            controls
            autoPlay
            playsInline
            onError={() => setLoadError(true)}
            className="w-full h-full block object-contain bg-black"
          />
          {loadError && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/85 p-6 text-center">
              <div className="text-3xl mb-3">⏳</div>
              <p className="text-white font-bold text-sm mb-1">This clip has expired</p>
              <p className="text-white/50 text-xs leading-relaxed">Old clips are cleaned up after a while. Paste the video link again to regenerate it.</p>
            </div>
          )}
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
export function ClipCard({ clip, index, onPlay }: { clip: Clip; index: number; onPlay: () => void }) {
  const [imgError, setImgError] = useState(false);
  const [dlState, setDlState] = useState<'idle' | 'downloading' | 'done'>('idle');
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  function handleDownload(e: React.MouseEvent<HTMLAnchorElement>) {
    e.stopPropagation();
    if (dlState !== 'idle') return;
    setDlState('downloading');
    setTimeout(() => {
      setDlState('done');
      setTimeout(() => setDlState('idle'), 2000);
    }, 1400);
  }

  async function handleCopyCaption(e: React.MouseEvent) {
    e.stopPropagation();
    if (!clip.caption || copyState !== 'idle') return;
    const ok = await copyText(clip.caption);
    setCopyState(ok ? 'copied' : 'failed');
    setTimeout(() => setCopyState('idle'), 1800);
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

        {/* Play button — always visible so users know clips are tappable */}
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="w-12 h-12 rounded-full bg-black/45 backdrop-blur-sm border border-white/25 flex items-center justify-center shadow-lg transition-all duration-200 group-hover:scale-110 group-hover:bg-[#D1FE17]">
            <Play className="w-5 h-5 text-white ml-0.5 group-hover:text-black transition-colors" fill="currentColor" />
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

      {/* Viral caption + one-tap copy (new jobs only — old clips have none) */}
      {clip.caption && (
        <div className="px-3 pb-3 -mt-1">
          <p
            className="text-white/50 text-[11px] leading-snug whitespace-pre-line"
            style={{ display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
          >
            {clip.caption}
          </p>
          <button
            type="button"
            onClick={handleCopyCaption}
            className={[
              'mt-2 w-full flex items-center justify-center gap-1.5 text-[11px] font-black px-3 py-2 rounded-xl transition-all duration-200 select-none',
              copyState === 'copied'
                ? 'bg-white/10 text-[#D1FE17] scale-95'
                : copyState === 'failed'
                  ? 'bg-white/10 text-red-300'
                  : 'bg-white/5 text-white/80 hover:bg-white/10 active:scale-95',
            ].join(' ')}
          >
            {copyState === 'copied' && (
              <>
                <Check className="w-3.5 h-3.5" />
                Copied!
              </>
            )}
            {copyState === 'failed' && (
              <>
                <X className="w-3.5 h-3.5" />
                Couldn&apos;t copy — select the text above
              </>
            )}
            {copyState === 'idle' && (
              <>
                <Copy className="w-3.5 h-3.5" />
                Copy caption
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Platform config ──────────────────────────────────────────────────────────
// Official TikTok note glyph — rendered 3× (cyan + pink offsets under white)
// to recreate the brand's signature chromatic look.
const TIKTOK_PATH = 'M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z';

const PLATFORMS = [
  {
    id: 'tiktok', label: 'TikTok', sub: '9:16 · 60s', maxDur: 60,
    icon: (
      <svg viewBox="0 0 24 24" className="w-5 h-5 overflow-visible">
        <path d={TIKTOK_PATH} fill="#25F4EE" transform="translate(-0.6 -0.4)" />
        <path d={TIKTOK_PATH} fill="#FE2C55" transform="translate(0.6 0.4)" />
        <path d={TIKTOK_PATH} fill="#fff" />
      </svg>
    ),
  },
  {
    id: 'reels', label: 'Reels', sub: '9:16 · 90s', maxDur: 90,
    icon: (
      <svg viewBox="0 0 24 24" className="w-5 h-5">
        <defs>
          <linearGradient id="igReelsGrad" x1="0%" y1="100%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#FFD600" />
            <stop offset="30%" stopColor="#FF7A00" />
            <stop offset="60%" stopColor="#FF0069" />
            <stop offset="100%" stopColor="#D300C5" />
          </linearGradient>
        </defs>
        <path fill="url(#igReelsGrad)" d="M12 0C8.74 0 8.333.015 7.053.072 5.775.132 4.905.333 4.14.63c-.789.306-1.459.717-2.126 1.384S.935 3.35.63 4.14C.333 4.905.131 5.775.072 7.053.012 8.333 0 8.74 0 12s.015 3.667.072 4.947c.06 1.277.261 2.148.558 2.913.306.788.717 1.459 1.384 2.126.667.666 1.336 1.079 2.126 1.384.766.296 1.636.499 2.913.558C8.333 23.988 8.74 24 12 24s3.667-.015 4.947-.072c1.277-.06 2.148-.262 2.913-.558.788-.306 1.459-.718 2.126-1.384.666-.667 1.079-1.335 1.384-2.126.296-.765.499-1.636.558-2.913.06-1.28.072-1.687.072-4.947s-.015-3.667-.072-4.947c-.06-1.277-.262-2.149-.558-2.913-.306-.789-.718-1.459-1.384-2.126C21.319 1.347 20.651.935 19.86.63c-.765-.297-1.636-.499-2.913-.558C15.667.012 15.26 0 12 0zm0 2.16c3.203 0 3.585.016 4.85.071 1.17.055 1.805.249 2.227.415.562.217.96.477 1.382.896.419.42.679.819.896 1.381.164.422.36 1.057.413 2.227.057 1.266.07 1.646.07 4.85s-.015 3.585-.074 4.85c-.061 1.17-.256 1.805-.421 2.227-.224.562-.479.96-.899 1.382-.419.419-.824.679-1.38.896-.42.164-1.065.36-2.235.413-1.274.057-1.649.07-4.859.07-3.211 0-3.586-.015-4.859-.074-1.171-.061-1.816-.256-2.236-.421-.569-.224-.96-.479-1.379-.899-.421-.419-.69-.824-.9-1.38-.165-.42-.359-1.065-.42-2.235-.045-1.26-.061-1.649-.061-4.844 0-3.196.016-3.586.061-4.861.061-1.17.255-1.814.42-2.234.21-.57.479-.96.9-1.381.419-.419.81-.689 1.379-.898.42-.166 1.051-.361 2.221-.421 1.275-.045 1.65-.06 4.859-.06zm0 3.678c-3.405 0-6.162 2.76-6.162 6.162 0 3.405 2.76 6.162 6.162 6.162 3.405 0 6.162-2.76 6.162-6.162 0-3.405-2.76-6.162-6.162-6.162zM12 16c-2.21 0-4-1.79-4-4s1.79-4 4-4 4 1.79 4 4-1.79 4-4 4zm7.846-10.405c0 .795-.646 1.44-1.44 1.44-.795 0-1.44-.646-1.44-1.44 0-.794.646-1.439 1.44-1.439.793-.001 1.44.645 1.44 1.439z" />
      </svg>
    ),
  },
  {
    id: 'shorts', label: 'Shorts', sub: '9:16 · 60s', maxDur: 60,
    icon: (
      <svg viewBox="0 0 24 24" className="w-5 h-5">
        <path fill="#FF0000" d="M17.77 10.32l-1.2-.5L18 9.06a3.74 3.74 0 0 0-3.5-6.62L6 6.94a3.74 3.74 0 0 0 .23 6.74l1.2.49L6 14.93a3.75 3.75 0 0 0 3.5 6.63l8.5-4.5a3.74 3.74 0 0 0-.23-6.74z" />
        <path fill="#fff" d="M10 14.65v-5.3L15 12l-5 2.65z" />
      </svg>
    ),
  },
  {
    id: 'original', label: 'Original', sub: '16:9 · No crop', maxDur: 300,
    icon: <Film className="w-5 h-5 text-white/80" />,
  },
] as const;
type PlatformId = typeof PLATFORMS[number]['id'];

// ─── Quality config ───────────────────────────────────────────────────────────
// 720p is what Shorts/TikTok/Reels effectively deliver after their own
// re-encode; 1080p is available for users who want full-HD source files but
// takes noticeably longer on the server.
const QUALITIES = [
  { id: 'fast',    label: '720p',  sub: 'Fast · recommended' },
  { id: 'quality', label: '1080p', sub: 'Full HD · slightly slower' },
] as const;
type QualityId = typeof QUALITIES[number]['id'];

// ─── Settings Panel ───────────────────────────────────────────────────────────
function SettingsPanel({
  platform, setPlatform,
  duration, setDuration,
  clipCount, setClipCount,
  quality, setQuality,
}: {
  platform: PlatformId; setPlatform: (v: PlatformId) => void;
  duration: number; setDuration: (v: number) => void;
  clipCount: number; setClipCount: (v: number) => void;
  quality: QualityId; setQuality: (v: QualityId) => void;
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
                  <span className="leading-none">{p.icon}</span>
                  <span className="text-xs font-black leading-none">{p.label}</span>
                  <span className="text-[10px] text-white/35 leading-none font-medium">{p.sub}</span>
                  {platform === p.id && (
                    <div className="w-1.5 h-1.5 rounded-full bg-[#D1FE17] mt-0.5" />
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Quality picker */}
          <div>
            <label className="block text-white/45 text-[11px] font-bold uppercase tracking-widest mb-3">Quality</label>
            <div className="grid grid-cols-2 gap-2">
              {QUALITIES.map(q => (
                <button
                  key={q.id}
                  type="button"
                  onClick={() => setQuality(q.id)}
                  className={`flex flex-col items-center gap-1 py-3 px-2 rounded-2xl border text-center transition-all ${
                    quality === q.id
                      ? 'border-[#D1FE17]/60 bg-[#D1FE17]/8 text-white'
                      : 'border-white/8 bg-[#1a1a1a] text-white/50 hover:border-white/20 hover:text-white/80'
                  }`}
                >
                  <span className="text-xs font-black leading-none">{q.label}</span>
                  <span className="text-[10px] text-white/35 leading-none font-medium">{q.sub}</span>
                  {quality === q.id && (
                    <div className="w-1.5 h-1.5 rounded-full bg-[#D1FE17] mt-0.5" />
                  )}
                </button>
              ))}
            </div>
            {quality === 'quality' && (
              <p className="text-white/40 text-[11px] mt-2 leading-relaxed">
                Full-HD clips take a little longer to render — with many clips, expect some extra wait.
              </p>
            )}
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

// ─── Source Platforms ─────────────────────────────────────────────────────────
const SOURCE_PLATFORMS = [
  {
    id: 'youtube', label: 'YouTube', placeholder: 'https://youtube.com/watch?v=…',
    color: '#FF0000', bg: 'rgba(255,0,0,0.12)', border: 'rgba(255,0,0,0.4)',
    icon: (
      <svg viewBox="0 0 24 24" className="w-5 h-5" fill="currentColor">
        <path d="M23.5 6.19a3.02 3.02 0 0 0-2.12-2.14C19.54 3.5 12 3.5 12 3.5s-7.54 0-9.38.55A3.02 3.02 0 0 0 .5 6.19C0 8.04 0 12 0 12s0 3.96.5 5.81a3.02 3.02 0 0 0 2.12 2.14C4.46 20.5 12 20.5 12 20.5s7.54 0 9.38-.55a3.02 3.02 0 0 0 2.12-2.14C24 15.96 24 12 24 12s0-3.96-.5-5.81zM9.75 15.5v-7l6.5 3.5-6.5 3.5z"/>
      </svg>
    ),
  },
  {
    id: 'kick', label: 'Kick ⚠️', placeholder: 'https://kick.com/channel — live only',
    color: '#53FC18', bg: 'rgba(83,252,24,0.10)', border: 'rgba(83,252,24,0.35)',
    icon: (
      <svg viewBox="0 0 24 24" className="w-5 h-5" fill="currentColor">
        <path d="M3 2h4v8l5-8h5l-6 9 6 11h-5l-5-9v9H3V2z"/>
      </svg>
    ),
  },
  {
    id: 'twitch', label: 'Twitch', placeholder: 'https://twitch.tv/videos/…',
    color: '#9146FF', bg: 'rgba(145,70,255,0.12)', border: 'rgba(145,70,255,0.4)',
    icon: (
      <svg viewBox="0 0 24 24" className="w-5 h-5" fill="currentColor">
        <path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714z"/>
      </svg>
    ),
  },
  {
    id: 'gdrive', label: 'Google Drive', placeholder: 'https://drive.google.com/file/d/…',
    color: '#4285F4', bg: 'rgba(66,133,244,0.12)', border: 'rgba(66,133,244,0.4)',
    icon: (
      <svg viewBox="0 0 24 24" className="w-5 h-5" fill="currentColor">
        <path d="M6.28 3L1 12.36l3.72 6.44L10 9.44zm11.44 0L12 9.44l3.28 5.68h6.44zM9.72 11.8L6 18.8h12l-3.72-7z" style={{fill:'#4285F4'}}/>
        <path d="M1 12.36L6.28 3h5.44L6 12.36z" style={{fill:'#34A853'}}/>
        <path d="M12 9.44l5.72-6.44H18l-6.28 10.88L9.72 9.44z" style={{fill:'#FBBC04'}}/>
      </svg>
    ),
  },
  {
    id: 'dropbox', label: 'Dropbox', placeholder: 'https://dropbox.com/s/…',
    color: '#0061FF', bg: 'rgba(0,97,255,0.12)', border: 'rgba(0,97,255,0.4)',
    icon: (
      <svg viewBox="0 0 24 24" className="w-5 h-5" fill="currentColor">
        <path d="M6 2L0 6l6 4-6 4 6 4 6-4-6-4 6-4zm12 0l-6 4 6 4-6 4 6 4 6-4-6-4 6-4zM6 16.5L12 20.5l6-4-6-4z"/>
      </svg>
    ),
  },
  {
    id: 'upload', label: 'My device', placeholder: '',
    color: '#D1FE17', bg: 'rgba(209,254,23,0.10)', border: 'rgba(209,254,23,0.4)',
    icon: <UploadIcon className="w-5 h-5" />,
  },
] as const;
type SourcePlatformId = typeof SOURCE_PLATFORMS[number]['id'];

function detectPlatformFromUrl(url: string): SourcePlatformId | null {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    if (h === 'youtube.com' || h === 'youtu.be') return 'youtube';
    if (h === 'kick.com')                         return 'kick';
    if (h === 'twitch.tv' || h === 'clips.twitch.tv') return 'twitch';
    if (h === 'drive.google.com')                 return 'gdrive';
    if (h === 'dropbox.com')                      return 'dropbox';
  } catch { /* invalid URL — ignore */ }
  return null;
}

// ─── Stat Pills ───────────────────────────────────────────────────────────────
const STATS = [
  { label: '1M+ videos clipped', icon: '🎬' },
  { label: '10x faster creation', icon: '⚡' },
  { label: 'YouTube · Kick · Twitch · Drive', icon: '📱' },
];

// ─── FAQ ──────────────────────────────────────────────────────────────────────
const FAQ_ITEMS = [
  {
    q: 'What is AutoCliper?',
    a: 'AutoCliper is an AI video clipping tool. Paste a long video from YouTube, Kick, Twitch, Google Drive or Dropbox — or upload one from your device — and it automatically cuts the best moments into short, viral-ready clips for TikTok, Reels and Shorts.',
  },
  {
    q: 'How does AutoCliper work?',
    a: 'Choose your source platform, paste the link (or pick a file), select your clip style and hit Get Clips. Our engine scans the video, finds the loudest and most exciting moments, crops them to vertical 9:16 and hands you ready-to-post clips — usually in under 2 minutes.',
  },
  {
    q: 'Which platforms can I clip from?',
    a: 'YouTube videos, Kick live streams, Twitch VODs and clips, Google Drive links, Dropbox links, and direct uploads from your phone or computer (up to 2 GB). Output styles: TikTok, Reels, Shorts (9:16) or Original 16:9 with no crop.',
  },
  {
    q: 'What are credits and how do they work?',
    a: 'Every clip costs 50 credits. A new account gets 150 free credits — that is 3 free clips, no card needed. Plan credits refill every month, and top-up credits never expire, so you can stack them safely.',
  },
  {
    q: 'Do my clips expire?',
    a: 'No. Clips saved to your account stay available in My videos — download them again anytime, from any device. Clips made without an account are remembered in your browser on that device.',
  },
  {
    q: 'Can I earn money from these clips?',
    a: 'Yes — the clips are made from your source video, so if you have the rights to that content you can post and monetize the clips on TikTok, Reels, Shorts or anywhere else, just like any other edit you make.',
  },
  {
    q: 'How does the referral program work?',
    a: 'Every account gets a unique share link. When a friend joins through your link and buys any plan, you instantly receive 1000 credits — that is 20 free clips. There is no limit, so refer as many friends as you like.',
  },
  {
    q: 'Can I cancel anytime?',
    a: 'Yes, there is no lock-in. If you stop your plan, the credits you already received stay usable, and your saved clips remain downloadable from your account.',
  },
];

function FaqSection() {
  const [open, setOpen] = useState<number | null>(0);
  return (
    <section id="faq" className="py-16 px-4 sm:px-6">
      <div className="max-w-3xl mx-auto">
        <h2 className="text-3xl sm:text-4xl font-black text-center leading-tight mb-3">
          Got questions? <span className="text-[#D1FE17]">We've got answers.</span>
        </h2>
        <p className="text-center text-white/35 text-sm mb-10">Everything you need to know about AutoCliper.</p>
        <div className="space-y-3">
          {FAQ_ITEMS.map((f, i) => (
            <div key={f.q} className="bg-[#161616] border border-white/8 rounded-2xl overflow-hidden hover:border-white/15 transition-colors">
              <button
                type="button"
                onClick={() => setOpen(open === i ? null : i)}
                className="w-full flex items-center justify-between gap-4 px-5 sm:px-6 py-4 text-left"
              >
                <span className="text-white text-sm sm:text-base font-bold">{f.q}</span>
                <Plus className={`w-5 h-5 text-[#D1FE17] shrink-0 transition-transform duration-200 ${open === i ? 'rotate-45' : ''}`} />
              </button>
              {open === i && (
                <p className="px-5 sm:px-6 pb-5 text-white/50 text-sm leading-relaxed">{f.a}</p>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─── History Panel ────────────────────────────────────────────────────────────
// ─── Source presentation helpers ──────────────────────────────────────────────
type SourceKind = 'youtube' | 'upload' | 'dropbox' | 'kick' | 'link';

/** Human-friendly source description for history rows — never raw query-string URLs. */
export function sourceInfo(url: string): { label: string; sub: string | null; kind: SourceKind } {
  if (url.startsWith('upload://')) {
    const raw = url.split('/').pop() ?? '';
    let name = raw;
    // Malformed %-encoding must never crash the drawer — fall back to raw.
    try { name = decodeURIComponent(raw); } catch { /* keep raw */ }
    return { label: name || 'Uploaded video', sub: 'From this device', kind: 'upload' };
  }
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    const path = u.pathname.replace(/\/+$/, '');
    if (host === 'youtu.be' || host.endsWith('youtube.com')) {
      const segs = path.split('/').filter(Boolean);
      const id =
        host === 'youtu.be' ? segs[0] :
        (segs[0] === 'shorts' || segs[0] === 'live' || segs[0] === 'embed') ? segs[1] :
        u.searchParams.get('v');
      return { label: 'YouTube video', sub: id ? `youtu.be/${id}` : host + path, kind: 'youtube' };
    }
    if (host.endsWith('dropbox.com')) return { label: 'Dropbox video', sub: host + path, kind: 'dropbox' };
    if (host.endsWith('kick.com')) {
      const segs = path.split('/').filter(Boolean);
      const ch = segs[0] && segs[0] !== 'video' ? segs[0] : null;
      return { label: ch ? `Kick · ${ch}` : 'Kick video', sub: host + path, kind: 'kick' };
    }
    if (host.endsWith('twitch.tv')) return { label: 'Twitch video', sub: host + path, kind: 'link' };
    return { label: host, sub: host + path, kind: 'link' };
  } catch {
    return { label: url.slice(0, 42), sub: null, kind: 'link' };
  }
}

/** "Jul 31 · 7:04 PM" — empty string for missing/invalid timestamps. */
export function fmtDateTime(t: number | string): string {
  const d = new Date(t);
  if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    + ' · '
    + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

export function SourceBadge({ kind }: { kind: SourceKind }) {
  const Icon =
    kind === 'youtube' ? Youtube :
    kind === 'upload' ? FileVideo :
    kind === 'kick' ? Radio :
    kind === 'dropbox' ? Box : Globe;
  return (
    <div className="w-10 h-10 shrink-0 rounded-xl bg-white/[0.06] border border-white/10 flex items-center justify-center">
      <Icon className="w-[18px] h-[18px] text-white/60" />
    </div>
  );
}

interface HistoryJob {
  id: string;
  source_url: string;
  platform: string;
  clip_duration: number;
  clip_count: number;
  total_duration: string | null;
  created_at: string;
  /** Clip files linked to this session — present while still downloadable. */
  clips?: Clip[] | null;
  /** True when clips existed but their storage TTL has passed. */
  clips_expired?: boolean;
  clips_expire_at?: string | null;
}

export function HistoryPanel({ onRerun, onPlay, localJobs = [] }: {
  onRerun: (url: string, platform: string, clipDuration: number, clipCount: number) => void;
  onPlay?: (clip: Clip) => void;
  localJobs?: RecentJob[];
}) {
  const [jobs, setJobs] = useState<HistoryJob[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API}/history`, { credentials: 'include' })
      .then(r => r.json())
      .then(d => { setJobs(d.jobs ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const deleteJob = async (id: string) => {
    // Only drop the row from the list when the server confirms — a failed
    // delete (e.g. storage briefly unreachable) keeps the row so the user
    // can retry instead of the entry silently reappearing later.
    try {
      const res = await fetch(`${API}/history/${id}`, { method: 'DELETE', credentials: 'include' });
      if (res.ok) setJobs(j => j.filter(x => x.id !== id));
    } catch { /* network hiccup — keep the row visible */ }
  };

  // Sessions already shown as playable groups in the "on this device" section:
  // linked via historyId, or (for records saved before linking existed) the
  // same URL clipped within 24 hours.
  const isLocalTwin = (j: HistoryJob) => {
    const created = Date.parse(j.created_at);
    return localJobs.some(l =>
      l.historyId === String(j.id) ||
      (l.url === j.source_url && Number.isFinite(created) && Math.abs(l.date - created) < 24 * 3600 * 1000),
    );
  };
  const visible = jobs.filter(j => !isLocalTwin(j));

  if (loading) return (
    <div className="flex justify-center py-8">
      <Loader2 className="w-5 h-5 text-white/30 animate-spin" />
    </div>
  );

  // When everything the account knows about is already rendered in the
  // "on this device" section, an extra header + filler note is just noise.
  if (jobs.length === 0) {
    if (localJobs.length > 0) return null;
    return (
      <div className="text-center py-12">
        <div className="w-12 h-12 mx-auto mb-3 rounded-2xl bg-white/[0.05] border border-white/10 flex items-center justify-center">
          <History className="w-5 h-5 text-white/30" />
        </div>
        <p className="text-white/40 text-sm">No clips yet — generate your first one!</p>
      </div>
    );
  }

  if (visible.length === 0) return null;

  // Sessions whose clip files are still alive in storage — downloadable from
  // this device too. Rendered with the same expandable clip UI as local jobs.
  const downloadable: RecentJob[] = visible
    .filter(j => Array.isArray(j.clips) && j.clips.length > 0)
    .map(j => ({
      id: String(j.id),
      url: j.source_url,
      platform: j.platform,
      date: Date.parse(j.created_at) || 0,
      totalDuration: j.total_duration ?? '',
      clips: j.clips as Clip[],
    }));
  const rest = visible.filter(j => !(Array.isArray(j.clips) && j.clips.length > 0));

  return (
    <div>
      <p className="text-white/40 text-[11px] font-black uppercase tracking-widest mb-2 px-1">From your account</p>
      <div className="space-y-3">
      {downloadable.length > 0 && (
        <RecentJobList
          jobs={downloadable}
          onPlay={clip => onPlay?.(clip)}
          onDelete={id => deleteJob(id)}
        />
      )}
      {rest.map(job => {
        const info = sourceInfo(job.source_url);
        const meta = [
          `${job.clip_count} ${job.clip_count === 1 ? 'clip' : 'clips'} · ${job.clip_duration}s each`,
          fmtDateTime(job.created_at),
          info.sub ?? undefined,
        ].filter(Boolean).join(' · ');
        return (
          <div key={job.id} className="bg-[#161616] border border-white/[0.07] rounded-2xl p-3.5 transition-colors hover:border-white/[0.14]">
            <div className="flex items-center gap-3">
              <SourceBadge kind={info.kind} />
              <div className="flex-1 min-w-0">
                <p className="text-white/90 text-[13px] font-semibold truncate">{info.label}</p>
                <p className="text-white/35 text-[11px] mt-0.5 truncate">{meta}</p>
              </div>
              <button
                onClick={() => onRerun(job.source_url, job.platform, job.clip_duration, job.clip_count)}
                className="shrink-0 bg-[#D1FE17] text-black text-xs font-black px-3 py-1.5 rounded-lg hover:bg-[#c5f010] transition-colors"
              >
                Regenerate
              </button>
              <button
                onClick={() => deleteJob(job.id)}
                className="shrink-0 w-7 h-7 flex items-center justify-center rounded-lg text-white/20 hover:text-red-400 hover:bg-white/5 transition-colors"
                aria-label="Delete this session"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            {job.clips_expired && (
              <p className="text-white/30 text-[11px] mt-2 pl-[52px]">
                These clip files have expired — regenerate to get fresh ones.
              </p>
            )}
          </div>
        );
      })}
      </div>
    </div>
  );
}

// ─── Recent clip groups — shared by "My clips" (signed-out) & History drawer ──
function RecentJobList({ jobs, onPlay, onDelete }: {
  jobs: RecentJob[];
  onPlay: (clip: Clip) => void;
  onDelete: (id: string) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(jobs[0]?.id ?? null);

  return (
    <div className="space-y-3">
      {jobs.map(job => {
        const open = openId === job.id;
        const info = sourceInfo(job.url);
        const meta = [
          `${job.clips.length} ${job.clips.length === 1 ? 'clip' : 'clips'}`,
          job.totalDuration ? `${job.totalDuration} video` : undefined,
          job.date > 0 ? fmtDateTime(job.date) : undefined,
          info.sub ?? undefined,
        ].filter(Boolean).join(' · ');
        return (
          <div key={job.id} className={`bg-[#161616] border rounded-2xl overflow-hidden transition-colors ${open ? 'border-white/[0.14]' : 'border-white/[0.07] hover:border-white/[0.14]'}`}>
            <div className="w-full flex items-center pr-2">
              <button
                type="button"
                onClick={() => setOpenId(open ? null : job.id)}
                className="flex-1 min-w-0 flex items-center gap-3 p-3.5 text-left"
              >
                <SourceBadge kind={info.kind} />
                <div className="flex-1 min-w-0">
                  <p className="text-white/90 text-[13px] font-semibold truncate">{info.label}</p>
                  <p className="text-white/35 text-[11px] mt-0.5 truncate">{meta}</p>
                </div>
                <ChevronDown className={`w-4 h-4 text-white/40 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
              </button>
              <button
                type="button"
                onClick={() => onDelete(job.id)}
                className="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg text-white/20 hover:text-red-400 hover:bg-white/5 transition-colors"
                aria-label="Delete this video's clips"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            {open && (
              <div className="px-4 pb-4">
                <a
                  href={`${API}/video/zip?ids=${job.clips.map(c => c.id).join(',')}`}
                  download="clips.zip"
                  className="flex items-center justify-center gap-2 w-full bg-[#D1FE17] text-black text-xs font-black py-2.5 rounded-xl hover:bg-[#c5f010] active:scale-95 transition-all mb-3"
                >
                  <Download className="w-3.5 h-3.5" />
                  Download all ({job.clips.length})
                </a>
                <div className="grid grid-cols-2 gap-3">
                  {job.clips.map((clip, i) => (
                    <ClipCard key={clip.id} clip={clip} index={i} onPlay={() => onPlay(clip)} />
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Auth nav (session accounts) ────────────────────────────────────────────────
interface AuthNavProps {
  recentCount?: number;
}

function AuthNavButtons({ recentCount = 0 }: AuthNavProps) {
  const { user, logout } = useAuth();
  const [, setLocation] = useLocation();
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  useEffect(() => {
    if (!userMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('[data-user-menu]')) setUserMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [userMenuOpen]);

  if (!user) {
    return (
      <>
        <button
          onClick={() => setLocation('/login')}
          className="hidden sm:block text-sm font-semibold text-white/60 hover:text-white transition-colors"
        >Sign in</button>
        <button
          onClick={() => setLocation('/signup')}
          className="bg-white text-black text-sm font-black px-4 py-2 rounded-xl hover:bg-white/90 active:scale-95 transition-all"
        >Get started — Free</button>
      </>
    );
  }

  return (
    <>
      <Link
        href="/history"
        className="flex items-center gap-2 text-sm font-semibold text-white/60 hover:text-white transition-colors"
      >
        <History className="w-4 h-4" />
        <span className="hidden sm:inline">My videos</span>
        {recentCount > 0 && (
          <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-[#D1FE17] text-black text-[10px] font-black flex items-center justify-center">
            {recentCount}
          </span>
        )}
      </Link>
      <Link
        href="/account"
        className="flex items-center gap-1.5 bg-[#D1FE17]/10 border border-[#D1FE17]/30 text-[#D1FE17] rounded-xl px-3 py-1.5 text-sm font-black hover:bg-[#D1FE17]/20 transition-colors"
        title="Your credits"
      >
        <Zap className="w-4 h-4" />
        {user.credits.total}
      </Link>
      <div className="relative" data-user-menu>
        <button
          onClick={() => setUserMenuOpen(o => !o)}
          className="flex items-center gap-2 bg-white/8 hover:bg-white/12 border border-white/10 rounded-xl px-3 py-2 transition-colors"
        >
          <User className="w-4 h-4 text-white/60" />
          <span className="hidden sm:block text-sm font-semibold text-white/80 max-w-[100px] truncate">
            {user.name || user.email.split('@')[0]}
          </span>
        </button>
        {userMenuOpen && (
          <div className="absolute right-0 top-full mt-2 w-56 bg-[#1a1a1a] border border-white/10 rounded-2xl shadow-2xl shadow-black/60 overflow-hidden z-50">
            <div className="px-4 py-3 border-b border-white/8">
              <p className="text-white text-sm font-bold truncate">{user.name || 'Creator'}</p>
              <p className="text-white/40 text-xs truncate mt-0.5">{user.email}</p>
            </div>
            <button
              onClick={() => { setUserMenuOpen(false); setLocation('/history'); }}
              className="w-full flex items-center gap-3 px-4 py-3 text-white/70 hover:text-white hover:bg-white/5 text-sm transition-colors"
            >
              <History className="w-4 h-4" /> My videos
            </button>
            <button
              onClick={() => { setUserMenuOpen(false); setLocation('/account'); }}
              className="w-full flex items-center gap-3 px-4 py-3 text-white/70 hover:text-white hover:bg-white/5 text-sm transition-colors"
            >
              <Gift className="w-4 h-4 text-[#D1FE17]" /> Refer &amp; earn 1000
            </button>
            <button
              onClick={() => { setUserMenuOpen(false); setLocation('/account'); }}
              className="w-full flex items-center gap-3 px-4 py-3 text-white/70 hover:text-white hover:bg-white/5 text-sm transition-colors"
            >
              <CreditCard className="w-4 h-4" /> Account &amp; billing
            </button>
            <button
              onClick={() => { setUserMenuOpen(false); setLocation('/pricing'); }}
              className="w-full flex items-center gap-3 px-4 py-3 text-white/70 hover:text-white hover:bg-white/5 text-sm transition-colors"
            >
              <Zap className="w-4 h-4" /> Pricing &amp; credits
            </button>
            {user.role === 'admin' && (
              <button
                onClick={() => { setUserMenuOpen(false); setLocation('/admin'); }}
                className="w-full flex items-center gap-3 px-4 py-3 text-white/70 hover:text-white hover:bg-white/5 text-sm transition-colors"
              >
                <Shield className="w-4 h-4" /> Admin panel
              </button>
            )}
            <button
              onClick={async () => { setUserMenuOpen(false); await logout(); setLocation('/'); }}
              className="w-full flex items-center gap-3 px-4 py-3 text-red-400/70 hover:text-red-400 hover:bg-red-500/5 text-sm transition-colors border-t border-white/5"
            >
              <LogOut className="w-4 h-4" /> Sign out
            </button>
          </div>
        )}
      </div>
    </>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────────────────
export default function ClipperPage() {
  const { user, refresh } = useAuth();
  const isSignedIn = !!user;
  const [, setLocation] = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const [url, setUrl] = useState('');
  const [sourcePlatform, setSourcePlatform] = useState<SourcePlatformId>('youtube');
  const [duration, setDuration] = useState(30);
  const [clipCount, setClipCount] = useState(5);
  const [platform, setPlatform] = useState<PlatformId>('shorts');
  const [quality, setQuality] = useState<QualityId>('fast');
  const [videoFile, setVideoFile] = useState<File | null>(null); // "My device" source

  const [phase, setPhase] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [loadMsg, setLoadMsg] = useState('');
  const [clips, setClips] = useState<Clip[]>([]);
  const [totalDuration, setTotalDuration] = useState('');
  const [countNote, setCountNote] = useState('');
  const [error, setError] = useState('');
  const [errorCode, setErrorCode] = useState(''); // e.g. INSUFFICIENT_CREDITS → show "View plans"
  const [playingClip, setPlayingClip] = useState<Clip | null>(null);
  const [recentJobs, setRecentJobs] = useState<RecentJob[]>(() => loadRecentJobs());

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const jobIdRef = useRef<string | null>(null);
  // True once the server reports real pipeline steps — stops the canned rotation.
  const serverStageRef = useRef(false);
  // Job id shown with a Cancel button — only while the job waits in the queue
  const [cancellableJobId, setCancellableJobId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  // Stop background job polling + message rotation if the user leaves this page
  useEffect(() => () => {
    abortRef.current?.abort();
    if (intervalRef.current) clearInterval(intervalRef.current);
  }, []);

  const canSubmit = sourcePlatform === 'upload' ? !!videoFile : url.trim().startsWith('http');

  // Warm-on-paste: tell the server about a YouTube link the moment it lands in
  // the box, so the download engine converts while the user is still choosing
  // clip count/length. Best-effort — failures are silent, the server dedupes
  // and rate-limits, and the eventual job simply finds the source ready.
  const lastWarmedRef = useRef('');
  useEffect(() => {
    if (!user) return;
    const val = url.trim();
    if (!/^https?:\/\//i.test(val) || detectPlatformFromUrl(val) !== 'youtube') return;
    if (lastWarmedRef.current === val) return;
    const t = setTimeout(() => {
      lastWarmedRef.current = val;
      apiFetch('/video/warm', { method: 'POST', body: JSON.stringify({ url: val }) })
        .catch(() => { /* best-effort — the clip job works either way */ });
    }, 800);
    return () => clearTimeout(t);
  }, [url, user]);

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
    if (phase === 'loading') return; // guard against double-submit (rapid clicks/Enter)
    if (!user) { setLocation('/login?next=/'); return; } // clips need an account (credits)

    setPhase('loading');
    setError('');
    setErrorCode('');
    setClips([]);
    setCountNote('');
    serverStageRef.current = false; // new job — canned rotation runs until real stages arrive

    // Cancel any previous submission's polling before starting a new one
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    let idx = 0;
    let queuedAhead = 0; // >0 while the server has this job waiting in line
    // Rotation starts when clipping starts — for device uploads that is AFTER
    // the upload itself (the progress % owns the message until then).
    const startRotation = () => {
      setLoadMsg(MSGS[0]);
      intervalRef.current = setInterval(() => {
        if (queuedAhead > 0 || serverStageRef.current) return; // hold queue/server text — don't rotate over it
        idx = Math.min(idx + 1, MSGS.length - 1);
        setLoadMsg(MSGS[idx]);
      }, 4000);
    };

    try {
      // "My device": push the file up in 4MB parts first, then clip the
      // uploaded copy exactly like any other source.
      let jobUrl = url;
      if (sourcePlatform === 'upload') {
        if (!videoFile) { setPhase('idle'); return; }
        setLoadMsg('Uploading your video — 0%');
        const uploaded = await uploadVideoFile(API, videoFile, {
          signal: ac.signal,
          onProgress: pct => setLoadMsg(`Uploading your video — ${Math.floor(pct)}%`),
        });
        jobUrl = uploaded.url;
      }
      startRotation();

      // Async job + polling — survives the proxy's 120s limit on long videos
      const data = await requestClips(
        API,
        { url: jobUrl, clipDuration: duration, platform, clipCount, quality },
        {
          signal: ac.signal,
          onJobId: (id) => { jobIdRef.current = id; },
          onStatus: ({ status, queuePosition, stage }) => {
            if (status === 'queued' && queuePosition > 0) {
              queuedAhead = queuePosition;
              setLoadMsg(`Waiting in line — ${queuePosition} ${queuePosition === 1 ? 'job' : 'jobs'} ahead of you…`);
              // While queued the server can still cancel this job — offer the button
              setCancellableJobId(jobIdRef.current);
            } else {
              // Our turn — processing started; cancelling is no longer possible
              setCancellableJobId(null);
              if (queuedAhead > 0) {
                queuedAhead = 0;
                if (!serverStageRef.current) setLoadMsg(MSGS[idx]);
              }
              if (stage) {
                // Real pipeline step from the server beats canned rotating text
                serverStageRef.current = true;
                setLoadMsg(stage);
              }
            }
          },
        },
      );

      setClips(data.clips);
      setTotalDuration(data.totalDuration);
      setCountNote(typeof data.countNote === 'string' ? data.countNote : '');
      setPhase('done');

      // Save locally (this browser) so the finished clips survive a refresh
      // and stay downloadable — with or without an account.
      const localJob: RecentJob = {
        id: String(Date.now()),
        url: jobUrl,
        platform,
        date: Date.now(),
        totalDuration: data.totalDuration,
        clips: data.clips,
      };
      setRecentJobs(saveRecentJob(localJob));

      if (isSignedIn) {
        // Also record in account history, then link the device copy to the
        // server row so the History drawer shows one entry instead of two.
        fetch(`${API}/history`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            sourceUrl: jobUrl,
            platform,
            clipDuration: duration,
            clipCount: data.clips.length,
            totalDuration: data.totalDuration,
            // Link the finished clip files to the account so any signed-in
            // device can download them (thumbnails stripped — too big for DB).
            clips: data.clips.map(c => ({
              id: c.id, name: c.name, label: c.label,
              startTime: c.startTime, endTime: c.endTime,
              duration: c.duration, size: c.size, caption: c.caption,
            })),
          }),
        })
          .then(r => (r.ok ? r.json() : null))
          .then((d: { id?: string | number } | null) => {
            // Skip the link-back if the user already deleted this group —
            // re-saving would resurrect it.
            if (d?.id != null && loadRecentJobs().some(j => j.id === localJob.id)) {
              setRecentJobs(saveRecentJob({ ...localJob, historyId: String(d.id) }));
            }
          })
          .catch(() => {});
      }

      setTimeout(() => {
        resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 100);
    } catch (err) {
      if (ac.signal.aborted) return; // cancelled — user left or resubmitted
      if (err instanceof ClipJobCancelledError) {
        // Cancelled (this tab's button or another tab) — back to the form, no error
        setPhase('idle');
        return;
      }
      const apiErr = err as Error & { status?: number; code?: string };
      if (apiErr.status === 401) {
        setLocation('/login?next=/'); // session expired mid-flight
        return;
      }
      if (apiErr.code === 'INSUFFICIENT_CREDITS' || apiErr.status === 402) {
        setErrorCode('INSUFFICIENT_CREDITS');
      }
      setError(err instanceof Error ? err.message : String(err));
      setPhase('error');
    } finally {
      if (intervalRef.current) clearInterval(intervalRef.current);
      jobIdRef.current = null;
      setCancellableJobId(null);
      setCancelling(false);
      void refresh(); // credits moved (spent / refunded) — update the chip
    }
  };

  // Leave the line: tell the server to drop the waiting job, then reset the UI.
  const handleCancelJob = async () => {
    const jobId = cancellableJobId;
    if (!jobId || cancelling) return;
    setCancelling(true);
    const ok = await cancelClipJob(API, jobId);
    if (ok) {
      abortRef.current?.abort(); // stop polling
      if (intervalRef.current) clearInterval(intervalRef.current);
      jobIdRef.current = null;
      setCancellableJobId(null);
      setPhase('idle');
    }
    // If !ok the job already started processing — keep waiting; the button
    // disappears on the next 'processing' status update.
    setCancelling(false);
  };

  const reset = () => {
    setPhase('idle');
    setClips([]);
    setCountNote('');
    setUrl('');
    setError('');
    setErrorCode('');
    serverStageRef.current = false;
  };

  // Handoff from /history: "Regenerate" stores the job settings and navigates
  // here — pick them up once and prefill the form.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem('autocliper_rerun');
      if (!raw) return;
      sessionStorage.removeItem('autocliper_rerun');
      const r = JSON.parse(raw);
      if (typeof r?.url === 'string' && r.url) {
        setUrl(r.url);
        if (PLATFORMS.some(p => p.id === r.platform)) setPlatform(r.platform as PlatformId);
        if (Number.isFinite(r.clipDuration)) setDuration(Math.min(Math.max(Math.round(r.clipDuration), 5), 300));
        if (Number.isFinite(r.clipCount)) setClipCount(Math.min(Math.max(Math.round(r.clipCount), 1), 10));
      }
    } catch { /* corrupted handoff — land on an empty form */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="min-h-screen bg-[#0d0d0d] text-white font-sans">

      {/* ── Video Player Modal ────────────────────────────────────────────── */}
      {playingClip && (
        <VideoModal clip={playingClip} onClose={() => setPlayingClip(null)} />
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

          {/* Nav — desktop */}
          <div className="hidden md:flex items-center gap-6 text-sm font-medium text-white/50">
            <a href="#how" className="hover:text-white transition-colors">How it works</a>
            <a href="#features" className="hover:text-white transition-colors">Features</a>
          </div>

          {/* Right side: auth buttons + mobile hamburger */}
          <div className="flex items-center gap-3 shrink-0">
            {!isSignedIn && (
              <Link
                href="/history"
                className="flex items-center gap-2 text-sm font-semibold text-white/60 hover:text-white transition-colors"
              >
                <History className="w-4 h-4" />
                <span className="hidden sm:inline">My videos</span>
                {recentJobs.length > 0 && (
                  <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-[#D1FE17] text-black text-[10px] font-black flex items-center justify-center">
                    {recentJobs.length}
                  </span>
                )}
              </Link>
            )}
            <AuthNavButtons recentCount={recentJobs.length} />
            {/* Hamburger — mobile only */}
            <button
              type="button"
              onClick={() => setMobileMenuOpen(o => !o)}
              className="md:hidden w-9 h-9 flex items-center justify-center rounded-xl bg-white/5 hover:bg-white/10 transition-colors"
              aria-label="Toggle menu"
            >
              {mobileMenuOpen
                ? <X className="w-5 h-5 text-white/70" />
                : <Menu className="w-5 h-5 text-white/70" />}
            </button>
          </div>
        </div>

        {/* Mobile menu */}
        {mobileMenuOpen && (
          <div className="md:hidden border-t border-white/5 bg-[#0d0d0d]/95 px-4 py-3 flex flex-col gap-1">
            <a
              href="#how"
              onClick={() => setMobileMenuOpen(false)}
              className="text-sm font-medium text-white/60 hover:text-white transition-colors py-2 px-3 rounded-xl hover:bg-white/5"
            >How it works</a>
            <a
              href="#features"
              onClick={() => setMobileMenuOpen(false)}
              className="text-sm font-medium text-white/60 hover:text-white transition-colors py-2 px-3 rounded-xl hover:bg-white/5"
            >Features</a>
            <Link
              href="/history"
              onClick={() => setMobileMenuOpen(false)}
              className="text-left text-sm font-medium text-white/60 hover:text-white transition-colors py-2 px-3 rounded-xl hover:bg-white/5"
            >My videos {recentJobs.length > 0 ? `(${recentJobs.length})` : ''}</Link>
            <Link
              href="/pricing"
              onClick={() => setMobileMenuOpen(false)}
              className="text-sm font-medium text-white/60 hover:text-white transition-colors py-2 px-3 rounded-xl hover:bg-white/5"
            >Pricing</Link>
            {isSignedIn ? (
              <Link
                href="/account"
                onClick={() => setMobileMenuOpen(false)}
                className="text-sm font-medium text-white/60 hover:text-white transition-colors py-2 px-3 rounded-xl hover:bg-white/5"
              >Account &amp; credits</Link>
            ) : (
              <Link
                href="/login"
                onClick={() => setMobileMenuOpen(false)}
                className="text-sm font-medium text-white/60 hover:text-white transition-colors py-2 px-3 rounded-xl hover:bg-white/5"
              >Log in</Link>
            )}
          </div>
        )}
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
            YouTube, Kick, Twitch, Google Drive ya Dropbox — link paste karo,
            best moments dhundh ke short clips mein cut kar denge.
          </p>

          {/* ── Input bar ─────────────────────────────────────────────── */}
          <form onSubmit={handleSubmit} className="max-w-2xl mx-auto">
            {/* Source platform selector */}
            <div className="mb-4">
              <p className="text-white/30 text-xs font-semibold uppercase tracking-widest mb-3 text-center">Choose Source Platform</p>
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                {SOURCE_PLATFORMS.map(sp => {
                  const active = sourcePlatform === sp.id;
                  return (
                    <button
                      key={sp.id}
                      type="button"
                      onClick={() => setSourcePlatform(sp.id)}
                      style={active ? { background: sp.bg, borderColor: sp.border, color: sp.color } : {}}
                      className={`flex flex-col items-center gap-1.5 py-3 px-2 rounded-xl border text-center transition-all duration-200 ${
                        active
                          ? 'shadow-lg scale-105'
                          : 'bg-white/5 border-white/10 text-white/40 hover:bg-white/10 hover:border-white/20 hover:text-white/70 hover:scale-102'
                      }`}
                    >
                      <span style={{ color: sp.color }}>
                        {sp.icon}
                      </span>
                      <span className="text-[10px] font-bold leading-tight">{sp.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div
              className="relative flex items-center bg-[#1a1a1a] rounded-2xl p-1.5 transition-all shadow-xl shadow-black/30"
              style={{ border: `1.5px solid ${SOURCE_PLATFORMS.find(s => s.id === sourcePlatform)?.border ?? 'rgba(255,255,255,0.1)'}` }}
            >
              {sourcePlatform === 'upload' ? (
                <>
                  <FileVideo className="w-5 h-5 text-white/30 ml-3 shrink-0" />
                  <label
                    className={`flex-1 min-w-0 flex items-center gap-2 px-3 py-2.5 ${phase === 'loading' ? 'cursor-not-allowed' : 'cursor-pointer'}`}
                    onDragOver={e => e.preventDefault()}
                    onDrop={e => {
                      e.preventDefault();
                      if (phase === 'loading') return;
                      const f = e.dataTransfer.files?.[0];
                      if (f) setVideoFile(f);
                    }}
                  >
                    <input
                      type="file"
                      accept="video/*,.mp4,.mov,.m4v,.mkv,.webm,.avi"
                      className="hidden"
                      disabled={phase === 'loading'}
                      onChange={e => { setVideoFile(e.target.files?.[0] ?? null); e.target.value = ''; }}
                    />
                    {videoFile ? (
                      <>
                        <span className="truncate text-white text-sm sm:text-base font-medium">{videoFile.name}</span>
                        <span className="text-white/30 text-xs font-semibold shrink-0">{(videoFile.size / (1024 * 1024)).toFixed(1)} MB</span>
                      </>
                    ) : (
                      <span className="text-white/25 text-sm sm:text-base font-medium">Choose a video from your device — or drag &amp; drop…</span>
                    )}
                  </label>
                  {videoFile && phase !== 'loading' && (
                    <button
                      type="button"
                      onClick={() => setVideoFile(null)}
                      className="w-8 h-8 flex items-center justify-center text-white/30 hover:text-white/70 transition-colors shrink-0"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </>
              ) : (
                <>
                  <Link2 className="w-5 h-5 text-white/30 ml-3 shrink-0" />
                  <input
                    type="url"
                    value={url}
                    onChange={e => {
                      const val = e.target.value;
                      setUrl(val);
                      const detected = detectPlatformFromUrl(val);
                      if (detected) setSourcePlatform(detected);
                    }}
                    placeholder={SOURCE_PLATFORMS.find(s => s.id === sourcePlatform)?.placeholder ?? 'Paste a video link…'}
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
                </>
              )}
            </div>

            {/* Big CTA below the input — impossible to miss */}
            <button
              type="submit"
              disabled={!canSubmit || phase === 'loading'}
              className="w-full mt-3 bg-[#D1FE17] text-black text-base sm:text-lg font-black py-4 rounded-2xl hover:bg-[#c5f010] active:scale-[0.98] transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-lg shadow-[#D1FE17]/20"
            >
              {phase === 'loading' ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <Sparkles className="w-5 h-5" />
              )}
              Get Clips
            </button>
            {sourcePlatform === 'upload' && (
              <p className="text-white/25 text-[11px] font-semibold mt-2 text-center">
                MP4 · MOV · M4V · MKV · WEBM · AVI — up to 2 GB
              </p>
            )}

            {/* Settings */}
            <SettingsPanel
              platform={platform} setPlatform={setPlatform}
              duration={duration} setDuration={setDuration}
              clipCount={clipCount} setClipCount={setClipCount}
              quality={quality} setQuality={setQuality}
            />

          </form>

          {/* Credits nudge */}
          {user && user.credits.total === 0 && (
            <div className="max-w-2xl mx-auto mt-4 flex items-center justify-center gap-1.5 bg-amber-400/8 border border-amber-400/20 text-amber-200/90 text-xs font-semibold px-4 py-2.5 rounded-xl flex-wrap">
              <Zap className="w-3.5 h-3.5 shrink-0" />
              <span>You're out of credits —</span>
              <Link href="/pricing" className="text-[#D1FE17] font-black hover:underline">get more</Link>
              <span>to keep clipping.</span>
            </div>
          )}
          {!user && (
            <p className="max-w-2xl mx-auto mt-4 text-center text-xs text-white/35">
              Free to start — <Link href="/signup" className="text-[#D1FE17] font-bold hover:underline">create an account</Link> and get 3 free clips. No card needed.
            </p>
          )}

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
              Large videos may take 2–5 minutes. Don't close this tab.
            </p>
            {/* Progress bar */}
            <div className="mt-6 h-1 bg-white/5 rounded-full overflow-hidden max-w-xs mx-auto">
              <div className="h-full bg-[#D1FE17] rounded-full animate-pulse w-2/3" />
            </div>
            {/* Cancel — only while the job is still waiting in the queue */}
            {cancellableJobId && (
              <button
                type="button"
                onClick={handleCancelJob}
                disabled={cancelling}
                className="mt-6 inline-flex items-center gap-2 bg-white/8 hover:bg-white/15 disabled:opacity-50 text-white/80 hover:text-white text-sm font-bold px-5 py-2.5 rounded-xl border border-white/10 transition-colors"
              >
                <X className="w-4 h-4" />
                {cancelling ? 'Leaving the line…' : 'Cancel — leave the line'}
              </button>
            )}
          </div>
        </section>
      )}

      {/* ── Error state ───────────────────────────────────────────────────── */}
      {phase === 'error' && (
        <section className="py-12 px-4 text-center">
          <div className="max-w-md mx-auto bg-red-950/40 border border-red-500/20 rounded-2xl p-8">
            <AlertCircle className="w-10 h-10 text-red-400 mx-auto mb-4" />
            <h3 className="text-white text-lg font-bold mb-2">
              {errorCode === 'INSUFFICIENT_CREDITS' ? 'Not enough credits' : 'Something went wrong'}
            </h3>
            <p className="text-white/50 text-sm leading-relaxed mb-6">{error}</p>
            <div className="flex items-center justify-center gap-3 flex-wrap">
              {errorCode === 'INSUFFICIENT_CREDITS' && (
                <Link
                  href="/pricing"
                  className="bg-[#D1FE17] text-black text-sm font-black px-6 py-2.5 rounded-xl hover:bg-[#c5f010] transition-colors"
                >
                  View plans
                </Link>
              )}
              <button
                onClick={reset}
                className="bg-white/10 hover:bg-white/15 text-white text-sm font-bold px-6 py-2.5 rounded-xl transition-colors"
              >
                Try again
              </button>
            </div>
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
                {countNote && (
                  <p className="text-amber-200/80 text-xs font-semibold mt-1.5">{countNote}</p>
                )}
                <p className="text-white/40 text-sm mt-1">
                  From a {totalDuration} video · Tap any clip to play · Saved to{' '}
                  <Link
                    href="/history"
                    className="text-[#D1FE17] hover:underline font-semibold"
                  >My videos</Link>
                </p>
              </div>
              <div className="flex items-center gap-3">
                {/* Download all */}
                <button
                  onClick={async () => {
                    // Preferred: one ZIP download — mobile browsers show a single
                    // prompt instead of blocking N separate files.
                    const ids = clips.map(c => c.id).join(',');
                    try {
                      const check = await fetch(`${API}/video/zip?ids=${ids}&check=1`);
                      if (!check.ok) throw new Error('zip unavailable');
                      const a = document.createElement('a');
                      a.href = `${API}/video/zip?ids=${ids}`;
                      a.download = 'clips.zip';
                      document.body.appendChild(a);
                      a.click();
                      a.remove();
                      return;
                    } catch {
                      // Fall through to per-file downloads below.
                    }
                    // Fallback: stagger the downloads — many mobile browsers drop
                    // all but the first when N links are clicked in the same tick.
                    clips.forEach((c, i) => setTimeout(() => {
                      const a = document.createElement('a');
                      a.href = dlUrl(c.id);
                      a.download = c.name;
                      a.click();
                    }, i * 600));
                  }}
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
        <section id="how" className="py-20 px-4 sm:px-6">
          <div className="max-w-5xl mx-auto">
            <p className="text-center text-[#D1FE17] text-xs font-black uppercase tracking-[0.25em] mb-3">How it works</p>
            <h2 className="text-3xl sm:text-4xl font-black text-center leading-tight">
              Three steps. <span className="text-[#D1FE17]">That's it.</span>
            </h2>
            <p className="text-center text-white/35 text-sm sm:text-base mt-3 mb-12 max-w-lg mx-auto">
              No editor, no timeline, no learning curve — paste a link, wait a minute, post.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-6">
              {[
                { step: '01', title: 'Paste your link', desc: 'YouTube, Kick, Twitch, Google Drive ya Dropbox — or upload a video straight from your device.', icon: <Link2 className="w-5 h-5" /> },
                { step: '02', title: 'AI finds the moments', desc: 'The engine scans the full video and locks onto the loudest, most exciting parts worth posting.', icon: <Sparkles className="w-5 h-5" /> },
                { step: '03', title: 'Download & post', desc: 'Vertical, ready for TikTok, Reels & Shorts — grab one clip or download all of them at once.', icon: <Download className="w-5 h-5" /> },
              ].map((item, i) => (
                <div key={item.step} className="relative group">
                  <div className="relative h-full overflow-hidden bg-gradient-to-b from-[#1a1a1a] to-[#131313] border border-white/8 rounded-3xl p-6 sm:p-7 transition-all duration-300 group-hover:border-[#D1FE17]/30 group-hover:-translate-y-1">
                    <span className="absolute -top-2 right-4 text-[80px] font-black leading-none text-white/[0.045] select-none pointer-events-none">{item.step}</span>
                    <div className="w-12 h-12 rounded-2xl bg-[#D1FE17]/10 border border-[#D1FE17]/25 text-[#D1FE17] flex items-center justify-center mb-5">
                      {item.icon}
                    </div>
                    <div className="text-[#D1FE17] text-[11px] font-black uppercase tracking-widest mb-2">Step {item.step}</div>
                    <h3 className="text-white text-lg font-black mb-2">{item.title}</h3>
                    <p className="text-white/40 text-sm leading-relaxed">{item.desc}</p>
                  </div>
                  {i < 2 && (
                    <div className="hidden md:flex absolute top-1/2 -right-[26px] -translate-y-1/2 z-10 w-9 h-9 rounded-full bg-[#0d0d0d] border border-white/10 items-center justify-center">
                      <ArrowRight className="w-4 h-4 text-[#D1FE17]" />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* ── Features ──────────────────────────────────────────────────────── */}
      {phase === 'idle' && (
        <section id="features" className="py-10 pb-16 px-4 sm:px-6">
          <div className="max-w-5xl mx-auto">
            <p className="text-center text-[#D1FE17] text-xs font-black uppercase tracking-[0.25em] mb-3">What you get</p>
            <h2 className="text-3xl sm:text-4xl font-black text-center leading-tight mb-12">
              Built to make you <span className="text-[#D1FE17]">go viral.</span>
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {[
                { icon: <Scissors className="w-5 h-5" />, c: '#D1FE17', title: 'Smart trimming', desc: 'The loudest, most viral moments — never boring random cuts.' },
                { icon: <Smartphone className="w-5 h-5" />, c: '#9146FF', title: '9:16 vertical', desc: 'Auto-cropped for TikTok, Reels & Shorts — no editing needed.' },
                { icon: <Zap className="w-5 h-5" />, c: '#FBBF24', title: 'Ready in ~2 min', desc: 'From pasted link to downloadable clips in about two minutes.' },
                { icon: <Globe className="w-5 h-5" />, c: '#38BDF8', title: 'Every source covered', desc: 'YouTube, Kick, Twitch, Drive, Dropbox — even files on your phone.' },
              ].map(f => (
                <div key={f.title} className="bg-[#161616] border border-white/8 rounded-3xl p-6 transition-all duration-300 hover:-translate-y-1 hover:border-white/20">
                  <div
                    className="w-11 h-11 rounded-xl flex items-center justify-center mb-4"
                    style={{ background: `${f.c}1A`, border: `1px solid ${f.c}40`, color: f.c }}
                  >
                    {f.icon}
                  </div>
                  <div className="text-white text-base font-black mb-1.5">{f.title}</div>
                  <div className="text-white/40 text-sm leading-relaxed">{f.desc}</div>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* ── FAQ ───────────────────────────────────────────────────────────── */}
      {phase === 'idle' && <FaqSection />}

      {/* ── Refer & earn banner ───────────────────────────────────────────── */}
      {phase === 'idle' && (
        <section className="py-6 pb-20 px-4 sm:px-6">
          <div className="max-w-5xl mx-auto relative overflow-hidden bg-gradient-to-br from-[#D1FE17]/15 via-[#161616] to-[#161616] border border-[#D1FE17]/25 rounded-3xl p-8 sm:p-10 text-center">
            <div className="absolute -top-24 -right-24 w-64 h-64 bg-[#D1FE17]/10 rounded-full blur-3xl pointer-events-none" />
            <div className="inline-flex items-center gap-2 bg-[#D1FE17]/10 border border-[#D1FE17]/25 rounded-full px-4 py-1.5 mb-4">
              <Gift className="w-3.5 h-3.5 text-[#D1FE17]" />
              <span className="text-[#D1FE17] text-xs font-black uppercase tracking-widest">Refer &amp; earn</span>
            </div>
            <h2 className="text-3xl sm:text-4xl font-black leading-tight">
              Refer a friend, get <span className="text-[#D1FE17]">1000 credits</span>
            </h2>
            <p className="text-white/45 text-sm sm:text-base mt-3 max-w-xl mx-auto">
              Share your link — when your friend buys any plan, you instantly get 1000 credits
              (20 free clips). No limit, refer as many friends as you like.
            </p>
            <Link
              href={isSignedIn ? '/account' : '/signup'}
              className="inline-flex items-center gap-2 bg-[#D1FE17] text-black font-black px-7 py-3.5 rounded-full hover:bg-[#c2ef0e] active:scale-95 transition-all mt-6"
            >
              <Gift className="w-4 h-4" />
              {isSignedIn ? 'Get your referral link' : 'Sign up & get your link'}
            </Link>
          </div>
        </section>
      )}

      {/* ── Footer ────────────────────────────────────────────────────────── */}
      <Footer />
    </div>
  );
}
