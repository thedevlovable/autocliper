/**
 * Buffer social-media posting — Buffer GraphQL API with Personal Access Tokens.
 * Endpoint: https://api.buffer.com/graphql
 *
 * Required env vars:
 *   BUFFER_API_KEY   – Personal Access Token (publish.buffer.com/settings/api)
 *   BUFFER_CHANNELS  – Comma-separated "channelId:service" pairs, e.g.
 *                      "abc123:instagram,def456:tiktok"
 *
 * Optional:
 *   BUFFER_SCHEDULE_DELAY_MINUTES – Minutes between clips (0 = post now)
 *   BUFFER_CAPTION_TEMPLATE       – {label} and {caption} replaced per clip
 */

import { createShareToken } from "./clipShareToken";
import { requireDb } from "./db";

const GQL = "https://api.buffer.com/graphql";

function apiKey(): string {
  return (process.env.BUFFER_API_KEY ?? "").trim();
}

interface ChannelConfig {
  id: string;
  service: string;
}

function channels(): ChannelConfig[] {
  return (process.env.BUFFER_CHANNELS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [id, service = "unknown"] = s.split(":");
      return { id, service };
    });
}

export function isBufferConfigured(): boolean {
  return apiKey().length > 0;
}

// ── DB-backed channel management ──────────────────────────────────────────────

export interface ChannelRow {
  id: string;
  service: string;
  name: string;
  enabled: boolean;
}

/** Active channels from DB (enabled=true). Falls back to BUFFER_CHANNELS env var if DB empty. */
export async function getActiveChannels(): Promise<ChannelConfig[]> {
  try {
    const { rows } = await requireDb().query<{ id: string; service: string }>(
      `SELECT id, service FROM buffer_channels WHERE enabled = true`,
    );
    if (rows.length > 0) return rows;
  } catch {
    // DB not ready — fall back to env var
  }
  return channels();
}

/** All channels from DB (enabled + disabled). */
export async function getAllChannelsFromDB(): Promise<ChannelRow[]> {
  const { rows } = await requireDb().query<ChannelRow>(
    `SELECT id, service, name, enabled FROM buffer_channels ORDER BY name`,
  );
  return rows;
}

/**
 * Get active channels for a specific user.
 * If the user has set preferences → use those.
 * If no preferences set (new user) → fall back to admin-enabled channels.
 */
export async function getChannelsForUser(userId: string): Promise<ChannelConfig[]> {
  try {
    const { rows: prefs } = await requireDb().query<{ channel_id: string; enabled: boolean }>(
      `SELECT channel_id, enabled FROM user_buffer_channels WHERE user_id = $1`,
      [userId],
    );
    if (prefs.length > 0) {
      const enabledIds = prefs.filter((r) => r.enabled).map((r) => r.channel_id);
      if (enabledIds.length === 0) return []; // user turned everything off
      const { rows } = await requireDb().query<{ id: string; service: string }>(
        `SELECT id, service FROM buffer_channels WHERE id = ANY($1::text[])`,
        [enabledIds],
      );
      return rows;
    }
  } catch { /* DB not ready */ }
  return getActiveChannels();
}

/** Enable or disable a Buffer channel. */
export async function setChannelEnabled(channelId: string, enabled: boolean): Promise<void> {
  await requireDb().query(
    `UPDATE buffer_channels SET enabled = $1 WHERE id = $2`,
    [enabled, channelId],
  );
}

/**
 * Pull all channels from Buffer API and upsert into DB.
 * Preserves existing enabled state; auto-enables any channel listed in BUFFER_CHANNELS env var.
 */
export async function syncAllChannelsToDB(): Promise<ChannelRow[]> {
  const profiles = await getBufferProfiles();
  if (profiles.length === 0) return getAllChannelsFromDB();

  const { rows: existing } = await requireDb().query<{ id: string; enabled: boolean }>(
    `SELECT id, enabled FROM buffer_channels`,
  );
  const existingMap = new Map(existing.map((r) => [r.id, r.enabled]));
  const envIds = new Set(channels().map((c) => c.id));

  for (const p of profiles) {
    const shouldEnable = existingMap.has(p.id)
      ? existingMap.get(p.id)!
      : envIds.has(p.id);
    await requireDb().query(
      `INSERT INTO buffer_channels (id, service, name, enabled)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET service = $2, name = $3, synced_at = NOW()`,
      [p.id, p.service, p.displayName ?? p.name ?? "", shouldEnable],
    );
  }

  return getAllChannelsFromDB();
}

async function gql<T = unknown>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(GQL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) {
    throw new Error(`Buffer GQL: ${json.errors.map((e) => e.message).join("; ")}`);
  }
  return json.data as T;
}

// ── Create post ───────────────────────────────────────────────────────────────

const CREATE_POST = /* GraphQL */ `
  mutation CreatePost($input: CreatePostInput!) {
    createPost(input: $input) {
      ... on PostActionSuccess  { post { id status } }
      ... on NotFoundError      { message }
      ... on UnauthorizedError  { message }
      ... on UnexpectedError    { message }
      ... on LimitReachedError  { message }
      ... on InvalidInputError  { message }
      ... on RestProxyError     { message }
    }
  }
`;

