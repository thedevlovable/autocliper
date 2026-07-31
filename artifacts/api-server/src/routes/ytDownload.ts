/**
 * ZylaLabs "YouTube Download and Info API" (#11016) — the download engine
 * behind the site's Downloader page.
 *
 * Live-verified contract (July 2026):
 *   START (auth'd, consumes monthly quota — the ONLY call that does):
 *     GET https://zylalabs.com/api/11016/youtube+download+and+info+api/20761/download?url=<YT_URL>&format=<FMT>
 *     Header: authorization: Bearer <ZYLA_API_KEY>
 *     → { success: true, id, image, progress_url }
 *   PROGRESS (no auth, free):
 *     GET <progress_url> → { success:1, progress:0..1000, text, download_url?, title?, duration? }
 *     Done when download_url appears. text matching /error|fail/i ⇒ failure.
 *   download_url 302-redirects to a presigned Cloudflare R2 file (~7 days,
 *   range/resume support, filename via content-disposition).
 *
 * Hard rules:
 *   - ZYLA_API_KEY lives server-side only; never in client code, URLs or logs.
 *   - NEVER pipe file bytes through this server — always redirect the browser
 *     to download_url (zero egress for us).
 *   - Cache url+format → download_url for 6 days; a repeat download must not
 *     start a new Zyla job (every start costs quota).
 *   - Accept ONLY YouTube URLs / 11-char ids. Per-IP rate limiting on starts.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { randomUUID } from "crypto";
import rateLimit from "express-rate-limit";
import { logger } from "../lib/logger";

// ── Config ────────────────────────────────────────────────────────────────────
const ZYLA_START_BASE =
  "https://zylalabs.com/api/11016/youtube+download+and+info+api/20761/download";
const FALLBACK_BASE = "https://yt-downloader-rose-six.vercel.app/download";

const FORMATS = new Set(["360", "480", "720", "1080", "1440", "2160", "mp3"]);
const CACHE_TTL_MS = 6 * 24 * 60 * 60 * 1000; // 6 days (links valid ~7)
const JOB_TIMEOUT_MS = Number(process.env["YT_JOB_TIMEOUT_MS"] ?? 240_000);
const POLL_FETCH_TIMEOUT_MS = 15_000;
const SERVER_POLL_INTERVAL_MS = Number(process.env["YT_POLL_INTERVAL_MS"] ?? 4_500);

function apiKey(): string | undefined {
  return process.env["ZYLA_API_KEY"] || undefined;
}

// ── YouTube URL / id validation ───────────────────────────────────────────────
const ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** Returns the 11-char video id, or null if the input is not YouTube. */
export function parseYouTubeId(raw: string): string | null {
  const input = (raw ?? "").trim();
  if (ID_RE.test(input)) return input;
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, "");
  if (host === "youtu.be") {
    const id = u.pathname.split("/")[1] ?? "";
    return ID_RE.test(id) ? id : null;
  }
  if (host !== "youtube.com") return null;
  const v = u.searchParams.get("v");
  if (v && ID_RE.test(v)) return v;
  const m = u.pathname.match(/^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{11})(?:\/|$)/);
  return m?.[1] ?? null;
}

function watchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function fallbackUrlFor(videoId: string, format: string): string | undefined {
  if (format === "mp3") return undefined; // backup server has no mp3
  return `${FALLBACK_BASE}?url=${encodeURIComponent(watchUrl(videoId))}&quality=${format}`;
}

// ── In-memory state ───────────────────────────────────────────────────────────
interface YtJob {
  jobId: string;
  videoId: string;
  format: string;
  progressUrl: string;
  createdAt: number;
  progress: number; // 0-100
  statusText: string;
  done: boolean;
  failed: boolean;
  error?: string;
  downloadUrl?: string;
  title?: string;
}

const jobs = new Map<string, YtJob>();
const cache = new Map<string, { downloadUrl: string; title?: string; expiresAt: number }>();
const cacheKey = (videoId: string, format: string) => `${videoId}|${format}`;

// Sweep expired cache entries and stale job records so memory stays bounded.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of cache) if (v.expiresAt <= now) cache.delete(k);
  for (const [k, j] of jobs) if (now - j.createdAt > 60 * 60 * 1000) jobs.delete(k);
}, 30 * 60 * 1000).unref();

