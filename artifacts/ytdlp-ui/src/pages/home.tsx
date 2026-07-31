import { useState, FormEvent, useCallback, useEffect, useRef } from 'react';
import {
  Download, Loader2, Video, AlertCircle,
  Clock, Eye, User, XCircle, Terminal, Activity, WifiOff
} from 'lucide-react';

const API = import.meta.env.VITE_API_URL
  ? import.meta.env.VITE_API_URL.replace(/\/$/, '')
  : import.meta.env.BASE_URL.replace(/\/$/, '') + '/api';

// ── Types ──────────────────────────────────────────────────────────────────────
interface VideoInfo {
  id: string;
  title: string;
  description?: string | null;
  uploader?: string | null;
  duration?: number | null;
  view_count?: number | null;
  like_count?: number | null;
  upload_date?: string | null;
  thumbnail?: string | null;
  webpage_url: string;
  extractor: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function formatDuration(seconds?: number | null) {
  if (!seconds) return '--:--';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ── Fixed quality menu (Zyla download engine) ──────────────────────────────────
const QUALITIES: Array<{ v: string; label: string; tag: string }> = [
  { v: '360',  label: '360p',  tag: 'MP4' },
  { v: '480',  label: '480p',  tag: 'MP4' },
  { v: '720',  label: '720p',  tag: 'HD' },
  { v: '1080', label: '1080p', tag: 'FHD' },
  { v: '1440', label: '1440p', tag: '2K' },
  { v: '2160', label: '2160p', tag: '4K' },
  { v: 'mp3',  label: 'MP3',   tag: 'AUDIO' },
];

function isLikelyYouTube(u: string): boolean {
  if (/^[A-Za-z0-9_-]{11}$/.test(u)) return true;
  return /(youtube\.com|youtu\.be)\//i.test(u);
}

// ── Error code → display title ─────────────────────────────────────────────────
const ERROR_TITLES: Record<string, string> = {
  PRIVATE_VIDEO:    'PRIVATE_VIDEO',
  MEMBERS_ONLY:     'MEMBERS_ONLY',
  AGE_RESTRICTED:   'AGE_RESTRICTED',
  GEO_BLOCKED:      'GEO_BLOCKED',
  VIDEO_UNAVAILABLE:'VIDEO_UNAVAILABLE',
  COPYRIGHT:        'COPYRIGHT_BLOCK',
  UNSUPPORTED_URL:  'UNSUPPORTED_URL',
  NETWORK_ERROR:    'NETWORK_ERROR',
  NO_OUTPUT:        'NO_OUTPUT',
  SESSION_EXPIRED:  'SESSION_EXPIRED',
};
function errorTitle(code: string, fallback: string) {
  return ERROR_TITLES[code] ?? fallback;
}

// ── API reachability ────────────────────────────────────────────────────────────
type ApiStatus = 'checking' | 'ok' | 'unreachable';

async function checkApiReachability(): Promise<ApiStatus> {
  try {
    const controller = new AbortController();
    const timerId = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${API}/healthz`, { signal: controller.signal });
    clearTimeout(timerId);
    return res.ok ? 'ok' : 'unreachable';
  } catch {
    return 'unreachable';
  }
}

// ── Main Page ──────────────────────────────────────────────────────────────────
export default function Home() {
  const [urlInput, setUrlInput] = useState('');
  const [selectedQuality, setSelectedQuality] = useState<string>('1080');

  const [apiStatus, setApiStatus] = useState<ApiStatus>('checking');

  // Lets the async download loop stop touching state after unmount/navigation.
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    checkApiReachability().then(status => {
      if (!cancelled) setApiStatus(status);
    });
    return () => { cancelled = true; };
  }, []);

  const [isFetching, setIsFetching] = useState(false);
  const [isError, setIsError] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [errorCode, setErrorCode] = useState('');
  const [info, setInfo] = useState<VideoInfo | null>(null);

  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState('');
  const [downloadErrorCode, setDownloadErrorCode] = useState('');
  const [downloadStatus, setDownloadStatus] = useState('');
  const [downloadPercent, setDownloadPercent] = useState<number | null>(null);
  const [zylaFallback, setZylaFallback] = useState('');

  const handleFetch = useCallback(async (e: FormEvent) => {
    e.preventDefault();
    const url = urlInput.trim();
    if (!url) return;

    setIsFetching(true);
    setIsError(false);
    setErrorMsg('');
    setErrorCode('');
    setInfo(null);

    try {
      // Info is only a nice preview now — downloads run on the external engine
      // and still work even when this lookup fails (e.g. YouTube blocking us).
      const infoRes = await fetch(`${API}/ytdlp/info?url=${encodeURIComponent(url)}`).catch(() => {
        throw Object.assign(new Error('Unable to reach the server. Check your connection and try again.'), { code: 'NETWORK_ERROR' });
      });
      const infoJson = await infoRes.json();
      if (!infoRes.ok) {
        throw Object.assign(
          new Error(infoJson.error || `Info error ${infoRes.status}`),
          { code: infoJson.code || 'UNKNOWN' }
        );
      }
      setInfo(infoJson);
    } catch (err) {
      setIsError(true);
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setErrorCode((err as { code?: string }).code ?? '');
    } finally {
      setIsFetching(false);
    }
  }, [urlInput]);

  /** Start a Zyla download job, poll its progress, then hand the browser the file link. */
  const handleZylaDownload = async () => {
    if (!selectedQuality || isDownloading) return;

    setIsDownloading(true);
    setDownloadError('');
    setDownloadErrorCode('');
    setZylaFallback('');
    setDownloadStatus('Starting…');
    setDownloadPercent(null);

    try {
      const startRes = await fetch(`${API}/yt/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: urlInput.trim(), format: selectedQuality }),
      }).catch(() => {
        throw Object.assign(new Error('Unable to reach the server. Check your connection and try again.'), { code: 'NETWORK_ERROR' });
      });
      const startJson = await startRes.json().catch(() => ({}));
      if (!startRes.ok) {
        throw Object.assign(
          new Error((startJson as { error?: string }).error || `Download failed (${startRes.status})`),
          { code: (startJson as { code?: string }).code || 'UNKNOWN' }
        );
      }

      let snap = startJson as {
        jobId: string; done: boolean; failed?: boolean; progress?: number;
        statusText?: string; downloadUrl?: string; error?: string; fallbackUrl?: string;
      };

      // Poll every 4s until the file link is ready (server itself gives up at ~4 min).
      const startedAt = Date.now();
      while (!snap.done && !snap.failed) {
        if (!aliveRef.current) return; // page left — stop polling silently
        if (Date.now() - startedAt > 280_000) {
          throw Object.assign(new Error('Timed out preparing this video. Try again.'), { code: 'TIMEOUT' });
        }
        await new Promise(r => setTimeout(r, 4000));
        const progRes = await fetch(`${API}/yt/progress?jobId=${encodeURIComponent(snap.jobId)}`).catch(() => null);
        if (!aliveRef.current) return;
        if (!progRes) continue; // transient network blip — keep polling
        const progJson = await progRes.json().catch(() => ({}));
        if (!progRes.ok) {
          throw Object.assign(
            new Error((progJson as { error?: string }).error || `Progress check failed (${progRes.status})`),
            { code: (progJson as { code?: string }).code || 'UNKNOWN' }
          );
        }
        snap = { ...snap, ...(progJson as object) };
        if (typeof snap.progress === 'number') setDownloadPercent(snap.progress);
        setDownloadStatus(snap.statusText || 'Preparing…');
      }

      if (snap.failed || !snap.downloadUrl) {
        if (snap.fallbackUrl) setZylaFallback(snap.fallbackUrl);
        throw Object.assign(
          new Error(snap.error || 'The download service could not prepare this video.'),
          { code: 'ENGINE_ERROR' }
        );
      }

      // File lives on fast external storage (proper filename via content-disposition)
      // — send the browser straight there instead of piping bytes through our server.
      setDownloadPercent(100);
      setDownloadStatus('Saving file…');
      const a = document.createElement('a');
      a.href = snap.downloadUrl;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (err) {
      if (aliveRef.current) {
        setDownloadError(err instanceof Error ? err.message : String(err));
        setDownloadErrorCode((err as { code?: string }).code ?? '');
      }
    } finally {
      if (aliveRef.current) setIsDownloading(false);
    }
  };

  return (
    <div className="min-h-[100dvh] bg-background text-foreground font-mono selection:bg-primary selection:text-primary-foreground flex flex-col relative overflow-hidden">

      {/* Subtle grid background */}
      <div className="absolute inset-0 bg-[linear-gradient(to_right,#80808012_1px,transparent_1px),linear-gradient(to_bottom,#80808012_1px,transparent_1px)] bg-[size:24px_24px] pointer-events-none z-0" />

      <main className="flex-1 w-full max-w-4xl mx-auto p-6 z-10 flex flex-col">

        <header className="mb-12 mt-8 flex items-center gap-3">
          <div className="bg-primary p-2 rounded-sm text-primary-foreground shadow-[0_0_15px_rgba(16,185,129,0.4)]">
            <Terminal size={28} strokeWidth={2.5} />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-white leading-none mb-1">YT_DLP::UI</h1>
            <p className="text-xs text-primary/80">HIGH_VELOCITY_MEDIA_EXTRACTOR_v1.0</p>
          </div>
        </header>

        {apiStatus === 'unreachable' && (
          <div className="mb-6 p-4 border border-yellow-500/50 bg-yellow-500/10 text-yellow-400 rounded flex items-start gap-3">
            <WifiOff size={20} className="shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <h3 className="font-bold text-sm mb-1">API_SERVER_UNREACHABLE</h3>
              <p className="text-xs opacity-90 break-words">
                Cannot reach the API server at <code className="bg-yellow-500/20 px-1 rounded">{API}</code>.
                {!import.meta.env.VITE_API_URL && ' Set the VITE_API_URL environment variable to point to your API server.'}
              </p>
            </div>
          </div>
        )}

        <form onSubmit={handleFetch} className="relative w-full group mb-8">
          <div className="absolute inset-y-0 left-0 flex items-center pl-4 pointer-events-none text-primary">
            <span className="animate-pulse font-bold text-lg">❯</span>
          </div>
          <input
            type="text"
            className="w-full bg-zinc-950/80 backdrop-blur-sm border border-zinc-800 text-white font-mono p-5 pl-12 pr-36 rounded focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all shadow-xl placeholder:text-zinc-600"
            placeholder="Target URL [https://...]"
            value={urlInput}
            onChange={e => setUrlInput(e.target.value)}
            spellCheck={false}
          />
          <button
            type="submit"
            disabled={!urlInput.trim() || isFetching || apiStatus !== 'ok'}
            className="absolute inset-y-2 right-2 px-6 bg-primary text-primary-foreground font-bold rounded hover:bg-primary/90 disabled:opacity-50 transition-colors flex items-center gap-2 text-sm"
            title={apiStatus === 'unreachable' ? 'API server is unreachable' : apiStatus === 'checking' ? 'Checking API server…' : undefined}
          >
            {isFetching
              ? <Loader2 size={16} className="animate-spin" />
              : apiStatus === 'checking'
                ? <Loader2 size={16} className="animate-spin" />
                : 'FETCH'}
          </button>
        </form>

        {isError && (
          <div className="mb-8 p-4 border border-destructive/50 bg-destructive/10 text-destructive rounded flex items-start gap-3">
            <AlertCircle size={20} className="shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <h3 className="font-bold text-sm mb-1">{errorTitle(errorCode, 'ERR_FETCH_FAILED')}</h3>
              <p className="text-xs opacity-90 break-words">{errorMsg || 'Unknown error occurred during extraction.'}</p>
            </div>
          </div>
        )}

        {info && (
          <div className="animate-in fade-in slide-in-from-bottom-4 duration-500 space-y-6">

            <div className="bg-card border border-border rounded-lg overflow-hidden flex flex-col md:flex-row shadow-2xl">
              {info.thumbnail ? (
                <div className="md:w-64 shrink-0 relative bg-black">
                  <img
                    src={info.thumbnail}
                    alt="Thumbnail"
                    className="w-full h-full object-cover opacity-80"
                  />
                  <div className="absolute bottom-2 right-2 bg-black/80 px-2 py-1 text-xs font-bold rounded text-white backdrop-blur flex items-center gap-1">
                    <Clock size={12} className="text-primary" />
                    {formatDuration(info.duration)}
                  </div>
                </div>
              ) : (
                <div className="md:w-64 h-32 md:h-auto shrink-0 bg-zinc-900 flex items-center justify-center">
                  <Video size={32} className="text-zinc-700" />
                </div>
              )}

              <div className="p-5 flex-1 min-w-0 flex flex-col justify-center">
                <h2 className="text-lg font-bold text-white leading-tight mb-2 truncate" title={info.title}>
                  {info.title}
                </h2>

                <div className="flex flex-wrap gap-4 text-xs text-zinc-400 mb-4">
                  {info.uploader && (
                    <div className="flex items-center gap-1.5">
                      <User size={14} className="text-primary" />
                      <span className="truncate max-w-[150px]">{info.uploader}</span>
                    </div>
                  )}
                  {info.view_count != null && (
                    <div className="flex items-center gap-1.5">
                      <Eye size={14} className="text-primary" />
                      <span>{info.view_count.toLocaleString()}</span>
                    </div>
                  )}
                </div>

                <div className="mt-auto flex items-center justify-between text-xs text-zinc-500 border-t border-zinc-800/50 pt-3">
                  <span>ID: {info.id}</span>
                  <span>EXTRACTOR: {info.extractor}</span>
                </div>
              </div>
            </div>

          </div>
        )}

        {(info || (isError && isLikelyYouTube(urlInput.trim()))) && (
          <div className="bg-card border border-border rounded-lg p-5 animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="flex items-center justify-between mb-4 pb-4 border-b border-zinc-800 gap-3">
              <h3 className="font-bold text-sm text-white flex items-center gap-2">
                <Activity size={16} className="text-primary" />
                DOWNLOAD_CONFIG
              </h3>
              {!info && (
                <span className="text-[10px] text-yellow-400/80 font-bold text-right">PREVIEW_UNAVAILABLE — DOWNLOAD STILL WORKS</span>
              )}
            </div>

            <p className="text-xs text-zinc-500 mb-2">SELECT_QUALITY:</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-7 gap-2">
              {QUALITIES.map(q => (
                <button
                  key={q.v}
                  onClick={() => setSelectedQuality(q.v)}
                  disabled={isDownloading}
                  className={`flex flex-col items-center p-3 rounded text-xs border transition-all ${
                    selectedQuality === q.v
                      ? 'border-primary bg-primary/10 text-white shadow-[0_0_10px_rgba(16,185,129,0.1)]'
                      : 'border-zinc-800 bg-zinc-950/50 text-zinc-400 hover:border-zinc-600 hover:bg-zinc-900'
                  }`}
                >
                  <span className={`font-bold ${selectedQuality === q.v ? 'text-primary' : 'text-zinc-300'}`}>{q.label}</span>
                  <span className="uppercase text-[10px] bg-zinc-800 px-1.5 py-0.5 rounded text-zinc-300 mt-1">{q.tag}</span>
                </button>
              ))}
            </div>
            <p className="text-[10px] text-zinc-600 mt-2">2160p = real 4K (3840×2160) with audio · repeat downloads of the same video are instant</p>

            <button
              onClick={handleZylaDownload}
              disabled={isDownloading || !selectedQuality || apiStatus !== 'ok'}
              className="w-full mt-6 bg-primary text-primary-foreground font-bold py-4 rounded hover:bg-primary/90 disabled:opacity-50 flex items-center justify-center gap-2 transition-all shadow-[0_0_20px_rgba(16,185,129,0.15)] hover:shadow-[0_0_30px_rgba(16,185,129,0.3)] disabled:shadow-none disabled:bg-zinc-800 disabled:text-zinc-500"
            >
              {isDownloading ? <Loader2 size={20} className="animate-spin" /> : <Download size={20} />}
              {isDownloading ? 'PREPARING_FILE...' : 'EXECUTE_DOWNLOAD'}
            </button>

            {/* Progress indicator shown while the engine prepares the file */}
            {isDownloading && (
              <div className="mt-4 space-y-2">
                <div className="w-full h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                  {downloadPercent !== null ? (
                    <div
                      className="h-full bg-primary rounded-full transition-all duration-300"
                      style={{ width: `${downloadPercent}%` }}
                    />
                  ) : (
                    <div className="h-full bg-primary rounded-full animate-[progress-indeterminate_1.5s_ease-in-out_infinite] w-1/3" />
                  )}
                </div>
                {downloadStatus && (
                  <p className="text-xs text-zinc-400 font-mono truncate">
                    <span className="text-primary mr-1">❯</span>
                    {downloadStatus}{downloadPercent !== null ? `  ·  ${downloadPercent}%` : ''}
                  </p>
                )}
              </div>
            )}

            {downloadError && (
              <div className="mt-4 p-4 border border-destructive/50 bg-destructive/10 text-destructive rounded flex items-start gap-3">
                <XCircle size={18} className="shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <h4 className="font-bold text-sm mb-1">{errorTitle(downloadErrorCode, 'ERR_DOWNLOAD_FAILED')}</h4>
                  <p className="text-xs opacity-90 break-words">{downloadError}</p>
                  {zylaFallback && (
                    <a
                      href={zylaFallback}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-2 mt-3 px-4 py-2 bg-primary/10 border border-primary/40 text-primary text-xs font-bold rounded hover:bg-primary/20 transition-colors"
                    >
                      <Download size={14} />
                      TRY_BACKUP_SERVER
                    </a>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

