/**
 * Bulk social scheduler — "1000 videos Drive mein, roz shaam 6 baje post ho".
 *
 * Design goal: ZERO load on our server for media.
 *   1. User pastes public Google Drive / Dropbox links (files or a whole
 *      Drive folder) + picks platforms, start date and times-of-day.
 *   2. We enumerate the videos and store one small metadata row per video
 *      with its computed posting slot. No bytes are downloaded here.
 *   3. A background loop asks bundle.social to fetch each video straight
 *      from its public URL (`/upload/from-url` — THEIR servers download it),
 *      then creates a post with a future postDate. bundle.social stores the
 *      media and publishes it at the right moment all by itself.
 *
 * So our server never stores video bytes and never runs a posting cron —
 * exactly the "provider ke API pe ho, website pe load na pade" requirement.
 */

import { Router, type IRouter } from "express";
import { randomUUID } from "node:crypto";
import { requireUser } from "../middlewares/sessionAuth";
import { requireDb } from "../lib/db";
import {
  isBundleConfigured,
  getUserTeamId,
  getUserSocialAccounts,
  uploadFromUrl,
  waitForUploadReady,
  createScheduledBundlePost,
  deleteBundlePost,
} from "../lib/bundle";
import { extractGDriveId, resolveGDriveConfirmUrl } from "./videoTools";

const router: IRouter = Router();

// ── Source enumeration (no downloads — just URL/HTML parsing) ─────────────────

const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv|avi)$/i;
const MAX_SOURCE_LINES = 300;   // pasted lines per request
const MAX_TOTAL_FILES  = 1000;  // videos per batch

interface SourceFile { name: string; url: string; }

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCharCode(parseInt(n, 16)));
}

/** List video files in a PUBLIC Google Drive folder via the embedded folder
 *  view (no API key needed). Only works for "Anyone with the link" folders. */
async function listGDriveFolder(folderId: string): Promise<SourceFile[]> {
  const res = await fetch(
    `https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(folderId)}`,
    { redirect: "follow", signal: AbortSignal.timeout(30_000) },
  );
  if (!res.ok) {
    throw new Error(`Google Drive folder is not accessible (HTTP ${res.status}). Share it as "Anyone with the link can view".`);
  }
  const html = await res.text();
  const out: SourceFile[] = [];
  // Entries look like: <div class="flip-entry" id="entry-FILEID"> … <div class="flip-entry-title">NAME</div>
  const re = /id="entry-([-\w]+)"[\s\S]{0,2000}?flip-entry-title">([^<]+)</g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < MAX_TOTAL_FILES) {
    const name = decodeEntities(m[2].trim());
    if (!VIDEO_EXT.test(name)) continue; // skips subfolders + non-videos
    out.push({ name, url: `https://drive.google.com/file/d/${m[1]}/view` });
  }
  return out;
}

/** Convert a Dropbox share link to a direct-download entry.
 *  Folder links need ?preview=<file>; returns null when not convertible. */
function dropboxDirect(link: string): SourceFile | null {
  const u = new URL(link);
  const isFolder = /^\/(sh)\//.test(u.pathname) || u.pathname.startsWith("/scl/fo/");
  if (isFolder) {
    const preview = u.searchParams.get("preview");
    if (!preview || !VIDEO_EXT.test(preview)) return null;
    const dl = new URL(link);
    dl.hostname = "dl.dropboxusercontent.com";
    dl.pathname = dl.pathname.replace(/\/$/, "") + "/" + encodeURIComponent(preview);
    dl.searchParams.delete("preview");
    dl.searchParams.delete("dl");
    return { name: preview, url: dl.toString() };
  }
  const name = decodeURIComponent(u.pathname.split("/").pop() ?? "");
  if (!VIDEO_EXT.test(name)) return null;
  const dl = new URL(link);
  dl.hostname = "dl.dropboxusercontent.com";
  dl.searchParams.delete("dl");
  return { name, url: dl.toString() };
}

const gdriveFolderId = (u: URL): string | null =>
  u.pathname.match(/\/folders\/([-\w]+)/)?.[1] ?? null;

/** Direct video URLs are handed to the posting provider to fetch — refuse
 *  localhost / private-range / internal-looking hosts so we can't be used as
 *  a scheduling hop for URLs that were never meant to be public. */
function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || !h.includes(".")) return true;
  if (h.includes(":")) return true; // IPv6 literal
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  return false;
}

