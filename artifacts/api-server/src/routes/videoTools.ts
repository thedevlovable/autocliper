import { Router, type IRouter } from "express";
import { exec, execFile, execSync } from "child_process";
import { promisify } from "util";
import path from "path";
import os from "os";
import fs from "fs";
import https from "https";
import http from "http";

import { isSafePublicUrl } from "../lib/ssrfGuard";
import {
  SERVE_DIR,
  STORAGE_SIZE_CAP_BYTES,
  FileMeta,
  getStorageClient,
  storeFile,
  resolveFile,
  checkStorageHealth,
  getStorageCircuitState,
  setBucketBytes,
  initBucketCounter,
} from "../lib/fileStore";

// Initialise the headroom counter once at startup.  Runs async; any storeFile
// calls that arrive before it completes will see _bucketBytes === -1 and skip
// the headroom check (safe: the full cleanup cycle recalibrates within 15 min).
initBucketCounter().catch((err: unknown) =>
  console.warn('[storage] startup initBucketCounter error:', (err as Error).message),
);

// ── Resolve absolute paths for ffmpeg + ffprobe ───────────────────────────────
// Primary: npm packages that ship real binaries — work in any container incl. Cloud Run.
// Fallback: system PATH / Nix store — works in the Replit dev workspace.

function getNpmBinaryPath(pkg: string, key: string): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = require(pkg) as any;
    const p: string = typeof mod === 'string' ? mod : (mod[key] ?? mod.path ?? mod.default ?? '');
    if (p && fs.existsSync(p)) return p;
  } catch {}
  return null;
}

function findBinaryFallback(name: string): string {
  // 1. Check process.env.PATH dirs
  const pathDirs = (process.env.PATH ?? "").split(":");
  for (const dir of pathDirs) {
    if (!dir) continue;
    try { if (fs.existsSync(`${dir}/${name}`)) return `${dir}/${name}`; } catch {}
  }

  // 2. Known fixed locations (Nix profiles, standard system paths)
  const home = process.env.HOME ?? "/root";
  const fixed = [
    `${home}/.nix-profile/bin/${name}`,
    `/nix/var/nix/profiles/default/bin/${name}`,
    `/run/current-system/sw/bin/${name}`,
    `/usr/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/bin/${name}`,
  ];
  for (const p of fixed) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }

  // 3. which (last resort shell lookup)
  try {
    const r = execSync(`which ${name} 2>/dev/null`, { encoding: 'utf8', timeout: 5000 }).trim();
    if (r) return r;
  } catch {}

  return name; // bare fallback
}

// ffmpeg-static exports the path string directly as the default export
const FFMPEG_PATH  = getNpmBinaryPath('ffmpeg-static', 'default') ?? findBinaryFallback('ffmpeg');
// @ffprobe-installer/ffprobe exports { path, version }
const FFPROBE_PATH = getNpmBinaryPath('@ffprobe-installer/ffprobe', 'path') ?? findBinaryFallback('ffprobe');
const YTDLP_PATH   = process.env.YTDLP_PATH || findBinaryFallback('yt-dlp');

console.log('[ClipAI] ffmpeg:', FFMPEG_PATH);
console.log('[ClipAI] ffprobe:', FFPROBE_PATH);
console.log('[ClipAI] yt-dlp:', YTDLP_PATH);

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const router: IRouter = Router();

// ── Shared browser-like headers so remote APIs don't block server requests ────
const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept': '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'identity',
};

// ── Railway yt-dlp API ────────────────────────────────────────────────────────
const RAILWAY_API = "https://yt-api-railway-production-7709.up.railway.app";

/** Strip YouTube/TikTok tracking params that cause Railway to return 400.
 *  Only the video ID matters — `si`, `feature`, `app`, `pp` are share tokens. */
function cleanVideoUrl(raw: string): string {
  try {
    const u = new URL(raw);
    ['si', 'feature', 'app', 'pp', 'utm_source', 'utm_medium', 'utm_campaign'].forEach(p => u.searchParams.delete(p));
    return u.toString();
  } catch {
    return raw;
  }
}

/** Generic streaming download: GET url → write to destPath, follows redirects, 
 *  reads error body on non-200, rejects with a clean message. */
