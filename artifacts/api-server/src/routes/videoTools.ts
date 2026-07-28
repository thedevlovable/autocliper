import { Router, type IRouter } from "express";
import { exec, execSync } from "child_process";
import { promisify } from "util";
import path from "path";
import os from "os";
import fs from "fs";
import https from "https";
import http from "http";
import crypto from "crypto";

// ── Resolve absolute paths for ffmpeg + ffprobe ───────────────────────────────
function findBinary(name: string): string {
  // 1. which — works when PATH already has Nix bins (dev, or after PATH export in start script)
  try {
    const r = execSync(`which ${name} 2>/dev/null`, { encoding: 'utf8' }).trim();
    if (r) return r;
  } catch {}

  // 2. Scan process.env.PATH dirs with fs.existsSync — instant, no shell needed
  const pathDirs = (process.env.PATH ?? "").split(":");
  for (const dir of pathDirs) {
    if (!dir) continue;
    try { if (fs.existsSync(`${dir}/${name}`)) return `${dir}/${name}`; } catch {}
  }

  // 3. Known fixed locations (nix-env user profile, system profile, standard system paths)
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

  // 4. Search the entire Nix store (slow but thorough — 10s timeout, last resort)
  try {
    const r = execSync(
      `find /nix/store -name "${name}" -type f 2>/dev/null | grep "/bin/${name}$" | head -1`,
      { encoding: 'utf8', timeout: 10000 }
    ).trim();
    if (r) return r;
  } catch {}

  return name; // bare fallback
}

const FFMPEG_PATH  = findBinary('ffmpeg');
const FFPROBE_PATH = findBinary('ffprobe');

console.log('[ClipAI] ffmpeg:', FFMPEG_PATH);
console.log('[ClipAI] ffprobe:', FFPROBE_PATH);

const execAsync = promisify(exec);
const router: IRouter = Router();

// ── Railway yt-dlp API ────────────────────────────────────────────────────────
const RAILWAY_API = "https://yt-api-railway-production-7709.up.railway.app";

