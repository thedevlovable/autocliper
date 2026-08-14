/**
 * Public YouTube channel discovery.
 *
 * The Data API key is server-only. A channel subscription stores the stable
 * channel id, not a fragile @handle, and the uploads playlist is used for
 * cheap, deterministic new-video polling.
 */

export interface YouTubeChannelInfo {
  id: string;
  title: string;
  uploadsPlaylistId: string | null;
  canonicalUrl: string;
}

export interface YouTubeChannelVideo {
  id: string;
  title: string;
  publishedAt: string;
  url: string;
}

export function isYouTubeChannelConfigured(): boolean {
  return Boolean(process.env.YOUTUBE_API_KEY?.trim());
}

function apiKey(): string {
  const key = process.env.YOUTUBE_API_KEY?.trim();
  if (!key) throw new Error("YouTube channel monitoring is not configured on this server.");
  return key;
}

async function youtubeApi(
  endpoint: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
  for (const [key, value] of Object.entries({ ...params, key: apiKey() })) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    headers: { "User-Agent": "AutoCliper/1.0" },
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const error = body.error as { message?: string } | undefined;
    throw new Error(error?.message || `YouTube API returned HTTP ${response.status}.`);
  }
  return body;
}

function channelLocator(raw: string): { kind: "id" | "handle" | "username" | "custom"; value: string } {
  const input = raw.trim();
  if (!input) throw new Error("Paste a YouTube channel link.");

  if (/^UC[\w-]{20,30}$/.test(input)) return { kind: "id", value: input };

  let parsed: URL;
  try {
    parsed = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    throw new Error("That does not look like a YouTube channel link.");
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
  if (host !== "youtube.com") {
    throw new Error("Paste a youtube.com channel link, not a video link.");
  }

  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts[0]?.startsWith("@")) return { kind: "handle", value: parts[0].slice(1) };
  if (parts[0] === "channel" && /^UC[\w-]{20,30}$/.test(parts[1] ?? "")) {
    return { kind: "id", value: parts[1] };
  }
  if (parts[0] === "user" && parts[1]) return { kind: "username", value: parts[1] };
  if (parts[0] === "c" && parts[1]) return { kind: "custom", value: parts[1] };
  throw new Error("Use a YouTube channel link such as youtube.com/@creator or youtube.com/channel/UC…");
}

export async function resolveYouTubeChannel(raw: string): Promise<YouTubeChannelInfo> {
  const locator = channelLocator(raw);
  const params: Record<string, string> = {
    part: "snippet,contentDetails",
    maxResults: "1",
  };
  if (locator.kind === "id") params.id = locator.value;
  if (locator.kind === "handle") params.forHandle = locator.value;
  if (locator.kind === "username") params.forUsername = locator.value;

  let data: Record<string, unknown>;
  if (locator.kind === "custom") {
    const search = await youtubeApi("search", {
      part: "snippet",
      type: "channel",
      q: locator.value,
      maxResults: "5",
    });
    const items = Array.isArray(search.items) ? search.items as Record<string, unknown>[] : [];
    const exact = items.find((item) => {
      const snippet = item.snippet as { title?: string } | undefined;
      return snippet?.title?.toLowerCase() === locator.value.toLowerCase();
    });
    const chosen = exact ?? items[0];
    const id = (chosen?.snippet as { channelId?: string } | undefined)?.channelId;
    if (!id) throw new Error("That YouTube custom channel link could not be resolved.");
    params.id = id;
    data = await youtubeApi("channels", params);
  } else {
    data = await youtubeApi("channels", params);
  }

  const items = Array.isArray(data.items) ? data.items as Record<string, unknown>[] : [];
  const channel = items[0];
  if (!channel) throw new Error("YouTube channel was not found. Check that the link is public and correct.");
  const snippet = channel.snippet as { title?: string } | undefined;
  const details = channel.contentDetails as { relatedPlaylists?: { uploads?: string } } | undefined;
  const id = String(channel.id ?? "");
  if (!/^UC[\w-]{20,30}$/.test(id)) throw new Error("YouTube returned an invalid channel id.");
  return {
    id,
    title: String(snippet?.title ?? "YouTube channel").slice(0, 200),
    uploadsPlaylistId: details?.relatedPlaylists?.uploads ?? null,
    canonicalUrl: `https://www.youtube.com/channel/${id}`,
  };
}

export async function latestYouTubeChannelVideos(
  channel: YouTubeChannelInfo,
  limit = 15,
): Promise<YouTubeChannelVideo[]> {
  if (!channel.uploadsPlaylistId) return [];
  const data = await youtubeApi("playlistItems", {
    part: "snippet,contentDetails",
    playlistId: channel.uploadsPlaylistId,
    maxResults: String(Math.min(50, Math.max(1, limit))),
  });
  const items = Array.isArray(data.items) ? data.items as Record<string, unknown>[] : [];
  return items.flatMap((item) => {
    const snippet = item.snippet as {
      title?: string; publishedAt?: string; resourceId?: { videoId?: string };
    } | undefined;
    const details = item.contentDetails as { videoId?: string; videoPublishedAt?: string } | undefined;
    const id = details?.videoId ?? snippet?.resourceId?.videoId;
    if (!id) return [];
    const publishedAt = details?.videoPublishedAt ?? snippet?.publishedAt;
    if (!publishedAt || Number.isNaN(Date.parse(publishedAt))) return [];
    return [{
      id,
      title: String(snippet?.title ?? "YouTube video").slice(0, 200),
      publishedAt,
      url: `https://www.youtube.com/watch?v=${id}`,
    }];
  });
}