/** Expand one pasted line into video entries (a Drive folder may yield many). */
async function expandSource(line: string): Promise<{ files: SourceFile[]; skipped?: string }> {
  let u: URL;
  try { u = new URL(line); } catch { return { files: [], skipped: "not a valid link" }; }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    return { files: [], skipped: "not a web link" };
  }
  const h = u.hostname.replace(/^www\./, "");

  if (h === "drive.google.com") {
    const folderId = gdriveFolderId(u);
    if (folderId) {
      const files = await listGDriveFolder(folderId);
      return files.length > 0
        ? { files }
        : { files: [], skipped: "no videos found in this Drive folder (is it public?)" };
    }
    const fileId = extractGDriveId(line);
    if (fileId) return { files: [{ name: "", url: line }] }; // name resolved as "Video N" later
    return { files: [], skipped: "unrecognized Google Drive link" };
  }

  if (h === "dropbox.com" || h.endsWith(".dropbox.com")) {
    const d = dropboxDirect(line);
    if (d) return { files: [d] };
    return { files: [], skipped: "Dropbox folder links need per-file links (open folder → Share → Copy link on each video, or add ?preview=file.mp4)" };
  }

  if (h === "dl.dropboxusercontent.com" || VIDEO_EXT.test(u.pathname)) {
    if (h !== "dl.dropboxusercontent.com" && isBlockedHost(u.hostname)) {
      return { files: [], skipped: "private/internal hosts are not allowed" };
    }
    const name = decodeURIComponent(u.pathname.split("/").pop() ?? "video.mp4");
    return { files: [{ name, url: line }] };
  }

  return { files: [], skipped: "not a supported video link (Drive/Dropbox/direct .mp4)" };
}

// ── Posting-slot math (IANA timezone, no deps) ────────────────────────────────

/** Interpret `dateStr` (YYYY-MM-DD) + `timeStr` (HH:MM) as wall-clock time in
 *  `timeZone` and return the UTC instant. Two-pass offset probe handles DST. */
function zonedTimeToUtc(dateStr: string, timeStr: string, timeZone: string): Date {
  const [y, mo, d] = dateStr.split("-").map(Number);
  const [hh, mm] = timeStr.split(":").map(Number);
  const wallUtc = Date.UTC(y, mo - 1, d, hh, mm, 0);
  const offsetAt = (t: number): number => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(t));
    const p: Record<string, string> = {};
    for (const part of parts) p[part.type] = part.value;
    const asUtc = Date.UTC(
      Number(p.year), Number(p.month) - 1, Number(p.day),
      p.hour === "24" ? 0 : Number(p.hour), Number(p.minute), Number(p.second),
    );
    return asUtc - t;
  };
  let ts = wallUtc - offsetAt(wallUtc);
  ts = wallUtc - offsetAt(ts); // second pass for DST boundaries
  return new Date(ts);
}

