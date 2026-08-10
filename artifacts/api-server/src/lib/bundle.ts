/**
 * bundle.social — Unified Social Media API (https://bundle.social)
 *
 * Admin sets BUNDLE_API_KEY once.
 * Each AutoCliper user gets their own bundle.social "team".
 * Users connect their Instagram/TikTok/YouTube via bundle.social's hosted portal.
 * Posts go through admin's bundle.social org (no user account needed).
 *
 * Docs: https://info.bundle.social/api-reference
 */

import fs from "fs/promises";
import path from "path";
import { requireDb } from "./db";
import { resolveFile } from "./fileStore";

const BASE = "https://api.bundle.social/api/v1";

// ── Helpers ───────────────────────────────────────────────────────────────────

function apiKey(): string {
  return (process.env.BUNDLE_API_KEY ?? "").trim();
}

export function isBundleConfigured(): boolean {
  return apiKey().length > 0;
}

/** HTTP error from bundle.social with the status code preserved, so callers
 *  can tell a definite rejection (4xx) from an ambiguous failure (5xx). */
export class BundleApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "BundleApiError";
    this.status = status;
  }
}

async function bundleApi<T = unknown>(
  path: string,
  method: "GET" | "POST" | "PATCH" | "DELETE" = "GET",
  body?: unknown,
): Promise<T> {
  const key = apiKey();
  if (!key) throw new Error("BUNDLE_API_KEY not set");

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "x-api-key": key,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = { _raw: text }; }

  if (!res.ok) {
    const j = json as Record<string, unknown>;
    const msg = j?.message ?? text;
    // Include full validation error details so we can see exactly which field fails
    const errs = j?.errors ?? j?.error ?? j?.details ?? j?.issues ?? null;
    const extra = errs ? ` | validation: ${JSON.stringify(errs)}` : ` | body: ${JSON.stringify(json)}`;
    throw new BundleApiError(`bundle.social ${method} ${path} → ${res.status}: ${msg}${extra}`, res.status);
  }
  return json as T;
}

// ── Team management (1 team per AutoCliper user) ──────────────────────────────

interface BundleTeam { id: string; name: string; }

/** Get or create the bundle.social team for this AutoCliper user. */
export async function ensureUserTeam(userId: string, displayName?: string): Promise<string> {
  const db = requireDb();

  // Cached in DB
  const { rows } = await db.query<{ team_id: string }>(
    `SELECT team_id FROM bundle_teams WHERE user_id = $1`, [userId],
  );
  if (rows.length > 0) return rows[0].team_id;

  // Create new team in bundle.social
  const name = (displayName ?? userId).slice(0, 64);
  const team = await bundleApi<BundleTeam>("/team", "POST", { name });

  await db.query(
    `INSERT INTO bundle_teams (user_id, team_id, created_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (user_id) DO UPDATE SET team_id = $2`,
    [userId, team.id],
  );
  return team.id;
}

/** Look up the bundle.social teamId for a user (null if none). */
export async function getUserTeamId(userId: string): Promise<string | null> {
  try {
    const { rows } = await requireDb().query<{ team_id: string }>(
      `SELECT team_id FROM bundle_teams WHERE user_id = $1`, [userId],
    );
    return rows[0]?.team_id ?? null;
  } catch { return null; }
}

/** Delete a user's bundle.social team (and remove DB row). */
export async function deleteUserTeam(userId: string): Promise<void> {
  const teamId = await getUserTeamId(userId);
  if (!teamId) return;
  await bundleApi(`/team/${teamId}`, "DELETE").catch(() => { /* ignore */ });
  await requireDb().query(`DELETE FROM bundle_teams WHERE user_id = $1`, [userId]);
}

// ── Social account portal link ────────────────────────────────────────────────

const ALL_PLATFORMS = [
  "INSTAGRAM","TIKTOK","YOUTUBE","TWITTER","FACEBOOK",
  "LINKEDIN","PINTEREST","THREADS","REDDIT","BLUESKY",
];