function streamDownload(
  apiUrl: string,
  destPath: string,
  label: string,
  timeoutMs = 120_000,
  extraHeaders: Record<string, string> = {},
  redirectCount = 0,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) { reject(new Error(`${label}: too many redirects`)); return; }
    const proto = apiUrl.startsWith('https') ? https : http;
    const opts = new URL(apiUrl);
    const reqOpts = {
      hostname: opts.hostname,
      path: opts.pathname + opts.search,
      headers: { ...BROWSER_HEADERS, ...extraHeaders },
    };
    const req = proto.get(reqOpts, (res) => {
      // Follow redirects — validate each target to prevent open-redirect SSRF
      if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) && res.headers.location) {
        res.resume();
        const next = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, apiUrl).toString();
        if (!isSafePublicUrl(next)) {
          reject(new Error(`${label}: redirect to disallowed host blocked`));
          return;
        }
        streamDownload(next, destPath, label, timeoutMs, extraHeaders, redirectCount + 1).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString().slice(0, 2000); });
        res.on('end', () => {
          let msg = `${label} returned HTTP ${res.statusCode}`;
          try {
            const p = JSON.parse(body) as { detail?: string; error?: string; message?: string };
            const d = p.detail ?? p.error ?? p.message ?? '';
            if (d) msg = d.replace(/^yt-dlp download error:\s*ERROR:\s*/i, '').trim();
          } catch { /* keep */ }
          reject(new Error(msg));
        });
        return;
      }
      const ws = fs.createWriteStream(destPath);
      res.pipe(ws);
      ws.on('finish', resolve);
      ws.on('error', (e) => { req.destroy(); reject(e); });
      res.on('error', (e) => { req.destroy(); reject(e); });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`${label} timed out`)));
  });
}