function addDaysStr(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** True only for real calendar dates — "2025-99-99" normalizes in JS Date and
 *  would silently schedule at an unintended moment. */
function isRealDate(s: string): boolean {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (y < 2020 || y > 2100) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** One slot per video: day by day from startDate, at each time-of-day.
 *  Slots already in the past (or <5 min out) are skipped. */
function computeSlots(count: number, startDate: string, times: string[], timeZone: string): Date[] {
  const sorted = [...times].sort();
  const minStart = Date.now() + 5 * 60_000;
  const slots: Date[] = [];
  for (let day = 0; slots.length < count && day < 3650; day++) {
    const dayStr = addDaysStr(startDate, day);
    for (const t of sorted) {
      if (slots.length >= count) break;
      const at = zonedTimeToUtc(dayStr, t, timeZone);
      if (at.getTime() < minStart) continue;
      slots.push(at);
    }
  }
  return slots;
}

function prettyName(fileName: string): string {
  return fileName
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 150);
}

// ── Routes ────────────────────────────────────────────────────────────────────

interface ScheduleRow {
  id: string; user_id: string; batch_id: string; source_url: string;
  file_name: string; caption: string; account_ids: string[]; platforms: string[];
  post_at: string; status: string; attempts: number;
  bundle_upload_id: string | null; bundle_post_id: string | null; error: string | null;
  created_at: string;
}

// POST /user/social/schedule — create a batch of scheduled posts
router.post("/user/social/schedule", requireUser, async (req, res): Promise<void> => {
  const userId = req.currentUser!.id;
  const { sources, accountIds, times, startDate, timezone, caption } = req.body as {
    sources?: string[]; accountIds?: string[]; times?: string[];
    startDate?: string; timezone?: string; caption?: string;
  };

  if (!isBundleConfigured()) { res.status(503).json({ error: "Social posting is not configured." }); return; }
  if (!Array.isArray(sources) || sources.length === 0) { res.status(400).json({ error: "Paste at least one Drive/Dropbox link." }); return; }
  if (sources.length > MAX_SOURCE_LINES) { res.status(400).json({ error: `Too many links — max ${MAX_SOURCE_LINES} lines per batch.` }); return; }
  if (!Array.isArray(accountIds) || accountIds.length === 0) { res.status(400).json({ error: "Select at least one platform." }); return; }
  const timesClean = Array.isArray(times) ? [...new Set(times.map((t) => String(t)))] : [];
  if (timesClean.length === 0 || timesClean.length > 12 ||
      timesClean.some((t) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(t))) {
    res.status(400).json({ error: "Times must be 1-12 unique entries in HH:MM (24-hour) format." }); return;
  }
  if (!startDate || !isRealDate(startDate)) { res.status(400).json({ error: "startDate must be a real YYYY-MM-DD date." }); return; }
  const tz = typeof timezone === "string" && timezone ? timezone : "UTC";
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); }
  catch { res.status(400).json({ error: "Invalid timezone." }); return; }

  // Selected accounts must be the user's own, currently enabled ones
  const accounts = (await getUserSocialAccounts(userId)).filter((a) => a.enabled && accountIds.includes(a.id));
  if (accounts.length === 0) {
    res.status(400).json({ error: "None of the selected accounts are connected — connect them on the Social page first." });
    return;
  }
  const validAccountIds = accounts.map((a) => a.id);

  // Expand every pasted line (Drive folders may add many files)
  const files: SourceFile[] = [];
  const skipped: { url: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const raw of sources) {
    const line = String(raw ?? "").trim();
    if (!line) continue;
    if (files.length >= MAX_TOTAL_FILES) { skipped.push({ url: line, reason: `batch is full (max ${MAX_TOTAL_FILES} videos)` }); continue; }
    try {
      const r = await expandSource(line);
      if (r.skipped) skipped.push({ url: line, reason: r.skipped });
      for (const f of r.files) {
        if (files.length >= MAX_TOTAL_FILES) break;
        if (seen.has(f.url)) continue;
        seen.add(f.url);
        files.push(f);
      }
    } catch (err) {
      skipped.push({ url: line, reason: (err as Error).message });
    }
  }
  if (files.length === 0) {
    res.status(400).json({ error: "No usable videos found in those links.", skipped });
    return;
  }

  const slots = computeSlots(files.length, startDate, timesClean, tz);
  if (slots.length < files.length) { res.status(400).json({ error: "Could not compute posting slots — check the start date." }); return; }

  const batchId = randomUUID();
  const custom = typeof caption === "string" ? caption.trim() : "";
  const ids: string[] = [], urls: string[] = [], names: string[] = [], caps: string[] = [], ats: string[] = [];
  files.forEach((f, i) => {
    const name = f.name || `Video ${i + 1}`;
    ids.push(randomUUID());
    urls.push(f.url);
    names.push(name);
    caps.push(custom || prettyName(name) || `Video ${i + 1}`);
    ats.push(slots[i].toISOString());
  });

  await requireDb().query(
    `INSERT INTO scheduled_social_posts
       (id, user_id, batch_id, source_url, file_name, caption, account_ids, post_at, status)
     SELECT unnest($1::text[]), $2, $3, unnest($4::text[]), unnest($5::text[]),
            unnest($6::text[]), $7::text[], unnest($8::timestamptz[]), 'queued'`,
    [ids, userId, batchId, urls, names, caps, validAccountIds, ats],
  );

  req.log.info({ batchId, total: files.length, skipped: skipped.length }, "[scheduler] batch created");
  setTimeout(() => { void processQueue(); }, 100).unref();

  res.json({
    ok: true, batchId,
    scheduled: files.length, skipped,
    firstAt: ats[0], lastAt: ats[ats.length - 1],
  });
});

// GET /user/social/schedule — list this user's scheduled posts
router.get("/user/social/schedule", requireUser, async (req, res): Promise<void> => {
  const { rows } = await requireDb().query<ScheduleRow>(
    `SELECT * FROM scheduled_social_posts WHERE user_id = $1 ORDER BY post_at ASC LIMIT 500`,
    [req.currentUser!.id],
  );
  res.json({ posts: rows });
});