// ── Zyla calls ────────────────────────────────────────────────────────────────
async function fetchJson(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), POLL_FETCH_TIMEOUT_MS);
  try {
    const res = await globalThis.fetch(url, { ...init, signal: ctrl.signal });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, status: res.status, json };
  } finally {
    clearTimeout(t);
  }
}

/** Starts a Zyla job (consumes quota). Returns the job record or an error. */
async function startZylaJob(videoId: string, format: string): Promise<YtJob | { startError: string; status: number }> {
  const key = apiKey();
  if (!key) return { startError: "Downloader engine is not configured yet.", status: 503 };

  const url = `${ZYLA_START_BASE}?url=${encodeURIComponent(watchUrl(videoId))}&format=${encodeURIComponent(format)}`;
  let resp;
  try {
    resp = await fetchJson(url, { headers: { authorization: `Bearer ${key}` } });
  } catch {
    return { startError: "Could not reach the download service. Try again in a moment.", status: 502 };
  }
  const progressUrl = typeof resp.json["progress_url"] === "string" ? (resp.json["progress_url"] as string) : "";
  if (!resp.ok || !resp.json["success"] || !progressUrl) {
    // 401/403 → key or subscription problem; 429 → provider rate/quota.
    const reason =
      resp.status === 401 || resp.status === 403
        ? "Download service rejected our credentials (check the subscription)."
        : resp.status === 429
          ? "Download service rate/quota limit hit. Try again shortly."
          : "Download service could not start this video.";
    logger.warn({ videoId, format, zylaStatus: resp.status }, "[zyla] start failed");
    return { startError: reason, status: 502 };
  }

  const job: YtJob = {
    jobId: randomUUID(),
    videoId,
    format,
    progressUrl,
    createdAt: Date.now(),
    progress: 0,
    statusText: "Starting…",
    done: false,
    failed: false,
  };
  jobs.set(job.jobId, job);
  logger.info({ jobId: job.jobId, videoId, format }, "[zyla] job started");
  return job;
}

/** One poll of Zyla's progress_url; mutates the job in place. */
async function pollZylaOnce(job: YtJob): Promise<void> {
  if (job.done || job.failed) return;
  if (Date.now() - job.createdAt > JOB_TIMEOUT_MS) {
    job.failed = true;
    job.error = "Timed out preparing this video. Try again or use the backup server.";
    logger.warn({ jobId: job.jobId }, "[zyla] job timed out");
    return;
  }
  let resp;
  try {
    resp = await fetchJson(job.progressUrl);
  } catch {
    // Transient network issue — keep the job alive; timeout is the backstop.
    job.statusText = "Waiting for the download service…";
    return;
  }
  const j = resp.json;
  const downloadUrl = typeof j["download_url"] === "string" ? (j["download_url"] as string) : "";
  const text = typeof j["text"] === "string" ? (j["text"] as string) : "";
  const title = typeof j["title"] === "string" ? (j["title"] as string) : undefined;

  if (downloadUrl) {
    job.done = true;
    job.progress = 100;
    job.downloadUrl = downloadUrl;
    if (title) job.title = title;
    job.statusText = "Ready";
    cache.set(cacheKey(job.videoId, job.format), {
      downloadUrl,
      ...(title !== undefined ? { title } : {}),
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
    logger.info({ jobId: job.jobId, videoId: job.videoId, format: job.format }, "[zyla] job done");
    return;
  }
  if (/error|fail/i.test(text)) {
    job.failed = true;
    job.error = "The download service reported an error for this video.";
    logger.warn({ jobId: job.jobId, videoId: job.videoId }, "[zyla] job reported failure");
    return;
  }
  const raw = Number(j["progress"]);
  if (Number.isFinite(raw)) job.progress = Math.min(99, Math.max(job.progress, Math.round(raw / 10)));
  if (text) job.statusText = text.slice(0, 80);
}

function jobSnapshot(job: YtJob) {
  return {
    jobId: job.jobId,
    progress: job.progress,
    done: job.done,
    failed: job.failed,
    statusText: job.statusText,
    ...(job.downloadUrl ? { downloadUrl: job.downloadUrl } : {}),
    ...(job.title ? { title: job.title } : {}),
    ...(job.error ? { error: job.error } : {}),
    ...(job.failed ? { fallbackUrl: fallbackUrlFor(job.videoId, job.format) } : {}),
  };
}

// ── Router ────────────────────────────────────────────────────────────────────
const router: IRouter = Router();

// Starts cost paid quota — keep per-IP limits tight but humane.
const startLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many download requests — wait a minute and try again." },
});