/**
 * Build service-specific metadata required by Buffer per platform.
 * Returns undefined for platforms that don't need extra metadata.
 */
function buildMetadata(service: string): Record<string, unknown> | undefined {
  switch (service.toLowerCase()) {
    case "instagram":
      // Instagram videos must declare a type (reel / post / story)
      return { instagram: { type: "reel", shouldShareToFeed: true } };
    case "tiktok":
      // TikTok requires privacy and comment settings
      return { tiktok: { privacy: "PUBLIC_TO_EVERYONE", allowComments: true, allowDuet: true, allowStitch: true } };
    default:
      return undefined;
  }
}

export interface BufferPostOptions {
  channel: ChannelConfig;
  text: string;
  videoUrl: string;
  thumbnailUrl?: string;
  /** Omit to post immediately ("shareNow"). */
  scheduledAt?: Date;
}

/** Create one Buffer post on one channel. Throws on API error. */
export async function postToBuffer(opts: BufferPostOptions): Promise<void> {
  // mode = WHEN to post; schedulingType = delivery method (automatic vs notification)
  const mode = opts.scheduledAt ? "customScheduled" : "shareNow";
  const metadata = buildMetadata(opts.channel.service);

  const input: Record<string, unknown> = {
    channelId: opts.channel.id,
    text: opts.text,
    assets: [
      {
        video: {
          url: opts.videoUrl,
          ...(opts.thumbnailUrl ? { thumbnailUrl: opts.thumbnailUrl } : {}),
        },
      },
    ],
    mode,
    schedulingType: "automatic",
    needsApproval: false,
    ...(opts.scheduledAt ? { dueAt: opts.scheduledAt.toISOString() } : {}),
    ...(metadata ? { metadata } : {}),
  };

  const data = await gql<{ createPost: { post?: { id: string; status: string }; message?: string } }>(
    CREATE_POST,
    { input },
  );

  // Buffer returns errors in the payload (union type) instead of the errors array
  if (data.createPost?.message) {
    throw new Error(`Buffer: ${data.createPost.message}`);
  }
}

// ── List channels ─────────────────────────────────────────────────────────────

const LIST_CHANNELS = /* GraphQL */ `
  query ListChannels($orgId: OrganizationId!) {
    channels(input: { organizationId: $orgId }) {
      id name service displayName
    }
  }
`;

export async function getBufferProfiles(): Promise<
  { id: string; service: string; name: string; displayName?: string; channelEnvEntry: string }[]
> {
  const orgId = (process.env.BUFFER_ORG_ID ?? "").trim();
  if (!apiKey() || !orgId) return [];

  const data = await gql<{
    channels: { id: string; service: string; name: string; displayName?: string }[];
  }>(LIST_CHANNELS, { orgId });

  return (data.channels ?? []).map((c) => ({
    ...c,
    // Convenience value for copying into BUFFER_CHANNELS env var
    channelEnvEntry: `${c.id}:${c.service}`,
  }));
}

// ── Auto-post batch ───────────────────────────────────────────────────────────

/**
 * Auto-post all clips from a finished job to every configured Buffer channel.
 * Each clip becomes one post per channel. Clips are staggered by
 * BUFFER_SCHEDULE_DELAY_MINUTES if set (0 = all post now).
 */
export async function autoPostClipsToBuffer(
  clips: Array<{ id: string; label: string; caption?: string }>,
  ownerId: string,
  appBaseUrl: string,
  log?: { warn(obj: object, msg: string): void },
): Promise<void> {
  if (!isBufferConfigured()) return;

  const channelList = await getChannelsForUser(ownerId);
  if (channelList.length === 0) return;
  const delayMin = Number(process.env.BUFFER_SCHEDULE_DELAY_MINUTES ?? 0);
  const template = ((process.env.BUFFER_CAPTION_TEMPLATE ?? "") || "{caption}").trim();

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const text = template
      .replace("{label}", clip.label)
      .replace("{caption}", clip.caption ?? clip.label);

    // Create a 24-hour share token so Buffer can fetch the video without auth
    let videoUrl: string;
    try {
      const token = await createShareToken(clip.id, ownerId);
      videoUrl = `${appBaseUrl}/api/video/clip-share/${token}`;
    } catch (err) {
      log?.warn({ err, clipId: clip.id }, "Buffer: failed to create share token");
      continue;
    }

    const scheduledAt =
      delayMin > 0 ? new Date(Date.now() + i * delayMin * 60 * 1000) : undefined;

    // Post to each channel independently
    for (const channel of channelList) {
      try {
        await postToBuffer({ channel, text, videoUrl, scheduledAt });
      } catch (err) {
        log?.warn({ err, clipId: clip.id, channelId: channel.id }, "Buffer: failed to post clip");
      }
    }
  }
}