/** Cancel one row: delete the provider-side post when it exists, then mark
 *  cancelled. Returns an error string (null = cancelled fine). */
async function cancelRow(row: ScheduleRow): Promise<string | null> {
  if (row.status === "cancelled") return null;
  if (row.status === "failed") {
    await requireDb().query(`UPDATE scheduled_social_posts SET status='cancelled', updated_at=NOW() WHERE id=$1`, [row.id]);
    return null;
  }
  if (row.status === "scheduled" && new Date(row.post_at).getTime() <= Date.now()) {
    return "already posted";
  }
  if (row.bundle_post_id) {
    try { await deleteBundlePost(row.bundle_post_id); }
    catch (err) {
      // Already gone on the provider (double cancel, manual delete) = success.
      if (!isPostGoneError(err as Error)) {
        return `could not cancel on provider: ${(err as Error).message}`;
      }
    }
  }
  await requireDb().query(
    `UPDATE scheduled_social_posts SET status='cancelled', updated_at=NOW() WHERE id=$1`,
    [row.id],
  );
  return null;
}

/** "Post not found" from the provider means it's already deleted. */
const isPostGoneError = (err: Error): boolean => /\b404\b|not found/i.test(err.message);

// DELETE /user/social/schedule/:id — cancel a single scheduled post
router.delete("/user/social/schedule/:id", requireUser, async (req, res): Promise<void> => {
  const { rows } = await requireDb().query<ScheduleRow>(
    `SELECT * FROM scheduled_social_posts WHERE id = $1 AND user_id = $2`,
    [req.params.id, req.currentUser!.id],
  );
  if (rows.length === 0) { res.status(404).json({ error: "Not found" }); return; }
  const err = await cancelRow(rows[0]);
  if (err) { res.status(409).json({ error: err }); return; }
  res.json({ ok: true });
});

// POST /user/social/schedule/batch/:batchId/cancel — cancel the rest of a batch
router.post("/user/social/schedule/batch/:batchId/cancel", requireUser, async (req, res): Promise<void> => {
  const { rows } = await requireDb().query<ScheduleRow>(
    `SELECT * FROM scheduled_social_posts
     WHERE batch_id = $1 AND user_id = $2 AND status IN ('queued','uploading','scheduled','failed')`,
    [req.params.batchId, req.currentUser!.id],
  );
  let cancelled = 0, errors = 0;
  for (const row of rows) {
    const err = await cancelRow(row);
    if (err) errors++; else cancelled++;
  }
  res.json({ ok: true, cancelled, errors });
});

// ── Background worker (metadata only — bundle.social does the heavy lifting) ──

/** Fresh direct-download URL for the provider to fetch. Drive confirm tokens
 *  are one-time, so this must run at upload time, not enqueue time. */
async function resolveDirectUrl(sourceUrl: string): Promise<string> {
  const u = new URL(sourceUrl);
  const h = u.hostname.replace(/^www\./, "");
  if (h === "drive.google.com") {
    const id = extractGDriveId(sourceUrl);
    if (!id) throw new Error("Could not extract Google Drive file id");
    const confirmed = await resolveGDriveConfirmUrl(id).catch(() => null);
    return confirmed ?? `https://drive.google.com/uc?export=download&confirm=t&id=${id}`;
  }
  return sourceUrl; // Dropbox/direct URLs were already resolved at enqueue time
}

/** Claim the next row to work on. Besides fresh 'queued' rows this also
 *  reclaims 'uploading' rows whose lease went stale (process died mid-upload)
 *  — updated_at is bumped on claim and on every state change, so a healthy
 *  in-flight row is never older than waitForUploadReady's 4-min cap. */