/** Download video from Railway API → write to destPath */
async function downloadVideo(videoUrl: string, destPath: string): Promise<void> {
  const apiUrl = `${RAILWAY_API}/download?url=${encodeURIComponent(videoUrl)}`;
  return new Promise((resolve, reject) => {
    const proto = apiUrl.startsWith("https") ? https : http;
    proto.get(apiUrl, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Railway API returned HTTP ${res.statusCode}`));
        return;
      }
      const ws = fs.createWriteStream(destPath);
      res.pipe(ws);
      ws.on("finish", resolve);
      ws.on("error", reject);
      res.on("error", reject);
    }).on("error", reject);
  });
}

// ── Disk-based file store (2-hour TTL) ───────────────────────────────────────
// Files are copied to SERVE_DIR/{uuid}{ext} with a SERVE_DIR/{uuid}.meta.json
// sidecar. This survives process restarts and works across Autoscale redeploys
// within the same container's tmpfs lifetime.
const SERVE_DIR = path.join(os.tmpdir(), "clipai-serve");
try { fs.mkdirSync(SERVE_DIR, { recursive: true }); } catch { /* exists */ }

interface FileMeta {
  name: string;
  mimeType: string;
  ext: string;
  expiresMs: number; // Unix ms
}

/** Copy file into SERVE_DIR and write a .meta.json sidecar. Returns UUID id. */
function storeFile(filePath: string, name: string, mimeType: string): string {
  const id = crypto.randomUUID();
  const ext = path.extname(name) || "";
  const dest = path.join(SERVE_DIR, `${id}${ext}`);
  fs.copyFileSync(filePath, dest);
  const meta: FileMeta = {
    name,
    mimeType,
    ext,
    expiresMs: Date.now() + 2 * 60 * 60 * 1000, // 2 hours
  };
  fs.writeFileSync(path.join(SERVE_DIR, `${id}.meta.json`), JSON.stringify(meta));
  return id;
}

/** Resolve a stored file from disk. Returns null if not found or expired. */
function resolveFile(id: string): { filePath: string; meta: FileMeta } | null {
  // Sanitize id — must be a UUID (no path traversal)
  if (!/^[\w-]{8,64}$/.test(id)) return null;
  const metaPath = path.join(SERVE_DIR, `${id}.meta.json`);
  if (!fs.existsSync(metaPath)) return null;
  let meta: FileMeta;
  try { meta = JSON.parse(fs.readFileSync(metaPath, "utf8")); }
  catch { return null; }
  if (Date.now() > meta.expiresMs) {
    // Expired — clean up lazily
    try { fs.unlinkSync(metaPath); } catch { /* ignore */ }
    try { fs.unlinkSync(path.join(SERVE_DIR, `${id}${meta.ext}`)); } catch { /* ignore */ }
    return null;
  }
  const filePath = path.join(SERVE_DIR, `${id}${meta.ext}`);
  if (!fs.existsSync(filePath)) return null;
  return { filePath, meta };
}

// Periodic cleanup of expired files
setInterval(() => {
  try {
    for (const f of fs.readdirSync(SERVE_DIR)) {
      if (!f.endsWith(".meta.json")) continue;
      const metaPath = path.join(SERVE_DIR, f);
      try {
        const meta: FileMeta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        if (Date.now() > meta.expiresMs) {
          fs.unlinkSync(metaPath);
          fs.unlinkSync(path.join(SERVE_DIR, f.replace(".meta.json", meta.ext)));
        }
      } catch { /* ignore malformed */ }
    }
  } catch { /* ignore */ }
}, 15 * 60 * 1000);

function validateUrl(url: string): boolean {
  try {
    const p = new URL(url);
    return p.protocol === "http:" || p.protocol === "https:";
  } catch { return false; }
}

function fmtDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// ── GET /video/file/:id ───────────────────────────────────────────────────────
// Supports Range requests (needed for <video> seeking in browser).
// Files are served from disk-based store — survives process restarts.
router.get("/video/file/:id", (req, res): void => {
  const resolved = resolveFile(req.params.id);
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
    const fileId = storeFile(srcPath, "video.mp4", "video/mp4");
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
            id: storeFile(clipPath, `clip_${i + 1}.mp4`, "video/mp4"),
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

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "viralai-trim-"));
  try {
    req.log.info({ url, startTime, endTime }, "Trimming video");

    const srcPath = path.join(tmpDir, "source.mp4");
    await downloadVideo(url, srcPath);

    const outPath = path.join(tmpDir, "trimmed.mp4");
    await execAsync(
      `"${FFMPEG_PATH}" -y -i "${srcPath}" \
       -ss "${startTime}" -to "${endTime}" \
       -c copy \
       "${outPath}"`,
      { maxBuffer: 20 * 1024 * 1024 }
    );

    const stat = fs.statSync(outPath);
    const fileId = storeFile(outPath, "trimmed.mp4", "video/mp4");
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
    const fileId = storeFile(outPath, "vertical_9x16.mp4", "video/mp4");
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
    const fileId = storeFile(outPath, "audio.mp3", "audio/mpeg");
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
      await execAsync(
        `yt-dlp ${flag} --sub-format vtt --sub-langs "en,en-US,en-GB" \
         --skip-download --no-warnings \
         --extractor-args "youtube:player_client=ios,android,web" \
         -o "${path.join(tmpDir, "%(id)s")}" \
         "${url.replace(/"/g, '\\"')}"`,
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

  try {
    req.log.info({ topic }, "Searching clips");
    const safeQuery = topic.replace(/"/g, "'");
    const { stdout } = await execAsync(
      `yt-dlp "ytsearch${count}:${safeQuery}" --dump-json --flat-playlist --no-warnings`,
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
