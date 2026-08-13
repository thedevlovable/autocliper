/**
 * Post for Me (postforme.dev) integration — social posting provider.
 *
 * Model: ONE project API key (server-side only, never exposed to the
 * frontend). Multi-user separation runs on `external_id = user_<id>`:
 * every account a user connects is tagged with their external_id, and our
 * `social_connections` table is the ownership authority (PFM dedupes the
 * same physical account project-wide, so external_id alone can be
 * overwritten when two users connect a shared page — never trust it for
 * authorization, only for import).
 *
 * Posting is idempotent per (user, clip, account) via `clip_account_posts`
 * claim markers:
 *   pending → submitted → posted, with 'error' (reported once, then freed)
 *   and 'unknown' (ambiguous create — blocks duplicates until reconciled
 *   via the post_row_id external-id lookup, or force-reposted).
 *
 * Media is never uploaded from our server: clips get a 24h public share
 * URL that PFM's servers fetch and store ("zero load on our website").
 */
import { randomUUID } from "node:crypto";
import { requireDb } from "./db";
import { resolveFile } from "./fileStore";
import { createShareToken } from "./clipShareToken";

const PFM_BASE = "https://api.postforme.dev/v1";

/** Platforms Post for Me supports (their enum, lowercase). */
export const PFM_PLATFORMS = [
  "facebook", "instagram", "x", "tiktok", "youtube",
  "pinterest", "linkedin", "bluesky", "threads", "tiktok_business",
] as const;
export type PfmPlatform = (typeof PFM_PLATFORMS)[number];

export function isPfmConfigured(): boolean {
  return Boolean(process.env.POSTFORME_API_KEY?.trim());
}

export const externalIdFor = (userId: string): string => `user_${userId}`;
export function userIdFromExternalId(extId: string | null | undefined): string | null {
  if (typeof extId !== "string" || !extId.startsWith("user_")) return null;
  const id = extId.slice("user_".length);
  return id.length > 0 ? id : null;
}

// ── HTTP core ─────────────────────────────────────────────────────────────────

export class PfmApiError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string, message?: string) {
    super(message ?? `Post for Me API error ${status}: ${body.slice(0, 300)}`);
    this.name = "PfmApiError";
    this.status = status;
    this.body = body;
  }
}

/** Definite rejection (safe to release claims) vs ambiguous (network/5xx). */
export const isDefiniteReject = (err: unknown): boolean =>
  err instanceof PfmApiError && err.status >= 400 && err.status < 500;

/** Human error for the UI — no raw provider internals, no key material. */
export function friendlyPfmError(err: unknown): string {
  if (err instanceof PfmApiError) {
    const body = err.body.toLowerCase();
    if (err.status === 401 || err.status === 403) {
      return "Social posting is misconfigured on the server — the posting provider rejected our API key.";
    }
    if (err.status === 404 && body.includes("provider app credentials")) {
      return "This platform isn't enabled in the posting provider dashboard yet — enable it and try again.";
    }
    if (err.status === 404) return "The posting provider couldn't find that — it may have been deleted.";
    if (err.status === 422 || err.status === 400) {
      // Surface the provider's validation reason — it's user-actionable
      try {
        const parsed = JSON.parse(err.body) as { message?: string | string[]; error?: string };
        const m = Array.isArray(parsed.message) ? parsed.message.join("; ") : (parsed.message ?? parsed.error);
        if (m) return `The posting provider rejected this: ${String(m).slice(0, 200)}`;
      } catch { /* fall through */ }
      return "The posting provider rejected this request — check the video and caption.";
    }
    if (err.status === 429) return "Posting rate limit reached — wait a minute and try again.";
    return "The posting provider is having trouble right now — try again shortly.";
  }
  return err instanceof Error && /abort|timeout/i.test(err.message)
    ? "The posting provider took too long to respond — try again."
    : "Could not reach the posting provider — try again.";
}

