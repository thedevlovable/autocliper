import { Sidebar } from '../components/Sidebar';
import { tools } from '../lib/data';
import { Link } from 'wouter';
import {
  ArrowLeft, Play, Download, Wand2, Scissors, Mic, Image as ImageIcon,
  Copy, Check, Clock, FileAudio, AlertCircle, ExternalLink, Search,
  ChevronRight, Sparkles, Video, Crop
} from 'lucide-react';
import { useState, useRef } from 'react';

// ─── API base ────────────────────────────────────────────────────────────────
const API = import.meta.env.BASE_URL.replace(/\/$/, '') + '/api';

// ─── Types ───────────────────────────────────────────────────────────────────
interface Clip { id: string; name: string; label: string; startTime: string; endTime: string; duration: string; size: number; thumbnailId?: string }
interface TranscriptSegment { start: string; end: string; text: string }
interface SearchResult { id: string; title: string; url: string; duration: string | null; channel: string | null; thumbnail: string }

type ToolOutput =
  | { type: 'clips'; clips: Clip[]; totalDuration: string }
  | { type: 'transcript'; text: string; segments: TranscriptSegment[]; wordCount: number }
  | { type: 'audio'; id: string; name: string; size: number }
  | { type: 'file'; id: string; name: string; size: number }
  | { type: 'titles'; titles: string[] }
  | { type: 'search'; results: SearchResult[] }
  | { type: 'coming_soon' };

// ─── Helpers ─────────────────────────────────────────────────────────────────
function fmtBytes(b: number) {
  if (b > 1e9) return (b / 1e9).toFixed(1) + ' GB';
  if (b > 1e6) return (b / 1e6).toFixed(1) + ' MB';
  return (b / 1e3).toFixed(0) + ' KB';
}

function fileDownloadUrl(id: string) {
  return `${API}/video/file/${id}`;
}

// ─── Per-tool config ──────────────────────────────────────────────────────────
interface ToolConfig {
  live: boolean;
  inputFields: React.ReactNode;
  run: (state: FormState) => Promise<ToolOutput>;
}

interface FormState {
  url: string;
  clipDuration: number;
  vertical: boolean;
  viralMode: boolean;
  clipCount: number;
  topic: string;
  niche: string;
  prompt: string;
  trimStart: string;
  trimEnd: string;
}

