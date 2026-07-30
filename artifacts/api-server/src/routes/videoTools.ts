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

/** True when a yt-dlp error message is YouTube's "Sign in to confirm you're not
 *  a bot" wall. Records the cookies-likely-expired state when cookies are
 *  configured, so the UI can prompt for a re-upload. */
function isBotCheckError(msg: string): boolean {
  const hit = msg.includes("Sign in to confirm");
  if (hit) reportCookieBotBlock();
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
 *  direct URL tricks for Drive/Dropbox. No third-party serverless APIs. */
async function downloadAny(videoUrl: string, destPath: string): Promise<void> {
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
    // file — the direct-download rewrite can't fetch those, so tell the user
    // to share the file itself instead of a confusing "not shared" error.
    if (/^\/(sh)\//.test(u.pathname) || u.pathname.startsWith('/scl/fo/')) {
      throw new Error(
        'This is a Dropbox folder link, not a file link. Open the folder, hover over the video file, click Share → Copy link for that file, and paste that link instead.'
      );
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
  await downloadVideo(videoUrl, destPath);
}

/** Download video: yt-dlp (VM, no size cap) → Railway → Vercel → Cobalt */
async function downloadVideo(videoUrl: string, destPath: string): Promise<void> {
  const clean = cleanVideoUrl(videoUrl);
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
async function downloadVideoSection(videoUrl: string, startSec: number, endSec: number, destPath: string): Promise<void> {
  try {
  await execFileAsync(
    YTDLP_PATH,
    [
      "-f", "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best[height<=720]/best",
      "--download-sections", `*${Math.max(0, Math.floor(startSec))}-${Math.ceil(endSec)}`,
      "--merge-output-format", "mp4",
      "--concurrent-fragments", "16",
      "--no-playlist", "--no-warnings",
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

// Job records are ALSO mirrored to Object Storage. On autoscale deployments
// the poll request can land on a different instance than the one running the
// job (or a cold-started instance after scale-to-zero) — the local /tmp store
// alone then 404s every poll: "Lost track of this job".
const jobStorageKey = (jobId: string) => `jobs/${jobId}.json`;

// Per-job upload chains keep mirror writes ordered — rapid queued→processing→done
// transitions otherwise race and a stale "processing" can overwrite the final
// "done" record in the bucket.
const jobMirrorChain = new Map<string, Promise<unknown>>();
function mirrorJob(jobId: string, json: string): void {
  const prev = jobMirrorChain.get(jobId) ?? Promise.resolve();
  const next = prev
    .then(() => getStorageClient().uploadFromText(jobStorageKey(jobId), json))
    .then(() => undefined, () => undefined); // a storage blip must never fail the pipeline
  jobMirrorChain.set(jobId, next);
  void next.finally(() => {
    if (jobMirrorChain.get(jobId) === next) jobMirrorChain.delete(jobId);
  });
}

function writeJob(jobId: string, record: JobRecord): void {
  const json = JSON.stringify(record);
  fs.writeFileSync(path.join(JOBS_DIR, `${jobId}.json`), json);
  try { mirrorJob(jobId, json); } catch { /* storage client unavailable (tests/dev without bucket) */ }
}
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
      for (const { name } of ls.value.slice(0, 500)) {
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
const inflightClips = new Map<string, Promise<{ clips: ClipItem[]; totalDuration: string }>>();

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
  res.json({ status: rec.status, clips: rec.clips, totalDuration: rec.totalDuration, error: rec.error, platform: rec.platform });
});

// ── Concurrency semaphore + queue limit ───────────────────────────────────────
// MAX_CONCURRENT_JOBS = heavy ffmpeg jobs at once
// MAX_QUEUED_JOBS = max waiting in queue before returning 429
const MAX_CONCURRENT_JOBS = parseInt(process.env.MAX_CONCURRENT_JOBS ?? "8", 10);  // 8 parallel ffmpeg jobs
const MAX_QUEUED_JOBS = parseInt(process.env.MAX_QUEUED_JOBS ?? "200", 10);  // 200 waiting in queue
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
  if (opts.allowTranscript) {
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
    async: asyncMode = false,
  } = req.body as {
    url?: string;
    clipDuration?: number;
    platform?: string;
    viralMode?: boolean;
    clipCount?: number;
    async?: boolean;
  };

  if (!url || !validateUrl(url)) {
    res.status(400).json({ error: "Invalid or missing URL" });
    return;
  }

  const safeClipCount = Math.min(Math.max(1, Number(clipCount)), 10);
  const platformCfg = PLATFORM_SETTINGS[platform as string] ?? PLATFORM_SETTINGS.shorts;
  const safeClipDuration = Math.min(Number(clipDuration), platformCfg.maxClipDuration);
  const cacheKey = `${url}|${safeClipDuration}|${safeClipCount}|${platform}`;

  // Async mode: respond immediately with a jobId; the frontend polls /video/job/:id.
  // This sidesteps the ~120s proxy timeout that kills long synchronous responses.
  const jobId = asyncMode ? crypto.randomBytes(12).toString("hex") : null;
  const jobMeta = { createdMs: Date.now(), url, platform };
  const writeJobSafe = (record: JobRecord) => {
    if (jobId) { try { writeJob(jobId, record); } catch { /* ignore */ } }
  };
  const settleJob = (p: Promise<{ clips: ClipItem[]; totalDuration: string }>) => {
    writeJobSafe({ status: "processing", ...jobMeta, updatedMs: Date.now() });
    // Heartbeat: refresh updatedMs every 60s so pollers can tell a long-running
    // job apart from one orphaned by a server restart.
    const heartbeat = setInterval(
      () => writeJobSafe({ status: "processing", ...jobMeta, updatedMs: Date.now() }),
      60_000,
    );
    p.then(
      (r) => { clearInterval(heartbeat); writeJobSafe({ status: "done", ...jobMeta, updatedMs: Date.now(), clips: r.clips, totalDuration: r.totalDuration }); },
      (e) => { clearInterval(heartbeat); writeJobSafe({ status: "error", ...jobMeta, updatedMs: Date.now(), error: e instanceof Error ? e.message : String(e) }); },
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
    res.json({ clips: cached.clips, totalDuration: cached.totalDuration, platform });
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
      res.json({ clips: r.clips, totalDuration: r.totalDuration, platform });
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

  // Queue full?
  const slot = tryAcquireJob();
  if (!slot) {
    res.status(429).json({ error: "Server is busy. Please try again in 30 seconds." });
    return;
  }

  // The actual work — one shared promise per cacheKey; joiners above await it.
  const jobPromise = (async (): Promise<{ clips: ClipItem[]; totalDuration: string }> => {
  await slot;
  try {
  // Re-check disk AFTER the queue wait — space may have vanished while queued
  if (tmpFreeBytes() < MIN_FREE_DISK_BYTES) {
    throw new Error("Server storage is temporarily full. Please try again in a few minutes.");
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "viralai-clip-"));
  try {
    req.log.info({ url, safeClipDuration, platform, safeClipCount }, "Starting clip job");

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
    if (srcKind === 'youtube' || srcKind === 'twitch' || srcKind === 'kick' || srcKind === 'unknown') {
      let probed = await probeDurationSeconds(url);
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
        const dlLimit = makeClipLimiter();
        try {
          sectionFiles = await Promise.all(
            timestamps.map((startSec, i) => dlLimit(async () => {
              const secPath = path.join(tmpDir, `section_${i}.mp4`);
              await downloadVideoSection(sectionSourceUrl, startSec, Math.min(startSec + safeClipDuration + 2, totalDuration), secPath);
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
      await downloadAny(url, srcPath);
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

    // Scale to full height first (maintains aspect ratio), then crop center 1080px width.
    // This avoids stretching a tiny strip — uses full resolution before cropping.
    // scale=-2:1920 → e.g. 640x360 becomes 3413x1920, then crop=1080:1920 takes center.
    const vfFilter = platformCfg.crop
      ? `scale=-2:1920,crop=1080:1920`
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
          // With vf filter (crop): veryfast/CRF23 — visibly better quality than ultrafast/26
          // +faststart puts the moov atom up front so clips start playing instantly in browsers
          const clipArgs = vfFilter ? [
            "-y", "-ss", seekSec.toFixed(3),
            "-i", clipSrc,
            "-t", (endSec - startSec).toFixed(3),
            "-vf", vfFilter,
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
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
          await execFileAsync(FFMPEG_PATH, clipArgs, { maxBuffer: 20 * 1024 * 1024, timeout: 240_000 });

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

    const result = { clips, totalDuration: fmtDuration(totalDuration) };
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
    settleJob(jobPromise);
    res.status(202).json({ jobId });
    return;
  }

  try {
    const r = await jobPromise;
    res.json({ clips: r.clips, totalDuration: r.totalDuration, platform });
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