async function claimNext(): Promise<ScheduleRow | null> {
  const { rows } = await requireDb().query<ScheduleRow>(
    `UPDATE scheduled_social_posts
     SET status='uploading', updated_at=NOW(),
         attempts = CASE WHEN status='uploading' THEN attempts + 1 ELSE attempts END
     WHERE id = (
       SELECT id FROM scheduled_social_posts
       WHERE (status = 'queued'
                AND (attempts = 0 OR updated_at < NOW() - INTERVAL '2 minutes'))
          OR (status = 'uploading'
                AND updated_at < NOW() - INTERVAL '15 minutes'
                AND attempts < 3)
       ORDER BY post_at
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
  );
  return rows[0] ?? null;
}

async function processRow(row: ScheduleRow): Promise<void> {
  const db = requireDb();
  try {
    const teamId = await getUserTeamId(row.user_id);
    if (!teamId) throw new Error("User has no social team — reconnect accounts on the Social page");
    const accounts = (await getUserSocialAccounts(row.user_id))
      .filter((a) => a.enabled && row.account_ids.includes(a.id));
    if (accounts.length === 0) throw new Error("Selected social accounts are no longer connected/enabled");

    const directUrl = await resolveDirectUrl(row.source_url);
    const uploadId  = await uploadFromUrl(teamId, directUrl);   // bundle fetches it — not us
    await waitForUploadReady(uploadId);

    // Never schedule in the past — if we're late, post ~2 min from now.
    const postAt = new Date(Math.max(new Date(row.post_at).getTime(), Date.now() + 2 * 60_000));
    const postId = await createScheduledBundlePost(teamId, accounts, row.caption, uploadId, postAt, row.file_name);
    const platforms = [...new Set(accounts.map((a) => a.type.toUpperCase()))];

    const upd = await db.query(
      `UPDATE scheduled_social_posts
       SET status='scheduled', bundle_upload_id=$2, bundle_post_id=$3, platforms=$4, error=NULL, updated_at=NOW()
       WHERE id = $1 AND status = 'uploading'`,
      [row.id, uploadId, postId, platforms],
    );
    if (upd.rowCount === 0) {
      // Row was cancelled (or reclaimed by another instance) while we were
      // uploading — undo OUR provider post so it can't publish. Retried,
      // and a persistent failure is recorded on the row instead of ignored.
      let undone = false;
      for (let i = 0; i < 3 && !undone; i++) {
        try { await deleteBundlePost(postId); undone = true; }
        catch (err) {
          if (isPostGoneError(err as Error)) { undone = true; break; }
          await new Promise((r) => setTimeout(r, 2_000 * (i + 1)));
        }
      }
      if (!undone) {
        await db.query(
          `UPDATE scheduled_social_posts SET error=$2, updated_at=NOW() WHERE id=$1`,
          [row.id, "cancelled, but the provider-side post could not be deleted — it may still publish"],
        ).catch(() => {});
        console.error(`[scheduler] could not undo provider post ${postId} for row ${row.id}`);
      }
      return;
    }
    console.log(`[scheduler] scheduled "${row.file_name}" for ${row.post_at} (${platforms.join(",")})`);
  } catch (err) {
    const msg = (err as Error).message.slice(0, 500);
    const attempts = (row.attempts ?? 0) + 1;
    const failed = attempts >= 3;
    await db.query(
      `UPDATE scheduled_social_posts
       SET status = $2, attempts = $3, error = $4, updated_at = NOW()
       WHERE id = $1 AND status = 'uploading'`,
      [row.id, failed ? "failed" : "queued", attempts, msg],
    ).catch(() => {});
    console.warn(`[scheduler] "${row.file_name}" attempt ${attempts} failed: ${msg}`);
  }
}

let workerBusy = false;
export async function processQueue(): Promise<void> {
  if (workerBusy || !isBundleConfigured()) return;
  workerBusy = true;
  try {
    for (let i = 0; i < 5; i++) {           // a few rows per tick, one at a time
      const row = await claimNext();
      if (!row) break;
      await processRow(row);
    }
    // Light housekeeping: drop month-old cancelled rows, and fail rows that
    // kept getting interrupted mid-upload (claimNext stops reclaiming at 3).
    await requireDb().query(
      `DELETE FROM scheduled_social_posts WHERE status='cancelled' AND updated_at < NOW() - INTERVAL '30 days'`,
    ).catch(() => {});
    await requireDb().query(
      `UPDATE scheduled_social_posts
       SET status='failed', error='upload kept getting interrupted (server restarts?) — cancel and re-add this one', updated_at=NOW()
       WHERE status='uploading' AND updated_at < NOW() - INTERVAL '15 minutes' AND attempts >= 3`,
    ).catch(() => {});
  } catch (err) {
    console.warn("[scheduler] tick failed:", (err as Error).message);
  } finally {
    workerBusy = false;
  }
}

if (process.env.NODE_ENV !== "test") {
  setInterval(() => { void processQueue(); }, 20_000).unref();
  setTimeout(() => { void processQueue(); }, 5_000).unref();  // boot: resume pending rows
}

export default router;