export interface PortalLinkOptions {
  redirectUrl: string;
  platforms?: string[];
  expiresIn?: number;           // minutes, default 60
  language?: string;
  hidePoweredBy?: boolean;
}

/** Create a bundle.social hosted connect portal link for a user. */
export async function createConnectPortalLink(
  teamId: string,
  opts: PortalLinkOptions,
): Promise<string> {
  const { url } = await bundleApi<{ url: string }>(
    "/social-account/create-portal-link",
    "POST",
    {
      teamId,
      redirectUrl: opts.redirectUrl,
      socialAccountTypes: opts.platforms ?? ALL_PLATFORMS,
      expiresIn: opts.expiresIn ?? 60,
      language: opts.language ?? "en",
      hidePoweredBy: opts.hidePoweredBy ?? false,
    },
  );
  return url;
}

// ── Social accounts ───────────────────────────────────────────────────────────

export interface BundleSocialAccount {
  id: string;
  type: string;       // "INSTAGRAM" | "TIKTOK" etc.
  name: string;
  username?: string;
  avatarUrl?: string;
  enabled?: boolean;  // stored in our DB
}

export async function getTeamSocialAccounts(teamId: string): Promise<BundleSocialAccount[]> {
  // Primary: GET /team/{id} returns team with embedded socialAccounts array
  try {
    const team = await bundleApi<Record<string, unknown>>(`/team/${encodeURIComponent(teamId)}`);
    const embedded = (team.socialAccounts ?? team.social_accounts ?? team.accounts) as BundleSocialAccount[] | undefined;
    if (Array.isArray(embedded)) return embedded;
  } catch (err) {
    console.log("[bundle] GET /team/{id} error:", String(err));
  }

  // Fallback: GET /social?teamId=... (documented as "get social account by team and type")
  try {
    const data = await bundleApi<unknown>(`/social?teamId=${encodeURIComponent(teamId)}`);
    const d = data as Record<string, unknown>;
    if (Array.isArray(d)) return d as BundleSocialAccount[];
    const list = (d.items ?? d.data ?? d.accounts ?? d.socialAccounts ?? []) as BundleSocialAccount[];
    return list;
  } catch (err) {
    console.log("[bundle] GET /social?teamId error:", String(err));
    return [];
  }
}

/** Accounts for a user with per-account enabled/disabled preference from DB. */
export async function getUserSocialAccounts(
  userId: string,
): Promise<(BundleSocialAccount & { enabled: boolean })[]> {
  const teamId = await getUserTeamId(userId);
  if (!teamId) return [];

  const [accounts, prefRows] = await Promise.all([
    getTeamSocialAccounts(teamId),
    requireDb()
      .query<{ account_id: string; enabled: boolean }>(
        `SELECT account_id, enabled FROM bundle_account_prefs WHERE user_id = $1`, [userId],
      )
      .then((r) => r.rows)
      .catch(() => [] as { account_id: string; enabled: boolean }[]),
  ]);

  const prefMap = new Map(prefRows.map((r) => [r.account_id, r.enabled]));
  return accounts.map((a) => ({ ...a, enabled: prefMap.get(a.id) ?? true }));
}

// ── Posting ───────────────────────────────────────────────────────────────────

export interface PostClip {
  label: string;
  caption: string;
  /** File-store ID (same as the clip's `id` field returned by the generation API). */
  fileId?: string;
}

/**
 * Upload a local video file to bundle.social.
 * Returns the uploadId to reference in a post payload.
 */
