import { useState, FormEvent, useCallback, useRef } from 'react';
import {
  Download, Loader2, Music, Video, AlertCircle,
  FileAudio, Clock, Eye, User, XCircle, Terminal, Activity
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

interface VideoFormat {
  format_id: string;
  format_note?: string;
  ext: string;
  resolution: string;
  fps?: number | null;
  filesize?: number | null;
  tbr?: number | null;
  vcodec?: string | null;
  acodec?: string | null;
}

interface FormatsResponse {
  id: string;
  title: string;
  formats: VideoFormat[];
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

function formatBytes(bytes?: number | null) {
  if (!bytes) return '???';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
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

// ── Main Page ──────────────────────────────────────────────────────────────────
export default function Home() {
  const [urlInput, setUrlInput] = useState('');
  const [audioOnly, setAudioOnly] = useState(false);
  const [selectedFormat, setSelectedFormat] = useState<string>('');

  const [isFetching, setIsFetching] = useState(false);
  const [isError, setIsError] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [errorCode, setErrorCode] = useState('');
  const [info, setInfo] = useState<VideoInfo | null>(null);
  const [formatsData, setFormatsData] = useState<FormatsResponse | null>(null);

  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState('');
  const [downloadErrorCode, setDownloadErrorCode] = useState('');
  const [downloadStatus, setDownloadStatus] = useState('');
  const [downloadPercent, setDownloadPercent] = useState<number | null>(null);
  const sseRef = useRef<EventSource | null>(null);

  const handleFetch = useCallback(async (e: FormEvent) => {
    e.preventDefault();
    const url = urlInput.trim();
    if (!url) return;

    setIsFetching(true);
    setIsError(false);
    setErrorMsg('');
    setErrorCode('');
    setInfo(null);
    setFormatsData(null);
    setSelectedFormat('');

    try {
      const [infoRes, formatsRes] = await Promise.all([
        fetch(`${API}/ytdlp/info?url=${encodeURIComponent(url)}`),
        fetch(`${API}/ytdlp/formats?url=${encodeURIComponent(url)}`),
      ]).catch(() => {
        throw Object.assign(new Error('Unable to reach the server. Check your connection and try again.'), { code: 'NETWORK_ERROR' });
      });

      const infoJson = await infoRes.json();
      const formatsJson = await formatsRes.json();

      if (!infoRes.ok) {
        throw Object.assign(
          new Error(infoJson.error || `Info error ${infoRes.status}`),
          { code: infoJson.code || 'UNKNOWN' }
        );
      }
      if (!formatsRes.ok) {
        throw Object.assign(
          new Error(formatsJson.error || `Formats error ${formatsRes.status}`),
          { code: formatsJson.code || 'UNKNOWN' }
        );
      }

      setInfo(infoJson);
      setFormatsData(formatsJson);
    } catch (err) {
      setIsError(true);
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setErrorCode((err as { code?: string }).code ?? '');
    } finally {
      setIsFetching(false);
    }
  }, [urlInput]);

  /** Parse a yt-dlp progress line and extract a human-readable status string and optional percent. */
  function parseProgressLine(line: string): { status: string; percent: number | null } {
    // [download]  42.3% of ~123.45MiB at 1.23MiB/s ETA 00:42
    const dlMatch = line.match(/\[download\]\s+([\d.]+)%\s+of\s+~?([\d.]+\w+)\s+at\s+([\d.]+\w+\/s)\s+ETA\s+(\S+)/);
    if (dlMatch) {
      const [, pct, size, speed, eta] = dlMatch;
      return { status: `${pct}% of ${size}  ·  ${speed}  ·  ETA ${eta}`, percent: parseFloat(pct) };
    }
    // [download]  42.3% of ~123.45MiB at 1.23MiB/s
    const dlMatch2 = line.match(/\[download\]\s+([\d.]+)%\s+of\s+~?([\d.]+\w+)\s+at\s+([\d.]+\w+\/s)/);
    if (dlMatch2) {
      const [, pct, size, speed] = dlMatch2;
      return { status: `${pct}% of ${size}  ·  ${speed}`, percent: parseFloat(pct) };
    }
    // [download] Destination: ...
    if (line.startsWith('[download] Destination:')) {
      return { status: 'Downloading…', percent: null };
    }
    // [ffmpeg] or [Merger] or [ExtractAudio]
    if (line.startsWith('[ffmpeg]') || line.startsWith('[Merger]') || line.startsWith('[ExtractAudio]')) {
      return { status: 'Processing with ffmpeg…', percent: null };
    }
    // [youtube] or [info] or generic extractors
    if (line.startsWith('[')) {
      const inner = line.slice(1, line.indexOf(']') + 1);
      if (inner && line.length > inner.length + 2) {
        return { status: line.slice(inner.length + 2).trim().slice(0, 80), percent: null };
      }
    }
    return { status: line.slice(0, 80), percent: null };
  }

  const handleDownload = async () => {
    if (!info) return;
    if (!audioOnly && !selectedFormat) return;

    // Close any previous SSE connection
    if (sseRef.current) { sseRef.current.close(); sseRef.current = null; }

    setIsDownloading(true);
    setDownloadError('');
    setDownloadErrorCode('');
    setDownloadStatus('Starting…');
    setDownloadPercent(null);

    try {
      // 1. Start the download job
      const startRes = await fetch(`${API}/ytdlp/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: urlInput.trim(),
          format: audioOnly ? undefined : selectedFormat,
          audio_only: audioOnly,
        }),
      }).catch(() => {
        throw Object.assign(new Error('Unable to reach the server. Check your connection and try again.'), { code: 'NETWORK_ERROR' });
      });

      if (!startRes.ok) {
        const json = await startRes.json().catch(() => ({}));
        throw Object.assign(
          new Error((json as any).error || `Download failed (${startRes.status})`),
          { code: (json as any).code || 'UNKNOWN' }
        );
      }

      const { jobId } = await startRes.json() as { jobId: string };

      // 2. Subscribe to SSE progress stream
      await new Promise<void>((resolve, reject) => {
        const sse = new EventSource(`${API}/ytdlp/progress/${jobId}`);
        sseRef.current = sse;

        sse.addEventListener('progress', (e) => {
          try {
            const { line } = JSON.parse((e as MessageEvent).data) as { line: string };
            const { status, percent } = parseProgressLine(line);
            setDownloadStatus(status);
            if (percent !== null) setDownloadPercent(percent);
          } catch { /* ignore parse errors */ }
        });

        sse.addEventListener('done', async (e) => {
          try {
            const { filename, ext: fileExt } = JSON.parse((e as MessageEvent).data) as { filename: string; ext: string };
            setDownloadStatus('Download complete — saving file…');
            setDownloadPercent(100);
            sse.close();
            sseRef.current = null;

            // 3. Fetch the file so we can detect auth errors (e.g. session expiry)
            //    before committing to a browser download.
            //    credentials:'include' ensures auth cookies are sent even when
            //    VITE_API_URL points to a different origin.
            const fileRes = await fetch(`${API}/ytdlp/file/${jobId}`, { credentials: 'include' });
            if (fileRes.status === 401) {
              reject(Object.assign(
                new Error('Session expired — please refresh and try again'),
                { code: 'SESSION_EXPIRED' }
              ));
              return;
            }
            if (!fileRes.ok) {
              const errJson = await fileRes.json().catch(() => ({}));
              reject(Object.assign(
                new Error((errJson as { error?: string }).error || `File download failed (${fileRes.status})`),
                { code: (errJson as { code?: string }).code || 'UNKNOWN' }
              ));
              return;
            }

            // Stream the blob and trigger a browser Save As dialog via a temporary object URL.
            const blob = await fileRes.blob();
            const objectUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.style.display = 'none';
            a.href = objectUrl;
            // Derive safe filename from video title
            const safeTitle = info!.title?.replace(/[^a-z0-9]/gi, '_').toLowerCase() || 'download';
            const ext = fileExt || (audioOnly ? 'mp3' : 'mp4');
            a.download = `${safeTitle}.${ext}`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            // Revoke after a tick so the browser has time to start the download
            setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);

            resolve();
          } catch (err) { reject(err); }
        });

        sse.addEventListener('error', (e) => {
          try {
            const { error: errMsg, code } = JSON.parse((e as MessageEvent).data) as { error: string; code: string };
            sse.close();
            sseRef.current = null;
            reject(Object.assign(new Error(errMsg), { code }));
          } catch {
            // SSE connection error (network issue)
            sse.close();
            sseRef.current = null;
            reject(Object.assign(new Error('Connection to server lost during download.'), { code: 'NETWORK_ERROR' }));
          }
        });
      });
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : String(err));
      setDownloadErrorCode((err as { code?: string }).code ?? '');
    } finally {
      setIsDownloading(false);
    }
  };

  const formats = formatsData?.formats || [];
  const videoFormats = formats.filter(f => f.vcodec !== 'none' && f.acodec !== 'none').reverse();
  const videoOnlyFormats = formats.filter(f => f.vcodec !== 'none' && f.acodec === 'none').reverse();
  const audioFormats = formats.filter(f => f.vcodec === 'none' && f.acodec !== 'none').reverse();

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
            disabled={!urlInput.trim() || isFetching}
            className="absolute inset-y-2 right-2 px-6 bg-primary text-primary-foreground font-bold rounded hover:bg-primary/90 disabled:opacity-50 transition-colors flex items-center gap-2 text-sm"
          >
            {isFetching ? <Loader2 size={16} className="animate-spin" /> : 'FETCH'}
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

            <div className="bg-card border border-border rounded-lg p-5">
              <div className="flex items-center justify-between mb-4 pb-4 border-b border-zinc-800">
                <h3 className="font-bold text-sm text-white flex items-center gap-2">
                  <Activity size={16} className="text-primary" />
                  PAYLOAD_CONFIG
                </h3>

                <button
                  onClick={() => setAudioOnly(!audioOnly)}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded text-xs font-bold transition-colors border ${
                    audioOnly
                      ? 'bg-primary text-primary-foreground border-primary shadow-[0_0_10px_rgba(16,185,129,0.3)]'
                      : 'bg-transparent text-zinc-400 border-zinc-700 hover:text-white hover:border-zinc-500'
                  }`}
                >
                  <Music size={14} />
                  AUDIO_ONLY (MP3)
                </button>
              </div>

              {audioOnly ? (
                <div className="py-8 text-center text-primary flex flex-col items-center justify-center bg-primary/5 rounded border border-primary/20">
                  <FileAudio size={48} className="mb-4 opacity-80" />
                  <p className="font-bold mb-1">AUDIO EXTRACTION MODE ENGAGED</p>
                  <p className="text-xs opacity-70">Will download highest quality audio and convert to MP3.</p>
                </div>
              ) : formatsData ? (
                <div className="space-y-4">
                  <p className="text-xs text-zinc-500 mb-2">SELECT_STREAM_FORMAT:</p>
                  <div className="max-h-[300px] overflow-y-auto pr-2 space-y-2">

                    {videoFormats.length > 0 && (
                      <div className="mb-4">
                        <div className="text-[10px] font-bold text-zinc-500 mb-2 tracking-wider">VIDEO + AUDIO</div>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                          {videoFormats.map(f => (
                            <FormatButton key={f.format_id} format={f} isSelected={selectedFormat === f.format_id} onClick={() => setSelectedFormat(f.format_id)} />
                          ))}
                        </div>
                      </div>
                    )}

                    {videoOnlyFormats.length > 0 && (
                      <div className="mb-4">
                        <div className="text-[10px] font-bold text-zinc-500 mb-2 tracking-wider">VIDEO ONLY (NO AUDIO)</div>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                          {videoOnlyFormats.map(f => (
                            <FormatButton key={f.format_id} format={f} isSelected={selectedFormat === f.format_id} onClick={() => setSelectedFormat(f.format_id)} />
                          ))}
                        </div>
                      </div>
                    )}

                    {audioFormats.length > 0 && (
                      <div className="mb-4">
                        <div className="text-[10px] font-bold text-zinc-500 mb-2 tracking-wider">AUDIO ONLY (RAW)</div>
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                          {audioFormats.map(f => (
                            <FormatButton key={f.format_id} format={f} isSelected={selectedFormat === f.format_id} onClick={() => setSelectedFormat(f.format_id)} />
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              ) : isFetching ? (
                <div className="py-8 flex justify-center">
                  <Loader2 size={24} className="animate-spin text-primary" />
                </div>
              ) : null}

              <button
                onClick={handleDownload}
                disabled={isDownloading || (!audioOnly && !selectedFormat)}
                className="w-full mt-6 bg-primary text-primary-foreground font-bold py-4 rounded hover:bg-primary/90 disabled:opacity-50 flex items-center justify-center gap-2 transition-all shadow-[0_0_20px_rgba(16,185,129,0.15)] hover:shadow-[0_0_30px_rgba(16,185,129,0.3)] disabled:shadow-none disabled:bg-zinc-800 disabled:text-zinc-500"
              >
                {isDownloading ? <Loader2 size={20} className="animate-spin" /> : <Download size={20} />}
                {isDownloading ? 'TRANSMITTING_DATA...' : 'EXECUTE_DOWNLOAD'}
              </button>

              {/* Progress indicator shown while downloading */}
              {isDownloading && (
                <div className="mt-4 space-y-2">
                  {/* Progress bar */}
                  <div className="w-full h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                    {downloadPercent !== null ? (
                      <div
                        className="h-full bg-primary rounded-full transition-all duration-300"
                        style={{ width: `${downloadPercent}%` }}
                      />
                    ) : (
                      /* Indeterminate bar */
                      <div className="h-full bg-primary rounded-full animate-[progress-indeterminate_1.5s_ease-in-out_infinite] w-1/3" />
                    )}
                  </div>
                  {/* Status text */}
                  {downloadStatus && (
                    <p className="text-xs text-zinc-400 font-mono truncate">
                      <span className="text-primary mr-1">❯</span>
                      {downloadStatus}
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
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function FormatButton({ format: f, isSelected, onClick }: { format: VideoFormat; isSelected: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`flex flex-col text-left p-3 rounded text-xs border transition-all ${
        isSelected
          ? 'border-primary bg-primary/10 text-white shadow-[0_0_10px_rgba(16,185,129,0.1)]'
          : 'border-zinc-800 bg-zinc-950/50 text-zinc-400 hover:border-zinc-600 hover:bg-zinc-900'
      }`}
    >
      <div className="flex items-center justify-between w-full mb-1">
        <span className={`font-bold ${isSelected ? 'text-primary' : 'text-zinc-300'}`}>
          {f.resolution || 'Audio'}
        </span>
        <span className="uppercase text-[10px] bg-zinc-800 px-1.5 py-0.5 rounded text-zinc-300">
          {f.ext}
        </span>
      </div>

      <div className="flex items-center justify-between w-full opacity-70 mt-1">
        <div className="flex gap-2">
          {f.fps ? <span>{f.fps}fps</span> : null}
          {f.vcodec !== 'none' && f.vcodec && (
            <span className="truncate max-w-[60px]" title={f.vcodec}>{f.vcodec.split('.')[0]}</span>
          )}
        </div>
        <span>{formatBytes(f.filesize)}</span>
      </div>
    </button>
  );
}
