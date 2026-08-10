/**
 * Social routes — Post for Me (postforme.dev) provider.
 *
 * Connect: per-platform OAuth links (multiple accounts per platform are
 * first-class — PFM auto-imports every account the login can access, all
 * tagged with our external_id). The OAuth redirect ALWAYS comes back to
 * /api/social/postforme/callback (success AND failure) with
 * `provider, projectId, isSuccess, accountIds, failedAccountIds, error`.
 *
 * Posting: ownership is enforced server-side on EVERY post/disconnect —
 * requested account ids must exist in social_connections for the CURRENT
 * user (403 otherwise; frontend input is never trusted).
 *
 * Bulk scheduler: rows are enqueued locally, then a small drain loop hands
 * each one to PFM with `scheduled_at` — PFM stores the media (fetched from
 * the user's public Drive/Dropbox URL by THEIR servers) and publishes it at
 * the right moment. No posting cron on our side.
 *
 * Webhook: POST /api/webhooks/postforme — verified via the shared secret
 * header, acked instantly (<1s), processed async and idempotently.
 */

import { Router, type IRouter } from "express";
import { randomUUID } from "node:crypto";
import { requireUser } from "../middlewares/sessionAuth";
import { requireDb } from "../lib/db";
import {
  isPfmConfigured, PFM_PLATFORMS, type PfmPlatform,
  createAuthUrl, syncUserAccounts, getUserConnections, upsertConnection,
  verifyAccountOwnership, disconnectAccount, getPfmAccount, userIdFromExternalId,
  autoPostClips, getClipPostStatuses, friendlyPfmError,
  createPfmPost, deletePfmPost, fetchPostState, isDefiniteReject, findPfmPostByExternalId,
  getWebhookSecrets, processWebhookEvent, getPublicAppBase,
  PfmApiError,
} from "../lib/postforme";
import { resolveFile } from "../lib/fileStore";
import { createShareToken } from "../lib/clipShareToken";
import { urlResolvesPublic } from "../lib/ssrfGuard";
import { extractGDriveId, resolveGDriveConfirmUrl } from "./videoTools";

const router: IRouter = Router();

// ── Source enumeration (no downloads — just URL/HTML parsing) ─────────────────

const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv|avi)$/i;
const MAX_SOURCE_LINES = 300;   // pasted lines per request
const MAX_TOTAL_FILES  = 1000;  // videos per batch

export interface SourceFile { name: string; url: string; }

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
  const re = /id="entry-([-\w]+)"[\s\S]{0,2000}?flip-entry-title">([^<]+)</g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && out.length < MAX_TOTAL_FILES) {
    const name = decodeEntities(m[2].trim());
    if (!VIDEO_EXT.test(name)) continue;
    out.push({ name, url: `https://drive.google.com/file/d/${m[1]}/view` });
  }
  return out;
}

/** Convert a Dropbox share link to a direct-download entry.
 *  Folder links need ?preview=<file>; returns null when not convertible. */
export function dropboxDirect(link: string): SourceFile | null {
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
export function isBlockedHost(host: string): boolean {
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
    if (fileId) return { files: [{ name: "", url: line }] };
    return { files: [], skipped: "unrecognized Google Drive link" };
  }

  if (h === "dropbox.com" || h.endsWith(".dropbox.com")) {
    const d = dropboxDirect(line);
    if (d) return { files: [d] };
    return { files: [], skipped: "Dropbox folder links need per-file links (open folder → Share → Copy link on each video, or add ?preview=file.mp4)" };
  }

  if (h === "dl.dropboxusercontent.com" || VIDEO_EXT.test(u.pathname)) {
    if (h !== "dl.dropboxusercontent.com") {
      // Literal + DNS check: a public-looking hostname that resolves to a
      // private/loopback/metadata address is refused (fail closed).
      if (isBlockedHost(u.hostname) || !(await urlResolvesPublic(line))) {
        return { files: [], skipped: "private/internal hosts are not allowed" };
      }
    }
    const name = decodeURIComponent(u.pathname.split("/").pop() ?? "video.mp4");
    return { files: [{ name, url: line }] };
  }

  return { files: [], skipped: "not a supported video link (Drive/Dropbox/direct .mp4)" };
}

// ── Posting-slot math (IANA timezone, no deps) ────────────────────────────────

/** Interpret `dateStr` (YYYY-MM-DD) + `timeStr` (HH:MM) as wall-clock time in
 *  `timeZone` and return the UTC instant. Two-pass offset probe handles DST. */