async function uploadVideoToBundle(teamId: string, filePath: string): Promise<string> {
  const key = apiKey();
  if (!key) throw new Error("BUNDLE_API_KEY not set");

  const buf  = await fs.readFile(filePath);
  const ext  = path.extname(filePath).toLowerCase();
  const mime = ext === ".mov" ? "video/quicktime" : "video/mp4";
  const blob = new Blob([buf], { type: mime });

  const form = new FormData();
  form.append("file",   blob, path.basename(filePath));
  form.append("teamId", teamId);

  const res  = await fetch(`${BASE}/upload`, {
    method:  "POST",
    headers: { "x-api-key": key },
    body:    form,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`bundle.social upload → ${res.status}: ${text}`);

  let json: Record<string, unknown>;
  try { json = JSON.parse(text); } catch { throw new Error(`bundle.social upload: bad JSON — ${text}`); }
  const uploadId = (json.uploadId ?? json.id) as string | undefined;
  if (!uploadId) throw new Error(`bundle.social upload: no uploadId in response — ${text}`);
  return uploadId;
}

/**
 * Ask bundle.social to fetch a video from a public URL into team storage.
 * THEIR servers download the file — the bytes never touch our machine.
 * Returns the uploadId to reference in a post payload.
 */
export async function uploadFromUrl(teamId: string, url: string): Promise<string> {
  const json = await bundleApi<Record<string, unknown>>("/upload/from-url", "POST", { teamId, url });
  const uploadId = (json.uploadId ?? json.id) as string | undefined;
  if (!uploadId) throw new Error(`bundle.social upload/from-url: no id in response — ${JSON.stringify(json)}`);
  return uploadId;
}

/**
 * Poll an upload until bundle.social has finished fetching/processing it.
 * Status names are matched loosely (their docs don't pin the enum); on
 * timeout we return anyway and let post creation be the final arbiter.
 */
export async function waitForUploadReady(uploadId: string, timeoutMs = 4 * 60_000): Promise<void> {
  const READY  = ["UPLOADED", "READY", "DONE", "PROCESSED", "COMPLETED", "FINISHED"];
  const FAILED = ["ERROR", "FAILED"];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const u = await bundleApi<Record<string, unknown>>(`/upload/${encodeURIComponent(uploadId)}`);
    const status = String(u.status ?? u.state ?? "").toUpperCase();
    if (READY.includes(status)) return;
    if (FAILED.includes(status)) {
      throw new Error(`bundle.social upload failed: ${String(u.error ?? u.message ?? status)}`);
    }
    if (Date.now() > deadline) return;
    await new Promise((r) => setTimeout(r, 5_000));
  }
}

/**
 * Per-platform payload for a single-video post — one place for all the
 * platform quirks (YouTube 100-char title cap, required type fields, …).
 * All platforms use `text` (not `caption`).
 */
function buildPostData(types: string[], caption: string, uploadId: string): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const t of types) {
    if (t === "INSTAGRAM") {
      // type: "POST" = feed post (also supports "STORY", "REEL")
      data[t] = { type: "POST", text: caption, uploadIds: [uploadId] };
    } else if (t === "TIKTOK") {
      data[t] = { type: "VIDEO", text: caption, uploadIds: [uploadId] };
    } else if (t === "FACEBOOK") {
      data[t] = { type: "POST", text: caption, uploadIds: [uploadId] };
    } else if (t === "YOUTUBE") {
      // YouTube title: max 100 chars (bundle.social hard limit)
      data[t] = { text: caption.slice(0, 100), uploadIds: [uploadId] };
    } else {
      // TWITTER, LINKEDIN, THREADS, BLUESKY, REDDIT, PINTEREST, etc.
      data[t] = { text: caption, uploadIds: [uploadId] };
    }
  }
  return data;
}

/**
 * Create a post scheduled for `postDate`. bundle.social stores the media and
 * publishes it at that moment all by itself — no cron on our side.
 * Returns the bundle.social post id (for cancellation).
 */