async function pfmApi<T>(
  path: string,
  init?: { method?: string; body?: unknown; timeoutMs?: number },
): Promise<T> {
  const key = process.env.POSTFORME_API_KEY?.trim();
  if (!key) throw new Error("POSTFORME_API_KEY is not configured");
  const res = await fetch(`${PFM_BASE}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(init?.timeoutMs ?? 30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new PfmApiError(res.status, text);
  if (!text) return undefined as T;
  try { return JSON.parse(text) as T; }
  catch { throw new Error(`Post for Me returned non-JSON (HTTP ${res.status})`); }
}

// ── Provider DTOs (only the fields we use — tokens are NEVER read) ───────────

export interface PfmAccount {
  id: string;
  platform: string;
  username: string | null;
  user_id?: string | null;       // provider-side platform user id
  profile_photo_url?: string | null;
  status: "connected" | "disconnected" | string;
  external_id?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface PfmPost {
  id: string;
  status: "draft" | "scheduled" | "processing" | "processed" | string;
  external_id?: string | null;
  scheduled_at?: string | null;
}

export interface PfmPostResult {
  id?: string;
  post_id?: string;
  social_post_id?: string;
  social_account_id: string;
  success: boolean;
  error?: unknown;
  details?: unknown;
}

interface ListEnvelope<T> { data: T[]; meta?: { total?: number; limit?: number; offset?: number } }

// ── Accounts ──────────────────────────────────────────────────────────────────

/** Fresh single-use OAuth URL for one platform, tagged with the user. */
export async function createAuthUrl(
  userId: string,
  platform: PfmPlatform,
  redirectUrl: string,
  connectionType?: string,
): Promise<string> {
  // Some platforms have two login variants (Instagram direct vs via Facebook,
  // X OAuth 1.0 vs 2.0). When both provider apps are enabled in the PFM
  // dashboard, the API requires platform_data.<platform>.connection_type.
  const extra = connectionType
    ? { platform_data: { [platform]: { connection_type: connectionType } } }
    : {};
  let r: { url: string; platform: string };
  try {
    r = await pfmApi<{ url: string; platform: string }>(
      "/social-accounts/auth-url",
      { method: "POST", body: { platform, external_id: externalIdFor(userId), redirect_url_override: redirectUrl, ...extra } },
    );
  } catch (err) {
    // Quickstart projects (PFM's shared platform credentials) reject
    // per-request redirect overrides — the dashboard's Project Redirect URL
    // is used instead. Retry without the override so connects still work;
    // the browser then lands on the dashboard-configured URL.
    const quickstartNoOverride =
      err instanceof PfmApiError && err.status >= 400 && err.status < 500 &&
      /redirect url override is not allowed/i.test(err.body ?? "");
    if (!quickstartNoOverride) throw err;
    r = await pfmApi<{ url: string; platform: string }>(
      "/social-accounts/auth-url",
      { method: "POST", body: { platform, external_id: externalIdFor(userId), ...extra } },
    );
  }
  if (!r?.url) throw new Error("Post for Me did not return a connect URL");
  return r.url;
}

async function listPfmAccountsByExternalId(extId: string): Promise<PfmAccount[]> {
  const out: PfmAccount[] = [];
  for (let offset = 0; offset < 500; offset += 100) {
    const page = await pfmApi<ListEnvelope<PfmAccount>>(
      `/social-accounts?external_id=${encodeURIComponent(extId)}&limit=100&offset=${offset}`,
    );
    out.push(...(page.data ?? []));
    if ((page.data?.length ?? 0) < 100) break;
  }
  return out;
}

export async function getPfmAccount(accountId: string): Promise<PfmAccount | null> {
  try {
    return await pfmApi<PfmAccount>(`/social-accounts/${encodeURIComponent(accountId)}`);
  } catch (err) {
    if (err instanceof PfmApiError && err.status === 404) return null;
    throw err;
  }
}

export interface Connection {
  pfmAccountId: string;
  platform: string;
  username: string | null;
  displayName: string | null;
  profileImage: string | null;
  status: string;
  autopostEnabled: boolean;
}

interface ConnectionRow {
  pfm_account_id: string; platform: string; username: string | null;
  display_name: string | null; profile_image: string | null;
  status: string; autopost_enabled: boolean;
}

const rowToConnection = (r: ConnectionRow): Connection => ({
  pfmAccountId: r.pfm_account_id,
  platform: r.platform,
  username: r.username,
  displayName: r.display_name,
  profileImage: r.profile_image,
  status: r.status,
  autopostEnabled: r.autopost_enabled,
});

export async function upsertConnection(userId: string, acc: PfmAccount): Promise<void> {
  await requireDb().query(
    `INSERT INTO social_connections
       (user_id, pfm_account_id, platform, username, display_name, profile_image, status, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (user_id, pfm_account_id) DO UPDATE SET
       platform = EXCLUDED.platform, username = EXCLUDED.username,
       display_name = EXCLUDED.display_name, profile_image = EXCLUDED.profile_image,
       status = EXCLUDED.status, updated_at = NOW()`,
    [
      userId, acc.id, String(acc.platform ?? "").toLowerCase(),
      acc.username ?? null,
      (acc.metadata as { name?: string } | null)?.name ?? acc.username ?? null,
      acc.profile_photo_url ?? null,
      acc.status === "disconnected" ? "disconnected" : "connected",
    ],
  );
}

/**
 * Pull the user's accounts from PFM and mirror them locally.
 * Local rows whose account no longer carries our external_id are NOT removed
 * (another user may have re-connected a shared page, which overwrites PFM's
 * external_id) — instead their live status is refreshed individually.
 */
export async function syncUserAccounts(userId: string): Promise<void> {
  const remote = await listPfmAccountsByExternalId(externalIdFor(userId));
  for (const acc of remote) await upsertConnection(userId, acc);

  const remoteIds = new Set(remote.map((a) => a.id));
  const { rows } = await requireDb().query<{ pfm_account_id: string }>(
    `SELECT pfm_account_id FROM social_connections WHERE user_id = $1`, [userId],
  );
  const missing = rows.map((r) => r.pfm_account_id).filter((id) => !remoteIds.has(id)).slice(0, 10);
  for (const id of missing) {
    try {
      const acc = await getPfmAccount(id);
      if (!acc) {
        await requireDb().query(
          `UPDATE social_connections SET status='disconnected', updated_at=NOW()
           WHERE user_id=$1 AND pfm_account_id=$2`, [userId, id],
        );
      } else {
        await upsertConnection(userId, acc);
      }
    } catch { /* transient — keep the local mirror as-is */ }
  }
}

/** Local (authoritative) connection list — no provider round-trip. */
export async function getUserConnections(userId: string): Promise<Connection[]> {
  const { rows } = await requireDb().query<ConnectionRow>(
    `SELECT pfm_account_id, platform, username, display_name, profile_image, status, autopost_enabled
     FROM social_connections WHERE user_id = $1
     ORDER BY platform, username NULLS LAST, pfm_account_id`,
    [userId],
  );
  return rows.map(rowToConnection);
}

/**
 * Ownership gate for posting/disconnecting: every requested id must be one of
 * the CURRENT user's connected accounts. Returns the foreign/unknown ids so
 * routes can 403 instead of silently filtering.
 */
export async function verifyAccountOwnership(
  userId: string,
  accountIds: string[],
): Promise<{ owned: Connection[]; foreign: string[] }> {
  if (accountIds.length === 0) return { owned: [], foreign: [] };
  const { rows } = await requireDb().query<ConnectionRow>(
    `SELECT pfm_account_id, platform, username, display_name, profile_image, status, autopost_enabled
     FROM social_connections
     WHERE user_id = $1 AND pfm_account_id = ANY($2) AND status = 'connected'`,
    [userId, accountIds],
  );
  const ownedIds = new Set(rows.map((r) => r.pfm_account_id));
  return {
    owned: rows.map(rowToConnection),
    foreign: [...new Set(accountIds)].filter((id) => !ownedIds.has(id)),
  };
}

/**
 * Disconnect ONE account for this user. The provider-side disconnect only
 * happens when no other AutoCliper user still maps the same physical account
 * (PFM dedupes shared pages project-wide).
 */
export async function disconnectAccount(userId: string, accountId: string): Promise<void> {
  const db = requireDb();
  const { rows } = await db.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM social_connections
     WHERE pfm_account_id = $1 AND user_id <> $2`,
    [accountId, userId],
  );
  const sharedWithOthers = Number(rows[0]?.n ?? "0") > 0;
  if (!sharedWithOthers) {
    try {
      await pfmApi(`/social-accounts/${encodeURIComponent(accountId)}/disconnect`, { method: "POST" });
    } catch (err) {
      // Already gone on the provider = success for our purposes
      if (!(err instanceof PfmApiError && err.status === 404)) throw err;
    }
  }
  await db.query(
    `DELETE FROM social_connections WHERE user_id = $1 AND pfm_account_id = $2`,
    [userId, accountId],
  );
}

// ── Posts ─────────────────────────────────────────────────────────────────────

export interface CreatePostInput {
  caption: string;
  accountIds: string[];
  mediaUrl: string;
  scheduledAt?: Date | null;
  externalId?: string;
  /** Optional YouTube title (their feed shows it prominently). */
  youtubeTitle?: string;
}

export async function createPfmPost(input: CreatePostInput): Promise<PfmPost> {
  const body: Record<string, unknown> = {
    caption: input.caption,
    social_accounts: input.accountIds,
    media: [{ url: input.mediaUrl }],
  };
  if (input.scheduledAt) body.scheduled_at = input.scheduledAt.toISOString();
  if (input.externalId) body.external_id = input.externalId;
  if (input.youtubeTitle) {
    body.platform_configurations = { youtube: { title: input.youtubeTitle.slice(0, 95) } };
  }
  const post = await pfmApi<PfmPost>("/social-posts", { method: "POST", body, timeoutMs: 60_000 });
  if (!post?.id) throw new Error("Post for Me did not return a post id");
  return post;
}

export async function getPfmPost(postId: string): Promise<PfmPost | null> {
  try {
    return await pfmApi<PfmPost>(`/social-posts/${encodeURIComponent(postId)}`);
  } catch (err) {
    if (err instanceof PfmApiError && err.status === 404) return null;
    throw err;
  }
}

/** DELETE cancels a scheduled post / removes the record. 404 = already gone. */
export async function deletePfmPost(postId: string): Promise<void> {
  try {
    await pfmApi(`/social-posts/${encodeURIComponent(postId)}`, { method: "DELETE" });
  } catch (err) {
    if (err instanceof PfmApiError && err.status === 404) return;
    throw err;
  }
}

/** Recover a post by OUR idempotency key after an ambiguous create. */
export async function findPfmPostByExternalId(externalId: string): Promise<PfmPost | null> {
  const page = await pfmApi<ListEnvelope<PfmPost>>(
    `/social-posts?external_id=${encodeURIComponent(externalId)}&limit=1`,
  );
  return page.data?.[0] ?? null;
}

export async function getPfmPostResults(postId: string): Promise<PfmPostResult[]> {
  const page = await pfmApi<ListEnvelope<PfmPostResult>>(
    `/social-post-results?post_id=${encodeURIComponent(postId)}&limit=100`,
  );
  return page.data ?? [];
}

export const resultErrorText = (r: PfmPostResult): string => {
  const raw = r.error ?? (r.details as { error?: unknown } | null)?.error;
  if (raw == null) return "Posting failed on the platform";
  const s = typeof raw === "string" ? raw : JSON.stringify(raw);
  return s.slice(0, 300);
};

// ── Post-state cache (20s) — one provider round-trip per post per poll ───────

export interface PostState {
  gone: boolean;
  status: string;                       // scheduled | processing | processed | …
  results: PfmPostResult[];
}

const postStateCache = new Map<string, { at: number; state: PostState }>();
const POST_STATE_TTL_MS = 20_000;

/** null = provider unreachable (ambiguous — callers must not free markers). */
export async function fetchPostState(postId: string): Promise<PostState | null> {
  const hit = postStateCache.get(postId);
  if (hit && Date.now() - hit.at < POST_STATE_TTL_MS) return hit.state;
  try {
    const post = await getPfmPost(postId);
    const state: PostState = post
      ? {
          gone: false,
          status: post.status,
          // Results only exist once processing finishes — skip the extra call before that
          results: post.status === "processed" || post.status === "processing"
            ? await getPfmPostResults(postId).catch(() => [])
            : [],
        }
      : { gone: true, status: "deleted", results: [] };
    postStateCache.set(postId, { at: Date.now(), state });
    if (postStateCache.size > 500) {
      const oldest = [...postStateCache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 100);
      for (const [k] of oldest) postStateCache.delete(k);
    }
    return state;
  } catch {
    return null; // ambiguous — never treat as gone
  }
}

/** Test hook — drop the cached provider state. */
export function _clearPostStateCache(): void {
  postStateCache.clear();
}

// ── Aggregate (social_posts) provider-truth mapping ───────────────────────────
//
// PFM 'processed' only means the provider FINISHED its attempts — per-account
// results carry the truth. Mapping processed → posted blindly showed users
// "POSTED ✓" while every platform upload had failed (observed live: Drive
// media URL unfetchable → all-account failure, row still promoted).

export interface AggregateOutcome {
  status: "posted" | "failed" | "processing";
  /** string = store it; null = clear stale error; undefined = leave it alone */
  error: string | null | undefined;
}

/** Decide social_posts.status for a post the provider reports as processed.
 *  `ageMs` = time since the scheduled publish moment: results normally land
 *  within seconds of processing, so with none after 15 min settle optimistic
 *  (never strand the row in 'processing' forever on a results hiccup). */
export function aggregateProcessedOutcome(results: PfmPostResult[], ageMs: number): AggregateOutcome {
  if (results.length === 0) {
    return ageMs > 15 * 60_000
      ? { status: "posted", error: undefined }
      : { status: "processing", error: undefined };
  }
  const ok = results.filter((r) => r.success).length;
  if (ok === 0) {
    return {
      status: "failed",
      error: `Failed on every account: ${resultErrorText(results[0])}`.slice(0, 300),
    };
  }
  if (ok < results.length) {
    const bad = results.find((r) => !r.success)!;
    return {
      status: "posted",
      error: `${ok}/${results.length} accounts posted — rest failed: ${resultErrorText(bad)}`.slice(0, 300),
    };
  }
  return { status: "posted", error: null };
}

/** Live-refresh schedule/campaign rows against provider truth (mutates the
 *  passed rows AND persists). Covers near-due scheduled/processing rows, plus
 *  'posted' rows carrying an error text — a failure result arrived after a
 *  blind promote, so re-check instead of trusting it. Never throws. */
export async function refreshAggregateRows(
  rows: Array<{
    id: string; pfm_post_id?: string | null; status: string;
    error?: string | null; scheduled_at?: string | null;
  }>,
  limit = 15,
): Promise<void> {
  const db = requireDb();
  const due = rows.filter((r) =>
    r.pfm_post_id && (
      ((r.status === "scheduled" || r.status === "processing") &&
        r.scheduled_at && new Date(r.scheduled_at).getTime() < Date.now() + 15 * 60_000) ||
      (r.status === "posted" && !!r.error)
    ),
  ).slice(0, limit);

  for (const r of due) {
    const state = await fetchPostState(r.pfm_post_id!);
    if (!state) continue; // provider unreachable — never guess
    let next: string | null = null;
    let nextError: string | null | undefined = undefined;
    if (state.gone) {
      next = "deleted";
    } else if (state.status === "processed") {
      const age = r.scheduled_at ? Date.now() - new Date(r.scheduled_at).getTime() : 0;
      const out = aggregateProcessedOutcome(state.results, age);
      next = out.status; nextError = out.error;
    } else if (state.status === "processing") {
      next = "processing";
    }
    if (!next || (next === r.status && nextError === undefined)) continue;
    // Compare-and-set on the status we based this decision on: a result
    // webhook may have applied NEWER truth (e.g. flipped to 'failed') between
    // our read and this write — a stale refresh must lose that race, never
    // overwrite it. (Cancelled/deleted rows are never selected into `due`.)
    const res = await db.query(
      nextError === undefined
        ? `UPDATE social_posts SET status=$3, updated_at=NOW()
           WHERE id=$1 AND status=$2`
        : `UPDATE social_posts SET status=$3, error=$4, updated_at=NOW()
           WHERE id=$1 AND status=$2`,
      nextError === undefined ? [r.id, r.status, next] : [r.id, r.status, next, nextError],
    ).catch(() => null);
    if (res && (res.rowCount ?? 0) > 0) {
      r.status = next;
      if (nextError !== undefined) r.error = nextError;
    }
  }
}

// ── Clip auto/manual posting with per-account idempotency markers ─────────────

export interface ClipToPost {
  fileId: string;
  label: string;
  caption: string;
  /** Optional explicit YouTube title (user-edited). When absent, the
   *  caption's hook line is used — never the generic "Clip N" label. */
  youtubeTitle?: string;
}

/** First usable line of a caption → platform title (YouTube shows it big).
 *  Skips empty and hashtag/mention-only lines; undefined when nothing usable
 *  so callers fall back to the clip label / file name. */
export function titleFromCaption(caption?: string | null): string | undefined {
  for (const raw of (caption ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    // A line that is only hashtags/mentions/punctuation/emoji isn't a title.
    if (!line.replace(/[#@][\p{L}\p{N}_]+/gu, "").replace(/[\s\p{P}\p{S}]+/gu, "")) continue;
    return line.slice(0, 95);
  }
  return undefined;
}

export interface ClipPostOutcome {
  clipId: string;
  postedAccounts: string[];      // claim succeeded → post created (or in flight)
  alreadyPosted: string[];       // blocked by a live/pending marker
  fileMissing?: boolean;
  noAccounts?: boolean;
  error?: string;                // friendly message when the create failed
}

interface MarkerRow {
  id: number; clip_id: string; social_account_id: string; platform: string;
  pfm_post_id: string | null; post_row_id: string | null; status: string;
  error: string | null; posted_at: string; updated_at: string;
}

const STALE_PENDING_MS = 15 * 60 * 1000;

type Log = { warn: (...a: unknown[]) => void; info: (...a: unknown[]) => void } | Console;

/**
 * Frees markers whose provider post is dead so the account can be posted to
 * again with a normal tap. NEVER frees on ambiguity:
 *  - 'error' rows → freed (the failure was already reported once)
 *  - stale 'pending' without a post id → conditional sweep (only if STILL
 *    id-less — a concurrent writer saving the id wins the race)
 *  - 'unknown' with a post_row_id → deterministic external-id lookup:
 *    found → adopt the post id (submitted); definitively absent → freed
 *  - rows with a post id → freed only when the post is GONE or that
 *    account's result row says success=false
 */
async function reconcileBlockedMarkers(
  userId: string,
  clipId: string,
  markers: MarkerRow[],
  log: Log,
): Promise<void> {
  const db = requireDb();
  for (const m of markers) {
    try {
      if (m.status === "error") {
        await db.query(`DELETE FROM clip_account_posts WHERE id = $1`, [m.id]);
        continue;
      }
      if (m.status === "pending" && !m.pfm_post_id) {
        const age = Date.now() - new Date(m.updated_at).getTime();
        if (age > STALE_PENDING_MS) {
          await db.query(
            `DELETE FROM clip_account_posts
             WHERE id = $1 AND status = 'pending' AND pfm_post_id IS NULL`,
            [m.id],
          );
        }
        continue;
      }
      if (m.status === "unknown" && !m.pfm_post_id && m.post_row_id) {
        try {
          const found = await findPfmPostByExternalId(m.post_row_id);
          if (found) {
            await db.query(
              `UPDATE clip_account_posts SET pfm_post_id=$2, status='submitted', updated_at=NOW()
               WHERE id=$1 AND status='unknown'`,
              [m.id, found.id],
            );
          } else {
            // Search worked and the post definitively does not exist → the
            // ambiguous create actually failed. Free the account.
            await db.query(`DELETE FROM clip_account_posts WHERE id=$1 AND status='unknown'`, [m.id]);
          }
        } catch { /* provider unreachable — stays blocked (correct) */ }
        continue;
      }
      if (m.pfm_post_id) {
        const state = await fetchPostState(m.pfm_post_id);
        if (!state) continue; // ambiguous
        const myResult = state.results.find((r) => r.social_account_id === m.social_account_id);
        if (state.gone || (myResult && myResult.success === false)) {
          await db.query(`DELETE FROM clip_account_posts WHERE id = $1`, [m.id]);
        }
      }
    } catch (err) {
      log.warn(`[pfm] reconcile marker ${m.id} (clip ${clipId}, user ${userId}) failed: ${(err as Error).message}`);
    }
  }
}

/**
 * Post clips to the user's accounts — the ONE entry point used by auto-post
 * (generation worker) and the manual Post button. Claims markers BEFORE
 * posting so double-posting is impossible across instances.
 *
 * targetAccountIds, when given, MUST already be ownership-verified by the
 * route. When absent (auto-post), the user's autopost-enabled accounts are
 * used.
 */
export async function autoPostClips(
  clips: ClipToPost[],
  userId: string,
  appBase: string,
  log: Log = console,
  targetAccountIds?: string[],
  opts?: { force?: boolean },
): Promise<ClipPostOutcome[]> {
  const db = requireDb();
  const all = await getUserConnections(userId);
  const connected = all.filter((c) => c.status === "connected");
  const targets = targetAccountIds && targetAccountIds.length > 0
    ? connected.filter((c) => targetAccountIds.includes(c.pfmAccountId))
    : connected.filter((c) => c.autopostEnabled);

  const outcomes: ClipPostOutcome[] = [];
  if (targets.length === 0) {
    return clips.map((c) => ({ clipId: c.fileId, postedAccounts: [], alreadyPosted: [], noAccounts: true }));
  }
  const platformOf = new Map(targets.map((t) => [t.pfmAccountId, t.platform]));
  const targetIds = targets.map((t) => t.pfmAccountId);

  for (const clip of clips) {
    const outcome: ClipPostOutcome = { clipId: clip.fileId, postedAccounts: [], alreadyPosted: [] };
    outcomes.push(outcome);
    try {
      // Deliberate repost: clear existing markers for the selected accounts first
      if (opts?.force) {
        await db.query(
          `DELETE FROM clip_account_posts
           WHERE user_id=$1 AND clip_id=$2 AND social_account_id = ANY($3)`,
          [userId, clip.fileId, targetIds],
        );
      }

      const claim = async (): Promise<string[]> => {
        const { rows } = await db.query<{ social_account_id: string }>(
          `INSERT INTO clip_account_posts (user_id, clip_id, social_account_id, platform, status)
           SELECT $1, $2, unnest($3::text[]), unnest($4::text[]), 'pending'
           ON CONFLICT (user_id, clip_id, social_account_id) DO NOTHING
           RETURNING social_account_id`,
          [userId, clip.fileId, targetIds, targetIds.map((id) => platformOf.get(id) ?? "")],
        );
        return rows.map((r) => r.social_account_id);
      };

      let claimed = await claim();
      let blockedIds = targetIds.filter((id) => !claimed.includes(id));

      // Self-heal dead markers (platform-deleted posts, reported errors,
      // stale pendings), then try to claim the freed accounts once more.
      if (blockedIds.length > 0) {
        const { rows: blockedRows } = await db.query<MarkerRow>(
          `SELECT * FROM clip_account_posts
           WHERE user_id=$1 AND clip_id=$2 AND social_account_id = ANY($3)`,
          [userId, clip.fileId, blockedIds],
        );
        await reconcileBlockedMarkers(userId, clip.fileId, blockedRows, log);
        const extra = await claim();
        claimed = [...claimed, ...extra];
        blockedIds = targetIds.filter((id) => !claimed.includes(id));
      }
      outcome.alreadyPosted = blockedIds;
      if (claimed.length === 0) continue;

      const releaseClaims = async () => {
        await db.query(
          `DELETE FROM clip_account_posts
           WHERE user_id=$1 AND clip_id=$2 AND social_account_id = ANY($3)
             AND status='pending' AND pfm_post_id IS NULL`,
          [userId, clip.fileId, claimed],
        ).catch(() => {});
      };

      // Resolve the clip file and build a public URL PFM's servers can fetch
      const resolved = await resolveFile(clip.fileId).catch(() => null);
      if (!resolved) {
        await releaseClaims();
        outcome.fileMissing = true;
        continue;
      }
      if (!appBase) {
        await releaseClaims();
        outcome.error = "Server is missing its public URL (PUBLIC_APP_URL) — cannot hand media to the posting provider.";
        log.warn("[pfm] no appBase — cannot build a public media URL");
        continue;
      }
      const token = await createShareToken(clip.fileId, userId);
      const mediaUrl = `${appBase}/api/video/clip-share/${token}`;

      // Mirror row first — its id is the PFM external_id (deterministic
      // recovery if the create outcome is ambiguous).
      const rowId = randomUUID();
      await db.query(
        `UPDATE clip_account_posts SET post_row_id=$4, updated_at=NOW()
         WHERE user_id=$1 AND clip_id=$2 AND social_account_id = ANY($3) AND status='pending'`,
        [userId, clip.fileId, claimed, rowId],
      );
      const claimedPlatforms = [...new Set(claimed.map((id) => platformOf.get(id) ?? ""))].filter(Boolean);
      await db.query(
        `INSERT INTO social_posts (id, user_id, source, clip_id, media_url, file_name, caption, account_ids, platforms, status)
         VALUES ($1, $2, 'clip', $3, $4, $5, $6, $7, $8, 'creating')`,
        [rowId, userId, clip.fileId, mediaUrl, clip.label.slice(0, 200), clip.caption, claimed, claimedPlatforms],
      );

      let post: PfmPost | null = null;
      try {
        post = await createPfmPost({
          caption: clip.caption || clip.label,
          accountIds: claimed,
          mediaUrl,
          externalId: rowId,
          youtubeTitle: claimed.some((id) => platformOf.get(id) === "youtube")
            ? (clip.youtubeTitle?.trim() || titleFromCaption(clip.caption) || clip.label)
            : undefined,
        });
      } catch (err) {
        if (isDefiniteReject(err)) {
          await releaseClaims();
          await db.query(
            `UPDATE social_posts SET status='failed', error=$2, updated_at=NOW() WHERE id=$1`,
            [rowId, friendlyPfmError(err)],
          ).catch(() => {});
          outcome.error = friendlyPfmError(err);
          log.warn(`[pfm] post create rejected for clip ${clip.fileId}: ${(err as Error).message}`);
          continue;
        }
        // Ambiguous (network/5xx) — the post MAY exist. Recover by external id.
        try {
          post = await findPfmPostByExternalId(rowId);
        } catch { post = null; }
        if (!post) {
          // Could not confirm either way → markers become 'unknown' (block
          // duplicates; reconcile resolves them via post_row_id later).
          await db.query(
            `UPDATE clip_account_posts SET status='unknown', updated_at=NOW()
             WHERE user_id=$1 AND clip_id=$2 AND social_account_id = ANY($3) AND status='pending'`,
            [userId, clip.fileId, claimed],
          ).catch(() => {});
          await db.query(
            `UPDATE social_posts SET status='unknown', error=$2, updated_at=NOW() WHERE id=$1`,
            [rowId, friendlyPfmError(err)],
          ).catch(() => {});
          outcome.error = "Posting status is unclear — we'll sort it out automatically, check back in a minute.";
          log.warn(`[pfm] ambiguous create for clip ${clip.fileId}: ${(err as Error).message}`);
          continue;
        }
      }

      // Persist the provider post id on the markers. If this write keeps
      // failing the markers escalate to 'unknown' (reconcilable via
      // post_row_id) — NEVER left 'pending' with an untracked live post.
      let saved = false;
      for (let i = 0; i < 3 && !saved; i++) {
        try {
          await db.query(
            `UPDATE clip_account_posts SET pfm_post_id=$4, status='submitted', updated_at=NOW()
             WHERE user_id=$1 AND clip_id=$2 AND social_account_id = ANY($3)`,
            [userId, clip.fileId, claimed, post.id],
          );
          saved = true;
        } catch (err) {
          if (i === 2) {
            log.warn(`[pfm] could not save post id ${post.id} on markers — escalating to unknown: ${(err as Error).message}`);
            await db.query(
              `UPDATE clip_account_posts SET status='unknown', updated_at=NOW()
               WHERE user_id=$1 AND clip_id=$2 AND social_account_id = ANY($3) AND status='pending'`,
              [userId, clip.fileId, claimed],
            ).catch(() => {});
          } else {
            await new Promise((r) => setTimeout(r, 500 * (i + 1)));
          }
        }
      }
      await db.query(
        `UPDATE social_posts SET pfm_post_id=$2, status=$3, updated_at=NOW() WHERE id=$1`,
        [rowId, post.id, post.status === "processed" ? "posted" : "processing"],
      ).catch(() => {});

      outcome.postedAccounts = claimed;
      log.info(`[pfm] clip ${clip.fileId} → post ${post.id} (${claimed.length} account${claimed.length === 1 ? "" : "s"})`);
    } catch (err) {
      outcome.error = friendlyPfmError(err);
      log.warn(`[pfm] posting clip ${clip.fileId} failed: ${(err as Error).message}`);
    }
  }
  return outcomes;
}

// ── Live per-account status for the UI (self-healing) ────────────────────────

export interface AccountPostStatus {
  accountId: string;
  platform: string;
  username?: string | null;
  status: "processing" | "posted" | "error" | "deleted";
  error?: string;
}

/**
 * Mirror provider truth for a set of clips, per account:
 *  - submitted/posted markers follow the provider post + this account's result
 *  - posts deleted on the platform free their markers (report 'deleted' once)
 *  - 'error' rows are reported once with the real reason, then freed
 *  - ambiguity (provider unreachable) keeps the last known state
 */
export async function getClipPostStatuses(
  userId: string,
  clipIds: string[],
): Promise<Record<string, AccountPostStatus[]>> {
  const db = requireDb();
  const out: Record<string, AccountPostStatus[]> = {};
  if (clipIds.length === 0) return out;

  const { rows } = await db.query<MarkerRow & { username: string | null }>(
    `SELECT m.*, c.username
     FROM clip_account_posts m
     LEFT JOIN social_connections c
       ON c.user_id = m.user_id AND c.pfm_account_id = m.social_account_id
     WHERE m.user_id = $1 AND m.clip_id = ANY($2)`,
    [userId, clipIds],
  );

  const push = (clipId: string, s: AccountPostStatus) => {
    (out[clipId] ??= []).push(s);
  };

  for (const m of rows) {
    const base = { accountId: m.social_account_id, platform: m.platform, username: m.username };
    try {
      if (m.status === "error") {
        // Surface the stored failure once, then free the account for repost
        push(m.clip_id, { ...base, status: "error", error: (m.error ?? "Posting failed on the platform").slice(0, 300) });
        await db.query(`DELETE FROM clip_account_posts WHERE id=$1 AND status='error'`, [m.id]);
        continue;
      }
      if (!m.pfm_post_id) {
        if (m.status === "pending") {
          const age = Date.now() - new Date(m.updated_at).getTime();
          if (age > STALE_PENDING_MS) {
            // Conditional sweep — a racing writer that just saved a post id wins
            const swept = await db.query(
              `DELETE FROM clip_account_posts
               WHERE id=$1 AND status='pending' AND pfm_post_id IS NULL`,
              [m.id],
            );
            if ((swept.rowCount ?? 0) > 0) { push(m.clip_id, { ...base, status: "deleted" }); continue; }
          }
          push(m.clip_id, { ...base, status: "processing" });
        } else if (m.status === "unknown") {
          // Try the deterministic recovery; until it lands, show processing
          if (m.post_row_id) {
            try {
              const found = await findPfmPostByExternalId(m.post_row_id);
              if (found) {
                await db.query(
                  `UPDATE clip_account_posts SET pfm_post_id=$2, status='submitted', updated_at=NOW()
                   WHERE id=$1 AND status='unknown'`, [m.id, found.id],
                );
              } else {
                await db.query(`DELETE FROM clip_account_posts WHERE id=$1 AND status='unknown'`, [m.id]);
                push(m.clip_id, { ...base, status: "deleted" });
                continue;
              }
            } catch { /* unreachable — stay blocked */ }
          }
          push(m.clip_id, { ...base, status: "processing" });
        } else {
          // Legacy 'posted'/'submitted' rows without a post id → posted
          push(m.clip_id, { ...base, status: "posted" });
        }
        continue;
      }

      const state = await fetchPostState(m.pfm_post_id);
      if (!state) {
        // Provider unreachable — keep the last known state, never guess
        push(m.clip_id, { ...base, status: m.status === "posted" ? "posted" : "processing" });
        continue;
      }
      if (state.gone) {
        await db.query(`DELETE FROM clip_account_posts WHERE id=$1`, [m.id]);
        push(m.clip_id, { ...base, status: "deleted" });
        continue;
      }
      const myResult = state.results.find((r) => r.social_account_id === m.social_account_id);
      if (myResult) {
        if (myResult.success) {
          if (m.status !== "posted") {
            await db.query(
              `UPDATE clip_account_posts SET status='posted', updated_at=NOW() WHERE id=$1`, [m.id],
            );
          }
          push(m.clip_id, { ...base, status: "posted" });
        } else {
          const errText = resultErrorText(myResult);
          push(m.clip_id, { ...base, status: "error", error: errText });
          // Freed immediately — the user saw the real reason and can retry
          await db.query(`DELETE FROM clip_account_posts WHERE id=$1`, [m.id]);
        }
        continue;
      }
      if (m.status === "posted") { push(m.clip_id, { ...base, status: "posted" }); continue; }
      if (state.status === "processed") {
        // Post finished but this account's result row hasn't appeared yet.
        // Give results 15 min to land, then settle optimistically.
        const age = Date.now() - new Date(m.posted_at).getTime();
        if (age > STALE_PENDING_MS) {
          await db.query(`UPDATE clip_account_posts SET status='posted', updated_at=NOW() WHERE id=$1`, [m.id]).catch(() => {});
          push(m.clip_id, { ...base, status: "posted" });
        } else {
          push(m.clip_id, { ...base, status: "processing" });
        }
        continue;
      }
      push(m.clip_id, { ...base, status: "processing" });
    } catch {
      push(m.clip_id, { ...base, status: m.status === "posted" ? "posted" : "processing" });
    }
  }
  return out;
}

// ── Webhooks ──────────────────────────────────────────────────────────────────

let webhookSecretsCache: { at: number; secrets: Set<string> } | null = null;

/** Known webhook secrets (cached 5 min) — used to verify deliveries. */
export async function getWebhookSecrets(): Promise<Set<string>> {
  if (webhookSecretsCache && Date.now() - webhookSecretsCache.at < 5 * 60_000) {
    return webhookSecretsCache.secrets;
  }
  try {
    const { rows } = await requireDb().query<{ secret: string }>(`SELECT secret FROM pfm_webhooks`);
    webhookSecretsCache = { at: Date.now(), secrets: new Set(rows.map((r) => r.secret)) };
  } catch {
    // DB hiccup: keep serving the last known secrets instead of caching an
    // empty set (which would 401 every delivery for 5 minutes).
    webhookSecretsCache = { at: Date.now(), secrets: webhookSecretsCache?.secrets ?? new Set() };
  }
  return webhookSecretsCache.secrets;
}

export function _clearWebhookSecretsCache(): void {
  webhookSecretsCache = null;
}

const PFM_EVENT_TYPES = [
  "social.post.created", "social.post.updated", "social.post.deleted",
  "social.post.result.created", "social.account.created", "social.account.updated",
];

/**
 * Register (once) the public webhook endpoint with PFM and store its secret.
 * Only runs when a public app URL exists — dev environments rely on polling.
 */
export async function ensurePfmWebhook(log: Log = console): Promise<void> {
  if (!isPfmConfigured()) return;
  const base = (process.env.PUBLIC_APP_URL ?? "").trim().replace(/\/$/, "");
  if (!base) return; // no stable public URL (dev) — polling covers status sync
  const url = `${base}/api/webhooks/postforme`;
  const db = requireDb();
  try {
    const existing = await db.query<{ secret: string }>(`SELECT secret FROM pfm_webhooks WHERE url = $1`, [url]);
    interface PfmWebhook { id: string; url: string; secret?: string; event_types?: string[] }
    const list = await pfmApi<ListEnvelope<PfmWebhook>>(`/webhooks?limit=100`);
    const remote = (list.data ?? []).find((w) => w.url === url);

    if (remote && existing.rows[0]) return; // registered + secret known
    if (remote && !existing.rows[0]) {
      if (remote.secret) {
        await db.query(
          `INSERT INTO pfm_webhooks (url, webhook_id, secret) VALUES ($1,$2,$3)
           ON CONFLICT (url) DO UPDATE SET webhook_id=$2, secret=$3`,
          [url, remote.id, remote.secret],
        );
      } else {
        // Secret not readable from the list — recreate to learn it
        await pfmApi(`/webhooks/${encodeURIComponent(remote.id)}`, { method: "DELETE" }).catch(() => {});
        const created = await pfmApi<PfmWebhook>("/webhooks", {
          method: "POST", body: { url, event_types: PFM_EVENT_TYPES },
        });
        await db.query(
          `INSERT INTO pfm_webhooks (url, webhook_id, secret) VALUES ($1,$2,$3)
           ON CONFLICT (url) DO UPDATE SET webhook_id=$2, secret=$3`,
          [url, created.id, created.secret ?? ""],
        );
      }
    } else if (!remote) {
      const created = await pfmApi<PfmWebhook>("/webhooks", {
        method: "POST", body: { url, event_types: PFM_EVENT_TYPES },
      });
      await db.query(
        `INSERT INTO pfm_webhooks (url, webhook_id, secret) VALUES ($1,$2,$3)
         ON CONFLICT (url) DO UPDATE SET webhook_id=$2, secret=$3`,
        [url, created.id, created.secret ?? ""],
      );
      log.info(`[pfm] webhook registered: ${url}`);
    }
    _clearWebhookSecretsCache();
  } catch (err) {
    log.warn(`[pfm] webhook registration failed (polling still covers status sync): ${(err as Error).message}`);
  }
}

/**
 * Apply one webhook event to our mirrors. Idempotent by construction — every
 * write is an UPDATE/UPSERT keyed on provider ids, so PFM's ~8 retries over
 * 24h can never double-apply. Runs AFTER the 200 ack (their 1s deadline).
 */
export async function processWebhookEvent(body: unknown, log: Log = console): Promise<void> {
  const evt = body as { type?: string; event_type?: string; event?: string; data?: unknown };
  const type = evt?.type ?? evt?.event_type ?? evt?.event ?? "";
  const data = (evt?.data ?? body) as Record<string, unknown>;
  if (!type || typeof data !== "object" || data === null) return;
  const db = requireDb();

  try {
    if (type === "social.post.result.created") {
      const r = data as unknown as PfmPostResult;
      const postId = r.post_id ?? r.social_post_id;
      if (!postId || !r.social_account_id) return;
      if (r.success) {
        await db.query(
          `UPDATE clip_account_posts SET status='posted', updated_at=NOW()
           WHERE pfm_post_id=$1 AND social_account_id=$2 AND status <> 'posted'`,
          [postId, r.social_account_id],
        );
        // A confirmed platform success makes the aggregate row honestly posted.
        await db.query(
          `UPDATE social_posts SET status='posted', updated_at=NOW()
           WHERE pfm_post_id=$1 AND status NOT IN ('cancelled','deleted','posted')`,
          [postId],
        );
      } else {
        const errText = resultErrorText(r);
        await db.query(
          `UPDATE clip_account_posts SET status='error', error=$3, updated_at=NOW()
           WHERE pfm_post_id=$1 AND social_account_id=$2 AND status IN ('pending','submitted','unknown')`,
          [postId, r.social_account_id, errText],
        );
        await db.query(
          `UPDATE social_posts SET error=$2, updated_at=NOW() WHERE pfm_post_id=$1`,
          [postId, errText],
        );
        // Every account failed? Then 'posted' would be a lie — reflect reality.
        // (Local row lookup FIRST so posts we don't track cost no provider call.)
        const { rows: agg } = await db.query<{ id: string; account_ids: string[] | null }>(
          `SELECT id, account_ids FROM social_posts WHERE pfm_post_id=$1 LIMIT 1`,
          [postId],
        );
        const expected = agg[0]?.account_ids?.length ?? 0;
        if (agg[0] && expected > 0) {
          const results = await getPfmPostResults(String(postId)).catch(() => null);
          if (results && results.length >= expected && results.every((x) => !x.success)) {
            await db.query(
              `UPDATE social_posts SET status='failed', error=$2, updated_at=NOW()
               WHERE pfm_post_id=$1 AND status NOT IN ('cancelled','deleted')`,
              [postId, `Failed on every account: ${errText}`.slice(0, 300)],
            );
          }
        }
      }
      postStateCache.delete(String(postId));
      return;
    }
    if (type === "social.post.updated" || type === "social.post.created") {
      const p = data as unknown as PfmPost;
      if (!p.id || !p.status) return;
      postStateCache.delete(p.id);
      if (p.status === "processed") {
        // 'processed' ≠ success — per-account results decide. Local row lookup
        // FIRST so posts we don't track never cost a provider call.
        const { rows: agg } = await db.query<{ id: string; scheduled_at: string | null; status: string }>(
          `SELECT id, scheduled_at, status FROM social_posts WHERE pfm_post_id=$1 LIMIT 1`,
          [p.id],
        );
        if (agg[0] && agg[0].status !== "cancelled" && agg[0].status !== "deleted") {
          const state = await fetchPostState(p.id);
          if (state && !state.gone) {
            const age = agg[0].scheduled_at ? Date.now() - new Date(agg[0].scheduled_at).getTime() : 0;
            const out = aggregateProcessedOutcome(state.results, age);
            // Compare-and-set: a concurrent result webhook may have applied
            // newer truth — this (possibly cache-stale) view must lose then.
            await db.query(
              out.error === undefined
                ? `UPDATE social_posts SET status=$3, updated_at=NOW()
                   WHERE pfm_post_id=$1 AND status=$2`
                : `UPDATE social_posts SET status=$3, error=$4, updated_at=NOW()
                   WHERE pfm_post_id=$1 AND status=$2`,
              out.error === undefined
                ? [p.id, agg[0].status, out.status]
                : [p.id, agg[0].status, out.status, out.error],
            );
          }
        }
      } else {
        const mapped = p.status === "processing" ? "processing"
          : p.status === "scheduled" ? "scheduled" : null;
        if (mapped) {
          await db.query(
            `UPDATE social_posts SET status=$2, updated_at=NOW()
             WHERE pfm_post_id=$1 AND status NOT IN ('cancelled','deleted','failed')`,
            [p.id, mapped],
          );
        }
      }
      return;
    }
    if (type === "social.post.deleted") {
      const p = data as unknown as PfmPost;
      if (!p.id) return;
      await db.query(
        `UPDATE social_posts SET status='deleted', updated_at=NOW()
         WHERE pfm_post_id=$1 AND status NOT IN ('posted','cancelled')`,
        [p.id],
      );
      // Post gone on the provider → clips become repostable with a normal tap
      await db.query(`DELETE FROM clip_account_posts WHERE pfm_post_id=$1 AND status <> 'posted'`, [p.id]);
      postStateCache.delete(p.id);
      return;
    }
    if (type === "social.account.created" || type === "social.account.updated") {
      const acc = data as unknown as PfmAccount;
      const userId = userIdFromExternalId(acc.external_id);
      if (!userId || !acc.id) return;
      const exists = await db.query<{ id: string }>(`SELECT id FROM users WHERE id=$1`, [userId]);
      if (exists.rows.length === 0) return;
      await upsertConnection(userId, acc);
      return;
    }
  } catch (err) {
    log.warn(`[pfm] webhook event ${type} processing failed: ${(err as Error).message}`);
  }
}

// ── Misc ──────────────────────────────────────────────────────────────────────

/** Public base URL for media/callback links (PUBLIC_APP_URL on the VPS,
 *  forwarded headers behind Replit's proxy, dev domain as a last resort). */
export function getPublicAppBase(req?: {
  headers: Record<string, string | string[] | undefined>;
}): string {
  const fromEnv = (process.env.PUBLIC_APP_URL ?? "").trim().replace(/\/$/, "");
  if (fromEnv) return fromEnv;
  if (req) {
    const proto = (Array.isArray(req.headers["x-forwarded-proto"]) ? req.headers["x-forwarded-proto"][0] : req.headers["x-forwarded-proto"]) ?? "https";
    const host = (Array.isArray(req.headers["x-forwarded-host"]) ? req.headers["x-forwarded-host"][0] : req.headers["x-forwarded-host"])
      ?? (Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host) ?? "";
    if (host) return `${String(proto).split(",")[0]}://${String(host).split(",")[0]}`;
  }
  const dev = (process.env.REPLIT_DEV_DOMAIN ?? "").trim();
  return dev ? `https://${dev}` : "";
}