export function zonedTimeToUtc(dateStr: string, timeStr: string, timeZone: string): Date {
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
export function isRealDate(s: string): boolean {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (y < 2020 || y > 2100) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** One slot per video: day by day from startDate, at each time-of-day.
 *  Slots already in the past (or <5 min out) are skipped. */
export function computeSlots(count: number, startDate: string, times: string[], timeZone: string): Date[] {
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

export function prettyName(fileName: string): string {
  return fileName
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 150);
}

// ── Connect / accounts ────────────────────────────────────────────────────────

const CONNECTABLE = new Set<string>(PFM_PLATFORMS);

// Platforms with two login variants: PFM needs an explicit connection_type
// when both provider apps are enabled in its dashboard. Users pick the
// Instagram variant in the UI; for X we default to OAuth 2.0.
const CONNECTION_TYPES: Record<string, { allowed: string[]; fallback: string }> = {
  instagram: { allowed: ["instagram", "facebook"], fallback: "instagram" },
  x: { allowed: ["oauth1", "oauth2"], fallback: "oauth2" },
};

// POST /social/connect { platform, connectionType? } → fresh single-use OAuth URL
router.post("/social/connect", requireUser, async (req, res): Promise<void> => {
  if (!isPfmConfigured()) { res.status(503).json({ error: "Social posting is not configured yet — check back soon." }); return; }
  const body = (req.body ?? {}) as { platform?: string; connectionType?: string };
  const platform = String(body.platform ?? "").toLowerCase();
  if (!CONNECTABLE.has(platform)) {
    res.status(400).json({ error: `Unknown platform "${platform}". Supported: ${PFM_PLATFORMS.join(", ")}` });
    return;
  }
  const ctSpec = CONNECTION_TYPES[platform];
  const requestedType = String(body.connectionType ?? "").toLowerCase();
  const connectionType = ctSpec
    ? (ctSpec.allowed.includes(requestedType) ? requestedType : ctSpec.fallback)
    : undefined;
  try {
    const appBase = getPublicAppBase(req);
    const redirectUrl = `${appBase}/api/social/postforme/callback`;
    const url = await createAuthUrl(req.currentUser!.id, platform as PfmPlatform, redirectUrl, connectionType);
    res.json({ url });
  } catch (err) {
    req.log.error({ err: (err as Error).message }, "[social] connect auth-url failed");
    // Bluesky: PFM currently returns an empty URL (app-password platform,
    // no OAuth page) — tell the truth instead of a generic provider error.
    if (/did not return a connect URL/i.test((err as Error).message ?? "")) {
      res.status(409).json({
        error: platform === "bluesky"
          ? "Bluesky sign-in isn't available yet — the posting provider doesn't offer a login link for it."
          : "The posting provider didn't return a login link — try again shortly.",
      });
      return;
    }
    res.status(err instanceof PfmApiError && err.status === 404 ? 409 : 502).json({ error: friendlyPfmError(err) });
  }
});

// GET /social/postforme/callback — PFM redirects here after EVERY OAuth
// attempt (success and failure) with:
//   provider, projectId, isSuccess, accountIds, failedAccountIds, error
router.get("/social/postforme/callback", async (req, res): Promise<void> => {
  const q = req.query as Record<string, string | string[] | undefined>;
  const one = (k: string): string => {
    const v = q[k];
    return Array.isArray(v) ? String(v[0] ?? "") : String(v ?? "");
  };
  const isSuccess = /^true$/i.test(one("isSuccess"));
  const accountIds = one("accountIds").split(",").map((s) => s.trim()).filter(Boolean);
  const errText = one("error");

  // Import the freshly connected accounts. Session cookie survives the
  // top-level OAuth navigation (SameSite=Lax), but we ALSO resolve accounts
  // by id → external_id so the import works even without a session.
  try {
    const sessionUserId = req.currentUser?.id ?? null;
    if (sessionUserId) {
      await syncUserAccounts(sessionUserId);
    } else {
      for (const id of accountIds.slice(0, 20)) {
        const acc = await getPfmAccount(id).catch(() => null);
        const userId = userIdFromExternalId(acc?.external_id);
        if (acc && userId) await upsertConnection(userId, acc);
      }
    }
  } catch (err) {
    req.log.warn({ err: (err as Error).message }, "[social] callback account sync failed");
  }

  // Land back on the Social page (same origin serves the SPA in prod; the
  // dev proxy forwards /api and the SPA lives on the same dev domain).
  if (isSuccess && accountIds.length > 0) {
    res.redirect(`/social?connected=1&added=${accountIds.length}`);
  } else if (isSuccess) {
    res.redirect(`/social?connected=1`);
  } else {
    res.redirect(`/social?error=${encodeURIComponent((errText || "Connection failed or was cancelled").slice(0, 180))}`);
  }
});

// GET /social/accounts — live-synced list, grouped client-side by platform
router.get("/social/accounts", requireUser, async (req, res): Promise<void> => {
  const userId = req.currentUser!.id;
  try {
    if (isPfmConfigured()) {
      await syncUserAccounts(userId).catch((err: Error) => {
        req.log.warn({ err: err.message }, "[social] account sync failed — serving local mirror");
      });
    }
    const accounts = (await getUserConnections(userId)).map((c) => ({
      id: c.pfmAccountId,
      platform: c.platform,
      username: c.username,
      displayName: c.displayName,
      profileImage: c.profileImage,
      status: c.status,
      autopostEnabled: c.autopostEnabled,
    }));
    res.json({ accounts });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// PATCH /social/accounts/:id { autopostEnabled } — per-account auto-post toggle
router.patch("/social/accounts/:id", requireUser, async (req, res): Promise<void> => {
  const { autopostEnabled } = req.body as { autopostEnabled?: boolean };
  if (typeof autopostEnabled !== "boolean") { res.status(400).json({ error: "autopostEnabled must be boolean" }); return; }
  try {
    const upd = await requireDb().query(
      `UPDATE social_connections SET autopost_enabled=$3, updated_at=NOW()
       WHERE user_id=$1 AND pfm_account_id=$2`,
      [req.currentUser!.id, String(req.params.id), autopostEnabled],
    );
    if ((upd.rowCount ?? 0) === 0) { res.status(404).json({ error: "That account isn't connected to your profile." }); return; }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

// POST /social/disconnect { accountId }
router.post("/social/disconnect", requireUser, async (req, res): Promise<void> => {
  const accountId = String((req.body as { accountId?: string })?.accountId ?? "");
  if (!accountId) { res.status(400).json({ error: "accountId required" }); return; }
  const userId = req.currentUser!.id;
  try {
    const { owned } = await verifyAccountOwnership(userId, [accountId]);
    const mine = owned.length > 0 || (await getUserConnections(userId)).some((c) => c.pfmAccountId === accountId);
    if (!mine) { res.status(403).json({ error: "That account isn't connected to your profile." }); return; }
    await disconnectAccount(userId, accountId);
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err: (err as Error).message }, "[social] disconnect failed");
    res.status(502).json({ error: friendlyPfmError(err) });
  }
});

// GET /social/status — connection + auto-post summary for the header/UI
router.get("/social/status", requireUser, async (req, res): Promise<void> => {
  const userId = req.currentUser!.id;
  const prefRow = await requireDb().query<{ auto_post_enabled: boolean }>(
    `SELECT auto_post_enabled FROM social_user_prefs WHERE user_id = $1`, [userId],
  ).then((r) => r.rows[0]).catch(() => null);
  const autoPostEnabled = prefRow?.auto_post_enabled ?? true;
  try {
    const accounts = await getUserConnections(userId);
    const connected = accounts.filter((a) => a.status === "connected");
    res.json({
      configured: isPfmConfigured(),
      hasAccounts: connected.length > 0,
      accountCount: connected.length,
      activeCount: connected.filter((a) => a.autopostEnabled).length,
      autoPostEnabled,
    });
  } catch {
    res.json({ configured: isPfmConfigured(), hasAccounts: false, accountCount: 0, activeCount: 0, autoPostEnabled });
  }
});

// GET /social/prefs · PATCH /social/prefs — master auto-post toggle
router.get("/social/prefs", requireUser, async (req, res): Promise<void> => {
  try {
    const { rows } = await requireDb().query<{ auto_post_enabled: boolean }>(
      `SELECT auto_post_enabled FROM social_user_prefs WHERE user_id = $1`, [req.currentUser!.id],
    );
    res.json({ autoPostEnabled: rows[0]?.auto_post_enabled ?? true });
  } catch (err) {
    req.log.error({ err: (err as Error).message }, "[social] prefs read failed");
    res.status(500).json({ error: "Could not load the auto-post setting — try again." });
  }
});
router.patch("/social/prefs", requireUser, async (req, res): Promise<void> => {
  const { autoPostEnabled } = req.body as { autoPostEnabled?: boolean };
  if (typeof autoPostEnabled !== "boolean") { res.status(400).json({ error: "autoPostEnabled must be boolean" }); return; }
  try {
    await requireDb().query(
      `INSERT INTO social_user_prefs (user_id, auto_post_enabled, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id) DO UPDATE SET auto_post_enabled = $2, updated_at = NOW()`,
      [req.currentUser!.id, autoPostEnabled],
    );
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err: (err as Error).message }, "[social] prefs save failed");
    res.status(500).json({ error: "Could not save the auto-post setting — try again." });
  }
});

// ── Publishing ────────────────────────────────────────────────────────────────

// POST /social/posts — publish ONE clip to selected accounts right now.
// Ownership enforced: any foreign/unknown account id → 403, nothing posted.
router.post("/social/posts", requireUser, async (req, res): Promise<void> => {
  const userId = req.currentUser!.id;
  const { clipId, caption, label, accountIds, force } = req.body as {
    clipId?: string; caption?: string; label?: string;
    accountIds?: string[]; force?: boolean;
  };
  if (!clipId) { res.status(400).json({ error: "clipId required" }); return; }
  if (!isPfmConfigured()) { res.status(503).json({ error: "Social posting is not configured." }); return; }
  try {
    let targetIds: string[] | undefined;
    if (Array.isArray(accountIds) && accountIds.length > 0) {
      const ids = accountIds.filter((x): x is string => typeof x === "string" && x.length > 0).slice(0, 50);
      const { owned, foreign } = await verifyAccountOwnership(userId, ids);
      if (foreign.length > 0) {
        res.status(403).json({ error: "One or more selected accounts don't belong to your profile — refresh and try again." });
        return;
      }
      if (owned.length === 0) {
        res.status(400).json({ error: "None of the selected accounts are connected — connect them on the Social page first." });
        return;
      }
      targetIds = owned.map((o) => o.pfmAccountId);
    }
    const appBase = getPublicAppBase(req);
    const results = await autoPostClips(
      [{ label: label ?? "Clip", caption: caption ?? label ?? "Clip", fileId: clipId }],
      userId, appBase,
      req.log as { warn: (...a: unknown[]) => void; info: (...a: unknown[]) => void },
      targetIds,
      force === true ? { force: true } : undefined,
    );
    const r0 = results[0];
    if (!r0 || r0.noAccounts) {
      res.status(400).json({ error: "No social accounts connected — connect them on /social first." });
      return;
    }
    if (r0.fileMissing) {
      res.status(410).json({ error: "This clip's video file is no longer on the server — re-generate the clip, then post." });
      return;
    }
    if (r0.error && r0.postedAccounts.length === 0 && r0.alreadyPosted.length === 0) {
      res.status(502).json({ error: r0.error });
      return;
    }
    res.json({ ok: true, posted: r0.postedAccounts, alreadyPosted: r0.alreadyPosted });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

// POST /social/posts/schedule — schedule ONE clip for later (PFM publishes).
router.post("/social/posts/schedule", requireUser, async (req, res): Promise<void> => {
  const userId = req.currentUser!.id;
  const { clipId, caption, label, accountIds, scheduledAt } = req.body as {
    clipId?: string; caption?: string; label?: string;
    accountIds?: string[]; scheduledAt?: string;
  };
  if (!clipId) { res.status(400).json({ error: "clipId required" }); return; }
  if (!isPfmConfigured()) { res.status(503).json({ error: "Social posting is not configured." }); return; }
  const at = new Date(String(scheduledAt ?? ""));
  if (Number.isNaN(at.getTime())) { res.status(400).json({ error: "scheduledAt must be an ISO datetime" }); return; }
  if (at.getTime() < Date.now() + 2 * 60_000) { res.status(400).json({ error: "Pick a time at least 2 minutes from now." }); return; }
  if (!Array.isArray(accountIds) || accountIds.length === 0) { res.status(400).json({ error: "Select at least one account." }); return; }

  try {
    const ids = accountIds.filter((x): x is string => typeof x === "string" && x.length > 0).slice(0, 50);
    const { owned, foreign } = await verifyAccountOwnership(userId, ids);
    if (foreign.length > 0) { res.status(403).json({ error: "One or more selected accounts don't belong to your profile — refresh and try again." }); return; }
    if (owned.length === 0) { res.status(400).json({ error: "None of the selected accounts are connected." }); return; }

    const resolved = await resolveFile(clipId).catch(() => null);
    if (!resolved) { res.status(410).json({ error: "This clip's video file is no longer on the server — re-generate the clip first." }); return; }

    const db = requireDb();
    const ownedIds = owned.map((o) => o.pfmAccountId);
    // Claim markers so the same clip+account can't ALSO be posted now/auto
    const { rows: claimedRows } = await db.query<{ social_account_id: string }>(
      `INSERT INTO clip_account_posts (user_id, clip_id, social_account_id, platform, status)
       SELECT $1, $2, unnest($3::text[]), unnest($4::text[]), 'pending'
       ON CONFLICT (user_id, clip_id, social_account_id) DO NOTHING
       RETURNING social_account_id`,
      [userId, clipId, ownedIds, ownedIds.map((id) => owned.find((o) => o.pfmAccountId === id)?.platform ?? "")],
    );
    const claimed = claimedRows.map((r) => r.social_account_id);
    if (claimed.length === 0) {
      res.status(409).json({ error: "This clip is already posted or scheduled on the selected accounts." });
      return;
    }

    const appBase = getPublicAppBase(req);
    const token = await createShareToken(clipId, userId);
    const mediaUrl = `${appBase}/api/video/clip-share/${token}`;
    const rowId = randomUUID();
    await db.query(
      `UPDATE clip_account_posts SET post_row_id=$4, updated_at=NOW()
       WHERE user_id=$1 AND clip_id=$2 AND social_account_id = ANY($3) AND status='pending'`,
      [userId, clipId, claimed, rowId],
    );
    const platforms = [...new Set(owned.filter((o) => claimed.includes(o.pfmAccountId)).map((o) => o.platform))];
    await db.query(
      `INSERT INTO social_posts (id, user_id, source, clip_id, media_url, file_name, caption, account_ids, platforms, scheduled_at, status)
       VALUES ($1,$2,'clip',$3,$4,$5,$6,$7,$8,$9,'creating')`,
      [rowId, userId, clipId, mediaUrl, (label ?? "Clip").slice(0, 200), caption ?? label ?? "Clip", claimed, platforms, at],
    );

    try {
      const post = await createPfmPost({
        caption: caption ?? label ?? "Clip",
        accountIds: claimed,
        mediaUrl,
        scheduledAt: at,
        externalId: rowId,
        youtubeTitle: platforms.includes("youtube") ? (label ?? undefined) : undefined,
      });
      await db.query(
        `UPDATE clip_account_posts SET pfm_post_id=$4, status='submitted', updated_at=NOW()
         WHERE user_id=$1 AND clip_id=$2 AND social_account_id = ANY($3)`,
        [userId, clipId, claimed, post.id],
      );
      await db.query(
        `UPDATE social_posts SET pfm_post_id=$2, status='scheduled', updated_at=NOW() WHERE id=$1`,
        [rowId, post.id],
      );
      res.json({ ok: true, scheduled: claimed, scheduledAt: at.toISOString() });
    } catch (err) {
      if (isDefiniteReject(err)) {
        await db.query(
          `DELETE FROM clip_account_posts
           WHERE user_id=$1 AND clip_id=$2 AND social_account_id = ANY($3) AND status='pending' AND pfm_post_id IS NULL`,
          [userId, clipId, claimed],
        ).catch(() => {});
        await db.query(`UPDATE social_posts SET status='failed', error=$2, updated_at=NOW() WHERE id=$1`, [rowId, friendlyPfmError(err)]).catch(() => {});
        res.status(502).json({ error: friendlyPfmError(err) });
        return;
      }
      const found = await findPfmPostByExternalId(rowId).catch(() => null);
      if (found) {
        await db.query(
          `UPDATE clip_account_posts SET pfm_post_id=$4, status='submitted', updated_at=NOW()
           WHERE user_id=$1 AND clip_id=$2 AND social_account_id = ANY($3)`,
          [userId, clipId, claimed, found.id],
        ).catch(() => {});
        await db.query(`UPDATE social_posts SET pfm_post_id=$2, status='scheduled', updated_at=NOW() WHERE id=$1`, [rowId, found.id]).catch(() => {});
        res.json({ ok: true, scheduled: claimed, scheduledAt: at.toISOString() });
        return;
      }
      await db.query(
        `UPDATE clip_account_posts SET status='unknown', updated_at=NOW()
         WHERE user_id=$1 AND clip_id=$2 AND social_account_id = ANY($3) AND status='pending'`,
        [userId, clipId, claimed],
      ).catch(() => {});
      await db.query(`UPDATE social_posts SET status='unknown', error=$2, updated_at=NOW() WHERE id=$1`, [rowId, friendlyPfmError(err)]).catch(() => {});
      res.status(502).json({ error: "Scheduling status is unclear — we'll sort it out automatically, check the calendar in a minute." });
    }
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

// POST /social/clip-status — live per-account status for a set of clips
router.post("/social/clip-status", requireUser, async (req, res): Promise<void> => {
  const { clipIds } = req.body as { clipIds?: unknown };
  if (!Array.isArray(clipIds) || clipIds.length === 0) { res.json({ clips: {} }); return; }
  if (!isPfmConfigured()) { res.json({ clips: {} }); return; }
  const ids = [...new Set(
    clipIds.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 80),
  )].slice(0, 60);
  try {
    const clips = await getClipPostStatuses(req.currentUser!.id, ids);
    res.json({ clips });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

// ── Bulk scheduler (Drive/Dropbox → PFM scheduled posts) ─────────────────────

interface SocialPostRow {
  id: string; user_id: string; pfm_post_id: string | null; source: string;
  clip_id: string | null; batch_id: string | null; media_url: string | null;
  file_name: string; caption: string; account_ids: string[]; platforms: string[];
  scheduled_at: string | null; status: string; attempts: number; error: string | null;
  created_at: string; updated_at: string;
}

// POST /social/schedule — create a batch of scheduled posts
router.post("/social/schedule", requireUser, async (req, res): Promise<void> => {
  const userId = req.currentUser!.id;
  const { sources, accountIds, times, startDate, timezone, caption } = req.body as {
    sources?: string[]; accountIds?: string[]; times?: string[];
    startDate?: string; timezone?: string; caption?: string;
  };

  if (!isPfmConfigured()) { res.status(503).json({ error: "Social posting is not configured." }); return; }
  if (!Array.isArray(sources) || sources.length === 0) { res.status(400).json({ error: "Paste at least one Drive/Dropbox link." }); return; }
  if (sources.length > MAX_SOURCE_LINES) { res.status(400).json({ error: `Too many links — max ${MAX_SOURCE_LINES} lines per batch.` }); return; }
  if (!Array.isArray(accountIds) || accountIds.length === 0) { res.status(400).json({ error: "Select at least one account." }); return; }
  const timesClean = Array.isArray(times) ? [...new Set(times.map((t) => String(t)))] : [];
  if (timesClean.length === 0 || timesClean.length > 12 ||
      timesClean.some((t) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(t))) {
    res.status(400).json({ error: "Times must be 1-12 unique entries in HH:MM (24-hour) format." }); return;
  }
  if (!startDate || !isRealDate(startDate)) { res.status(400).json({ error: "startDate must be a real YYYY-MM-DD date." }); return; }
  const tz = typeof timezone === "string" && timezone ? timezone : "UTC";
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); }
  catch { res.status(400).json({ error: "Invalid timezone." }); return; }

  // Ownership: every selected account must belong to the CURRENT user
  const ids = accountIds.filter((x): x is string => typeof x === "string" && x.length > 0).slice(0, 50);
  const { owned, foreign } = await verifyAccountOwnership(userId, ids);
  if (foreign.length > 0) {
    res.status(403).json({ error: "One or more selected accounts don't belong to your profile — refresh and try again." });
    return;
  }
  if (owned.length === 0) {
    res.status(400).json({ error: "None of the selected accounts are connected — connect them on the Social page first." });
    return;
  }
  const validAccountIds = owned.map((a) => a.pfmAccountId);
  const platforms = [...new Set(owned.map((a) => a.platform))];

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
  const rowIds: string[] = [], urls: string[] = [], names: string[] = [], caps: string[] = [], ats: string[] = [];
  files.forEach((f, i) => {
    const name = f.name || `Video ${i + 1}`;
    rowIds.push(randomUUID());
    urls.push(f.url);
    names.push(name);
    caps.push(custom || prettyName(name) || `Video ${i + 1}`);
    ats.push(slots[i].toISOString());
  });

  await requireDb().query(
    `INSERT INTO social_posts
       (id, user_id, source, batch_id, media_url, file_name, caption, account_ids, platforms, scheduled_at, status)
     SELECT unnest($1::text[]), $2, 'schedule', $3, unnest($4::text[]), unnest($5::text[]),
            unnest($6::text[]), $7::text[], $8::text[], unnest($9::timestamptz[]), 'queued'`,
    [rowIds, userId, batchId, urls, names, caps, validAccountIds, platforms, ats],
  );

  req.log.info({ batchId, total: files.length, skipped: skipped.length }, "[scheduler] batch created");
  setTimeout(() => { void drainScheduleQueue(); }, 100).unref();

  res.json({
    ok: true, batchId,
    scheduled: files.length, skipped,
    firstAt: ats[0], lastAt: ats[ats.length - 1],
  });
});

// GET /social/schedule — content calendar (bulk batches + scheduled clips)
router.get("/social/schedule", requireUser, async (req, res): Promise<void> => {
  const db = requireDb();
  const { rows } = await db.query<SocialPostRow & { post_at: string }>(
    `SELECT *, scheduled_at AS post_at FROM social_posts
     WHERE user_id = $1 AND scheduled_at IS NOT NULL
     ORDER BY scheduled_at ASC LIMIT 500`,
    [req.currentUser!.id],
  );

  // Light live refresh for rows whose publish moment is near/past — webhooks
  // usually beat this, but polling keeps dev + webhook-less setups honest.
  const due = rows.filter((r) =>
    r.pfm_post_id &&
    (r.status === "scheduled" || r.status === "processing") &&
    r.scheduled_at && new Date(r.scheduled_at).getTime() < Date.now() + 15 * 60_000,
  ).slice(0, 15);
  for (const r of due) {
    const state = await fetchPostState(r.pfm_post_id!);
    if (!state) continue;
    const next = state.gone ? "deleted"
      : state.status === "processed" ? "posted"
      : state.status === "processing" ? "processing" : null;
    if (next && next !== r.status) {
      await db.query(
        `UPDATE social_posts SET status=$2, updated_at=NOW()
         WHERE id=$1 AND status NOT IN ('cancelled','failed')`, [r.id, next],
      ).catch(() => {});
      r.status = next;
    }
  }

  res.json({
    posts: rows.map((r) => ({
      id: r.id, batch_id: r.batch_id ?? r.id, source: r.source,
      file_name: r.file_name, caption: r.caption,
      platforms: r.platforms, account_ids: r.account_ids,
      post_at: r.post_at, status: r.status, error: r.error, created_at: r.created_at,
    })),
  });
});

/** Cancel one row: delete the provider-side post when it exists, then mark
 *  cancelled. Returns an error string (null = cancelled fine). */
async function cancelRow(row: SocialPostRow): Promise<string | null> {
  const db = requireDb();
  if (row.status === "cancelled") return null;
  if (row.status === "posted" || row.status === "processing") return "already posted";
  if (row.status === "failed" || row.status === "deleted") {
    await db.query(`UPDATE social_posts SET status='cancelled', updated_at=NOW() WHERE id=$1`, [row.id]);
    return null;
  }
  if (row.status === "scheduled" && row.scheduled_at && new Date(row.scheduled_at).getTime() <= Date.now()) {
    return "already posted";
  }
  if (row.pfm_post_id) {
    try { await deletePfmPost(row.pfm_post_id); }
    catch (err) {
      return `could not cancel on provider: ${friendlyPfmError(err)}`;
    }
  }
  await db.query(`UPDATE social_posts SET status='cancelled', updated_at=NOW() WHERE id=$1`, [row.id]);
  // Scheduled-clip rows hold idempotency markers — free them so the clip can
  // be posted/scheduled again.
  if (row.source === "clip") {
    await db.query(
      `DELETE FROM clip_account_posts WHERE post_row_id=$1 AND status <> 'posted'`, [row.id],
    ).catch(() => {});
  }
  return null;
}

// DELETE /social/schedule/:id — cancel a single scheduled post
router.delete("/social/schedule/:id", requireUser, async (req, res): Promise<void> => {
  const { rows } = await requireDb().query<SocialPostRow>(
    `SELECT * FROM social_posts WHERE id = $1 AND user_id = $2`,
    [req.params.id, req.currentUser!.id],
  );
  if (rows.length === 0) { res.status(404).json({ error: "Not found" }); return; }
  const err = await cancelRow(rows[0]);
  if (err) { res.status(409).json({ error: err }); return; }
  res.json({ ok: true });
});

// POST /social/schedule/batch/:batchId/cancel — cancel the rest of a batch
router.post("/social/schedule/batch/:batchId/cancel", requireUser, async (req, res): Promise<void> => {
  const { rows } = await requireDb().query<SocialPostRow>(
    `SELECT * FROM social_posts
     WHERE batch_id = $1 AND user_id = $2 AND status IN ('queued','creating','scheduled','failed')`,
    [req.params.batchId, req.currentUser!.id],
  );
  let cancelled = 0, errors = 0;
  for (const row of rows) {
    const err = await cancelRow(row);
    if (err) errors++; else cancelled++;
  }
  res.json({ ok: true, cancelled, errors });
});

// ── Provider-handoff drain (NOT a posting cron — PFM publishes) ───────────────

/** Fresh direct-download URL for the provider to fetch. Drive confirm tokens
 *  are one-time, so this must run at handoff time, not enqueue time. */
async function resolveDirectUrl(sourceUrl: string): Promise<string> {
  const u = new URL(sourceUrl);
  const h = u.hostname.replace(/^www\./, "");
  if (h === "drive.google.com") {
    const id = extractGDriveId(sourceUrl);
    if (!id) throw new Error("Could not extract Google Drive file id");
    const confirmed = await resolveGDriveConfirmUrl(id).catch(() => null);
    return confirmed ?? `https://drive.google.com/uc?export=download&confirm=t&id=${id}`;
  }
  // Direct/Dropbox URLs: re-verify at handoff time (DNS may have changed
  // since enqueue — never hand a privately-resolving URL to the provider).
  if (h !== "dl.dropboxusercontent.com" && !(await urlResolvesPublic(sourceUrl))) {
    throw new Error("This video URL no longer resolves to a public host");
  }
  return sourceUrl;
}

/** Claim the next queued row (lease-based so instance crashes self-heal). */
async function claimNext(): Promise<SocialPostRow | null> {
  const { rows } = await requireDb().query<SocialPostRow>(
    `UPDATE social_posts
     SET status='creating', updated_at=NOW(),
         attempts = CASE WHEN status='creating' THEN attempts + 1 ELSE attempts END
     WHERE id = (
       SELECT id FROM social_posts
       WHERE source = 'schedule'
         AND ((status = 'queued' AND (attempts = 0 OR updated_at < NOW() - INTERVAL '2 minutes'))
           OR (status = 'creating' AND updated_at < NOW() - INTERVAL '10 minutes' AND attempts < 3))
       ORDER BY scheduled_at
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
  );
  return rows[0] ?? null;
}

async function handOffRow(row: SocialPostRow): Promise<void> {
  const db = requireDb();
  try {
    // Accounts may have been disconnected since enqueue — re-verify ownership
    const { owned } = await verifyAccountOwnership(row.user_id, row.account_ids);
    if (owned.length === 0) throw new Error("Selected social accounts are no longer connected");
    const ownedIds = owned.map((o) => o.pfmAccountId);

    const directUrl = await resolveDirectUrl(row.media_url ?? "");
    // Never schedule in the past — if we're late, post ~2 min from now.
    const postAt = new Date(Math.max(new Date(row.scheduled_at ?? Date.now()).getTime(), Date.now() + 2 * 60_000));
    const post = await createPfmPost({
      caption: row.caption,
      accountIds: ownedIds,
      mediaUrl: directUrl,
      scheduledAt: postAt,
      externalId: row.id,
      youtubeTitle: owned.some((o) => o.platform === "youtube") ? prettyName(row.file_name) || row.file_name : undefined,
    });

    const upd = await db.query(
      `UPDATE social_posts
       SET status='scheduled', pfm_post_id=$2, account_ids=$3, platforms=$4, error=NULL, updated_at=NOW()
       WHERE id = $1 AND status = 'creating'`,
      [row.id, post.id, ownedIds, [...new Set(owned.map((o) => o.platform))]],
    );
    if ((upd.rowCount ?? 0) === 0) {
      // Row was cancelled (or reclaimed) while we were creating — undo OUR
      // provider post so it can't publish.
      let undone = false;
      for (let i = 0; i < 3 && !undone; i++) {
        try { await deletePfmPost(post.id); undone = true; }
        catch { await new Promise((r) => setTimeout(r, 2_000 * (i + 1))); }
      }
      if (!undone) {
        await db.query(
          `UPDATE social_posts SET error=$2, updated_at=NOW() WHERE id=$1`,
          [row.id, "cancelled, but the provider-side post could not be deleted — it may still publish"],
        ).catch(() => {});
        console.error(`[scheduler] could not undo provider post ${post.id} for row ${row.id}`);
      }
      return;
    }
    console.log(`[scheduler] scheduled "${row.file_name}" for ${row.scheduled_at}`);
  } catch (err) {
    // Ambiguous create? The post may exist — recover it by our external id
    // before burning an attempt.
    if (!isDefiniteReject(err)) {
      const found = await findPfmPostByExternalId(row.id).catch(() => null);
      if (found) {
        await db.query(
          `UPDATE social_posts SET status='scheduled', pfm_post_id=$2, error=NULL, updated_at=NOW()
           WHERE id=$1 AND status='creating'`,
          [row.id, found.id],
        ).catch(() => {});
        return;
      }
    }
    const msg = friendlyPfmError(err).slice(0, 500);
    const attempts = (row.attempts ?? 0) + 1;
    const failed = attempts >= 3 || isDefiniteReject(err);
    await db.query(
      `UPDATE social_posts
       SET status = $2, attempts = $3, error = $4, updated_at = NOW()
       WHERE id = $1 AND status = 'creating'`,
      [row.id, failed ? "failed" : "queued", attempts, msg],
    ).catch(() => {});
    console.warn(`[scheduler] "${row.file_name}" attempt ${attempts} failed: ${(err as Error).message}`);
  }
}

let drainBusy = false;
export async function drainScheduleQueue(): Promise<void> {
  if (drainBusy || !isPfmConfigured()) return;
  drainBusy = true;
  try {
    for (let i = 0; i < 5; i++) {           // a few rows per tick, one at a time
      const row = await claimNext();
      if (!row) break;
      await handOffRow(row);
    }
    // Housekeeping: drop month-old cancelled rows; fail rows that kept
    // getting interrupted mid-handoff (claimNext stops reclaiming at 3).
    await requireDb().query(
      `DELETE FROM social_posts WHERE status='cancelled' AND updated_at < NOW() - INTERVAL '30 days'`,
    ).catch(() => {});
    await requireDb().query(
      `UPDATE social_posts
       SET status='failed', error='hand-off kept getting interrupted (server restarts?) — cancel and re-add this one', updated_at=NOW()
       WHERE source='schedule' AND status='creating' AND updated_at < NOW() - INTERVAL '10 minutes' AND attempts >= 3`,
    ).catch(() => {});
  } catch (err) {
    console.warn("[scheduler] tick failed:", (err as Error).message);
  } finally {
    drainBusy = false;
  }
}

if (process.env.NODE_ENV !== "test") {
  setInterval(() => { void drainScheduleQueue(); }, 20_000).unref();
  setTimeout(() => { void drainScheduleQueue(); }, 5_000).unref();  // boot: resume pending rows
}

// ── Webhook (POST /webhooks/postforme) ────────────────────────────────────────
// PFM requires a 2xx within ONE second — verify, ack, then process async.
// Every delivery carries the shared secret in Post-For-Me-Webhook-Secret.
router.post("/webhooks/postforme", async (req, res): Promise<void> => {
  const given = String(req.headers["post-for-me-webhook-secret"] ?? "");
  // Bound the ack under PFM's 1s deadline even on a cold cache / slow DB:
  // fail closed (401) on timeout — PFM retries, and by then the cache is warm
  // (it's also primed at boot).
  const secrets = await Promise.race([
    getWebhookSecrets(),
    new Promise<null>((r) => { setTimeout(() => r(null), 700).unref(); }),
  ]);
  if (!secrets || !given || secrets.size === 0 || !secrets.has(given)) {
    res.status(401).json({ error: "invalid webhook secret" });
    return;
  }
  const body = req.body as unknown;
  res.json({ ok: true }); // ack instantly — retries are exponential over 24h
  setImmediate(() => {
    void processWebhookEvent(body, req.log as unknown as Console).catch(() => {});
  });
});

// ── Admin overview ────────────────────────────────────────────────────────────
// GET /admin/social/connections — who has connected what (replaces the old
// per-team view; PFM has no teams, just external_id-tagged accounts).
router.get("/admin/social/connections", requireUser, async (req, res): Promise<void> => {
  if (req.currentUser!.role !== "admin") { res.status(403).json({ error: "Admin only" }); return; }
  try {
    const { rows } = await requireDb().query(
      `SELECT c.user_id, u.username,
              COUNT(*)::int AS account_count,
              ARRAY_AGG(DISTINCT c.platform) AS platforms,
              MIN(c.created_at) AS first_connected
       FROM social_connections c
       LEFT JOIN users u ON u.id = c.user_id
       WHERE c.status = 'connected'
       GROUP BY c.user_id, u.username
       ORDER BY MIN(c.created_at) DESC`,
    );
    res.json({ configured: isPfmConfigured(), users: rows });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

export default router;