/** Download video: Railway → Vercel → Cobalt → yt-dlp */
async function downloadVideo(videoUrl: string, destPath: string): Promise<void> {
  const clean = cleanVideoUrl(videoUrl);

  // 1. Railway (raw URL, browser headers)
  try {
    await streamDownload(
      `${RAILWAY_API}/download?url=${clean}`,
      destPath, 'Railway', 90_000
    );
    return;
  } catch (e) {
    console.warn('[download] Railway failed:', (e as Error).message);
  }

  // 2. Vercel yt-downloader (encoded URL, browser headers)
  try {
    await streamDownload(
      `https://yt-downloader-rose-six.vercel.app/download?url=${encodeURIComponent(clean)}&quality=1080`,
      destPath, 'Vercel', 120_000
    );
    return;
  } catch (e) {
    console.warn('[download] Vercel failed:', (e as Error).message);
  }

  // 3. Cobalt.tools API (JSON → get stream URL → download)
  try {
    const cobaltRes = await new Promise<{ url?: string; status?: string; error?: { code?: string } }>((res, rej) => {
      const body = JSON.stringify({ url: clean, videoQuality: '1080', filenameStyle: 'basic' });
      const req = https.request({
        hostname: 'api.cobalt.tools',
        path: '/api/json',
        method: 'POST',
        headers: {
          ...BROWSER_HEADERS,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (r) => {
        let data = '';
        r.on('data', (c: Buffer) => { data += c.toString(); });
        r.on('end', () => { try { res(JSON.parse(data)); } catch { rej(new Error('Cobalt: bad JSON')); } });
      });
      req.on('error', rej);
      req.setTimeout(20_000, () => req.destroy(new Error('Cobalt request timed out')));
      req.write(body);
      req.end();
    });
    if (cobaltRes.url) {
      await streamDownload(cobaltRes.url, destPath, 'Cobalt', 120_000);
      return;
    }
    console.warn('[download] Cobalt: no URL in response', cobaltRes.status);
  } catch (e) {
    console.warn('[download] Cobalt failed:', (e as Error).message);
  }

  // 4. Direct yt-dlp fallback
  try {
    await execFileAsync(
      YTDLP_PATH,
      ["-f", "best[ext=mp4]/best[height<=1080]/best", "--no-playlist", "-o", destPath, videoUrl],
      { maxBuffer: 200 * 1024 * 1024, timeout: 120_000 }
    );
  } catch (ytdlpErr: unknown) {
    const raw = (ytdlpErr instanceof Error ? ytdlpErr.message : String(ytdlpErr));
    const lines = raw.replace(/^Command failed:[^\n]*\n?/, '').trim().split('\n').slice(-3).join(' ');
    throw new Error(lines || 'All download sources failed. Try a different video.');
  }
}

// ── Persistent file store backed by Replit Object Storage ────────────────────
// storeFile, resolveFile, checkStorageHealth, and all storage helpers live in
// ../lib/fileStore — imported above. SERVE_DIR and STORAGE_SIZE_CAP_BYTES are
// re-exported from there so the cleanup intervals below can use them directly.

// ── Periodic cleanup: local disk cache + Object Storage ───────────────────────
setInterval(() => {
  // Local disk
  try {
    const entries = fs.readdirSync(SERVE_DIR);

    // Pass 1: expire files whose TTL has elapsed (driven by the meta sidecar)
    for (const f of entries) {
      if (!f.endsWith(".meta.json")) continue;
      const metaPath = path.join(SERVE_DIR, f);
      try {
        const meta: FileMeta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        if (Date.now() > meta.expiresMs) {
          fs.unlinkSync(metaPath);
          try { fs.unlinkSync(path.join(SERVE_DIR, f.replace(".meta.json", meta.ext))); } catch { /* ignore */ }
        }
      } catch { /* ignore malformed */ }
    }

    // Pass 2: remove orphan media files that have no paired meta sidecar.
    // These are left behind when storeFile throws after writing the local copy
    // but before (or during) the Object Storage upload, in case an older server
    // version didn't clean them up in the catch block.
    for (const f of entries) {
      if (f.endsWith(".meta.json")) continue;
      const metaPath = path.join(SERVE_DIR, f.replace(/\.[^.]+$/, ".meta.json"));
      if (!fs.existsSync(metaPath)) {
        try { fs.unlinkSync(path.join(SERVE_DIR, f)); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }

  // Object Storage — runs async, errors are non-fatal
  (async () => {
    try {
      const storage = getStorageClient();
      const listResult = await storage.list({ prefix: "clips/", matchGlob: "clips/*.meta.json" });
      if (!listResult.ok) return;
      const now = Date.now();

      // ── Pass 1: TTL expiry ────────────────────────────────────────────────
      // Fetch all meta files, delete expired ones, keep remaining for size check.
      interface LiveEntry { metaKey: string; base: string; meta: FileMeta }
      const live: LiveEntry[] = [];
      for (const obj of listResult.value) {
        try {
          const metaResult = await storage.downloadAsText(obj.name);
          if (!metaResult.ok) continue;
          const meta: FileMeta = JSON.parse(metaResult.value);
          if (now > meta.expiresMs) {
            const base = obj.name.replace(/^clips\//, "").replace(/\.meta\.json$/, "");
            await storage.delete(obj.name, { ignoreNotFound: true });
            await storage.delete(`clips/${base}${meta.ext}`, { ignoreNotFound: true });
          } else {
            const base = obj.name.replace(/^clips\//, "").replace(/\.meta\.json$/, "");
            live.push({ metaKey: obj.name, base, meta });
          }
        } catch { /* skip individual failures */ }
      }

      // ── Size recovery for legacy entries ─────────────────────────────────
      // Clips stored before sizeBytes was added contribute 0 to the tally.
      // For those entries, download the media object to measure its size, then
      // patch the meta file in Object Storage so future cycles use the stored
      // value and don't need to re-download.
      for (const entry of live) {
        if (entry.meta.sizeBytes && entry.meta.sizeBytes > 0) continue;
        try {
          const mediaKey = `clips/${entry.base}${entry.meta.ext}`;
          const bytesResult = await storage.downloadAsBytes(mediaKey);
          if (!bytesResult.ok) continue;
          const recovered = bytesResult.value.length;
          entry.meta.sizeBytes = recovered;
          // Persist the recovered size so subsequent cycles read it from meta.
          await storage.uploadFromText(entry.metaKey, JSON.stringify(entry.meta));
          console.log(
            `[storage] Recovered sizeBytes for ${entry.base}: ` +
            `${(recovered / (1024 ** 2)).toFixed(1)} MB`,
          );
        } catch { /* non-fatal — tally will be re-corrected next cycle */ }
      }

      // ── Size accounting & logging ─────────────────────────────────────────
      const totalBytes = live.reduce((sum, e) => sum + (e.meta.sizeBytes ?? 0), 0);
      // Keep the in-process headroom counter in sync with the authoritative scan.
      setBucketBytes(totalBytes);
      const totalMB = (totalBytes / (1024 ** 2)).toFixed(1);
      const capGB = (STORAGE_SIZE_CAP_BYTES / (1024 ** 3)).toFixed(1);
      console.log(
        `[storage] Bucket usage: ${totalMB} MB across ${live.length} clip(s) ` +
        `(cap: ${capGB} GB, TTL: 2 h)`
      );

      // ── Pass 2: Size cap — evict oldest-expiring clips first ─────────────
      if (totalBytes > STORAGE_SIZE_CAP_BYTES) {
        console.warn(
          `[storage] Bucket exceeds size cap (${totalMB} MB > ${capGB} GB) — ` +
          `evicting oldest clips early`
        );
        // Sort ascending by expiresMs so the soonest-to-expire clips go first
        live.sort((a, b) => a.meta.expiresMs - b.meta.expiresMs);
        let remaining = totalBytes;
        for (const entry of live) {
          if (remaining <= STORAGE_SIZE_CAP_BYTES) break;
          try {
            await storage.delete(entry.metaKey, { ignoreNotFound: true });
            await storage.delete(`clips/${entry.base}${entry.meta.ext}`, { ignoreNotFound: true });
            remaining -= (entry.meta.sizeBytes ?? 0);
            console.log(
              `[storage] Early-evicted clips/${entry.base} ` +
              `(${((entry.meta.sizeBytes ?? 0) / (1024 ** 2)).toFixed(1)} MB)`
            );
          } catch { /* skip */ }
        }
      }
    } catch (err) {
      console.warn('[storage] Object Storage cleanup failed:', (err as Error).message);
    }
  })();
}, 15 * 60 * 1000);

function validateUrl(url: string): boolean {
  return isSafePublicUrl(url);
}

function fmtDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// ── GET /video/file/:id ───────────────────────────────────────────────────────
// Supports Range requests (needed for <video> seeking in browser).
// Files are served from local disk cache; on cold start the file is fetched
// from Object Storage and cached before serving.
router.get("/video/file/:id", async (req, res): Promise<void> => {
  const resolved = await resolveFile(req.params.id);
  if (!resolved) {
    res.status(404).json({ error: "File not found or expired" });
    return;
  }
  const { filePath, meta } = resolved;

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const isMedia = meta.mimeType.startsWith("image/") || meta.mimeType.startsWith("video/") || meta.mimeType.startsWith("audio/");
  const disposition = (isMedia || req.query.inline === "1")
    ? `inline; filename="${encodeURIComponent(meta.name)}"`
    : `attachment; filename="${encodeURIComponent(meta.name)}"`;

  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", meta.mimeType);
  res.setHeader("Content-Disposition", disposition);

  // Handle Range request for video/audio seeking
  const range = req.headers.range;
  if (range && (meta.mimeType.startsWith("video/") || meta.mimeType.startsWith("audio/"))) {
    const [startStr, endStr] = range.replace(/bytes=/, "").split("-");
    const start = parseInt(startStr, 10);
    const end = endStr ? parseInt(endStr, 10) : fileSize - 1;
    if (start >= fileSize || end >= fileSize) {
      res.status(416).setHeader("Content-Range", `bytes */${fileSize}`).end();
      return;
    }
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
    res.setHeader("Content-Length", end - start + 1);
    fs.createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  res.setHeader("Content-Length", fileSize);
  fs.createReadStream(filePath).pipe(res);
});

// ── POST /video/download ──────────────────────────────────────────────────────
// Direct download proxy — downloads full video via Railway API then streams back
router.post("/video/download", async (req, res): Promise<void> => {
  const { url } = req.body as { url?: string };
  if (!url || !validateUrl(url)) {
    res.status(400).json({ error: "Invalid or missing URL" });
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "viralai-dl-"));
  try {
    req.log.info({ url }, "Direct download");
    const srcPath = path.join(tmpDir, "video.mp4");
    await downloadVideo(url, srcPath);

    const stat = fs.statSync(srcPath);
    const fileId = await storeFile(srcPath, "video.mp4", "video/mp4");
    res.json({ id: fileId, name: "video.mp4", size: stat.size });
  } catch (err) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    const msg = err instanceof Error ? err.message : String(err);
    req.log.error({ err: msg }, "Direct download failed");
    res.status(500).json({ error: msg });
  }
});

// ── Platform → ffmpeg settings ────────────────────────────────────────────────
const PLATFORM_SETTINGS: Record<string, { crop: boolean; scale: string; maxClipDuration: number }> = {
  tiktok:   { crop: true,  scale: "1080:1920", maxClipDuration: 60  },
  reels:    { crop: true,  scale: "1080:1920", maxClipDuration: 90  },
  shorts:   { crop: true,  scale: "1080:1920", maxClipDuration: 60  },
  original: { crop: false, scale: "",          maxClipDuration: 300 },
};

// ── URL result cache (2-hour TTL) ────────────────────────────────────────────
interface ClipItem {
  id: string; name: string; label: string; startTime: string; endTime: string;
  duration: string; size: number; thumbnailDataUrl: string; thumbnailId: string;
}
interface CachedClipResult {
  clips: ClipItem[];
  totalDuration: string;
  platform: string;
  expires: Date;
}
const resultCache = new Map<string, CachedClipResult>();

setInterval(() => {
  const now = new Date();
  for (const [k, v] of resultCache.entries()) {
    if (v.expires < now) resultCache.delete(k);
  }
}, 15 * 60 * 1000);

// ── Async job store (disk-based, survives restarts) ───────────────────────────
// POST /video/clip returns a jobId immediately; the real work runs in the background.
// GET /video/job/:jobId polls status until done/error.
// This avoids the Replit proxy's 120-second HTTP timeout on long-running requests.
const JOBS_DIR = path.join(os.tmpdir(), "clipai-jobs");
try { fs.mkdirSync(JOBS_DIR, { recursive: true }); } catch { /* exists */ }

type JobStatus = "queued" | "processing" | "done" | "error";
interface JobRecord {
  status: JobStatus;
  createdMs: number;
  updatedMs: number;
  url: string;
  platform: string;
  clips?: ClipItem[];
  totalDuration?: string;
  error?: string;
}

function writeJob(jobId: string, record: JobRecord): void {
  fs.writeFileSync(path.join(JOBS_DIR, `${jobId}.json`), JSON.stringify(record));
}
function readJob(jobId: string): JobRecord | null {
  if (!/^[\w-]{8,64}$/.test(jobId)) return null;
  const p = path.join(JOBS_DIR, `${jobId}.json`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); }
  catch { return null; }
}

// Clean up jobs older than 4 hours
setInterval(() => {
  try {
    const cutoff = Date.now() - 4 * 60 * 60 * 1000;
    for (const f of fs.readdirSync(JOBS_DIR)) {
      const p = path.join(JOBS_DIR, f);
      try {
        const rec: JobRecord = JSON.parse(fs.readFileSync(p, "utf8"));
        if (rec.createdMs < cutoff) fs.unlinkSync(p);
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}, 30 * 60 * 1000);

// ── Concurrency semaphore + queue limit ───────────────────────────────────────
// MAX_CONCURRENT_JOBS = heavy ffmpeg jobs at once
// MAX_QUEUED_JOBS = max waiting in queue before returning 429
const MAX_CONCURRENT_JOBS = 4;
const MAX_QUEUED_JOBS = 12;
let activeJobs = 0;
const jobQueue: Array<() => void> = [];

function tryAcquireJob(): Promise<void> | null {
  if (activeJobs >= MAX_CONCURRENT_JOBS && jobQueue.length >= MAX_QUEUED_JOBS) {
    return null; // signal: send 429
  }
  return new Promise(resolve => {
    if (activeJobs < MAX_CONCURRENT_JOBS) {
      activeJobs++;
      resolve();
    } else {
      jobQueue.push(() => { activeJobs++; resolve(); });
    }
  });
}
function releaseJob() {
  activeJobs--;
  jobQueue.shift()?.();
}

// ── Per-job clip-level parallelism limiter ────────────────────────────────────
// Within a single job we run clips in parallel, capped at CLIPS_PARALLEL
// so we don't spawn N*activeJobs ffmpeg processes simultaneously.
const CLIPS_PARALLEL = 3;

function makeClipLimiter() {
  let running = 0;
  const q: Array<() => void> = [];
  return function limit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const run = () => {
        running++;
        fn().then(resolve, reject).finally(() => {
          running--;
          q.shift()?.();
        });
      };
      running < CLIPS_PARALLEL ? run() : q.push(run);
    });
  };
}

// ── Viral timestamp picker ────────────────────────────────────────────────────
// Divides video into `count` sections and picks a random start within each
function pickViralTimestamps(totalDuration: number, clipDuration: number, count: number): number[] {
  const usable = totalDuration - clipDuration;
  if (usable <= 0) return [0];
  const safe = Math.min(count, Math.floor(usable / clipDuration));
  const section = usable / safe;
  const out: number[] = [];
  for (let i = 0; i < safe; i++) {
    const lo = i * section;
    const hi = Math.min(lo + section - clipDuration * 0.2, usable);
    out.push(lo + Math.random() * Math.max(0, hi - lo));
  }
  return out;
}

// ── POST /video/clip ── direct synchronous response ──────────────────────────
router.post("/video/clip", async (req, res): Promise<void> => {
  const {
    url,
    clipDuration = 30,
    platform = "shorts",
    clipCount = 5,
  } = req.body as {
    url?: string;
    clipDuration?: number;
    platform?: string;
    viralMode?: boolean;
    clipCount?: number;
  };

  if (!url || !validateUrl(url)) {
    res.status(400).json({ error: "Invalid or missing URL" });
    return;
  }

  const safeClipCount = Math.min(Math.max(1, Number(clipCount)), 10);
  const platformCfg = PLATFORM_SETTINGS[platform as string] ?? PLATFORM_SETTINGS.shorts;
  const safeClipDuration = Math.min(Number(clipDuration), platformCfg.maxClipDuration);
  const cacheKey = `${url}|${safeClipDuration}|${safeClipCount}|${platform}`;

  // Cache hit — instant response
  const cached = resultCache.get(cacheKey);
  if (cached && cached.expires > new Date()) {
    req.log.info({ cacheKey }, "Cache hit");
    res.json({ clips: cached.clips, totalDuration: cached.totalDuration, platform });
    return;
  }

  // Queue full?
  const slot = tryAcquireJob();
  if (!slot) {
    res.status(429).json({ error: "Server is busy. Please try again in 30 seconds." });
    return;
  }
  await slot;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "viralai-clip-"));
  try {
    req.log.info({ url, safeClipDuration, platform, safeClipCount }, "Starting clip job");

    // 1. Download
    const srcPath = path.join(tmpDir, "source.mp4");
    await downloadVideo(url, srcPath);

    // 2. Probe duration
    const { stdout: probeOut } = await execAsync(
      `"${FFPROBE_PATH}" -v quiet -print_format json -show_format "${srcPath}"`
    );
    const totalDuration = Math.floor(
      parseFloat((JSON.parse(probeOut) as { format: { duration: string } }).format.duration)
    );
    if (totalDuration > 7200) throw new Error("Video is too long (max 2 hours).");

    const clipsDir = path.join(tmpDir, "clips");
    const thumbsDir = path.join(tmpDir, "thumbs");
    fs.mkdirSync(clipsDir);
    fs.mkdirSync(thumbsDir);

    // Build vf filter — applied per-clip, never on full video
    const vfFilter = platformCfg.crop ? `crop=ih*9/16:ih,scale=${platformCfg.scale}` : null;
    const timestamps = pickViralTimestamps(totalDuration, safeClipDuration, safeClipCount);
    const limit = makeClipLimiter();

    const clips: ClipItem[] = await Promise.all(
      timestamps.map((startSec, i) =>
        limit(async () => {
          const endSec = Math.min(startSec + safeClipDuration, totalDuration);
          const clipPath = path.join(clipsDir, `clip_${String(i).padStart(3, "0")}.mp4`);
          const thumbPath = path.join(thumbsDir, `thumb_${i}.jpg`);
          const vfArg = vfFilter ? `-vf "${vfFilter}"` : "";

          // Fast seek (-ss before -i), only processes clipDuration seconds
          await execAsync(
            `"${FFMPEG_PATH}" -y -ss ${startSec.toFixed(3)} -i "${srcPath}" \
             -t ${(endSec - startSec).toFixed(3)} \
             ${vfArg} \
             -c:v libx264 -preset ultrafast -crf 28 -c:a aac -b:a 96k \
             "${clipPath}"`,
            { maxBuffer: 20 * 1024 * 1024 }
          );

          // Thumbnail as base64 inline — works across restarts
          const thumbVf = vfFilter ? `${vfFilter},scale=320:-2` : "scale=320:-2";
          const thumbOk = await execAsync(
            `"${FFMPEG_PATH}" -y -ss 1 -i "${clipPath}" -frames:v 1 -q:v 5 -vf "${thumbVf}" "${thumbPath}"`,
            { maxBuffer: 5 * 1024 * 1024 }
          ).then(() => true).catch(() =>
            execAsync(
              `"${FFMPEG_PATH}" -y -i "${clipPath}" -frames:v 1 -q:v 5 -vf "${thumbVf}" "${thumbPath}"`,
              { maxBuffer: 5 * 1024 * 1024 }
            ).then(() => true).catch(() => false)
          );

          let thumbnailDataUrl = "";
          if (thumbOk && fs.existsSync(thumbPath)) {
            try {
              thumbnailDataUrl = `data:image/jpeg;base64,${fs.readFileSync(thumbPath).toString("base64")}`;
            } catch { /* leave empty */ }
          }

          const stat = fs.statSync(clipPath);
          return {
            id: await storeFile(clipPath, `clip_${i + 1}.mp4`, "video/mp4"),
            name: `clip_${i + 1}.mp4`,
            label: `Clip ${i + 1}`,
            startTime: fmtDuration(startSec),
            endTime: fmtDuration(endSec),
            duration: fmtDuration(endSec - startSec),
            size: stat.size,
            thumbnailDataUrl,
            thumbnailId: "",
          };
        })
      )
    );

    try { fs.unlinkSync(srcPath); } catch {}

    const result = { clips, totalDuration: fmtDuration(totalDuration), platform };
    resultCache.set(cacheKey, { ...result, expires: new Date(Date.now() + 2 * 60 * 60 * 1000) });
    res.json(result);
  } catch (err) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    const msg = err instanceof Error ? err.message : String(err);
    req.log.error({ err: msg }, "Clip job failed");
    res.status(500).json({ error: msg });
  } finally {
    releaseJob();
  }
});

// ── POST /video/trim ──────────────────────────────────────────────────────────
// Trim a video to a specific start–end range
router.post("/video/trim", async (req, res): Promise<void> => {
  const { url, startTime = "0", endTime } =
    req.body as { url?: string; startTime?: string; endTime?: string };

  if (!url || !validateUrl(url)) {
    res.status(400).json({ error: "Invalid or missing URL" });
    return;
  }
  if (!endTime) {
    res.status(400).json({ error: "endTime is required" });
    return;
  }

  // Validate timestamps: accept HH:MM:SS.mmm, MM:SS, SS, or decimal seconds.
  // Reject anything containing shell metacharacters.
  const timestampRe = /^\d{1,2}(:\d{2})*(\.?\d+)?$/;
  if (!timestampRe.test(startTime) || !timestampRe.test(endTime)) {
    res.status(400).json({ error: "Invalid startTime or endTime format" });
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "viralai-trim-"));
  try {
    req.log.info({ url, startTime, endTime }, "Trimming video");

    const srcPath = path.join(tmpDir, "source.mp4");
    await downloadVideo(url, srcPath);

    const outPath = path.join(tmpDir, "trimmed.mp4");
    await execFileAsync(
      FFMPEG_PATH,
      ["-y", "-i", srcPath, "-ss", startTime, "-to", endTime, "-c", "copy", outPath],
      { maxBuffer: 20 * 1024 * 1024 }
    );

    const stat = fs.statSync(outPath);
    const fileId = await storeFile(outPath, "trimmed.mp4", "video/mp4");
    res.json({ id: fileId, name: "trimmed.mp4", size: stat.size });
  } catch (err) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    const msg = err instanceof Error ? err.message : String(err);
    req.log.error({ err: msg }, "Trim failed");
    res.status(500).json({ error: msg });
  }
});