function readParams(req: Request): { url?: string; format?: string } {
  const q = req.query as Record<string, unknown>;
  const b = (req.body ?? {}) as Record<string, unknown>;
  const url = typeof b["url"] === "string" ? (b["url"] as string) : typeof q["url"] === "string" ? (q["url"] as string) : undefined;
  const format = typeof b["format"] === "string" ? (b["format"] as string) : typeof q["format"] === "string" ? (q["format"] as string) : undefined;
  return { ...(url !== undefined ? { url } : {}), ...(format !== undefined ? { format } : {}) };
}

function validate(req: Request, res: Response): { videoId: string; format: string } | null {
  const { url, format } = readParams(req);
  const videoId = url ? parseYouTubeId(url) : null;
  if (!videoId) {
    res.status(400).json({ error: "Only YouTube links or video ids are supported here.", code: "UNSUPPORTED_URL" });
    return null;
  }
  if (!format || !FORMATS.has(format)) {
    res.status(400).json({ error: "format must be one of 360, 480, 720, 1080, 1440, 2160, mp3.", code: "BAD_FORMAT" });
    return null;
  }
  return { videoId, format };
}

async function handleStart(req: Request, res: Response): Promise<void> {
  const v = validate(req, res);
  if (!v) return;

  // Cache hit → no new Zyla job (starts cost quota; downloads are free).
  const hit = cache.get(cacheKey(v.videoId, v.format));
  if (hit && hit.expiresAt > Date.now()) {
    res.json({
      jobId: "cached",
      progress: 100,
      done: true,
      failed: false,
      statusText: "Ready",
      downloadUrl: hit.downloadUrl,
      ...(hit.title ? { title: hit.title } : {}),
      cached: true,
    });
    return;
  }

  const job = await startZylaJob(v.videoId, v.format);
  if ("startError" in job) {
    res.status(job.status).json({ error: job.startError, code: job.status === 503 ? "NOT_CONFIGURED" : "ENGINE_ERROR" });
    return;
  }
  res.json({ jobId: job.jobId, progress: 0, done: false, failed: false, statusText: job.statusText });
}

router.get("/yt/start", startLimiter, handleStart);
router.post("/yt/start", startLimiter, handleStart);

router.get("/yt/progress", async (req: Request, res: Response) => {
  const jobId = typeof req.query["jobId"] === "string" ? (req.query["jobId"] as string) : "";
  const job = jobs.get(jobId);
  if (!job) {
    res.status(404).json({ error: "Unknown or expired download job. Start it again.", code: "JOB_NOT_FOUND" });
    return;
  }
  await pollZylaOnce(job);
  res.json(jobSnapshot(job));
});

// Convenience: start + poll server-side, then send the browser to the file.
router.get("/yt/download", startLimiter, async (req: Request, res: Response) => {
  const v = validate(req, res);
  if (!v) return;

  const hit = cache.get(cacheKey(v.videoId, v.format));
  if (hit && hit.expiresAt > Date.now()) {
    res.redirect(302, hit.downloadUrl);
    return;
  }

  const job = await startZylaJob(v.videoId, v.format);
  if ("startError" in job) {
    const fb = fallbackUrlFor(v.videoId, v.format);
    if (fb) { res.redirect(302, fb); return; }
    res.status(job.status).json({ error: job.startError });
    return;
  }

  while (!job.done && !job.failed) {
    await new Promise(r => setTimeout(r, SERVER_POLL_INTERVAL_MS));
    if (res.writableEnded || req.destroyed) return; // client gave up
    await pollZylaOnce(job);
  }
  if (job.done && job.downloadUrl) {
    res.redirect(302, job.downloadUrl);
    return;
  }
  const fb = fallbackUrlFor(v.videoId, v.format);
  if (fb) { res.redirect(302, fb); return; }
  res.status(502).json({ error: job.error ?? "Download failed." });
});

export default router;