function buildConfig(slug: string): ToolConfig {
  const post = async (endpoint: string, body: object) => {
    const r = await fetch(`${API}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await r.json();
    if (!r.ok) throw new Error(json.error || `Server error ${r.status}`);
    return json;
  };

  switch (slug) {
    // ── Auto Clip ────────────────────────────────────────────────────────────
    case 'auto-clip':
      return {
        live: true,
        inputFields: null,
        run: async (s) => {
          const data = await post('video/clip', {
            url: s.url,
            clipDuration: s.clipDuration,
            vertical: s.vertical,
            viralMode: s.viralMode,
            clipCount: s.clipCount,
          });
          return { type: 'clips', ...data };
        },
      };

    // ── Transcript ───────────────────────────────────────────────────────────
    case 'transcript':
      return {
        live: true,
        inputFields: null,
        run: async (s) => {
          const data = await post('video/transcript', { url: s.url });
          return { type: 'transcript', ...data };
        },
      };

    // ── Vocal Remover / Extract Audio ────────────────────────────────────────
    case 'vocal-remover':
      return {
        live: true,
        inputFields: null,
        run: async (s) => {
          const data = await post('video/extract-audio', { url: s.url });
          return { type: 'audio', ...data };
        },
      };

    // ── Direct Download ───────────────────────────────────────────────────────
    case 'download-video':
      return {
        live: true,
        inputFields: null,
        run: async (s) => {
          const data = await post('video/download', { url: s.url });
          return { type: 'file', ...data };
        },
      };

    // ── Trim / Cut ────────────────────────────────────────────────────────────
    case 'trim-video':
      return {
        live: true,
        inputFields: null,
        run: async (s) => {
          const data = await post('video/trim', {
            url: s.url,
            startTime: s.trimStart || '0',
            endTime: s.trimEnd,
          });
          return { type: 'file', ...data };
        },
      };

    // ── Crop to Vertical ──────────────────────────────────────────────────────
    case 'crop-vertical':
      return {
        live: true,
        inputFields: null,
        run: async (s) => {
          const data = await post('video/crop-vertical', { url: s.url });
          return { type: 'file', ...data };
        },
      };

    // ── Clip Finder ──────────────────────────────────────────────────────────
    case 'clip-finder':
      return {
        live: true,
        inputFields: null,
        run: async (s) => {
          const data = await post('video/clip-finder', { topic: s.topic, count: 8 });
          return { type: 'search', ...data };
        },
      };

    // ── Title Generator ──────────────────────────────────────────────────────
    case 'title-generator':
      return {
        live: true,
        inputFields: null,
        run: async (s) => {
          const data = await post('video/title-generator', { topic: s.topic, niche: s.niche });
          return { type: 'titles', ...data };
        },
      };

    default:
      return {
        live: false,
        inputFields: null,
        run: async () => ({ type: 'coming_soon' }),
      };
  }
}

// ─── Input form per slug ──────────────────────────────────────────────────────
function InputForm({
  slug,
  state,
  setState,
}: {
  slug: string;
  state: FormState;
  setState: React.Dispatch<React.SetStateAction<FormState>>;
}) {
  const inputCls =
    'w-full bg-black/5 border-2 border-transparent focus:bg-white focus:border-primary focus:ring-0 rounded-2xl p-4 outline-none transition-all font-medium text-black placeholder-black/30';
  const selectCls =
    'w-full bg-black/5 border-2 border-transparent focus:bg-white focus:border-primary rounded-xl p-3.5 outline-none transition-all font-medium appearance-none text-black';

  // Download-only tool
  if (slug === 'download-video' || slug === 'crop-vertical') {
    return (
      <div className="space-y-5">
        <div>
          <label className="block text-sm font-bold mb-2">Video URL</label>
          <input
            type="url"
            className={inputCls}
            placeholder="https://youtube.com/watch?v=..."
            value={state.url}
            onChange={(e) => setState((p) => ({ ...p, url: e.target.value }))}
          />
          <p className="text-xs text-black/40 font-medium mt-1.5">
            Supports YouTube, TikTok, Instagram, Twitter, and 1000+ sites
          </p>
        </div>
        {slug === 'crop-vertical' && (
          <div className="p-4 bg-black/5 rounded-2xl">
            <div className="font-bold text-sm mb-1">Output: 1080×1920 (9:16)</div>
            <div className="text-xs text-black/50 font-medium">
              Center-crops the video — ideal for Shorts, TikTok & Reels
            </div>
          </div>
        )}
      </div>
    );
  }

  // Trim tool
  if (slug === 'trim-video') {
    return (
      <div className="space-y-5">
        <div>
          <label className="block text-sm font-bold mb-2">Video URL</label>
          <input
            type="url"
            className={inputCls}
            placeholder="https://youtube.com/watch?v=..."
            value={state.url}
            onChange={(e) => setState((p) => ({ ...p, url: e.target.value }))}
          />
          <p className="text-xs text-black/40 font-medium mt-1.5">
            Supports YouTube, TikTok, Instagram, and 1000+ sites
          </p>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-bold mb-2">Start Time</label>
            <input
              type="text"
              className={inputCls}
              placeholder="0:00 or 00:00:00"
              value={state.trimStart}
              onChange={(e) => setState((p) => ({ ...p, trimStart: e.target.value }))}
            />
          </div>
          <div>
            <label className="block text-sm font-bold mb-2">End Time</label>
            <input
              type="text"
              className={inputCls}
              placeholder="1:30 or 00:01:30"
              value={state.trimEnd}
              onChange={(e) => setState((p) => ({ ...p, trimEnd: e.target.value }))}
            />
          </div>
        </div>
        <div className="p-3 bg-black/5 rounded-xl text-xs font-medium text-black/50">
          Format: <strong>minutes:seconds</strong> (e.g. 1:30) or <strong>hours:minutes:seconds</strong> (e.g. 0:01:30)
        </div>
      </div>
    );
  }

  // URL-based tools
  if (['auto-clip', 'transcript', 'vocal-remover', 'auto-subtitle', 'video-enhancer', 'caption-remover'].includes(slug)) {
    return (
      <div className="space-y-5">
        <div>
          <label className="block text-sm font-bold mb-2">Video URL</label>
          <input
            type="url"
            className={inputCls}
            placeholder="https://youtube.com/watch?v=..."
            value={state.url}
            onChange={(e) => setState((p) => ({ ...p, url: e.target.value }))}
          />
          <p className="text-xs text-black/40 font-medium mt-1.5">
            Supports YouTube, TikTok, Instagram, Twitter, and 1000+ sites
          </p>
        </div>

        {slug === 'auto-clip' && (
          <>
            {/* Viral Mode toggle */}
            <div className={`flex items-center justify-between p-4 rounded-2xl border-2 transition-all ${state.viralMode ? 'border-primary bg-primary/10' : 'border-transparent bg-black/5'}`}>
              <div>
                <div className="font-black text-sm flex items-center gap-2">
                  🔥 Viral Mode
                  {state.viralMode && <span className="text-[10px] bg-primary text-black font-black px-2 py-0.5 rounded-full uppercase">ON</span>}
                </div>
                <div className="text-xs text-black/50 font-medium mt-0.5">
                  {state.viralMode ? 'Picks random moments spread across video' : 'Splits at fixed intervals'}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setState((p) => ({ ...p, viralMode: !p.viralMode }))}
                className={`relative w-12 h-6 rounded-full transition-all ${state.viralMode ? 'bg-black' : 'bg-black/20'}`}
              >
                <span className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-all ${state.viralMode ? 'left-7' : 'left-1'}`} />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-bold mb-2">Clip Length</label>
                <select
                  className={selectCls}
                  value={state.clipDuration}
                  onChange={(e) => setState((p) => ({ ...p, clipDuration: Number(e.target.value) }))}
                >
                  <option value={15}>15 sec (TikTok)</option>
                  <option value={30}>30 seconds</option>
                  <option value={60}>60 sec (Shorts)</option>
                  <option value={90}>90 seconds</option>
                  <option value={120}>2 minutes</option>
                </select>
              </div>

              {state.viralMode && (
                <div>
                  <label className="block text-sm font-bold mb-2">No. of Clips</label>
                  <select
                    className={selectCls}
                    value={state.clipCount}
                    onChange={(e) => setState((p) => ({ ...p, clipCount: Number(e.target.value) }))}
                  >
                    <option value={5}>5 clips</option>
                    <option value={8}>8 clips</option>
                    <option value={10}>10 clips</option>
                    <option value={15}>15 clips</option>
                    <option value={20}>20 clips</option>
                  </select>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between p-4 bg-black/5 rounded-2xl">
              <div>
                <div className="font-bold text-sm">Crop to Vertical (9:16)</div>
                <div className="text-xs text-black/50 font-medium mt-0.5">
                  Shorts, TikTok & Reels ready
                </div>
              </div>
              <button
                type="button"
                onClick={() => setState((p) => ({ ...p, vertical: !p.vertical }))}
                className={`relative w-12 h-6 rounded-full transition-all ${state.vertical ? 'bg-black' : 'bg-black/20'}`}
              >
                <span className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-all ${state.vertical ? 'left-7' : 'left-1'}`} />
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  // Topic-based tools
  if (['clip-finder', 'title-generator', 'channel-analyzer', 'shorts-audit', 'thumbnail-analyzer'].includes(slug)) {
    return (
      <div className="space-y-5">
        <div>
          <label className="block text-sm font-bold mb-2">
            {slug === 'clip-finder' ? 'Search Topic / Keywords' : 'Topic or Niche'}
          </label>
          <input
            type="text"
            className={inputCls}
            placeholder={
              slug === 'clip-finder'
                ? 'e.g. "morning routine productivity"'
                : 'e.g. "how to make passive income"'
            }
            value={state.topic}
            onChange={(e) => setState((p) => ({ ...p, topic: e.target.value }))}
          />
        </div>
        {slug === 'title-generator' && (
          <div>
            <label className="block text-sm font-bold mb-2">Niche / Platform</label>
            <input
              type="text"
              className={inputCls}
              placeholder="e.g. Finance, Tech, Fitness..."
              value={state.niche}
              onChange={(e) => setState((p) => ({ ...p, niche: e.target.value }))}
            />
          </div>
        )}
      </div>
    );
  }

  // Prompt / AI tools (coming soon)
  return (
    <div className="space-y-5">
      <div>
        <label className="block text-sm font-bold mb-2">Prompt / Description</label>
        <textarea
          rows={6}
          className={inputCls}
          placeholder="Describe what you want to create..."
          value={state.prompt}
          onChange={(e) => setState((p) => ({ ...p, prompt: e.target.value }))}
        />
      </div>
    </div>
  );
}

// ─── Output renderers ─────────────────────────────────────────────────────────
function ClipsOutput({ output }: { output: Extract<ToolOutput, { type: 'clips' }> }) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between mb-4 shrink-0">
        <h3 className="font-black text-lg">{output.clips.length} Clips Ready 🎬</h3>
        <span className="text-sm text-black/50 font-medium">Total: {output.totalDuration}</span>
      </div>
      <div className="space-y-3 overflow-auto flex-1 pr-1">
        {output.clips.map((clip) => (
          <div
            key={clip.id}
            className="flex items-center gap-3 p-3 rounded-2xl border border-black/8 hover:border-primary hover:bg-primary/5 transition-all group"
          >
            {/* Thumbnail */}
            <div className="relative w-24 h-14 rounded-xl overflow-hidden shrink-0 bg-black/10">
              {clip.thumbnailId ? (
                <img
                  src={`${API}/video/file/${clip.thumbnailId}`}
                  alt={clip.label}
                  className="w-full h-full object-cover"
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = 'none';
                  }}
                />
              ) : null}
              {/* Play overlay */}
              <div className="absolute inset-0 bg-black/30 group-hover:bg-black/10 transition-colors flex items-center justify-center">
                <div className="w-7 h-7 rounded-full bg-primary/90 flex items-center justify-center">
                  <Play className="w-3.5 h-3.5 text-black ml-0.5" fill="currentColor" />
                </div>
              </div>
              {/* Duration badge */}
              <div className="absolute bottom-1 right-1 bg-black/70 text-white text-[9px] font-bold px-1.5 py-0.5 rounded">
                {clip.duration}
              </div>
            </div>

            {/* Info */}
            <div className="flex-1 min-w-0">
              <div className="font-bold text-sm text-black">{clip.label}</div>
              <div className="text-xs text-black/45 font-medium mt-0.5">
                {clip.startTime} – {clip.endTime} &nbsp;·&nbsp; {fmtBytes(clip.size)}
              </div>
            </div>

            {/* Download */}
            <a
              href={fileDownloadUrl(clip.id)}
              download={clip.name}
              className="shrink-0 flex items-center gap-1.5 text-xs font-black bg-primary text-black px-3.5 py-2 rounded-full hover:bg-[#bbf00e] transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              Save
            </a>
          </div>
        ))}
      </div>
    </div>
  );
}

function TranscriptOutput({ output }: { output: Extract<ToolOutput, { type: 'transcript' }> }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    navigator.clipboard.writeText(output.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-4 flex flex-col h-full">
      <div className="flex items-center justify-between">
        <h3 className="font-black text-lg">Transcript</h3>
        <div className="flex items-center gap-3">
          <span className="text-xs text-black/50 font-medium">{output.wordCount} words</span>
          <button
            onClick={copy}
            className="flex items-center gap-1.5 text-xs font-bold bg-black text-white px-4 py-2 rounded-full hover:bg-black/80 transition-colors"
          >
            {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? 'Copied!' : 'Copy All'}
          </button>
        </div>
      </div>

      <div className="overflow-auto max-h-[50vh] space-y-2 pr-1">
        {output.segments.length > 0 ? (
          output.segments.map((seg, i) => (
            <div key={i} className="flex gap-3 p-3 rounded-xl hover:bg-black/5 transition-colors">
              <span className="text-[10px] font-mono text-black/40 pt-0.5 shrink-0 w-20">
                {seg.start.split('.')[0]}
              </span>
              <p className="text-sm font-medium text-black/80 leading-relaxed">{seg.text}</p>
            </div>
          ))
        ) : (
          <p className="text-sm font-medium text-black/70 leading-relaxed p-3">{output.text}</p>
        )}
      </div>
    </div>
  );
}

function AudioOutput({ output }: { output: Extract<ToolOutput, { type: 'audio' }> }) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center gap-6">
      <div className="w-20 h-20 rounded-full bg-black flex items-center justify-center">
        <FileAudio className="w-9 h-9 text-primary" />
      </div>
      <div>
        <h3 className="font-black text-xl mb-1">Audio Extracted!</h3>
        <p className="text-black/50 font-medium text-sm">{output.name} &nbsp;·&nbsp; {fmtBytes(output.size)}</p>
      </div>
      <a
        href={fileDownloadUrl(output.id)}
        download={output.name}
        className="flex items-center gap-2 bg-primary text-black font-black px-8 py-4 rounded-full hover:bg-[#bbf00e] transition-colors text-lg"
      >
        <Download className="w-5 h-5" />
        Download MP3
      </a>
    </div>
  );
}

function TitlesOutput({ output }: { output: Extract<ToolOutput, { type: 'titles' }> }) {
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  const copy = (title: string, i: number) => {
    navigator.clipboard.writeText(title);
    setCopiedIdx(i);
    setTimeout(() => setCopiedIdx(null), 1500);
  };

  return (
    <div className="space-y-3">
      <h3 className="font-black text-lg mb-4">10 Viral Titles</h3>
      {output.titles.map((title, i) => (
        <div
          key={i}
          className="flex items-center gap-3 p-4 rounded-2xl border border-black/8 hover:border-primary hover:bg-primary/5 transition-all group"
        >
          <span className="w-6 h-6 rounded-full bg-black/8 text-black/50 text-xs font-black flex items-center justify-center shrink-0">
            {i + 1}
          </span>
          <p className="flex-1 text-sm font-medium text-black leading-snug">{title}</p>
          <button
            onClick={() => copy(title, i)}
            className="shrink-0 w-8 h-8 rounded-full bg-black/5 flex items-center justify-center hover:bg-primary transition-colors"
          >
            {copiedIdx === i ? <Check className="w-3.5 h-3.5 text-black" /> : <Copy className="w-3.5 h-3.5 text-black/60" />}
          </button>
        </div>
      ))}
    </div>
  );
}

function SearchOutput({ output }: { output: Extract<ToolOutput, { type: 'search' }> }) {
  return (
    <div className="space-y-3">
      <h3 className="font-black text-lg mb-4">{output.results.length} Clips Found</h3>
      <div className="space-y-3 overflow-auto max-h-[55vh] pr-1">
        {output.results.map((r) => (
          <div
            key={r.id}
            className="flex gap-3 p-3 rounded-2xl border border-black/8 hover:border-primary hover:bg-primary/5 transition-all"
          >
            <img
              src={r.thumbnail}
              alt={r.title}
              className="w-28 h-16 rounded-xl object-cover shrink-0 bg-black/10"
            />
            <div className="flex-1 min-w-0 flex flex-col justify-between py-0.5">
              <p className="text-sm font-bold text-black line-clamp-2 leading-snug">{r.title}</p>
              <div className="flex items-center justify-between mt-1">
                <div className="text-xs text-black/50 font-medium truncate">
                  {r.channel && <span>{r.channel}</span>}
                  {r.duration && <span className="ml-2 flex items-center gap-1"><Clock className="w-3 h-3" />{r.duration}</span>}
                </div>
                <a
                  href={r.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 ml-2 flex items-center gap-1 text-[10px] font-black bg-black text-white px-3 py-1.5 rounded-full hover:bg-black/80 transition-colors"
                >
                  Open <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function FileOutput({ output, slug }: { output: Extract<ToolOutput, { type: 'file' }>; slug: string }) {
  const isVideo = output.name.endsWith('.mp4') || output.name.endsWith('.mkv') || output.name.endsWith('.webm');
  const label =
    slug === 'trim-video' ? 'Trimmed Video' :
    slug === 'crop-vertical' ? 'Vertical 9:16 Video' :
    'Video Downloaded';

  return (
    <div className="flex flex-col items-center justify-center h-full text-center gap-6">
      <div className="w-20 h-20 rounded-full bg-black flex items-center justify-center">
        {isVideo
          ? <Video className="w-9 h-9 text-primary" />
          : <FileAudio className="w-9 h-9 text-primary" />}
      </div>
      <div>
        <h3 className="font-black text-xl mb-1">{label}!</h3>
        <p className="text-black/50 font-medium text-sm">{output.name} &nbsp;·&nbsp; {fmtBytes(output.size)}</p>
      </div>
      <a
        href={fileDownloadUrl(output.id)}
        download={output.name}
        className="flex items-center gap-2 bg-primary text-black font-black px-8 py-4 rounded-full hover:bg-[#bbf00e] transition-colors text-lg"
      >
        <Download className="w-5 h-5" />
        Download {isVideo ? 'MP4' : 'File'}
      </a>
      <p className="text-xs text-black/40 font-medium">Link expires in 2 hours</p>
    </div>
  );
}

function ComingSoonOutput() {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center gap-5 py-10">
      <div className="w-20 h-20 rounded-full bg-black/5 flex items-center justify-center">
        <Sparkles className="w-9 h-9 text-black/20" />
      </div>
      <div>
        <h3 className="text-xl font-black mb-2">AI Integration Coming Soon</h3>
        <p className="text-black/50 font-medium text-sm max-w-xs">
          This tool requires a live AI model connection. We're wiring it up — check back soon!
        </p>
      </div>
      <div className="flex items-center gap-2 text-xs font-bold bg-black/5 text-black/60 px-4 py-2 rounded-full">
        <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
        In Development
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function ToolPage({ params }: { params?: { slug?: string } }) {
  const slug = params?.slug ?? '';
  const tool = tools.find((t) => t.slug === slug);

  const config = buildConfig(slug);

  const [state, setState] = useState<FormState>({
    url: '',
    clipDuration: 60,
    vertical: false,
    viralMode: true,
    clipCount: 10,
    topic: '',
    niche: '',
    prompt: '',
    trimStart: '',
    trimEnd: '',
  });

  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [output, setOutput] = useState<ToolOutput | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [loadingMsg, setLoadingMsg] = useState('Processing...');

  const loadingMessages: Record<string, string[]> = {
    'auto-clip':      ['Downloading video...', 'Splitting into clips...', 'Packaging clips...', 'Almost done...'],
    'transcript':     ['Fetching subtitles...', 'Parsing transcript...'],
    'vocal-remover':  ['Downloading video...', 'Extracting audio...', 'Encoding MP3...'],
    'clip-finder':    ['Searching YouTube...', 'Fetching results...'],
    'title-generator':['Generating titles...'],
    'download-video': ['Fetching video...', 'Downloading...', 'Almost done...'],
    'trim-video':     ['Downloading video...', 'Trimming to range...', 'Finalising...'],
    'crop-vertical':  ['Downloading video...', 'Cropping to 9:16...', 'Encoding...'],
  };

  const loadingInterval = useRef<ReturnType<typeof setInterval> | null>(null);

  const canRun = () => {
    const urlTools = ['auto-clip', 'transcript', 'vocal-remover', 'download-video', 'crop-vertical'];
    if (urlTools.includes(slug)) return state.url.trim() !== '';
    if (slug === 'trim-video') return state.url.trim() !== '' && state.trimEnd.trim() !== '';
    if (['clip-finder', 'title-generator'].includes(slug)) return state.topic.trim() !== '';
    return true; // coming-soon tools always enabled
  };

  const handleGenerate = async () => {
    setStatus('loading');
    setErrorMsg('');
    setOutput(null);

    // Rotate loading messages
    const msgs = loadingMessages[slug] ?? ['Processing...'];
    let msgIdx = 0;
    setLoadingMsg(msgs[0]);
    if (msgs.length > 1) {
      loadingInterval.current = setInterval(() => {
        msgIdx = (msgIdx + 1) % msgs.length;
        setLoadingMsg(msgs[msgIdx]);
      }, 3000);
    }

    try {
      const result = await config.run(state);
      setOutput(result);
      setStatus('done');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatus('error');
    } finally {
      if (loadingInterval.current) clearInterval(loadingInterval.current);
    }
  };

  if (!tool) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-3xl font-black mb-4">Tool not found</h1>
          <Link href="/dashboard" className="text-primary font-bold hover:underline">
            Return to Dashboard
          </Link>
        </div>
      </div>
    );
  }

  const getIcon = () => {
    if (tool.category === 'video') return <Wand2 className="w-5 h-5" />;
    if (tool.category === 'clip') return <Scissors className="w-5 h-5" />;
    if (tool.category === 'voice' || tool.category === 'audio') return <Mic className="w-5 h-5" />;
    if (tool.category === 'image') return <ImageIcon className="w-5 h-5" />;
    if (tool.category === 'analysis') return <Search className="w-5 h-5" />;
    return <Wand2 className="w-5 h-5" />;
  };

  return (
    <div className="min-h-screen bg-white flex">
      <Sidebar />

      <main className="flex-1 ml-64 overflow-hidden h-screen flex flex-col">
        {/* Header */}
        <header className="p-8 border-b border-black/5 bg-white shrink-0">
          <div className="max-w-6xl mx-auto flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Link
                href="/dashboard"
                className="w-10 h-10 rounded-full bg-black/5 flex items-center justify-center hover:bg-black/10 transition-colors"
              >
                <ArrowLeft className="w-5 h-5" />
              </Link>
              <div>
                <div className="flex items-center gap-3 mb-1">
                  <div className="w-8 h-8 rounded-lg bg-black/5 flex items-center justify-center">
                    {getIcon()}
                  </div>
                  <h1 className="text-2xl font-black">{tool.name}</h1>
                  {tool.isNew && (
                    <span className="bg-primary text-black text-[10px] font-black uppercase px-2 py-0.5 rounded-full">
                      NEW
                    </span>
                  )}
                  {config.live && (
                    <span className="bg-green-100 text-green-700 text-[10px] font-black uppercase px-2 py-0.5 rounded-full border border-green-200">
                      LIVE
                    </span>
                  )}
                </div>
                <p className="text-black/50 font-medium text-sm">{tool.longDesc}</p>
              </div>
            </div>

            <div className="flex items-center gap-2 bg-black/5 px-4 py-2 rounded-full">
              <span className={`w-2 h-2 rounded-full ${config.live ? 'bg-green-500 animate-pulse' : 'bg-amber-400 animate-pulse'}`} />
              <span className="text-sm font-bold text-black/60">
                {config.live ? 'Live & Working' : 'Coming Soon'}
              </span>
            </div>
          </div>
        </header>

        {/* Body */}
        <div className="flex-1 overflow-auto bg-[#FAFAFA]">
          <div className="max-w-6xl mx-auto p-8 flex flex-col lg:flex-row gap-8 min-h-full">

            {/* Input Panel */}
            <div className="w-full lg:w-[45%] flex flex-col">
              <div className="bg-white rounded-3xl border border-black/10 p-8 shadow-sm flex-1 flex flex-col">
                <h2 className="text-xl font-bold mb-6">Configuration</h2>

                <div className="flex-1">
                  <InputForm slug={slug} state={state} setState={setState} />
                </div>

                <div className="mt-8 pt-6 border-t border-black/5">
                  <div className="flex items-center justify-between mb-4">
                    <div className="text-sm font-bold text-black/50">Estimated Cost</div>
                    <div className="text-sm font-black bg-primary/20 text-black px-3 py-1 rounded-full border border-primary/40">
                      {tool.cost}
                    </div>
                  </div>

                  <button
                    onClick={handleGenerate}
                    disabled={status === 'loading' || (!config.live ? false : !canRun())}
                    className="w-full py-4 rounded-full bg-black text-white font-black text-lg hover:bg-black/90 active:scale-[0.98] transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {status === 'loading' ? (
                      <>
                        <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        {loadingMsg}
                      </>
                    ) : (
                      <>
                        {config.live ? 'Generate' : 'Generate'}{' '}
                        <ChevronRight className="w-5 h-5" />
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>

            {/* Output Panel */}
            <div className="w-full lg:w-[55%] flex flex-col">
              <div className="bg-white rounded-3xl border border-black/10 p-8 shadow-sm flex-1 flex flex-col">

                {status === 'idle' && (
                  <div className="flex flex-col items-center justify-center flex-1 text-center">
                    <div className="w-24 h-24 rounded-full bg-black/5 flex items-center justify-center mb-6">
                      <Wand2 className="w-10 h-10 text-black/20" />
                    </div>
                    <h3 className="text-xl font-bold mb-2">Ready to generate</h3>
                    <p className="text-black/50 font-medium max-w-sm text-sm">
                      Fill out the configuration on the left and hit generate. Your output will appear here.
                    </p>
                  </div>
                )}

                {status === 'loading' && (
                  <div className="flex flex-col items-center justify-center flex-1 text-center">
                    <div className="w-20 h-20 rounded-full border-4 border-black/10 border-t-primary animate-spin mb-6" />
                    <h3 className="text-xl font-bold mb-2">{loadingMsg}</h3>
                    <p className="text-black/50 font-medium text-sm">
                      This may take a minute for long videos. Please don't close the tab.
                    </p>
                  </div>
                )}

                {status === 'error' && (
                  <div className="flex flex-col items-center justify-center flex-1 text-center gap-4">
                    <div className="w-16 h-16 rounded-full bg-red-50 flex items-center justify-center">
                      <AlertCircle className="w-8 h-8 text-red-500" />
                    </div>
                    <div>
                      <h3 className="text-lg font-black text-red-600 mb-1">Something went wrong</h3>
                      <p className="text-sm font-medium text-black/60 max-w-sm leading-relaxed">{errorMsg}</p>
                    </div>
                    <button
                      onClick={() => setStatus('idle')}
                      className="text-sm font-bold bg-black/5 px-6 py-2.5 rounded-full hover:bg-black/10 transition-colors"
                    >
                      Try Again
                    </button>
                  </div>
                )}

                {status === 'done' && output && (
                  <div className="flex-1 overflow-hidden flex flex-col">
                    {output.type === 'clips' && <ClipsOutput output={output} />}
                    {output.type === 'transcript' && <TranscriptOutput output={output} />}
                    {output.type === 'audio' && <AudioOutput output={output} />}
                    {output.type === 'file' && <FileOutput output={output} slug={slug} />}
                    {output.type === 'titles' && <TitlesOutput output={output} />}
                    {output.type === 'search' && <SearchOutput output={output} />}
                    {output.type === 'coming_soon' && <ComingSoonOutput />}
                  </div>
                )}

              </div>
            </div>

          </div>
        </div>
      </main>
    </div>
  );
}