// ── POST /video/crop-vertical ─────────────────────────────────────────────────
// Crop 16:9 video to 9:16 vertical (for Shorts/TikTok/Reels)
router.post("/video/crop-vertical", async (req, res): Promise<void> => {
  const { url } = req.body as { url?: string };
  if (!url || !validateUrl(url)) {
    res.status(400).json({ error: "Invalid or missing URL" });
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "viralai-vert-"));
  try {
    req.log.info({ url }, "Cropping to 9:16 vertical");

    const srcPath = path.join(tmpDir, "source.mp4");
    await downloadVideo(url, srcPath);

    const outPath = path.join(tmpDir, "vertical_9x16.mp4");
    await execAsync(
      `"${FFMPEG_PATH}" -y -i "${srcPath}" \
       -vf "crop=ih*9/16:ih,scale=1080:1920" \
       -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k \
       "${outPath}"`,
      { maxBuffer: 20 * 1024 * 1024 }
    );

    const stat = fs.statSync(outPath);
    const fileId = await storeFile(outPath, "vertical_9x16.mp4", "video/mp4");
    res.json({ id: fileId, name: "vertical_9x16.mp4", size: stat.size });
  } catch (err) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    const msg = err instanceof Error ? err.message : String(err);
    req.log.error({ err: msg }, "Vertical crop failed");
    res.status(500).json({ error: msg });
  }
});

