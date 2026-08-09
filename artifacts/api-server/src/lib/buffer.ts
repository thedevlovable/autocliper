/**
 * Buffer social-media posting integration.
 *
 * Required env vars:
 *   BUFFER_API_KEY          – Personal Access Token from publish.buffer.com/settings/api
 *   BUFFER_PROFILE_IDS      – Comma-separated channel IDs to post to (e.g. "abc123,def456")
 *
 * Optional env vars:
 *   BUFFER_SCHEDULE_DELAY_MINUTES – Minutes between each clip when scheduling (default 0 = post now)
 *   BUFFER_CAPTION_TEMPLATE       – Caption template; {label} and {caption} are replaced
 *                                   (default: "{caption}")
 */

import { createShareToken } from "./clipShareToken";

const BUFFER_API = "https://api.bufferapp.com/1";

export function isBufferConfigured(): boolean {
  const key = (process.env.BUFFER_API_KEY ?? "").trim();
  const ids = (process.env.BUFFER_PROFILE_IDS ?? "").trim();
  return key.length > 0 && ids.length > 0;
}

function profileIds(): string[] {
  return (process.env.BUFFER_PROFILE_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface BufferPostOptions {
  text: string;
  videoUrl: string;
  thumbnailUrl?: string;
  /** If given, schedule for this exact time; otherwise post immediately. */
  scheduledAt?: Date;
}

/**
 * Create one Buffer update (one social post) with a video URL.
 * Throws on API error so callers can log / suppress.
 */
export async function postToBuffer(opts: BufferPostOptions): Promise<void> {
  const apiKey = (process.env.BUFFER_API_KEY ?? "").trim();
  const ids = profileIds();
  if (!apiKey || ids.length === 0) return;

  const body = new URLSearchParams();
  for (const id of ids) body.append("profile_ids[]", id);
  body.set("text", opts.text);
  body.set("media[video]", opts.videoUrl);
  if (opts.thumbnailUrl) body.set("media[thumbnail]", opts.thumbnailUrl);

  if (opts.scheduledAt) {
    body.set("scheduled_at", opts.scheduledAt.toISOString());
  } else {
    body.set("now", "true");
  }

  const res = await fetch(`${BUFFER_API}/updates/create.json`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => res.statusText);
    throw new Error(`Buffer API ${res.status}: ${txt}`);
  }
}

/**
 * List all Buffer profiles/channels connected to this API key.
 * Used by the admin panel to discover profile IDs.
 */
export async function getBufferProfiles(): Promise<
  { id: string; service: string; service_username: string; formatted_username: string }[]
> {
  const apiKey = (process.env.BUFFER_API_KEY ?? "").trim();
  if (!apiKey) return [];

  const res = await fetch(`${BUFFER_API}/profiles.json`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => res.statusText);
    throw new Error(`Buffer API ${res.status}: ${txt}`);
  }
  return res.json() as Promise<{ id: string; service: string; service_username: string; formatted_username: string }[]>;
}

/**
 * Auto-post a batch of clips to Buffer after a job completes.
 *
 * Each clip becomes one social media post. A temporary 24-hour share token
 * is created for each clip so Buffer can fetch the video without user auth.
 *
 * If BUFFER_SCHEDULE_DELAY_MINUTES > 0, each successive clip is staggered
 * by that many minutes so they don't all land at the same time.
 */
export async function autoPostClipsToBuffer(
  clips: Array<{ id: string; label: string; caption?: string }>,
  ownerId: string,
  appBaseUrl: string,
  log?: { warn(obj: object, msg: string): void },
): Promise<void> {
  if (!isBufferConfigured()) return;

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

    try {
      await postToBuffer({ text, videoUrl, scheduledAt });
    } catch (err) {
      log?.warn({ err, clipId: clip.id }, "Buffer: failed to post clip");
      // Continue with remaining clips even if one fails
    }
  }
}