export async function createScheduledBundlePost(
  teamId: string,
  accounts: BundleSocialAccount[],
  caption: string,
  uploadId: string,
  postDate: Date,
  title?: string,
): Promise<string> {
  const types = [...new Set(accounts.map((a) => a.type.toUpperCase()))];
  // Both postDate + status are REQUIRED by bundle.social (Zod validation)
  // status:"SCHEDULED" + future postDate = provider-side scheduled publish
  const json = await bundleApi<Record<string, unknown>>("/post/", "POST", {
    teamId,
    title: (title ?? caption).slice(0, 120),
    socialAccountTypes: types,
    data: buildPostData(types, caption, uploadId),
    status: "SCHEDULED",
    postDate: postDate.toISOString(),
  });
  return String(json.id ?? "");
}

/** Delete a (scheduled) post on bundle.social — used by schedule cancel. */
export async function deleteBundlePost(postId: string): Promise<void> {
  await bundleApi(`/post/${encodeURIComponent(postId)}`, "DELETE");
}

/**
 * Create and immediately publish a post via bundle.social.
 * (status:"SCHEDULED" + postDate = now → immediate publish)
 */
async function createBundlePost(
  teamId: string,
  accounts: BundleSocialAccount[],
  caption: string,
  uploadId: string,
): Promise<void> {
  await createScheduledBundlePost(teamId, accounts, caption, uploadId, new Date());
}

export interface PostResult {
  fileId?: string;
  label: string;
  platforms: string[];        // platforms actually posted to in THIS call
  alreadyPosted?: string[];   // platforms skipped because this clip was posted there before
}

/** After a failed post-create: release the claim markers only when the
 *  provider DEFINITELY did not create the post (HTTP 4xx rejection).
 *  Ambiguous outcomes (network drop, 5xx, timeout) keep the claim — the post
 *  may be live, and a false "already posted" is recoverable while a duplicate
 *  public post is not. */
export function shouldReleaseClaimOnPostError(err: unknown): boolean {
  return err instanceof BundleApiError && err.status >= 400 && err.status < 500;
}

/**
 * Auto-post completed clips to connected social accounts for a user.
 * @param filterAccountIds  If provided, only post to these account IDs (manual selection).
 * @returns per-clip list of platforms that were successfully posted to.
 */