// ── POST /video/extract-audio ─────────────────────────────────────────────────
// Download video then extract audio track as MP3
router.post("/video/extract-audio", async (req, res): Promise<void> => {
  const { url } = req.body as { url?: string };
  if (!url || !validateUrl(url)) {
    res.status(400).json({ error: "Invalid or missing URL" });
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "viralai-audio-"));
  try {
    req.log.info({ url }, "Extracting audio");

    const srcPath = path.join(tmpDir, "source.mp4");
    await downloadVideo(url, srcPath);

    const outPath = path.join(tmpDir, "audio.mp3");
    await execAsync(
      `"${FFMPEG_PATH}" -y -i "${srcPath}" -vn -c:a libmp3lame -b:a 192k "${outPath}"`,
      { maxBuffer: 20 * 1024 * 1024 }
    );

    const stat = fs.statSync(outPath);
    const fileId = await storeFile(outPath, "audio.mp3", "audio/mpeg");
    res.json({ id: fileId, name: "audio.mp3", size: stat.size });
  } catch (err) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    const msg = err instanceof Error ? err.message : String(err);
    req.log.error({ err: msg }, "Audio extraction failed");
    res.status(500).json({ error: msg });
  }
});

// ── POST /video/transcript ────────────────────────────────────────────────────
// Fetch subtitles using yt-dlp (skip-download — no video needed)
router.post("/video/transcript", async (req, res): Promise<void> => {
  const { url } = req.body as { url?: string };
  if (!url || !validateUrl(url)) {
    res.status(400).json({ error: "Invalid or missing URL" });
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "viralai-trans-"));
  try {
    req.log.info({ url }, "Fetching transcript");

    for (const flag of ["--write-auto-subs", "--write-subs"]) {
      await execFileAsync(
        YTDLP_PATH,
        [
          flag,
          "--sub-format", "vtt",
          "--sub-langs", "en,en-US,en-GB",
          "--skip-download",
          "--no-warnings",
          "--extractor-args", "youtube:player_client=ios,android,web",
          "-o", path.join(tmpDir, "%(id)s"),
          url,
        ],
        { maxBuffer: 5 * 1024 * 1024 }
      ).catch(() => { /* try next */ });

      const vttFiles = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".vtt"));
      if (vttFiles.length > 0) {
        const raw = fs.readFileSync(path.join(tmpDir, vttFiles[0]), "utf-8");
        const segments = parseVTT(raw);
        const fullText = segments.map((s) => s.text).join(" ");
        fs.rmSync(tmpDir, { recursive: true, force: true });
        res.json({ text: fullText, segments, wordCount: fullText.split(/\s+/).length });
        return;
      }
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
    res.status(422).json({
      error: "No subtitles found. Try a YouTube video with auto-captions enabled.",
    });
  } catch (err) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    const msg = err instanceof Error ? err.message : String(err);
    req.log.error({ err: msg }, "Transcript failed");
    res.status(500).json({ error: msg });
  }
});

