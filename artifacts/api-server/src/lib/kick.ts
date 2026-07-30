/**
 * Kick fallback-source resolution, extracted from routes/videoTools.ts so the
 * selection logic is unit-testable with a mocked API function.
 *
 * Kick's Cloudflare blocks Node's fetch by TLS fingerprint (HTTP 403), so the
 * real API caller shells out to curl (see kickApiJson in videoTools.ts). All
 * functions here take that caller as an injected dependency (`KickApiJson`).
 */

export interface KickVideoEntry {
  source?: string;
  is_live?: boolean;
  video?: { uuid?: string; source?: string };
}

/** The injected API caller. Returns parsed JSON, null on soft failure
 *  (timeout, bad JSON), or throws KickBlockedError on an HTTP-level block. */
export type KickApiJson = (apiUrl: string) => Promise<unknown | null>;

/** Thrown when Kick's API answers with a non-2xx status — i.e. Kick is
 *  actively refusing our request (bot blocking), not a transient failure. */
export class KickBlockedError extends Error {
  readonly status: number;
  constructor(status: number, apiUrl: string) {
    super(`Kick API blocked the request (HTTP ${status}) for ${apiUrl}`);
    this.name = "KickBlockedError";
    this.status = status;
  }
}

/** User-facing message when Kick is blocking our server's API requests. */
export const KICK_BLOCKED_MESSAGE =
  "Kick is currently blocking requests from our server, so this video can't be fetched right now. This is usually temporary — please try again in a few minutes.";

/** User-facing message when the video simply couldn't be resolved. */
export const KICK_NOT_FOUND_MESSAGE =
  "Could not download this Kick video. It may be deleted or private — or Kick briefly blocked our server. Please try again in a minute.";

/** Extract the HTTP status from a curl --fail error message, or null when the
 *  failure wasn't an HTTP error (timeout, DNS, etc.).
 *  curl -sS --fail prints: `curl: (22) The requested URL returned error: 403` */
export function curlHttpStatus(message: string): number | null {
  const m = message.match(/returned error:\s*(\d{3})/i);
  return m ? Number(m[1]) : null;
}

/** Parse a kick.com URL into its VOD uuid (if any) and channel slug (if any).
 *  kick.com/video/{uuid} links carry no channel slug. */
export function parseKickUrl(videoUrl: string): { uuid: string | null; channel: string | null } {
  const uuid = videoUrl.match(/\/videos?\/([0-9a-f][0-9a-f-]{20,})/i)?.[1]?.toLowerCase() ?? null;
  const chan = videoUrl.match(/kick\.com\/([^/?#]+)/i)?.[1];
  const channel = chan && !["video", "videos"].includes(chan.toLowerCase()) ? chan : null;
  return { uuid, channel };
}

/** Pick the m3u8 source from a channel videos list for the DOWNLOAD path:
 *  prefer the exact VOD from the URL; else (bare channel link) the live entry. */
export function pickDownloadSource(videos: unknown, uuid: string | null): string {
  const list = Array.isArray(videos) ? (videos as KickVideoEntry[]) : [];
  const match =
    (uuid ? list.find((v) => v.video?.uuid?.toLowerCase() === uuid) : undefined) ??
    (!uuid ? list.find((v) => v.is_live) : undefined);
  return match?.source || match?.video?.source || "";
}

/** Pick the m3u8 source from a channel videos list for the LIVE path:
 *  only `is_live` entries qualify (optionally matched to the URL's uuid). */
export function pickLiveSource(videos: unknown, uuid: string | null): string {
  const list = Array.isArray(videos) ? (videos as KickVideoEntry[]) : [];
  const liveEntry = list.find((v) => v.is_live && (!uuid || v.video?.uuid?.toLowerCase() === uuid));
  return liveEntry?.source || liveEntry?.video?.source || "";
}

/**
 * Resolve the fallback m3u8 source for a Kick URL when yt-dlp has failed.
 * Tries the direct video API (uuid links), then the channel videos list.
 * Throws a user-readable error: KICK_BLOCKED_MESSAGE when every attempt was
 * actively blocked by Kick, otherwise KICK_NOT_FOUND_MESSAGE.
 */
export async function resolveKickFallbackSource(videoUrl: string, api: KickApiJson): Promise<string> {
  const { uuid, channel } = parseKickUrl(videoUrl);
  let blocked = false;
  let attempted = false;

  // Direct video lookup — covers kick.com/video/{uuid} links with no channel slug.
  if (uuid) {
    attempted = true;
    try {
      const v = (await api(`https://kick.com/api/v1/video/${uuid}`)) as { source?: string } | null;
      if (v?.source) return v.source;
    } catch (e) {
      if (e instanceof KickBlockedError) blocked = true;
      else throw e;
    }
  }

  // Channel videos list — matches a uuid VOD or, for bare channel links, the live entry.
  if (channel) {
    attempted = true;
    try {
      const videos = await api(`https://kick.com/api/v2/channels/${channel}/videos?page=1&limit=20`);
      const src = pickDownloadSource(videos, uuid);
      if (src) return src;
      if (videos !== null) blocked = false; // got a real answer — video genuinely missing
    } catch (e) {
      if (e instanceof KickBlockedError) blocked = true;
      else throw e;
    }
  }

  void attempted;
  throw new Error(blocked ? KICK_BLOCKED_MESSAGE : KICK_NOT_FOUND_MESSAGE);
}

/**
 * Resolve the in-progress live recording's m3u8 for a Kick URL, or null when
 * no live source can be found. Blocked responses also yield null — the live
 * path is best-effort and the caller falls through to its normal handling.
 */
export async function resolveKickLiveSrc(videoUrl: string, api: KickApiJson): Promise<string | null> {
  const { uuid, channel } = parseKickUrl(videoUrl);
  let src = "";
  if (channel) {
    try {
      const videos = await api(`https://kick.com/api/v2/channels/${channel}/videos?page=1&limit=20`);
      src = pickLiveSource(videos, uuid);
    } catch (e) {
      if (!(e instanceof KickBlockedError)) throw e;
    }
  }
  // kick.com/video/{uuid} links carry no channel slug — try the direct video API
  if (!src && uuid) {
    try {
      const v = (await api(`https://kick.com/api/v1/video/${uuid}`)) as { source?: string } | null;
      src = v?.source ?? "";
    } catch (e) {
      if (!(e instanceof KickBlockedError)) throw e;
    }
  }
  return src || null;
}
