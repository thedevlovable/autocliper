import { Router, type IRouter } from "express";
import { exec, execFile, execSync } from "child_process";
import { promisify } from "util";
import path from "path";
import os from "os";
import fs from "fs";
import https from "https";
import http from "http";
import crypto from "crypto";

import { isSafePublicUrl } from "../lib/ssrfGuard";
import {
  KickBlockedError,
  curlHttpStatus,
  resolveKickFallbackSource,
  resolveKickLiveSrc,
} from "../lib/kick";
import { getCookieArgs, reportCookieBotBlock, reportCookieSuccess } from "../lib/cookieStore";
import { resolveZylaSource } from "./ytDownload";

/** True when a yt-dlp error message is YouTube's "Sign in to confirm you're not
 *  a bot" wall. Records the cookies-likely-expired state when cookies are
 *  configured, so the UI can prompt for a re-upload. */
let lastYtBotBlockMs = 0;
/** True within 10 min of a YouTube bot-check error. While blocked, further
 *  YouTube metadata calls (e.g. transcript fetch) are guaranteed to fail after
 *  burning their full timeout — skip them and go straight to fallbacks. */
function recentlyBotBlocked(): boolean {
  return Date.now() - lastYtBotBlockMs < 10 * 60 * 1000;
}
function isBotCheckError(msg: string): boolean {
  const hit = msg.includes("Sign in to confirm");
  if (hit) {
    lastYtBotBlockMs = Date.now();
    reportCookieBotBlock();
  }
  return hit;
}
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
  probeStorageIfOpen,
} from "../lib/fileStore";
import {
  parseVTTNumeric,
  pickAudioEnergyTimestamps,
  pickAudioProbeWindows,
  pickSpreadTimestamps,
  pickTranscriptTimestamps,
  type AudioEnergyMeasurement,
  type TranscriptSegment,
} from "../lib/highlightPicker";

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

// ALWAYS prefer the Nix/system ffmpeg — the npm ffmpeg-static segfaults inside
// yt-dlp's HLS section driver on this platform. npm packages are last resort only.
const _sysFfmpeg  = findBinaryFallback('ffmpeg');
const _sysFfprobe = findBinaryFallback('ffprobe');
const FFMPEG_PATH  = (_sysFfmpeg  !== 'ffmpeg'  ? _sysFfmpeg  : null) ?? getNpmBinaryPath('ffmpeg-static', 'default')  ?? 'ffmpeg';
const FFPROBE_PATH = (_sysFfprobe !== 'ffprobe' ? _sysFfprobe : null) ?? getNpmBinaryPath('@ffprobe-installer/ffprobe', 'path') ?? 'ffprobe';
const YTDLP_PATH   = process.env.YTDLP_PATH || findBinaryFallback('yt-dlp');

// Standalone yt-dlp binaries don't bundle ffmpeg — point them at one explicitly
// (needed for bestvideo+bestaudio merges and --download-sections).
// IMPORTANT: the npm static ffmpeg SEGFAULTS inside yt-dlp's HLS section driver,
// so prefer the system (Nix) ffmpeg dir — it ships ffprobe alongside too.
const SYSTEM_FFMPEG = findBinaryFallback('ffmpeg');
const YTDLP_FFMPEG_ARGS = SYSTEM_FFMPEG.includes('/')
  ? ["--ffmpeg-location", path.dirname(SYSTEM_FFMPEG)]
  : (FFMPEG_PATH ? ["--ffmpeg-location", FFMPEG_PATH] : []);

console.log('[ClipAI] ffmpeg:', FFMPEG_PATH);
console.log('[ClipAI] ffprobe:', FFPROBE_PATH);
console.log('[ClipAI] yt-dlp:', YTDLP_PATH);

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const router: IRouter = Router();

// ── Shared browser-like headers so remote APIs don't block server requests ────
/** Last non-empty line of a (possibly multi-line) error message — for compact logs. */
function lastErrLine(s: string): string {
  const lines = s.trim().split('\n').filter(l => l.trim().length > 0);
  return lines.length ? lines[lines.length - 1].slice(0, 300) : s.slice(0, 300);
}

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

    // youtube.com/live/ID → youtube.com/watch?v=ID (ended live streams)
    // youtube.com/shorts/ID → youtube.com/watch?v=ID
    const liveMatch = u.pathname.match(/^\/(live|shorts)\/([A-Za-z0-9_-]{11})$/);
    if ((u.hostname === 'www.youtube.com' || u.hostname === 'youtube.com') && liveMatch) {
      return `https://www.youtube.com/watch?v=${liveMatch[2]}`;
    }

    return u.toString();
  } catch {
    return raw;
  }
}

// ── Source platform detection ─────────────────────────────────────────────────
type SourcePlatform = 'youtube' | 'kick' | 'twitch' | 'gdrive' | 'dropbox' | 'unknown';

function detectSourcePlatform(url: string): SourcePlatform {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    if (h === 'youtube.com' || h === 'youtu.be') return 'youtube';
    if (h === 'kick.com')                         return 'kick';
    if (h === 'twitch.tv' || h === 'clips.twitch.tv') return 'twitch';
    if (h === 'drive.google.com')                 return 'gdrive';
    if (h === 'dropbox.com')                      return 'dropbox';
  } catch { /* ignore */ }
  return 'unknown';
}

function extractGDriveId(url: string): string | null {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/file\/d\/([^/]+)/);
    if (m) return m[1];
    return u.searchParams.get('id');
  } catch { return null; }
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
  rejectHtml = false,
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
      // (303 included: Google Drive now answers uc?export=download with a 303
      //  See Other pointing at drive.usercontent.google.com)
      if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 303 || res.statusCode === 307 || res.statusCode === 308) && res.headers.location) {
        res.resume();
        const next = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, apiUrl).toString();
        if (!isSafePublicUrl(next)) {
          reject(new Error(`${label}: redirect to disallowed host blocked`));
          return;
        }
        streamDownload(next, destPath, label, timeoutMs, extraHeaders, redirectCount + 1, rejectHtml).then(resolve).catch(reject);
        return;
      }
      // File hosts answer with an HTML page (login / confirm / "not found") when
      // the file isn't truly public — saving that as .mp4 breaks later with a
      // confusing ffprobe error, so fail cleanly here instead.
      if (rejectHtml && res.statusCode === 200 && String(res.headers['content-type'] ?? '').includes('text/html')) {
        res.resume();
        reject(new Error(`${label}: host returned a web page instead of the file — it is probably not shared publicly`));
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
      // Hard cap so a single runaway source can never fill the disk
      const MAX_STREAM_BYTES = 5 * 1024 ** 3;
      let received = 0;
      res.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > MAX_STREAM_BYTES) req.destroy(new Error(`${label}: file exceeds the 5 GB limit`));
      });
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

/** Try yt-dlp on our VM first (no size cap); on hard error fall back to `apiFallback`. */
async function ytdlpThenApi(
  videoUrl: string,
  destPath: string,
  apiFallback: () => Promise<void>,
): Promise<void> {
  for (const fmt of [
    "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best[height<=720]",
    "bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=480]/best",
  ]) {
    try {
      await execFileAsync(
        YTDLP_PATH,
        [
          "-f", fmt,
          "--merge-output-format", "mp4",
          "--concurrent-fragments", "16",
          "--no-playlist", "--no-warnings",
          "--max-filesize", "5G",
          ...YTDLP_FFMPEG_ARGS,
          "-o", destPath,
          videoUrl,
        ],
        { maxBuffer: 1024 * 1024 * 1024, timeout: 20 * 60 * 1000 }
      );
      return;
    } catch (err: unknown) {
      const msg = (err instanceof Error ? err.message : String(err));
      const isTimeout = msg.includes('ETIMEDOUT') || msg.includes('timed out') || msg.includes('killed');
      if (!isTimeout) {
        console.warn(`[download] yt-dlp hard error for ${videoUrl}, trying API fallback:`, lastErrLine(msg));
        break; // fall through to API
      }
      console.warn(`[download] yt-dlp timed out at "${fmt}", retrying lower quality`);
    }
  }
  await apiFallback();
}

/** Kick downloader — yt-dlp with a short timeout (fails fast when extractor returns 404),
 *  then falls back to Kick channel API for live-stream sources. VOD recordings are blocked
 *  by Kick's CloudFront signing; this throws a clear error rather than hanging 20 min. */
async function downloadKick(videoUrl: string, destPath: string): Promise<void> {
  // 1. Try yt-dlp with a short timeout — if it returns 404 it fails in <5s, no need to wait 20 min
  try {
    await execFileAsync(
      YTDLP_PATH,
      [
        "-f", "bestvideo[height<=720]+bestaudio/best[height<=720]/best",
        "--merge-output-format", "mp4",
        "--concurrent-fragments", "16",
        "--no-playlist", "--no-warnings",
        "--max-filesize", "5G",
        ...YTDLP_FFMPEG_ARGS,
        "-o", destPath,
        videoUrl,
      ],
      { maxBuffer: 1024 * 1024 * 1024, timeout: 20 * 60 * 1000 } // long VODs need time — a 404 still fails in seconds
    );
    return;
  } catch (e: unknown) {
    const msg = (e instanceof Error ? e.message : String(e));
    console.warn('[download] Kick yt-dlp failed:', lastErrLine(msg));
  }

  // 2. Kick API fallback — resolve the VOD's IVS master.m3u8 (publicly readable)
  //    and hand it to yt-dlp for proper HLS assembly — never save the playlist
  //    text itself as the video file.
  const dlM3u8 = async (src: string) => {
    await execFileAsync(
      YTDLP_PATH,
      ["-f", "best[height<=720]/best", "--no-playlist", "--no-warnings",
       ...YTDLP_FFMPEG_ARGS, "-o", destPath, src],
      { maxBuffer: 1024 * 1024 * 1024, timeout: 20 * 60 * 1000 },
    );
  };
  // Direct video API + channel videos list, with blocked-vs-missing
  // classification — throws a user-readable error when nothing resolves.
  const src = await resolveKickFallbackSource(videoUrl, kickApiJson);
  await dlM3u8(src);
}

/** Large public Drive files return an HTML "can't scan this file for viruses"
 *  page instead of bytes. Parse its confirm form and build the
 *  drive.usercontent.google.com URL (with one-time uuid token) that streams the
 *  real file. Returns null when the page is a permission/login wall instead. */