function parseVTT(vtt: string): { start: string; end: string; text: string }[] {
  const segments: { start: string; end: string; text: string }[] = [];
  const lines = vtt.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (line.includes(" --> ")) {
      const [rawStart, rawEnd] = line.split(" --> ");
      const start = rawStart.trim();
      const end = rawEnd.split(" ")[0].trim();
      i++;
      const textLines: string[] = [];
      while (i < lines.length && lines[i].trim() !== "") {
        const cleaned = lines[i].replace(/<[^>]+>/g, "").trim();
        if (cleaned) textLines.push(cleaned);
        i++;
      }
      if (textLines.length > 0) {
        const text = [...new Set(textLines)].join(" ");
        if (!segments.length || segments[segments.length - 1].text !== text) {
          segments.push({ start, end, text });
        }
      }
    }
    i++;
  }
  return segments;
}

// ── POST /video/clip-finder ───────────────────────────────────────────────────
// Search YouTube for clips matching a topic
router.post("/video/clip-finder", async (req, res): Promise<void> => {
  const { topic, count = 8 } = req.body as { topic?: string; count?: number };
  if (!topic) {
    res.status(400).json({ error: "Topic is required" });
    return;
  }

  // Validate count to a safe positive integer to prevent injection via the search prefix.
  const safeCount = Math.max(1, Math.min(50, Math.floor(Number(count) || 8)));

  try {
    req.log.info({ topic }, "Searching clips");
    const { stdout } = await execFileAsync(
      YTDLP_PATH,
      [`ytsearch${safeCount}:${topic}`, "--dump-json", "--flat-playlist", "--no-warnings"],
      { maxBuffer: 5 * 1024 * 1024 }
    );

    const results = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          const v = JSON.parse(line) as Record<string, unknown>;
          return {
            id: v.id,
            title: v.title,
            url: `https://youtube.com/watch?v=${v.id}`,
            duration: v.duration ? fmtDuration(v.duration as number) : null,
            channel: v.channel ?? v.uploader ?? null,
            thumbnail: `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`,
          };
        } catch { return null; }
      })
      .filter(Boolean);

    res.json({ results });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    req.log.error({ err: msg }, "Clip finder failed");
    res.status(500).json({ error: msg });
  }
});

// ── POST /video/title-generator ───────────────────────────────────────────────
router.post("/video/title-generator", async (req, res): Promise<void> => {
  const { topic, niche = "YouTube" } = req.body as { topic?: string; niche?: string };
  if (!topic) {
    res.status(400).json({ error: "Topic is required" });
    return;
  }
  const t = topic.trim();
  res.json({
    titles: [
      `I Tried ${t} For 30 Days (Shocking Results)`,
      `The Truth About ${t} Nobody Talks About`,
      `How I Made $10,000 With ${t} (Step by Step)`,
      `${t} Changed My Life Forever — Here's How`,
      `Stop Doing ${t} Wrong. Do THIS Instead.`,
      `${t}: What ${niche} Experts Don't Want You To Know`,
      `I Tested Every ${t} Method So You Don't Have To`,
      `The ${t} Strategy That Got Me 1M Views`,
      `Why 99% of People Fail at ${t} (And How to Fix It)`,
      `${t} in 2025: The Complete Beginner's Guide`,
    ],
  });
});

export default router;
