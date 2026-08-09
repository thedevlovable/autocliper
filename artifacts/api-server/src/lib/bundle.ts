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
    throw new Error(`bundle.social ${method} ${path} → ${res.status}: ${msg}${extra}`);
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
      disableAutoLogin: true,
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
 * Create and immediately publish a post via bundle.social.
 * Uses per-platform `data.PLATFORM.uploadIds` format.
 */
async function createBundlePost(
  teamId: string,
  accounts: BundleSocialAccount[],
  caption: string,
  uploadId: string,
): Promise<void> {
  // Collect unique platform types ("INSTAGRAM", "TIKTOK", …)
  const types = [...new Set(accounts.map((a) => a.type.toUpperCase()))];

  // Per-platform data — exact format from bundle.social API docs
  // All platforms use `text` (not `caption`). type field required for some.
  const data: Record<string, unknown> = {};
  for (const t of types) {
    if (t === "INSTAGRAM") {
      // type: "POST" = feed post (also supports "STORY", "REEL")
      data[t] = { type: "POST", text: caption, uploadIds: [uploadId] };
    } else if (t === "TIKTOK") {
      data[t] = { type: "VIDEO", text: caption, uploadIds: [uploadId] };
    } else if (t === "FACEBOOK") {
      data[t] = { type: "POST", text: caption, uploadIds: [uploadId] };
    } else {
      // TWITTER, LINKEDIN, THREADS, YOUTUBE, etc.
      data[t] = { text: caption, uploadIds: [uploadId] };
    }
  }

  // Both postDate + status are REQUIRED by bundle.social (Zod validation)
  // status:"SCHEDULED" + postDate = now → immediate publish
  await bundleApi("/post/", "POST", {
    teamId,
    title: caption.slice(0, 120),
    socialAccountTypes: types,
    data,
    status: "SCHEDULED",
    postDate: new Date().toISOString(),
  });
}

/** Auto-post completed clips to all active social accounts for a user. */
export async function autoPostClipsWithBundle(
  clips: PostClip[],
  userId: string,
  _appBase: string,          // kept for API compat, no longer used
  log?: { warn: (msg: string, meta?: unknown) => void; info: (msg: string, meta?: unknown) => void },
): Promise<void> {
  if (!isBundleConfigured()) return;

  const teamId = await getUserTeamId(userId);
  if (!teamId) return;

  const accounts      = await getUserSocialAccounts(userId);
  const activeAccounts = accounts.filter((a) => a.enabled);
  if (activeAccounts.length === 0) return;

  for (const clip of clips) {
    try {
      if (!clip.fileId) {
        log?.warn(`bundle.social: clip has no fileId — skipping`, { label: clip.label });
        continue;
      }
      const resolved = await resolveFile(clip.fileId);
      if (!resolved) {
        log?.warn(`bundle.social: file not found for clip — skipping`, { label: clip.label, fileId: clip.fileId });
        continue;
      }
      const uploadId = await uploadVideoToBundle(teamId, resolved.filePath);
      const caption  = clip.caption || clip.label;
      await createBundlePost(teamId, activeAccounts, caption, uploadId);
      log?.info("bundle.social: posted clip", { label: clip.label, accounts: activeAccounts.length });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log?.warn(`bundle.social: failed to post clip — ${msg}`, { label: clip.label });
    }
  }
}