async function resolveGDriveConfirmUrl(id: string): Promise<string | null> {
  const resp = await fetch(`https://drive.google.com/uc?export=download&id=${id}`, {
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000),
  });
  const ctype = resp.headers.get('content-type') ?? '';
  if (!ctype.includes('text/html')) {
    // Not a confirm page (likely the file bytes themselves) — drop the stream
    // without buffering it, so the pooled connection is released.
    await resp.body?.cancel().catch(() => {});
    return null;
  }
  const html = await resp.text();
  // Tolerant parse: any quote style, extra attributes, any attribute order.
  const action = html.match(/action\s*=\s*["']?(https:\/\/drive\.usercontent\.google\.com\/download)["']?/i)?.[1];
  if (!action) return null; // no confirm form → likely a permission wall
  const params = new URLSearchParams();
  for (const tag of html.match(/<input\b[^>]*>/gi) ?? []) {
    const name = tag.match(/\bname\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i);
    const value = tag.match(/\bvalue\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i);
    const n = name?.[1] ?? name?.[2] ?? name?.[3];
    if (n) params.set(n, value?.[1] ?? value?.[2] ?? value?.[3] ?? '');
  }
  if (!params.get('id')) params.set('id', id);
  if (!params.get('confirm')) params.set('confirm', 't');
  return `${action}?${params.toString()}`;
}

/** Route download to the right downloader — yt-dlp for everything it supports,
 *  direct URL tricks for Drive/Dropbox. No third-party serverless APIs.
 *  `zylaMirror`: outcome of an earlier Zyla resolution in the SAME job —
 *  a URL to reuse, or null meaning "already tried, don't spend another paid
 *  start". undefined = no earlier attempt (downloadVideo may resolve). */
async function downloadAny(videoUrl: string, destPath: string, zylaMirror?: string | null): Promise<void> {
  const src = detectSourcePlatform(videoUrl);

  // Twitch — yt-dlp supports VODs and clips natively
  if (src === 'twitch') {
    await ytdlpThenApi(videoUrl, destPath, async () => {
      throw new Error('Could not download this Twitch video. It may be subscriber-only, deleted, or geo-restricted.');
    });
    return;
  }

  // Kick — try yt-dlp; if it fails with 404/API error fall back to Kick channel API
  if (src === 'kick') {
    await downloadKick(videoUrl, destPath);
    return;
  }

  // Google Drive — convert share URL to direct download (no third-party API)
  if (src === 'gdrive') {
    const id = extractGDriveId(videoUrl);
    if (!id) throw new Error('Could not extract Google Drive file ID from this URL.');
    // Try confirm=t bypass first (large file warning bypass), then direct
    for (const directUrl of [
      `https://drive.google.com/uc?export=download&confirm=t&id=${id}`,
      `https://drive.google.com/uc?export=download&id=${id}`,
    ]) {
      try {
        await streamDownload(directUrl, destPath, 'GDrive-direct', 20 * 60 * 1000, {}, 0, true);
        return;
      } catch (e) {
        console.warn('[download] GDrive direct failed:', (e as Error).message);
      }
    }
    // Large files: Google serves a "can't scan for viruses — download anyway?"
    // HTML page. Parse its confirm form and stream from drive.usercontent.google.com.
    try {
      const confirmUrl = await resolveGDriveConfirmUrl(id);
      if (confirmUrl) {
        await streamDownload(confirmUrl, destPath, 'GDrive-confirm', 20 * 60 * 1000, {}, 0, true);
        return;
      }
    } catch (e) {
      console.warn('[download] GDrive confirm-flow failed:', (e as Error).message);
    }
    throw new Error('Could not download this Google Drive file. Make sure it is shared as "Anyone with the link can view".');
  }

  // Dropbox — serve from the direct-download host (handles www and no-www links,
  // keeps rlkey/st params that scl/fi share links require)
  if (src === 'dropbox') {
    const u = new URL(videoUrl);
    // Folder share links (/sh/... and /scl/fo/...) point at a folder, not a
    // file.  If the link includes ?preview=filename we can construct a direct
    // download URL by appending the filename to the folder path.  Without a
    // preview param we fall back to the helpful "share the file" message.
    const isFolderLink = /^\/(sh)\//.test(u.pathname) || u.pathname.startsWith('/scl/fo/');
    if (isFolderLink) {
      const preview = u.searchParams.get('preview');
      if (!preview) {
        throw new Error(
          'This is a Dropbox folder link, not a file link. Open the folder, hover over the video file, click Share → Copy link for that file, and paste that link instead.'
        );
      }
      // Build: dl.dropboxusercontent.com/<folder-path>/<preview-filename>
      // Dropbox folder share paths look like /sh/HASH/TOKEN or /scl/fo/HASH/TOKEN
      // Appending the filename and switching the host gives a direct download.
      const dl = new URL(videoUrl);
      dl.hostname = 'dl.dropboxusercontent.com';
      dl.pathname = dl.pathname.replace(/\/$/, '') + '/' + encodeURIComponent(preview);
      dl.searchParams.delete('preview');
      dl.searchParams.delete('dl');
      console.log('[download] Dropbox folder-preview URL:', dl.toString());
      try {
        await streamDownload(dl.toString(), destPath, 'Dropbox-folder-preview', 20 * 60 * 1000, {}, 0, true);
        return;
      } catch (e) {
        const msg = (e as Error).message;
        console.warn('[download] Dropbox folder-preview failed:', msg);
        if (/HTTP 4\d\d/.test(msg) || msg.includes('web page instead of the file')) {
          throw new Error(
            `Could not download "${preview}" from this Dropbox folder. Make sure the folder is shared publicly ("Anyone with the link can view") and the file still exists.`
          );
        }
        throw e;
      }
    }
    u.hostname = 'dl.dropboxusercontent.com';
    u.searchParams.delete('dl');
    try {
      await streamDownload(u.toString(), destPath, 'Dropbox-direct', 20 * 60 * 1000, {}, 0, true);
    } catch (e) {
      const msg = (e as Error).message;
      console.warn('[download] Dropbox direct failed:', msg);
      // 404/403 or an HTML page mean the link is dead, private, or unshared —
      // surface one clear message instead of the raw HTTP status.
      if (/HTTP 4\d\d/.test(msg) || msg.includes('web page instead of the file')) {
        throw new Error('Could not download this Dropbox file. Make sure the link is shared publicly ("Anyone with the link can view") and the file still exists.');
      }
      throw e;
    }
    return;
  }

  // YouTube or unknown — yt-dlp → Railway → Vercel → Cobalt chain
  await downloadVideo(videoUrl, destPath, zylaMirror);
}

/** Download video: Zyla mirror (YouTube) → yt-dlp (VM, no size cap) → Railway → Vercel → Cobalt.
 *  QUOTA INVARIANT: at most ONE paid Zyla start per user job. Callers that
 *  already ran a resolution MUST pass its outcome (`zylaMirror` string to
 *  reuse, or null to skip) — only `undefined` may trigger a fresh start here. */
async function downloadVideo(videoUrl: string, destPath: string, zylaMirror?: string | null): Promise<void> {
  const clean = cleanVideoUrl(videoUrl);

  // 0. Zyla engine — resolves YouTube links to a direct R2 mirror, so YouTube's
  //    bot-blocking never applies. Returns null instantly for non-YouTube URLs
  //    or when the engine is unconfigured; repeat videos hit its 6-day cache
  //    (no extra quota). Any failure falls through to the yt-dlp chain below.
  const mirrorUrl = zylaMirror === undefined
    ? (await resolveZylaSource(clean, 720))?.url ?? null
    : zylaMirror;
  if (mirrorUrl) {
    try {
      await streamDownload(mirrorUrl, destPath, "Zyla-mirror", 20 * 60 * 1000);
      console.log("[download] fetched via Zyla mirror");
      return;
    } catch (e) {
      console.warn("[download] Zyla mirror failed, using yt-dlp chain:", lastErrLine((e as Error).message));
    }
  }

  let botBlocked = false;

  // 1. yt-dlp — runs on our always-on VM, no serverless size limit.
  //    Try 720p first (fast, small), fall to 480p on timeout.
  for (const fmt of [
    "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best[height<=720]",
    "bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=480]/best",
  ]) {
    try {
      await execFileAsync(
        YTDLP_PATH,
        [
          "-f", fmt,
          "--merge-output-format", "mp4",
          "--no-playlist", "--no-warnings",
          "--retries", "2", "--extractor-retries", "1", // reach external-API fallbacks fast when bot-blocked
          "--max-filesize", "5G",
          "--extractor-args", "youtube:player_client=android,tv_embedded,ios;skip=webpage,configs",
          ...getCookieArgs(),
          ...YTDLP_FFMPEG_ARGS,
          "-o", destPath,
          clean,
        ],
        { maxBuffer: 1024 * 1024 * 1024, timeout: 20 * 60 * 1000 }
      );
      if (getCookieArgs().length > 0) reportCookieSuccess();
      return; // success — skip all external APIs
    } catch (ytdlpErr: unknown) {
      const raw = (ytdlpErr instanceof Error ? ytdlpErr.message : String(ytdlpErr));
      if (isBotCheckError(raw)) botBlocked = true;
      const isTimeout = raw.includes('ETIMEDOUT') || raw.includes('timed out') || raw.includes('killed');
      if (!isTimeout) {
        // Hard error (age-gate, geo-block, etc.) — fall through to external APIs
        console.warn('[download] yt-dlp hard error, trying external APIs:', lastErrLine(raw));
        break;
      }
      console.warn(`[download] yt-dlp timed out at format "${fmt}", trying lower quality`);
    }
  }

  // 2. Railway fallback (handles some bot-detection cases)
  try {
    await streamDownload(
      `${RAILWAY_API}/download?url=${encodeURIComponent(clean)}`,
      destPath, 'Railway', 120_000
    );
    return;
  } catch (e) {
    console.warn('[download] Railway failed:', (e as Error).message);
  }

  // 3. Vercel fallback — descending quality
  for (const q of ["1080", "720", "480"] as const) {
    try {
      await streamDownload(
        `https://yt-downloader-rose-six.vercel.app/download?url=${encodeURIComponent(clean)}&quality=${q}`,
        destPath, `Vercel-${q}`, 180_000
      );
      return;
    } catch (e) {
      console.warn(`[download] Vercel ${q} failed:`, (e as Error).message);
    }
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

  const hadCookies = getCookieArgs().length > 0;
  throw new Error(
    botBlocked
      ? (hadCookies
          ? 'Your uploaded YouTube cookies appear to have expired — YouTube is showing the "confirm you are not a bot" check again. Fix: open the YouTube Cookies panel on the Clipper page and upload a fresh cookies.txt exported from your signed-in browser, then try again.'
          : 'YouTube blocked our server with a "confirm you are not a bot" check. Fix: open the YouTube Cookies panel on the Clipper page, upload cookies.txt exported from your signed-in browser, then try again.')
      : 'Could not download this video after all fallbacks. It may be age-restricted, geo-blocked, or members-only.'
  );
}

// ── Long-video fast path: metadata probe + per-clip section downloads ────────
// For yt-dlp-native platforms we never download the whole video: we probe the
// duration (metadata only), pick clip timestamps, then download ONLY those
// sections. A 3-hour stream transfers a few minutes of footage, not gigabytes.

const YTDLP_EXTRACTOR_ARGS = ["--extractor-args", "youtube:player_client=android,tv_embedded,ios;skip=webpage,configs"];
// Cookie args are resolved per-call (getCookieArgs) so cookies uploaded at
// runtime via POST /ytdlp/cookies take effect without a server restart.

/** Video duration in seconds via yt-dlp metadata only (no download). Null on failure or live stream. */
async function probeDurationSeconds(videoUrl: string): Promise<{ duration: number; isLive: boolean } | null> {
  try {
    const { stdout } = await execFileAsync(
      YTDLP_PATH,
      ["--dump-json", "--skip-download", "--no-playlist", "--no-warnings",
       "--retries", "2", "--extractor-retries", "1", // fail fast on bot-block instead of ~90s of internal retries
       ...YTDLP_EXTRACTOR_ARGS, ...getCookieArgs(), cleanVideoUrl(videoUrl)],
      { maxBuffer: 64 * 1024 * 1024, timeout: 90_000 },
    );
    const info = JSON.parse(stdout) as { duration?: number; is_live?: boolean; live_status?: string };
    const isLive = Boolean(info.is_live) || info.live_status === "is_live";
    const d = Math.floor(Number(info.duration ?? 0));
    if (d <= 0) {
      // A live broadcast with no recorded timeline yet (e.g. YouTube live) has no duration.
      if (isLive) return { duration: 0, isLive: true };
      return null;
    }
    if (getCookieArgs().length > 0) reportCookieSuccess();
    return { duration: d, isLive };
  } catch (e) {
    isBotCheckError((e as Error).message); // record likely-expired cookies
    console.warn('[probe] yt-dlp metadata probe failed:', lastErrLine((e as Error).message));
    return null;
  }
}

/** Duration of a remote direct media file (e.g. the Zyla R2 mirror) straight
 *  from ffprobe — yt-dlp's generic extractor often reports no duration for
 *  plain mp4 URLs, but ffprobe reads the container header via range requests. */
async function ffprobeRemoteDuration(mediaUrl: string): Promise<{ duration: number; isLive: boolean } | null> {
  try {
    const { stdout } = await execFileAsync(
      FFPROBE_PATH,
      ["-v", "quiet", "-print_format", "json", "-show_format", mediaUrl],
      { maxBuffer: 16 * 1024 * 1024, timeout: 30_000 },
    );
    const d = Math.floor(parseFloat((JSON.parse(stdout) as { format?: { duration?: string } }).format?.duration ?? "0"));
    return d > 0 ? { duration: d, isLive: false } : null;
  } catch (e) {
    console.warn("[probe] ffprobe remote duration failed:", lastErrLine((e as Error).message));
    return null;
  }
}

/** Kick's Cloudflare blocks Node's fetch by TLS fingerprint (HTTP 403) but
 *  lets curl through — so all Kick API calls go via a curl subprocess. Returns
 *  parsed JSON or null on any failure (non-2xx, timeout, bad JSON). */
async function kickApiJson(apiUrl: string): Promise<unknown | null> {
  try {
    const { stdout } = await execFileAsync(
      'curl',
      ['-sS', '--fail', '--max-time', '15',
       '-H', `User-Agent: ${BROWSER_HEADERS['User-Agent']}`,
       '-H', 'Accept: application/json',
       apiUrl],
      { maxBuffer: 16 * 1024 * 1024, timeout: 20_000 },
    );
    return JSON.parse(stdout) as unknown;
  } catch (e) {
    const msg = (e as Error).message;
    console.warn('[kick-api] request failed:', lastErrLine(msg));
    // curl --fail exits 22 on non-2xx and names the status — that means Kick
    // actively refused us (bot blocking), which callers surface distinctly.
    const status = curlHttpStatus(msg);
    if (status !== null) throw new KickBlockedError(status, apiUrl);
    return null;
  }
}

/** Kick reports live streams via yt-dlp with `duration: null`, so the normal
 *  sealed-window logic can't run on the channel URL. But Kick's channel API
 *  exposes the in-progress recording's IVS m3u8 (`is_live` entry in the videos
 *  list), and probing THAT playlist yields the recorded (sealed) duration.
 *  Returns the m3u8 source + recorded seconds, or null when unresolvable. */
async function resolveKickLiveSource(videoUrl: string): Promise<{ src: string; duration: number } | null> {
  const src = await resolveKickLiveSrc(videoUrl, kickApiJson);
  if (!src) return null;
  // Probe the recorded portion's duration from the growing IVS playlist.
  const probed = await probeDurationSeconds(src);
  if (!probed || probed.duration <= 0) return null;
  return { src, duration: probed.duration };
}

/** Download only [startSec, endSec] of a video. The cut starts at the keyframe at or
 *  before startSec, so stream-copied clips begin on a clean frame (no black lead-in). */
async function downloadVideoSection(videoUrl: string, startSec: number, endSec: number, destPath: string, maxHeight = 720): Promise<void> {
  try {
  await execFileAsync(
    YTDLP_PATH,
    [
      "-f", `bestvideo[height<=${maxHeight}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${maxHeight}][ext=mp4]/best[height<=${maxHeight}]/best`,
      "--download-sections", `*${Math.max(0, Math.floor(startSec))}-${Math.ceil(endSec)}`,
      "--merge-output-format", "mp4",
      "--concurrent-fragments", "16",
      "--no-playlist", "--no-warnings",
      "--retries", "2", "--extractor-retries", "1", // fall back to full download fast when bot-blocked
      ...YTDLP_EXTRACTOR_ARGS, ...getCookieArgs(), ...YTDLP_FFMPEG_ARGS,
      "-o", destPath,
      cleanVideoUrl(videoUrl),
    ],
    { maxBuffer: 256 * 1024 * 1024, timeout: 5 * 60 * 1000 },
  );
  } catch (e) {
    isBotCheckError((e as Error).message); // record likely-expired cookies
    throw e;
  }
  if (getCookieArgs().length > 0) reportCookieSuccess();
  if (!fs.existsSync(destPath) || fs.statSync(destPath).size < 10_000) {
    throw new Error("Section download produced no usable output");
  }
}

// ── Disk guard: refuse new clip jobs when scratch space is nearly gone ───────
// Default 1 GB — autoscale deployment containers have far less scratch disk
// than the dev workspace; 3 GB made production 503 every single clip job.
const MIN_FREE_DISK_BYTES = Number(process.env.MIN_FREE_DISK_BYTES ?? "") || 1 * 1024 ** 3;
function tmpFreeBytes(): number {
  try { const s = fs.statfsSync(os.tmpdir()); return s.bavail * s.bsize; }
  catch { return Number.MAX_SAFE_INTEGER; } // can't measure — don't block jobs
}

// ── Persistent file store backed by Replit Object Storage ────────────────────
// storeFile, resolveFile, checkStorageHealth, and all storage helpers live in
// ../lib/fileStore — imported above. SERVE_DIR and STORAGE_SIZE_CAP_BYTES are
// re-exported from there so the cleanup intervals below can use them directly.

// ── Periodic cleanup: local disk cache + Object Storage ───────────────────────

/**
 * Run the two-pass local-disk cleanup against `dir`.
 *
 * Pass 1 — TTL expiry: delete any `.meta.json` whose `expiresMs` is in the
 *   past, together with its paired media file.
 *
 * Pass 2 — Orphan removal: delete any media file that has no paired
 *   `.meta.json` sidecar.  These arise when `storeFile` writes the local copy
 *   but then fails during the Object Storage upload (or a crash interrupted it).
 *
 * Exported so that unit tests can exercise the logic in isolation.
 */
export function runLocalDiskCleanup(dir: string): void {
  const entries = fs.readdirSync(dir);

  // Pass 1: expire files whose TTL has elapsed (driven by the meta sidecar)
  for (const f of entries) {
    if (!f.endsWith(".meta.json")) continue;
    const metaPath = path.join(dir, f);
    try {
      const meta: FileMeta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      if (Date.now() > meta.expiresMs) {
        fs.unlinkSync(metaPath);
        try { fs.unlinkSync(path.join(dir, f.replace(".meta.json", meta.ext))); } catch { /* ignore */ }
      }
    } catch { /* ignore malformed */ }
  }

  // Pass 2: remove orphan media files that have no paired meta sidecar.
  // These are left behind when storeFile throws after writing the local copy
  // but before (or during) the Object Storage upload, in case an older server
  // version didn't clean them up in the catch block.
  for (const f of entries) {
    if (f.endsWith(".meta.json")) continue;
    const metaPath = path.join(dir, f.replace(/\.[^.]+$/, ".meta.json"));
    if (!fs.existsSync(metaPath)) {
      try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ }
    }
  }
}

/**
 * Run the Object Storage cleanup cycle.
 *
 * Pass 1 — TTL expiry: download every .meta.json, delete the meta + media pair
 *   for any clip whose `expiresMs` is in the past.
 *
 * Pass 2 — Orphan removal: list all remaining objects in the bucket and delete
 *   any media key that has no live .meta.json counterpart.  These arise when
 *   `storeFile` uploads the media file but then fails (or crashes) before the
 *   meta upload completes.
 *
 * Pass 3 — Size cap: if the bucket still exceeds the cap after expiry, evict
 *   the soonest-to-expire live clips until usage falls below the cap.
 *
 * Exported so that unit tests can exercise the logic without triggering the
 * setInterval timer.
 */
export async function runObjectStorageCleanup(): Promise<void> {
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

  // ── Pass 2: Orphan removal ────────────────────────────────────────────
  // List all objects still in the bucket.  Any media key (non-.meta.json)
  // whose base name is not in the live set is an orphan — delete it.
  const liveBasesSet = new Set(live.map(e => e.base));
  const allKeysResult = await storage.list({ prefix: "clips/" });
  if (allKeysResult.ok) {
    for (const obj of allKeysResult.value) {
      if (obj.name.endsWith(".meta.json")) continue;
      const base = obj.name.replace(/^clips\//, "").replace(/\.[^.]+$/, "");
      if (!liveBasesSet.has(base)) {
        try {
          await storage.delete(obj.name, { ignoreNotFound: true });
        } catch { /* non-fatal */ }
      }
    }
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

  // ── Pass 3: Size cap — evict oldest-expiring clips first ─────────────
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
}

setInterval(() => {
  // Local disk
  try {
    runLocalDiskCleanup(SERVE_DIR);
  } catch { /* ignore */ }

  // Object Storage — runs async, errors are non-fatal
  runObjectStorageCleanup().catch((err: unknown) => {
    console.warn('[storage] Object Storage cleanup failed:', (err as Error).message);
  });

  // Circuit-breaker background probe — runs a cheap storage.list() when the
  // circuit is OPEN and the cool-down has elapsed, so uploads resume
  // automatically after an outage without needing a new clip to be processed.
  probeStorageIfOpen().catch((err: unknown) => {
    console.warn('[storage] Circuit breaker probe error:', (err as Error).message);
  });
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

// ── ZIP download of multiple clips ────────────────────────────────────────────
// Streams a single ZIP built from the stored clip files — no full buffering in
// memory (archiver pipes each file stream into the response). Mobile browsers
// get exactly one download prompt instead of N.
const MAX_ZIP_CLIPS = 50;

/** Resolve ids to files; skips missing/expired clips. */
async function resolveClipFiles(ids: string[]): Promise<Array<{ filePath: string; name: string }>> {
  const out: Array<{ filePath: string; name: string }> = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const resolved = await resolveFile(id);
    if (!resolved) continue;
    // De-duplicate entry names so the ZIP never contains colliding paths
    let name = path.basename(resolved.meta.name || `clip${resolved.meta.ext || ".mp4"}`);
    if (seen.has(name)) {
      const ext = path.extname(name);
      const base = name.slice(0, name.length - ext.length);
      let n = 2;
      while (seen.has(`${base} (${n})${ext}`)) n++;
      name = `${base} (${n})${ext}`;
    }
    seen.add(name);
    out.push({ filePath: resolved.filePath, name });
  }
  return out;
}

async function streamClipsZip(ids: string[], res: import("express").Response, checkOnly: boolean): Promise<void> {
  if (ids.length === 0) {
    res.status(400).json({ error: "No clip ids provided" });
    return;
  }
  const files = await resolveClipFiles(ids.slice(0, MAX_ZIP_CLIPS));
  if (files.length === 0) {
    res.status(404).json({ error: "None of the requested clips were found — they may have expired." });
    return;
  }
  if (checkOnly) {
    res.json({ ok: true, available: files.length, requested: ids.length });
    return;
  }

  // archiver v8 exports classes (ZipArchive) instead of a factory function
  const { ZipArchive } = await import("archiver");
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="clips.zip"`);
  // Explicit availability signal — lets the UI warn users when some clips were
  // skipped (expired / not found) rather than silently delivering a short archive.
  res.setHeader("X-Zip-Available", String(files.length));
  res.setHeader("X-Zip-Requested", String(ids.length));

  const archive = new ZipArchive({ zlib: { level: 0 } }); // mp4 is already compressed — store only
  archive.on("error", (err: Error) => {
    console.warn("[zip] archive error:", err.message);
    res.destroy();
  });
  archive.on("warning", (err: Error) => console.warn("[zip] archive warning:", err.message));
  res.on("close", () => { try { archive.destroy(); } catch { /* already done */ } });
  archive.pipe(res);
  for (const f of files) {
    archive.file(f.filePath, { name: f.name });
  }
  await archive.finalize();
}

// GET /video/zip?ids=a,b,c[&check=1] — ZIP arbitrary clip ids.
// With check=1 it only verifies the clips are available (cheap, no ZIP built),
// so the UI can decide between the ZIP path and the per-file fallback.
router.get("/video/zip", async (req, res): Promise<void> => {
  const ids = String(req.query.ids ?? "")
    .split(",")
    .map(s => s.trim())
    .filter(id => /^[\w-]{8,64}$/.test(id));
  try {
    await streamClipsZip(ids, res, req.query.check === "1");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[zip] failed:", msg);
    if (!res.headersSent) res.status(500).json({ error: "Could not build the ZIP file." });
    else res.destroy();
  }
});

// GET /video/job/:jobId/zip[?check=1] — ZIP all clips of a finished job.
router.get("/video/job/:jobId/zip", async (req, res): Promise<void> => {
  const rec = await readJobAnywhere(req.params.jobId);
  if (!rec || rec.status !== "done" || !rec.clips?.length) {
    res.status(404).json({ error: "Job not found, not finished, or has no clips." });
    return;
  }
  try {
    await streamClipsZip(rec.clips.map(c => c.id), res, req.query.check === "1");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[zip] failed:", msg);
    if (!res.headersSent) res.status(500).json({ error: "Could not build the ZIP file." });
    else res.destroy();
  }
});

// ── POST /video/download ──────────────────────────────────────────────────────
// Direct download proxy — downloads full video via Railway API then streams back
router.post("/video/download", async (req, res): Promise<void> => {
  const { url } = req.body as { url?: string };
  if (!url || !validateUrl(url)) {
    res.status(400).json({ error: "Invalid or missing URL" });
    return;
  }

  const slot = tryAcquireJob();
  if (!slot) { res.status(429).json({ error: "Server is busy right now — please try again in a minute." }); return; }
  await slot;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "viralai-dl-"));
  try {
    req.log.info({ url }, "Direct download");
    const srcPath = path.join(tmpDir, "video.mp4");
    await downloadVideo(url, srcPath);

    const stat = fs.statSync(srcPath);
    const fileId = await storeFile(srcPath, "video.mp4", "video/mp4");
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    res.json({ id: fileId, name: "video.mp4", size: stat.size });
  } catch (err) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    const msg = err instanceof Error ? err.message : String(err);
    req.log.error({ err: msg }, "Direct download failed");
    res.status(500).json({ error: msg });
  } finally {
    releaseJob();
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
  /** Set when the video couldn't fit the requested clip count. */
  countNote?: string;
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

// ── Orphan sweep: viralai-* tmp dirs left behind by a crash mid-job ──────────
// Normal jobs clean up after themselves; this catches the dirs (with large
// source.mp4 files) that survive a process crash and would fill the disk.
const ORPHAN_TMP_MAX_AGE_MS = 3 * 60 * 60 * 1000; // safely past any 20-min download cap
function sweepOrphanTmpDirs(): void {
  try {
    const tmp = os.tmpdir();
    for (const name of fs.readdirSync(tmp)) {
      if (!name.startsWith("viralai-")) continue;
      const p = path.join(tmp, name);
      try {
        // Liveness check: a dir's own mtime doesn't advance while a file inside
        // is being written, so use the NEWEST mtime of the dir and its entries.
        // An active download/encode keeps touching its files; a crash orphan
        // goes quiet and ages past the cutoff.
        let newest = fs.statSync(p).mtimeMs;
        for (const entry of fs.readdirSync(p)) {
          try {
            const m = fs.statSync(path.join(p, entry)).mtimeMs;
            if (m > newest) newest = m;
          } catch { /* entry vanished mid-scan */ }
        }
        if (Date.now() - newest > ORPHAN_TMP_MAX_AGE_MS) {
          fs.rmSync(p, { recursive: true, force: true });
        }
      } catch { /* raced with an active job — skip */ }
    }
  } catch { /* tmp unreadable — nothing to do */ }
}
sweepOrphanTmpDirs();
setInterval(sweepOrphanTmpDirs, 60 * 60 * 1000).unref();

type JobStatus = "queued" | "processing" | "done" | "error" | "cancelled";
interface JobRecord {
  status: JobStatus;
  createdMs: number;
  updatedMs: number;
  url: string;
  platform: string;
  clips?: ClipItem[];
  totalDuration?: string;
  /** Set when the video couldn't fit the requested clip count. */
  countNote?: string;
  error?: string;
  /** 1-based FIFO position while status === "queued" (0/absent once running). */
  queuePosition?: number;
  /** Instance that owns (runs) this job — records cached from Object Storage
   *  keep the REMOTE owner's id, so startup cleanup never touches them. */
  owner?: string;
}

// Stable per-machine owner id, persisted next to the job files so it survives
// process restarts on the same machine (dev restarts) but differs across
// autoscale instances. Falls back to a volatile id if the disk write fails.
const INSTANCE_ID_FILE = path.join(JOBS_DIR, ".owner-id");
const INSTANCE_ID: string = (() => {
  try {
    const existing = fs.readFileSync(INSTANCE_ID_FILE, "utf8").trim();
    if (/^[\w-]{8,64}$/.test(existing)) return existing;
  } catch { /* first boot on this machine */ }
  const id = crypto.randomBytes(12).toString("hex");
  try { fs.writeFileSync(INSTANCE_ID_FILE, id); } catch { /* tmp read-only — volatile id */ }
  return id;
})();

// Job records are ALSO mirrored to Object Storage. On autoscale deployments
// the poll request can land on a different instance than the one running the
// job (or a cold-started instance after scale-to-zero) — the local /tmp store
// alone then 404s every poll: "Lost track of this job".
const jobStorageKey = (jobId: string) => `jobs/${jobId}.json`;

// Per-job upload chains keep mirror writes ordered — rapid queued→processing→done
// transitions otherwise race and a stale "processing" can overwrite the final
// "done" record in the bucket.
const jobMirrorChain = new Map<string, Promise<unknown>>();
// Adapters signal failure via {ok:false} rather than throwing — a lost terminal
// "done" upload would leave other instances stuck on a stale "processing"
// record forever, so retry with backoff before giving up.
async function uploadJobWithRetry(jobId: string, json: string): Promise<void> {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await getStorageClient().uploadFromText(jobStorageKey(jobId), json);
      if (r.ok) return;
    } catch { /* treat like ok:false */ }
    await new Promise(res => setTimeout(res, 500 * 4 ** i)); // 0.5s, 2s, 8s
  }
  // Give up — the next heartbeat write retries within 60s; a storage outage
  // must never fail the pipeline itself.
}
function mirrorJob(jobId: string, json: string): void {
  const prev = jobMirrorChain.get(jobId) ?? Promise.resolve();
  const next = prev.then(() => uploadJobWithRetry(jobId, json), () => uploadJobWithRetry(jobId, json));
  jobMirrorChain.set(jobId, next);
  void next.catch(() => undefined).finally(() => {
    if (jobMirrorChain.get(jobId) === next) jobMirrorChain.delete(jobId);
  });
}

function writeJob(jobId: string, record: JobRecord): void {
  // Stamp ownership — this instance is running the job it writes about.
  const json = JSON.stringify({ ...record, owner: record.owner ?? INSTANCE_ID });
  fs.writeFileSync(path.join(JOBS_DIR, `${jobId}.json`), json);
  try { mirrorJob(jobId, json); } catch { /* storage client unavailable (tests/dev without bucket) */ }
}
// ── Startup sweep: fail jobs orphaned by a server restart ────────────────────
// Queued/processing records OWNED BY THIS INSTANCE belong to the previous
// process on this machine — their work is gone. Mark them failed with a
// friendly retry message right away (and mirror it) instead of leaving pollers
// waiting on the 5-minute stale-heartbeat timeout.
//
// Records with a DIFFERENT (or missing) owner are cross-instance cache copies
// written by readJobAnywhere — the job may still be running fine elsewhere, so
// they must never be failed or mirrored from here. Deleting the local copy is
// safe: the next poll re-fetches the authoritative record from Object Storage.
(function failOrphanedJobsOnStartup(): void {
  try {
    for (const f of fs.readdirSync(JOBS_DIR)) {
      if (!f.endsWith(".json")) continue;
      const id = f.slice(0, -".json".length);
      try {
        const p = path.join(JOBS_DIR, f);
        const rec = JSON.parse(fs.readFileSync(p, "utf8")) as JobRecord;
        if (rec.status !== "queued" && rec.status !== "processing") continue;
        if (rec.owner === INSTANCE_ID) {
          writeJob(id, {
            ...rec,
            status: "error",
            queuePosition: undefined,
            updatedMs: Date.now(),
            error: "The server restarted while this job was waiting. Please try again.",
          });
        } else {
          // Not ours — drop the stale local cache; storage stays authoritative.
          fs.unlinkSync(p);
        }
      } catch { /* unparseable record — cleanup interval will remove it */ }
    }
  } catch { /* jobs dir unreadable — nothing to sweep */ }
})();

function readJob(jobId: string): JobRecord | null {
  if (!/^[\w-]{8,64}$/.test(jobId)) return null;
  const p = path.join(JOBS_DIR, `${jobId}.json`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); }
  catch { return null; }
}
// Local-first read with Object Storage fallback (cross-instance polling).
// Terminal local records are authoritative. A non-terminal local record may be
// a stale re-cache from another instance's fallback — if its heartbeat is old,
// check the bucket for a fresher (possibly terminal) copy before trusting it.
async function readJobAnywhere(jobId: string): Promise<JobRecord | null> {
  if (!/^[\w-]{8,64}$/.test(jobId)) return null;
  const local = readJob(jobId);
  if (local && (local.status === "done" || local.status === "error")) return local;
  if (local && Date.now() - local.updatedMs <= 90 * 1000) return local; // heartbeat fresh — job live on this instance
  try {
    const r = await getStorageClient().downloadAsText(jobStorageKey(jobId));
    if (r.ok) {
      const rec = JSON.parse(r.value) as JobRecord;
      if (!local || rec.updatedMs >= local.updatedMs) {
        // Cache locally so subsequent polls on this instance stay fast.
        try { fs.writeFileSync(path.join(JOBS_DIR, `${jobId}.json`), r.value); } catch { /* disk full — serve anyway */ }
        return rec;
      }
    }
  } catch { /* storage unreachable — fall through to local */ }
  return local;
}
// GC mirrored job records older than 24h so the bucket never silently fills.
setInterval(() => {
  void (async () => {
    try {
      const cl = getStorageClient();
      const ls = await cl.list({ prefix: "jobs/" });
      if (!ls.ok) return;
      for (const { name } of ls.value) {
        try {
          const r = await cl.downloadAsText(name);
          if (!r.ok) continue;
          const rec = JSON.parse(r.value) as Partial<JobRecord>;
          if (Date.now() - (rec.createdMs ?? 0) > 24 * 60 * 60 * 1000) {
            await cl.delete(name, { ignoreNotFound: true });
          }
        } catch { /* skip unparseable record */ }
      }
    } catch { /* storage unreachable — retry next sweep */ }
  })();
}, 6 * 60 * 60 * 1000).unref();

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

// Identical concurrent clip requests (same URL + settings) share ONE running job —
// repeated "Try again" clicks or many users pasting the same link no longer
// download and encode the same video several times in parallel.
const inflightClips = new Map<string, Promise<{ clips: ClipItem[]; totalDuration: string; countNote?: string }>>();

// Cancel handles for async jobs that hold a queue ticket on THIS instance —
// DELETE /video/job/:id uses them to pull the waiter out of the FIFO queue.
const jobCancels = new Map<string, () => boolean>();

// ── DELETE /video/job/:jobId — cancel a job that is still waiting in line ────
router.delete("/video/job/:jobId", async (req, res): Promise<void> => {
  const jobId = req.params.jobId;
  const rec = await readJobAnywhere(jobId);
  if (!rec) {
    res.status(404).json({ error: "Job not found or expired." });
    return;
  }
  if (rec.status === "cancelled") {
    res.json({ status: "cancelled" }); // idempotent
    return;
  }
  if (rec.status === "done" || rec.status === "error") {
    res.status(409).json({ error: "This job has already finished." });
    return;
  }
  const cancel = jobCancels.get(jobId);
  if (!cancel || !cancel()) {
    // No local ticket (other instance / joined an in-flight job) or the slot
    // was already granted — the pipeline is running, too late to cancel.
    res.status(409).json({ error: "This job has already started processing and can't be cancelled." });
    return;
  }
  jobCancels.delete(jobId);
  // Write the terminal record immediately so the very next poll sees it
  // (settleJob's rejection handler writes the same state a microtask later).
  try {
    writeJob(jobId, { ...rec, status: "cancelled", queuePosition: undefined, error: undefined, updatedMs: Date.now(), owner: INSTANCE_ID });
  } catch { /* record write best-effort — pollers still see settleJob's write */ }
  res.json({ status: "cancelled" });
});

// ── GET /video/job/:jobId — poll an async clip job ────────────────────────────
router.get("/video/job/:jobId", async (req, res): Promise<void> => {
  const rec = await readJobAnywhere(req.params.jobId);
  if (!rec) {
    res.status(404).json({ error: "Job not found or expired. Please try again." });
    return;
  }
  // Running jobs heartbeat updatedMs every 60s — 5+ minutes of silence means the
  // server restarted mid-job and this record is orphaned.
  if ((rec.status === "queued" || rec.status === "processing") && Date.now() - rec.updatedMs > 5 * 60 * 1000) {
    res.json({ status: "error", error: "The job was interrupted. Please try again." });
    return;
  }
  res.json({ status: rec.status, clips: rec.clips, totalDuration: rec.totalDuration, countNote: rec.countNote, error: rec.error, platform: rec.platform, queuePosition: rec.queuePosition });
});

// ── Concurrency semaphore + FIFO queue ────────────────────────────────────────
// MAX_CONCURRENT_JOBS = heavy ffmpeg jobs at once. Derived from machine CPUs
// (leave one core for the event loop / downloads, cap at 8) — env-overridable.
// MAX_QUEUED_JOBS = max waiting in queue before returning 429.
const _JOB_CPUS = os.availableParallelism?.() ?? os.cpus().length;
const MAX_CONCURRENT_JOBS = Math.max(1, parseInt(
  process.env.MAX_CONCURRENT_JOBS ?? String(Math.min(8, Math.max(1, _JOB_CPUS - 1))),
  10) || 1);
const MAX_QUEUED_JOBS = parseInt(process.env.MAX_QUEUED_JOBS ?? "200", 10);  // 200 waiting in queue
// Fairness cap: one IP may hold at most this many WAITING queue slots at once.
// Running jobs don't count — the cap only stops a single user from stacking
// the FIFO line and starving everyone else. Env MAX_QUEUED_PER_IP overrides.
const MAX_QUEUED_PER_IP = Math.max(1, parseInt(process.env.MAX_QUEUED_PER_IP ?? "3", 10) || 3);
let activeJobs = 0;
interface QueueWaiter { id: number; grant: () => void; ip?: string }
let _waiterSeq = 0;
const jobQueue: QueueWaiter[] = [];

/** Thrown into a queued job's slot promise when the user cancels it — lets
 *  settleJob write a terminal "cancelled" record instead of a generic error. */
class JobCancelledError extends Error {
  constructor() { super("Cancelled by user"); this.name = "JobCancelledError"; }
}

/** A slot ticket: `promise` resolves when the job may start; `position()` is
 *  the live 1-based FIFO position (0 once the slot is granted). `cancel()`
 *  removes the waiter from the FIFO queue — returns true only while the job
 *  is still waiting (a started job cannot be cancelled). */
interface JobSlotTicket { promise: Promise<void>; position: () => number; cancel: () => boolean }

/** Rejection reasons from acquireJobSlot: global queue full vs per-IP fairness cap. */
type JobSlotDenied = { denied: "queue_full" } | { denied: "per_ip"; queuedForIp: number };

function isJobSlotDenied(t: JobSlotTicket | JobSlotDenied | null): t is JobSlotDenied {
  return t !== null && "denied" in t;
}

function acquireJobSlot(ip?: string): JobSlotTicket | JobSlotDenied | null {
  if (activeJobs >= MAX_CONCURRENT_JOBS && jobQueue.length >= MAX_QUEUED_JOBS) {
    return { denied: "queue_full" }; // signal: send 429
  }
  if (activeJobs < MAX_CONCURRENT_JOBS) {
    activeJobs++;
    return { promise: Promise.resolve(), position: () => 0, cancel: () => false };
  }
  // Fairness: refuse to queue more than MAX_QUEUED_PER_IP jobs for one IP.
  if (ip) {
    const queuedForIp = jobQueue.reduce((n, w) => n + (w.ip === ip ? 1 : 0), 0);
    if (queuedForIp >= MAX_QUEUED_PER_IP) {
      return { denied: "per_ip", queuedForIp };
    }
  }
  const id = ++_waiterSeq;
  let grant!: () => void;
  let cancelReject!: (e: Error) => void;
  const promise = new Promise<void>((resolve, reject) => {
    grant = () => { activeJobs++; resolve(); };
    cancelReject = reject;
  });
  jobQueue.push({ id, grant, ip });
  return {
    promise,
    position: () => {
      const idx = jobQueue.findIndex((w) => w.id === id);
      return idx === -1 ? 0 : idx + 1;
    },
    cancel: () => {
      const idx = jobQueue.findIndex((w) => w.id === id);
      if (idx === -1) return false; // slot already granted — job is processing
      jobQueue.splice(idx, 1);      // free the spot in line for everyone behind
      cancelReject(new JobCancelledError());
      return true;
    },
  };
}
/** Back-compat helper for endpoints that don't care about queue position. */
function tryAcquireJob(): Promise<void> | null {
  const t = acquireJobSlot();
  if (t === null || isJobSlotDenied(t)) return null;
  return t.promise;
}
function releaseJob() {
  activeJobs--;
  jobQueue.shift()?.grant();
}
/** Live queue stats — surfaced in /api/healthz for ops visibility. */
export function getJobQueueStats(): { active: number; queued: number; maxConcurrent: number; maxQueued: number } {
  return { active: activeJobs, queued: jobQueue.length, maxConcurrent: MAX_CONCURRENT_JOBS, maxQueued: MAX_QUEUED_JOBS };
}

// ── Per-job clip-level parallelism limiter ────────────────────────────────────
// Within a single job we run clips in parallel, capped at CLIPS_PARALLEL
// so we don't spawn N*activeJobs ffmpeg processes simultaneously.
// In deployments the default scales with the machine: leave one core for
// downloads/audio probing and cap at 4 (each encode holds a few hundred MB RAM).
// A 0.5-vCPU e2-small reports 2 → stays at 1 (parallel encodes starve each
// other into timeouts there); a 4-vCPU VM gets 3. Env CLIPS_PARALLEL overrides.
const MACHINE_CPUS = os.availableParallelism?.() ?? os.cpus().length;
const CLIPS_PARALLEL = Math.max(1, Number.parseInt(
  process.env.CLIPS_PARALLEL
    ?? (process.env.REPLIT_DEPLOYMENT ? String(Math.min(4, Math.max(1, MACHINE_CPUS - 1))) : "3"),
  10) || 1);

// Deployment machines are far weaker than dev (observed: 0.5-vCPU VM encodes
// 1080x1920 veryfast at ~0.1x realtime → a 30s clip blows the 4-min per-clip
// timeout). In deployments default to a light profile: 720x1280 + superfast +
// 30fps cap — ~4-6x faster, and 720p is native quality for Shorts/TikTok/Reels
// re-encodes. Override with ENCODE_PROFILE=quality|fast.
const ENCODE_PROFILE = process.env.ENCODE_PROFILE ?? (process.env.REPLIT_DEPLOYMENT ? "fast" : "quality");

interface EncProfile { w: number; h: number; preset: string; crf: string; fps: number | null; srcMaxHeight: number; clipTimeoutMs: number }
const ENC_PROFILES: Record<"fast" | "quality", EncProfile> = {
  // 720p vertical, ultrafast — reliable on 0.5-vCPU production machines.
  // ultrafast/crf25 is ~1.4x faster than superfast/crf24; at 720p social-clip
  // quality the difference is invisible after the platforms re-encode.
  fast:    { w: 720,  h: 1280, preset: "ultrafast", crf: "25", fps: 30,   srcMaxHeight: 720,  clipTimeoutMs: 240_000 },
  // Full-HD 1080p vertical — ~4x slower on small machines, so the per-clip
  // timeout is raised accordingly (a 0.5-vCPU VM encodes 1080x1920 at ~0.1x realtime).
  quality: { w: 1080, h: 1920, preset: "veryfast",  crf: "23", fps: null, srcMaxHeight: 1080, clipTimeoutMs: 900_000 },
};

/** Server-wide default profile (env-driven) — used when a job doesn't ask. */
const ENC = ENC_PROFILES[ENCODE_PROFILE === "fast" ? "fast" : "quality"];

/** Resolve the encode profile for a job: an explicit per-job request wins,
 *  otherwise the server-wide ENCODE_PROFILE default applies. */
function resolveEncProfile(requested?: string): { name: "fast" | "quality"; enc: EncProfile } {
  const name: "fast" | "quality" =
    requested === "quality" || requested === "1080p" ? "quality" :
    requested === "fast"    || requested === "720p"  ? "fast" :
    (ENCODE_PROFILE === "fast" ? "fast" : "quality");
  return { name, enc: ENC_PROFILES[name] };
}

// Surfaced in /api/healthz so we can verify which profile a deployment runs.
export const ENCODE_INFO = Object.freeze({
  profile: ENCODE_PROFILE,
  output: `${ENC.w}x${ENC.h}`,
  preset: ENC.preset,
  clipsParallel: CLIPS_PARALLEL,
  cpus: MACHINE_CPUS,
});

function makeClipLimiter(max: number = CLIPS_PARALLEL) {
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
      running < max ? run() : q.push(run);
    });
  };
}

// Section downloads are network-bound, not CPU-bound — running them at
// CLIPS_PARALLEL (1 in deployments) serialized five yt-dlp invocations and
// turned a ~40s stage into ~3 minutes on prod. Each section is ≤ ~20 MB, so a
// few concurrent downloads are safe even on a 2 GB machine.
const SECTION_DL_PARALLEL = Math.max(1, Number.parseInt(process.env.SECTION_DL_PARALLEL ?? "4", 10) || 4);

// ── Viral timestamp picker ────────────────────────────────────────────────────
// Preferred: transcript-scored highlights (dense/emphatic speech). Fallback:
// the original spread strategy when no usable transcript exists.

/** Fetch English subtitles via yt-dlp (metadata only, no video download) and
 *  return numeric-time segments. Null when no captions are available. */
async function fetchTranscriptSegments(videoUrl: string): Promise<TranscriptSegment[] | null> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "viralai-hlt-"));
  try {
    for (const flag of ["--write-auto-subs", "--write-subs"]) {
      await execFileAsync(
        YTDLP_PATH,
        [
          flag,
          "--sub-format", "vtt",
          "--sub-langs", "en,en-US,en-GB",
          "--skip-download", "--no-playlist", "--no-warnings",
          "--retries", "2", "--extractor-retries", "1",
          "--extractor-args", "youtube:player_client=ios,android,web",
          ...getCookieArgs(),
          "-o", path.join(tmpDir, "%(id)s"),
          cleanVideoUrl(videoUrl),
        ],
        { maxBuffer: 16 * 1024 * 1024, timeout: 90_000 },
      ).catch(() => { /* try next flag */ });

      const vttFiles = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".vtt"));
      if (vttFiles.length > 0) {
        const raw = fs.readFileSync(path.join(tmpDir, vttFiles[0]), "utf-8");
        const segments = parseVTTNumeric(raw);
        return segments.length > 0 ? segments : null;
      }
    }
    return null;
  } catch (e) {
    console.warn('[highlight] transcript fetch failed:', lastErrLine((e as Error).message));
    return null;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ── Audio-energy fallback (no usable transcript) ─────────────────────────────

/** Seconds of audio probed per candidate window (kept short — probes are cheap). */
const AUDIO_PROBE_SECONDS = 20;

/** Download only the audio track of [startSec, endSec] — a tiny fraction of a
 *  full section download; used to score loudness without touching video bytes. */
async function downloadAudioSection(videoUrl: string, startSec: number, endSec: number, destPath: string): Promise<void> {
  try {
    await execFileAsync(
      YTDLP_PATH,
      [
        "-f", "bestaudio[ext=m4a]/bestaudio/best",
        "--download-sections", `*${Math.max(0, Math.floor(startSec))}-${Math.ceil(endSec)}`,
        "--no-playlist", "--no-warnings",
        "--retries", "2", "--extractor-retries", "1",
        ...YTDLP_EXTRACTOR_ARGS, ...getCookieArgs(), ...YTDLP_FFMPEG_ARGS,
        "-o", destPath,
        cleanVideoUrl(videoUrl),
      ],
      { maxBuffer: 64 * 1024 * 1024, timeout: 90_000 },
    );
  } catch (e) {
    isBotCheckError((e as Error).message); // record likely-expired cookies
    throw e;
  }
  if (!fs.existsSync(destPath) || fs.statSync(destPath).size < 1_000) {
    throw new Error("Audio section download produced no usable output");
  }
}

/** Energy score for an audio file (or a [startSec, +durSec] slice of a local
 *  file): ffmpeg volumedetect mean volume plus a dynamic-range bonus, in dB.
 *  Higher = louder / punchier. Null when measurement fails. */
async function measureAudioEnergy(filePath: string, startSec?: number, durSec?: number): Promise<number | null> {
  try {
    const args: string[] = ["-hide_banner", "-nostats"];
    if (startSec !== undefined) args.push("-ss", startSec.toFixed(3));
    args.push("-i", filePath);
    if (durSec !== undefined) args.push("-t", durSec.toFixed(3));
    args.push("-vn", "-af", "volumedetect", "-f", "null", "-");
    const { stderr } = await execFileAsync(FFMPEG_PATH, args, { maxBuffer: 16 * 1024 * 1024, timeout: 60_000 });
    const mean = parseFloat(stderr.match(/mean_volume:\s*(-?[\d.]+)/)?.[1] ?? "");
    if (!Number.isFinite(mean)) return null;
    const max = parseFloat(stderr.match(/max_volume:\s*(-?[\d.]+)/)?.[1] ?? "");
    // Dynamic-range bonus: a window with big peaks over its average (crowd pop,
    // bass drop) beats one that is uniformly medium-loud.
    const dyn = Number.isFinite(max) ? (max - mean) * 0.3 : 0;
    return mean + dyn;
  } catch {
    return null;
  }
}

/** Probe evenly-spaced candidate windows for audio energy and keep the top-N.
 *  Uses cheap audio-only section downloads for remote URLs, or reads slices of
 *  an already-downloaded local file. Null when probing can't produce a ranking. */
async function pickAudioEnergyClipTimes(
  videoUrl: string,
  totalDuration: number,
  clipDuration: number,
  count: number,
  opts: { allowAudioProbe: boolean; localPath?: string },
): Promise<number[] | null> {
  if (!opts.localPath && !opts.allowAudioProbe) return null;
  const windows = pickAudioProbeWindows(totalDuration, clipDuration, count);
  if (windows.length < 2) return null;
  const probeDur = Math.min(clipDuration, AUDIO_PROBE_SECONDS);

  let measurements: AudioEnergyMeasurement[];
  if (opts.localPath) {
    // Full file already on disk (Drive/Dropbox path) — slice it directly.
    const localPath = opts.localPath;
    const limit = makeClipLimiter();
    measurements = await Promise.all(
      windows.map((start) => limit(async () => ({ start, energy: await measureAudioEnergy(localPath, start, probeDur) }))),
    );
  } else {
    // Fast path: audio-only section downloads — never the full video.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "viralai-aprobe-"));
    try {
      const limit = makeClipLimiter();
      measurements = await Promise.all(
        windows.map((start, i) => limit(async (): Promise<AudioEnergyMeasurement> => {
          const p = path.join(tmpDir, `probe_${i}.m4a`);
          try {
            await downloadAudioSection(videoUrl, start, start + probeDur, p);
            return { start, energy: await measureAudioEnergy(p) };
          } catch (e) {
            console.warn(`[highlight] audio probe at ${Math.round(start)}s failed:`, lastErrLine((e as Error).message));
            return { start, energy: null };
          } finally {
            try { fs.unlinkSync(p); } catch { /* ignore */ }
          }
        })),
      );
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  const valid = measurements.filter((m) => m.energy !== null).length;
  console.log(`[highlight] audio probe: ${valid}/${windows.length} windows measured`);
  return pickAudioEnergyTimestamps(measurements, totalDuration, clipDuration, count);
}

/** Pick clip start times: transcript highlights when available, audio-energy
 *  scoring when captions are missing/sparse, spread as the final fallback.
 *  `allowTranscript` gates the yt-dlp subtitle fetch to platforms it supports;
 *  `allowAudioProbe` gates yt-dlp audio-section probing (remote fast path);
 *  `localPath` lets the audio scorer read an already-downloaded file instead. */
async function pickClipTimestamps(
  videoUrl: string,
  totalDuration: number,
  clipDuration: number,
  count: number,
  opts: { allowTranscript: boolean; allowAudioProbe?: boolean; localPath?: string },
): Promise<{ timestamps: number[]; strategy: "transcript" | "audio" | "spread" }> {
  if (opts.allowTranscript && recentlyBotBlocked()) {
    console.log('[highlight] skipping transcript — YouTube bot-check active, going straight to audio energy');
  }
  if (opts.allowTranscript && !recentlyBotBlocked()) {
    try {
      const segments = await fetchTranscriptSegments(videoUrl);
      if (segments) {
        const picked = pickTranscriptTimestamps(segments, totalDuration, clipDuration, count);
        if (picked) return { timestamps: picked, strategy: "transcript" };
        console.log('[highlight] transcript too sparse — trying audio energy');
      } else {
        console.log('[highlight] no transcript available — trying audio energy');
      }
    } catch (e) {
      console.warn('[highlight] transcript scoring failed, trying audio energy:', (e as Error).message);
    }
  }

  try {
    const picked = await pickAudioEnergyClipTimes(videoUrl, totalDuration, clipDuration, count, {
      allowAudioProbe: opts.allowAudioProbe ?? false,
      localPath: opts.localPath,
    });
    if (picked) return { timestamps: picked, strategy: "audio" };
    console.log('[highlight] audio energy unavailable — using spread strategy');
  } catch (e) {
    console.warn('[highlight] audio probing failed, using spread strategy:', (e as Error).message);
  }

  return { timestamps: pickSpreadTimestamps(totalDuration, clipDuration, count), strategy: "spread" };
}

// ── POST /video/clip ── direct synchronous response ──────────────────────────
router.post("/video/clip", async (req, res): Promise<void> => {
  const {
    url,
    clipDuration = 30,
    platform = "shorts",
    clipCount = 5,
    quality,
    async: asyncMode = false,
  } = req.body as {
    url?: string;
    clipDuration?: number;
    platform?: string;
    viralMode?: boolean;
    clipCount?: number;
    quality?: string;
    async?: boolean;
  };

  if (!url || !validateUrl(url)) {
    res.status(400).json({ error: "Invalid or missing URL" });
    return;
  }

  const safeClipCount = Math.min(Math.max(1, Number(clipCount)), 10);
  const platformCfg = PLATFORM_SETTINGS[platform as string] ?? PLATFORM_SETTINGS.shorts;
  const safeClipDuration = Math.min(Number(clipDuration), platformCfg.maxClipDuration);
  // Per-job encode profile: users can request full-HD ("quality"/"1080p") or
  // fast 720p ("fast"/"720p"); otherwise the server default applies.
  const { name: encProfileName, enc: encJob } = resolveEncProfile(quality);
  const cacheKey = `${url}|${safeClipDuration}|${safeClipCount}|${platform}|${encProfileName}`;

  // Async mode: respond immediately with a jobId; the frontend polls /video/job/:id.
  // This sidesteps the ~120s proxy timeout that kills long synchronous responses.
  const jobId = asyncMode ? crypto.randomBytes(12).toString("hex") : null;
  const jobMeta = { createdMs: Date.now(), url, platform };
  const writeJobSafe = (record: JobRecord) => {
    if (jobId) { try { writeJob(jobId, record); } catch { /* ignore */ } }
  };
  // `positionFn` (from the queue ticket) makes the record honest while waiting:
  // status "queued" + live FIFO position until the slot is granted, then
  // "processing". Heartbeats refresh updatedMs so pollers can tell a live job
  // apart from one orphaned by a server restart.
  const settleJob = (p: Promise<{ clips: ClipItem[]; totalDuration: string; countNote?: string }>, positionFn?: () => number) => {
    const writeState = () => {
      const pos = positionFn?.() ?? 0;
      if (pos > 0) writeJobSafe({ status: "queued", ...jobMeta, updatedMs: Date.now(), queuePosition: pos });
      else writeJobSafe({ status: "processing", ...jobMeta, updatedMs: Date.now() });
    };
    writeState();
    // Queued jobs heartbeat fast so the frontend sees the position move;
    // processing jobs only need the 60s liveness heartbeat.
    const heartbeat = setInterval(writeState, positionFn ? 10_000 : 60_000);
    p.then(
      (r) => { clearInterval(heartbeat); writeJobSafe({ status: "done", ...jobMeta, updatedMs: Date.now(), clips: r.clips, totalDuration: r.totalDuration, countNote: r.countNote }); },
      (e) => {
        clearInterval(heartbeat);
        if (e instanceof Error && e.name === "JobCancelledError") {
          writeJobSafe({ status: "cancelled", ...jobMeta, updatedMs: Date.now() });
        } else {
          writeJobSafe({ status: "error", ...jobMeta, updatedMs: Date.now(), error: e instanceof Error ? e.message : String(e) });
        }
      },
    );
  };

  // Cache hit — instant response
  const cached = resultCache.get(cacheKey);
  if (cached && cached.expires > new Date()) {
    req.log.info({ cacheKey }, "Cache hit");
    if (jobId) {
      settleJob(Promise.resolve({ clips: cached.clips, totalDuration: cached.totalDuration }));
      res.status(202).json({ jobId });
      return;
    }
    res.json({ clips: cached.clips, totalDuration: cached.totalDuration, countNote: cached.countNote, platform });
    return;
  }

  // Identical job already running (repeated "Try again", multiple users, same URL)?
  // Join it instead of downloading/encoding the same video twice.
  const existing = inflightClips.get(cacheKey);
  if (existing) {
    req.log.info({ cacheKey }, "Joining in-flight identical clip job");
    if (jobId) {
      settleJob(existing);
      res.status(202).json({ jobId });
      return;
    }
    try {
      const r = await existing;
      res.json({ clips: r.clips, totalDuration: r.totalDuration, countNote: r.countNote, platform });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // Storage guard — refuse new jobs when the scratch disk is nearly full,
  // so running jobs can finish instead of everything failing mid-encode.
  if (tmpFreeBytes() < MIN_FREE_DISK_BYTES) {
    res.status(503).json({ error: "Server storage is temporarily full. Please try again in a few minutes." });
    return;
  }

  // Queue full or this IP already holds its fair share of the line?
  const ticket = acquireJobSlot(req.ip);
  if (!ticket || isJobSlotDenied(ticket)) {
    if (ticket && ticket.denied === "per_ip") {
      res.status(429).json({
        error: `You already have ${ticket.queuedForIp} jobs waiting in the queue. Please wait for one to finish before submitting more.`,
      });
    } else {
      res.status(429).json({ error: "Server is busy. Please try again in 30 seconds." });
    }
    return;
  }

  // The actual work — one shared promise per cacheKey; joiners above await it.
  const jobPromise = (async (): Promise<{ clips: ClipItem[]; totalDuration: string; countNote?: string }> => {
  await ticket.promise;
  try {
  // Re-check disk AFTER the queue wait — space may have vanished while queued
  if (tmpFreeBytes() < MIN_FREE_DISK_BYTES) {
    throw new Error("Server storage is temporarily full. Please try again in a few minutes.");
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "viralai-clip-"));
  try {
    req.log.info({ url, safeClipDuration, platform, safeClipCount, encProfile: encProfileName }, "Starting clip job");

    const srcPath = path.join(tmpDir, "source.mp4");
    let totalDuration = 0;
    let timestamps: number[] = [];
    let sectionFiles: string[] | null = null;

    // ── Step 1 (fast path): probe duration WITHOUT downloading, then fetch ONLY
    // the sections needed for the clips. Works for yt-dlp-native platforms
    // (YouTube, Twitch, most sites). Long videos never hit the disk in full.
    const srcKind = detectSourcePlatform(url);
    let isLiveSource = false;
    // Section downloads normally hit the submitted URL, but Kick live streams
    // must clip from the in-progress recording's IVS m3u8 instead.
    let sectionSourceUrl = url;
    // Zyla resolution outcome for THIS job: string = mirror to reuse, null =
    // already tried and failed (Step-2 fallback must NOT spend a second paid
    // start on the same job — quality jobs resolve at 1080 but downloadVideo
    // would re-resolve at 720, a different cache key).
    let zylaMirrorUrl: string | null = null;
    // YouTube: resolve a direct media mirror through the Zyla engine FIRST —
    // the duration probe, loudness analysis, and section downloads then all
    // read from that URL, so YouTube's bot-blocking never touches the clip
    // pipeline. On any engine failure we keep the original URL and the
    // existing yt-dlp → API fallback chain takes over unchanged.
    if (srcKind === 'youtube') {
      const zyla = await resolveZylaSource(url, encJob.srcMaxHeight);
      if (zyla) {
        sectionSourceUrl = zyla.url;
        zylaMirrorUrl = zyla.url;
        req.log.info("YouTube source resolved via download engine — clipping from direct mirror");
      } else {
        req.log.warn("Download engine unavailable for this video — using yt-dlp chain");
      }
    }
    if (srcKind === 'youtube' || srcKind === 'twitch' || srcKind === 'kick' || srcKind === 'unknown') {
      let probed = sectionSourceUrl !== url
        ? (await ffprobeRemoteDuration(sectionSourceUrl)) ?? (await probeDurationSeconds(url))
        : await probeDurationSeconds(url);
      // Kick live: yt-dlp reports is_live with NO duration (and channel URLs of
      // offline channels fail the probe entirely). Resolve the in-progress
      // recording via Kick's channel API and probe its sealed duration instead.
      if (srcKind === 'kick' && (!probed || (probed.isLive && probed.duration <= 0))) {
        const kickLive = await resolveKickLiveSource(url);
        if (kickLive) {
          req.log.info({ recordedSeconds: kickLive.duration }, "Kick live stream — clipping from in-progress recording");
          probed = { duration: kickLive.duration, isLive: true };
          sectionSourceUrl = kickLive.src;
        } else if (probed?.isLive) {
          throw new Error("This Kick stream is live but its recording isn't readable yet. Try again in a few minutes, or use the VOD after the stream ends.");
        }
      }
      if (probed) {
        isLiveSource = probed.isLive;
        // In-progress live VOD (e.g. Twitch stream still running): clip only the sealed
        // recorded part — stay a couple of minutes behind the live edge so every
        // section download hits finished segments.
        const usableDuration = probed.isLive
          ? probed.duration - Math.max(120, Math.floor(probed.duration * 0.03))
          : probed.duration;
        if (probed.isLive && usableDuration < safeClipDuration + 10) {
          throw new Error("This stream is live and just started — not enough recorded video yet. Try again in a few minutes.");
        }
        if (usableDuration > 0) {
        totalDuration = usableDuration;
        const pick = await pickClipTimestamps(sectionSourceUrl, totalDuration, safeClipDuration, safeClipCount, { allowTranscript: sectionSourceUrl === url, allowAudioProbe: true });
        timestamps = pick.timestamps;
        req.log.info({ strategy: pick.strategy, timestamps: timestamps.map(t => Math.round(t)) }, "Clip timestamps picked");
        const dlLimit = makeClipLimiter(SECTION_DL_PARALLEL);
        try {
          sectionFiles = await Promise.all(
            timestamps.map((startSec, i) => dlLimit(async () => {
              const secPath = path.join(tmpDir, `section_${i}.mp4`);
              await downloadVideoSection(sectionSourceUrl, startSec, Math.min(startSec + safeClipDuration + 2, totalDuration), secPath, encJob.srcMaxHeight);
              return secPath;
            })),
          );
          req.log.info({ sections: sectionFiles.length, totalDuration, live: isLiveSource }, "Section downloads done — skipped full-video download");
        } catch (e) {
          if (isLiveSource) {
            throw new Error("Couldn't read the recorded part of this live stream. Try again in a few minutes, or use the VOD after the stream ends.");
          }
          req.log.warn({ err: (e as Error).message }, "Section download failed — falling back to full download");
          sectionFiles = null;
        }
        }
      }
    }

    // ── Step 2 (fallback): full download + ffprobe — Drive/Dropbox, or when
    // the fast path failed for any reason.
    if (!sectionFiles) {
      if (isLiveSource) {
        // Never full-download a stream that is still live — it has no end.
        throw new Error("This stream is still live — try again in a few minutes, or use the VOD link once the stream ends.");
      }
      await downloadAny(url, srcPath, srcKind === 'youtube' ? zylaMirrorUrl : undefined);
      const { stdout: probeOut } = await execFileAsync(
        FFPROBE_PATH,
        ["-v", "quiet", "-print_format", "json", "-show_format", srcPath],
        { timeout: 15_000 },
      );
      totalDuration = Math.floor(
        parseFloat((JSON.parse(probeOut) as { format: { duration: string } }).format.duration),
      );
      if (totalDuration <= 0) throw new Error("Could not determine video duration.");
      // No hard cap — any video length is supported.
      // Transcript scoring only makes sense for yt-dlp-native sources (Drive/
      // Dropbox direct files have no subtitle endpoint to query).
      const canTranscript = srcKind === 'youtube' || srcKind === 'twitch' || srcKind === 'unknown';
      const pick = await pickClipTimestamps(url, totalDuration, safeClipDuration, safeClipCount, { allowTranscript: canTranscript, localPath: srcPath });
      timestamps = pick.timestamps;
      req.log.info({ strategy: pick.strategy, timestamps: timestamps.map(t => Math.round(t)) }, "Clip timestamps picked (full-download path)");
    }

    const clipsDir = path.join(tmpDir, "clips");
    const thumbsDir = path.join(tmpDir, "thumbs");
    fs.mkdirSync(clipsDir);
    fs.mkdirSync(thumbsDir);

    // Crop FIRST at source resolution, then scale once to the target size.
    // The old order (scale=-2:1920,crop=1080:1920) upscaled the FULL frame to
    // 1920-height (a 16:9 source becomes 3413x1920 = 6.5M px/frame through the
    // scaler) before throwing 2/3 of it away — brutal on small prod CPUs.
    // crop=min(iw,ih*9/16):ih takes the center 9:16 window at source res
    // (a no-op for narrower-than-9:16 sources), fps cap drops 60fps sources
    // before scaling. scale…decrease + pad preserves geometry for narrow
    // sources (pillarbox instead of stretch — the old chain hard-errored on
    // them); for normal wide/16:9 sources crop yields exact 9:16 so scale hits
    // the target and pad is a no-op. force_divisible_by keeps libx264-legal
    // even dims; setsar=1 squares pixels. Same visual output, fraction of CPU.
    const vfFilter = platformCfg.crop
      ? `crop=min(iw\\,ih*${encJob.w}/${encJob.h}):ih${encJob.fps ? `,fps=${encJob.fps}` : ""},` +
        `scale=${encJob.w}:${encJob.h}:force_original_aspect_ratio=decrease:force_divisible_by=2,` +
        `pad=${encJob.w}:${encJob.h}:(ow-iw)/2:(oh-ih)/2,setsar=1`
      : null;
    const limit = makeClipLimiter();

    // ── Step 3: Clip each segment from the downloaded source ─────────────────
    const clips: ClipItem[] = await Promise.all(
      timestamps.map((startSec, i) =>
        limit(async () => {
          const endSec    = Math.min(startSec + safeClipDuration, totalDuration);
          const clipPath  = path.join(clipsDir, `clip_${String(i).padStart(3, "0")}.mp4`);
          const thumbPath = path.join(thumbsDir, `thumb_${i}.jpg`);
          // Section files already start at (the keyframe just before) startSec — seek 0.
          const clipSrc   = sectionFiles ? sectionFiles[i] : srcPath;
          const seekSec   = sectionFiles ? 0 : startSec;
          // Fast seek (-ss before -i) — use execFileAsync (no shell) so * in vf filter isn't glob-expanded
          // No vf filter (original platform): stream copy — near-instant, no re-encode
          // With vf filter (crop): preset/crf come from ENC (light profile on small prod machines)
          // +faststart puts the moov atom up front so clips start playing instantly in browsers
          const clipArgs = vfFilter ? [
            "-y", "-ss", seekSec.toFixed(3),
            "-i", clipSrc,
            "-t", (endSec - startSec).toFixed(3),
            "-vf", vfFilter,
            "-c:v", "libx264", "-preset", encJob.preset, "-crf", encJob.crf,
            "-c:a", "aac", "-b:a", "128k",
            "-movflags", "+faststart",
            clipPath,
          ] : [
            "-y", "-ss", seekSec.toFixed(3),
            "-i", clipSrc,
            "-t", (endSec - startSec).toFixed(3),
            "-c", "copy",   // stream copy — instant, no quality loss
            "-movflags", "+faststart",
            clipPath,
          ];
          await execFileAsync(FFMPEG_PATH, clipArgs, { maxBuffer: 20 * 1024 * 1024, timeout: encJob.clipTimeoutMs });

          // Thumbnail (base64 inline — survives restarts)
          const thumbVf = vfFilter ? `${vfFilter},scale=320:-2` : "scale=320:-2";
          const thumbOk = await execFileAsync(
            FFMPEG_PATH,
            ["-y", "-ss", "1", "-i", clipPath, "-frames:v", "1", "-q:v", "5", "-vf", thumbVf, thumbPath],
            { maxBuffer: 5 * 1024 * 1024, timeout: 30_000 },
          ).then(() => true).catch(() =>
            execFileAsync(
              FFMPEG_PATH,
              ["-y", "-i", clipPath, "-frames:v", "1", "-q:v", "5", "-vf", thumbVf, thumbPath],
              { maxBuffer: 5 * 1024 * 1024, timeout: 30_000 },
            ).then(() => true).catch(() => false),
          );

          let thumbnailDataUrl = "";
          if (thumbOk && fs.existsSync(thumbPath)) {
            try {
              // async read — with 8 jobs × 10 clips, sync reads would block the event loop
              thumbnailDataUrl = `data:image/jpeg;base64,${(await fs.promises.readFile(thumbPath)).toString("base64")}`;
            } catch { /* leave empty */ }
          }

          const stat = await fs.promises.stat(clipPath);
          return {
            id: await storeFile(clipPath, `clip_${i + 1}.mp4`, "video/mp4"),
            name:  `clip_${i + 1}.mp4`,
            label: `Clip ${i + 1}`,
            startTime:       fmtDuration(startSec),
            endTime:         fmtDuration(endSec),
            duration:        fmtDuration(endSec - startSec),
            size:            stat.size,
            thumbnailDataUrl,
            thumbnailId: "",
          };
        }),
      ),
    );

    const countNote = timestamps.length < safeClipCount
      ? `This ${fmtDuration(totalDuration)} video only fits ${timestamps.length} non-overlapping ${safeClipDuration}s clip${timestamps.length === 1 ? "" : "s"} (you asked for ${safeClipCount}).`
      : undefined;
    const result = { clips, totalDuration: fmtDuration(totalDuration), countNote };
    resultCache.set(cacheKey, { ...result, platform, expires: new Date(Date.now() + 2 * 60 * 60 * 1000) });
    // Bound the cache — Map preserves insertion order, so the first key is the oldest.
    while (resultCache.size > 300) {
      const oldest = resultCache.keys().next().value;
      if (oldest === undefined) break;
      resultCache.delete(oldest);
    }
    // Clips + thumbs are persisted by storeFile — the whole scratch dir can go now
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    return result;
  } catch (err) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    throw err;
  }
  } finally {
    releaseJob();
  }
  })();

  inflightClips.set(cacheKey, jobPromise);
  jobPromise.then(
    () => inflightClips.delete(cacheKey),
    () => inflightClips.delete(cacheKey),
  );

  if (jobId) {
    settleJob(jobPromise, ticket.position);
    // Register the cancel handle so DELETE /video/job/:id can pull this job
    // out of the queue while it waits; drop it once the job settles.
    jobCancels.set(jobId, ticket.cancel);
    jobPromise.then(() => jobCancels.delete(jobId), () => jobCancels.delete(jobId));
    res.status(202).json({ jobId });
    return;
  }

  try {
    const r = await jobPromise;
    res.json({ clips: r.clips, totalDuration: r.totalDuration, countNote: r.countNote, platform });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    req.log.error({ err: msg }, "Clip job failed");
    res.status(500).json({ error: msg });
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

  const slot = tryAcquireJob();
  if (!slot) { res.status(429).json({ error: "Server is busy right now — please try again in a minute." }); return; }
  await slot;
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
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    res.json({ id: fileId, name: "trimmed.mp4", size: stat.size });
  } catch (err) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    const msg = err instanceof Error ? err.message : String(err);
    req.log.error({ err: msg }, "Trim failed");
    res.status(500).json({ error: msg });
  } finally {
    releaseJob();
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

  const slot = tryAcquireJob();
  if (!slot) { res.status(429).json({ error: "Server is busy right now — please try again in a minute." }); return; }
  await slot;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "viralai-vert-"));
  try {
    req.log.info({ url }, "Cropping to 9:16 vertical");

    const srcPath = path.join(tmpDir, "source.mp4");
    await downloadVideo(url, srcPath);

    const outPath = path.join(tmpDir, "vertical_9x16.mp4");
    await execFileAsync(FFMPEG_PATH, [
      "-y", "-i", srcPath,
      "-vf", "scale=-2:1920,crop=1080:1920",
      "-c:v", "libx264", "-preset", "fast", "-crf", "23",
      "-c:a", "aac", "-b:a", "128k",
      outPath,
    ], { maxBuffer: 20 * 1024 * 1024 });

    const stat = fs.statSync(outPath);
    const fileId = await storeFile(outPath, "vertical_9x16.mp4", "video/mp4");
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    res.json({ id: fileId, name: "vertical_9x16.mp4", size: stat.size });
  } catch (err) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    const msg = err instanceof Error ? err.message : String(err);
    req.log.error({ err: msg }, "Vertical crop failed");
    res.status(500).json({ error: msg });
  } finally {
    releaseJob();
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

  const slot = tryAcquireJob();
  if (!slot) { res.status(429).json({ error: "Server is busy right now — please try again in a minute." }); return; }
  await slot;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "viralai-audio-"));
  try {
    req.log.info({ url }, "Extracting audio");

    const srcPath = path.join(tmpDir, "source.mp4");
    await downloadVideo(url, srcPath);

    const outPath = path.join(tmpDir, "audio.mp3");
    await execFileAsync(
      FFMPEG_PATH,
      ["-y", "-i", srcPath, "-vn", "-c:a", "libmp3lame", "-b:a", "192k", outPath],
      { maxBuffer: 20 * 1024 * 1024 }
    );

    const stat = fs.statSync(outPath);
    const fileId = await storeFile(outPath, "audio.mp3", "audio/mpeg");
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    res.json({ id: fileId, name: "audio.mp3", size: stat.size });
  } catch (err) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    const msg = err instanceof Error ? err.message : String(err);
    req.log.error({ err: msg }, "Audio extraction failed");
    res.status(500).json({ error: msg });
  } finally {
    releaseJob();
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

  const slot = tryAcquireJob();
  if (!slot) { res.status(429).json({ error: "Server is busy right now — please try again in a minute." }); return; }
  await slot;
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
  } finally {
    releaseJob();
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
