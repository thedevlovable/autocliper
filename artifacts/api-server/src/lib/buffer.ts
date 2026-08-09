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
  return apiKey().length > 0 && channels().length > 0;
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

  const channelList = channels();
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