export async function autoPostClipsWithBundle(
  clips: PostClip[],
  userId: string,
  _appBase: string,          // kept for API compat, no longer used
  log?: { warn: (msg: string, meta?: unknown) => void; info: (msg: string, meta?: unknown) => void },
  filterAccountIds?: string[],
  opts?: { force?: boolean },
): Promise<PostResult[]> {
  if (!isBundleConfigured()) return [];

  const teamId = await getUserTeamId(userId);
  if (!teamId) return [];

  const accounts = await getUserSocialAccounts(userId);
  let activeAccounts = accounts.filter((a) => a.enabled);

  // Manual post: restrict to the accounts the user explicitly selected
  if (filterAccountIds && filterAccountIds.length > 0) {
    activeAccounts = activeAccounts.filter((a) => filterAccountIds.includes(a.id));
  }
  if (activeAccounts.length === 0) return [];

  const results: PostResult[] = [];

  const db = requireDb();

  for (const clip of clips) {
    try {
      if (!clip.fileId) {
        log?.warn(`bundle.social: clip has no fileId — skipping`, { label: clip.label });
        results.push({ fileId: clip.fileId, label: clip.label, platforms: [] });
        continue;
      }

      // ── Idempotency claim ─────────────────────────────────────────────────
      // Atomically claim a (user, clip, platform) marker BEFORE posting. The
      // unique index guarantees only ONE caller ever wins a given platform —
      // so auto-post + a manual click (or a double click / parallel "Post All")
      // can never post the same clip to the same platform twice.
      const wantPlatforms = [...new Set(activeAccounts.map((a) => a.type.toUpperCase()))];

      // Deliberate repost (user confirmed on an "Already posted" clip): clear
      // the old markers for exactly these platforms so the claim below wins.
      // Accidental duplicates stay impossible — force is only ever sent after
      // the UI has already told the user the clip was posted before.
      if (opts?.force) {
        await db.query(
          `DELETE FROM clip_social_posts WHERE user_id = $1 AND clip_id = $2 AND platform = ANY($3)`,
          [userId, clip.fileId, wantPlatforms],
        );
        log?.info("bundle.social: force repost — cleared posted-markers", { label: clip.label, platforms: wantPlatforms });
      }

      const claimed: string[] = [];
      for (const platform of wantPlatforms) {
        const r = await db.query<{ id: number }>(
          `INSERT INTO clip_social_posts (user_id, clip_id, platform) VALUES ($1, $2, $3)
           ON CONFLICT (user_id, clip_id, platform) DO NOTHING RETURNING id`,
          [userId, clip.fileId, platform],
        );
        if (r.rows.length > 0) claimed.push(platform);
      }
      const alreadyPosted = wantPlatforms.filter((p) => !claimed.includes(p));
      if (claimed.length === 0) {
        log?.info("bundle.social: clip already posted everywhere — skipping", { label: clip.label, platforms: wantPlatforms });
        results.push({ fileId: clip.fileId, label: clip.label, platforms: [], alreadyPosted });
        continue;
      }
      // Releasing a claim is retried — a stuck marker would falsely show
      // "already posted" forever and block any repost of this clip.
      const releaseClaims = async (reason: string) => {
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            await db.query(
              `DELETE FROM clip_social_posts WHERE user_id = $1 AND clip_id = $2 AND platform = ANY($3)`,
              [userId, clip.fileId, claimed],
            );
            return;
          } catch {
            if (attempt === 3) {
              log?.warn(
                `bundle.social: FAILED to release posted-markers (${reason}) — clip will falsely show "already posted"; delete its clip_social_posts rows to repost`,
                { clipId: clip.fileId, platforms: claimed },
              );
            } else {
              await new Promise((r) => setTimeout(r, 300 * attempt));
            }
          }
        }
      };

      // Phase 1 — resolve + upload. Nothing exists on the provider yet, so any
      // failure here always releases the claims (a retry can post again).
      let uploadId: string;
      try {
        const resolved = await resolveFile(clip.fileId);
        if (!resolved) {
          await releaseClaims("file missing");
          log?.warn(`bundle.social: file not found — skipping`, { label: clip.label, fileId: clip.fileId });
          results.push({ fileId: clip.fileId, label: clip.label, platforms: [] });
          continue;
        }
        uploadId = await uploadVideoToBundle(teamId, resolved.filePath);
      } catch (upErr) {
        await releaseClaims("upload failed");
        throw upErr;
      }

      // Phase 2 — create the post. Only a clear provider rejection (4xx)
      // releases the claims; ambiguous outcomes keep them (see
      // shouldReleaseClaimOnPostError for the reasoning).
      try {
        const caption = clip.caption || clip.label;
        const targetAccounts = activeAccounts.filter((a) => claimed.includes(a.type.toUpperCase()));
        await createBundlePost(teamId, targetAccounts, caption, uploadId);
      } catch (postErr) {
        if (shouldReleaseClaimOnPostError(postErr)) {
          await releaseClaims("provider rejected the post");
        } else {
          log?.warn(
            `bundle.social: post outcome UNKNOWN — keeping posted-marker to prevent a duplicate; verify on the provider dashboard`,
            { label: clip.label, platforms: claimed },
          );
        }
        throw postErr;
      }

      log?.info("bundle.social: posted clip", { label: clip.label, platforms: claimed });
      results.push({
        fileId: clip.fileId, label: clip.label, platforms: claimed,
        ...(alreadyPosted.length > 0 ? { alreadyPosted } : {}),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log?.warn(`bundle.social: failed to post clip — ${msg}`, { label: clip.label });
      results.push({ fileId: clip.fileId, label: clip.label, platforms: [] });
    }
  }
  return results;
}
