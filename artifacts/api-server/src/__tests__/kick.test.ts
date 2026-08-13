/**
 * Unit tests for the Kick fallback pipeline (lib/kick.ts):
 *   - parseKickUrl — uuid / channel-slug extraction
 *   - pickDownloadSource / pickLiveSource — entry-selection logic
 *   - resolveKickFallbackSource — API fallback order, blocked-vs-missing errors
 *   - resolveKickLiveSrc — live-entry selection, direct-video fallback
 *   - curlHttpStatus — curl --fail stderr parsing (the blocked-detection input)
 *
 * The kickApiJson dependency is injected, so no child_process/network mocking
 * is needed — these run fully offline.
 */

import { describe, it, expect, vi } from "vitest";
import {
  KickBlockedError,
  KICK_BLOCKED_MESSAGE,
  KICK_NOT_FOUND_MESSAGE,
  curlHttpStatus,
  isValidKickIvsSrc,
  parseKickUrl,
  pickDownloadSource,
  pickLiveSource,
  resolveKickFallbackSource,
  resolveKickLiveSrc,
  type KickApiJson,
  type KickVideoEntry,
} from "../lib/kick";

const UUID = "0192d3c8-1111-2222-3333-444455556666";
const M3U8 = "https://ivs.example/master.m3u8";

function apiFrom(map: Record<string, unknown | Error>): KickApiJson {
  return vi.fn(async (url: string) => {
    for (const [frag, resp] of Object.entries(map)) {
      if (url.includes(frag)) {
        if (resp instanceof Error) throw resp;
        return resp;
      }
    }
    return null;
  });
}

// ── parseKickUrl ──────────────────────────────────────────────────────────────

describe("parseKickUrl", () => {
  it("extracts uuid from kick.com/video/{uuid} links (no channel slug)", () => {
    const r = parseKickUrl(`https://kick.com/video/${UUID}`);
    expect(r.uuid).toBe(UUID);
    expect(r.channel).toBeNull();
  });

  it("extracts channel + uuid from kick.com/{channel}/videos/{uuid}", () => {
    const r = parseKickUrl(`https://kick.com/xqc/videos/${UUID.toUpperCase()}`);
    expect(r.uuid).toBe(UUID); // lowercased
    expect(r.channel).toBe("xqc");
  });

  it("extracts channel from bare channel links, ignoring query/hash", () => {
    expect(parseKickUrl("https://kick.com/trainwreckstv?tab=videos").channel).toBe("trainwreckstv");
    expect(parseKickUrl("https://kick.com/trainwreckstv#top").channel).toBe("trainwreckstv");
  });

  it("does not treat 'video'/'videos' path roots as channel slugs", () => {
    expect(parseKickUrl(`https://kick.com/videos/${UUID}`).channel).toBeNull();
  });
});

// ── selection logic ───────────────────────────────────────────────────────────

const entries: KickVideoEntry[] = [
  { is_live: false, video: { uuid: "aaaa1111-0000-0000-0000-000000000000", source: "https://ivs.example/old.m3u8" } },
  { is_live: true, source: "https://ivs.example/live.m3u8", video: { uuid: UUID } },
  { is_live: false, video: { uuid: "bbbb2222-0000-0000-0000-000000000000" } },
];

describe("pickDownloadSource", () => {
  it("prefers the exact VOD matching the URL uuid", () => {
    expect(pickDownloadSource(entries, "aaaa1111-0000-0000-0000-000000000000")).toBe("https://ivs.example/old.m3u8");
  });

  it("takes the live entry for bare channel links (no uuid)", () => {
    expect(pickDownloadSource(entries, null)).toBe("https://ivs.example/live.m3u8");
  });

  it("returns '' when the uuid matches an entry without a source", () => {
    expect(pickDownloadSource(entries, "bbbb2222-0000-0000-0000-000000000000")).toBe("");
  });

  it("returns '' for a non-array API response", () => {
    expect(pickDownloadSource({ error: "blocked" }, null)).toBe("");
    expect(pickDownloadSource(null, UUID)).toBe("");
  });
});

describe("pickLiveSource", () => {
  it("only selects is_live entries", () => {
    expect(pickLiveSource(entries, null)).toBe("https://ivs.example/live.m3u8");
    // uuid of a non-live VOD → no live source
    expect(pickLiveSource(entries, "aaaa1111-0000-0000-0000-000000000000")).toBe("");
  });

  it("matches the live entry against the URL uuid when given", () => {
    expect(pickLiveSource(entries, UUID)).toBe("https://ivs.example/live.m3u8");
  });

  it("falls back to nested video.source when the top-level source is missing", () => {
    const l: KickVideoEntry[] = [{ is_live: true, video: { uuid: UUID, source: M3U8 } }];
    expect(pickLiveSource(l, UUID)).toBe(M3U8);
  });
});

// ── resolveKickFallbackSource (downloadKick's API-fallback path) ─────────────

describe("resolveKickFallbackSource", () => {
  it("resolves via the direct video API for uuid links", async () => {
    const api = apiFrom({ [`/api/v1/video/${UUID}`]: { source: M3U8 } });
    await expect(resolveKickFallbackSource(`https://kick.com/video/${UUID}`, api)).resolves.toBe(M3U8);
    expect(api).toHaveBeenCalledTimes(1);
  });

  it("falls back to the channel videos list when the direct lookup is empty", async () => {
    const api = apiFrom({
      "/api/v1/video/": null,
      "/channels/xqc/videos": entries,
    });
    await expect(resolveKickFallbackSource(`https://kick.com/xqc/videos/${UUID}`, api)).resolves.toBe(
      "https://ivs.example/live.m3u8",
    );
  });

  it("uses the is_live entry for bare channel links", async () => {
    const api = apiFrom({ "/channels/xqc/videos": entries });
    await expect(resolveKickFallbackSource("https://kick.com/xqc", api)).resolves.toBe("https://ivs.example/live.m3u8");
  });

  it("throws the blocked message when every API call is blocked", async () => {
    const api: KickApiJson = async (url) => {
      throw new KickBlockedError(403, url);
    };
    await expect(resolveKickFallbackSource(`https://kick.com/xqc/videos/${UUID}`, api)).rejects.toThrow(
      KICK_BLOCKED_MESSAGE,
    );
  });

  it("throws the not-found message when the API answers but has no source", async () => {
    const api = apiFrom({ "/channels/ghost/videos": [] });
    await expect(resolveKickFallbackSource("https://kick.com/ghost", api)).rejects.toThrow(KICK_NOT_FOUND_MESSAGE);
  });

  it("throws not-found (not blocked) when the channel list answers after a blocked direct lookup", async () => {
    const api = apiFrom({
      [`/api/v1/video/${UUID}`]: new KickBlockedError(403, "v1"),
      "/channels/xqc/videos": [],
    });
    await expect(resolveKickFallbackSource(`https://kick.com/xqc/videos/${UUID}`, api)).rejects.toThrow(
      KICK_NOT_FOUND_MESSAGE,
    );
  });

  it("throws not-found on soft failures (timeouts → null) without blocked wording", async () => {
    const api: KickApiJson = async () => null;
    await expect(resolveKickFallbackSource(`https://kick.com/video/${UUID}`, api)).rejects.toThrow(
      KICK_NOT_FOUND_MESSAGE,
    );
  });
});

// ── resolveKickLiveSrc (live-clipping path) ──────────────────────────────────

describe("resolveKickLiveSrc", () => {
  it("returns the is_live entry's source for a bare channel link", async () => {
    const api = apiFrom({ "/channels/xqc/videos": entries });
    await expect(resolveKickLiveSrc("https://kick.com/xqc", api)).resolves.toBe("https://ivs.example/live.m3u8");
  });

  it("falls back to the direct video API for uuid links with no channel slug", async () => {
    const api = apiFrom({ [`/api/v1/video/${UUID}`]: { source: M3U8 } });
    await expect(resolveKickLiveSrc(`https://kick.com/video/${UUID}`, api)).resolves.toBe(M3U8);
  });

  it("returns null when nothing is live and the direct lookup has no source", async () => {
    const api = apiFrom({
      "/channels/xqc/videos": [{ is_live: false, video: { uuid: UUID } }],
      [`/api/v1/video/${UUID}`]: {},
    });
    await expect(resolveKickLiveSrc(`https://kick.com/xqc/videos/${UUID}`, api)).resolves.toBeNull();
  });

  it("returns null (best-effort) when Kick blocks the API", async () => {
    const api: KickApiJson = async (url) => {
      throw new KickBlockedError(403, url);
    };
    await expect(resolveKickLiveSrc(`https://kick.com/xqc/videos/${UUID}`, api)).resolves.toBeNull();
  });

  it("rethrows unexpected (non-blocked) errors", async () => {
    const api: KickApiJson = async () => {
      throw new Error("ECONNRESET");
    };
    await expect(resolveKickLiveSrc("https://kick.com/xqc", api)).rejects.toThrow("ECONNRESET");
  });
});

// ── curlHttpStatus — blocked-detection input parsing ─────────────────────────

describe("curlHttpStatus", () => {
  it("parses curl --fail HTTP-error output", () => {
    expect(curlHttpStatus("curl: (22) The requested URL returned error: 403")).toBe(403);
    expect(curlHttpStatus("Command failed: curl -sS --fail ...\ncurl: (22) The requested URL returned error: 503")).toBe(503);
  });

  it("returns null for non-HTTP failures", () => {
    expect(curlHttpStatus("curl: (28) Operation timed out after 15001 milliseconds")).toBeNull();
    expect(curlHttpStatus("Unexpected token < in JSON at position 0")).toBeNull();
  });
});

// ── isValidKickIvsSrc — SSRF allowlist for the browser-resolved kickSrc hint ──
// The hint is user-controlled input that ends up in the server's downloader,
// so ONLY Kick's own IVS VOD host over https may ever pass.
describe("isValidKickIvsSrc", () => {
  const GOOD =
    "https://stream.kick.com/3c81249a5ce0/ivs/v1/196233775518/AbCdEf/2026/8/10/22/20/xyz/media/hls/master.m3u8";

  it("accepts Kick's IVS VOD playlist URL", () => {
    expect(isValidKickIvsSrc(GOOD)).toBe(true);
  });

  it("accepts an uppercase .M3U8 extension", () => {
    expect(isValidKickIvsSrc("https://stream.kick.com/a/MASTER.M3U8")).toBe(true);
  });

  it("rejects non-string and empty values", () => {
    expect(isValidKickIvsSrc(undefined)).toBe(false);
    expect(isValidKickIvsSrc(null)).toBe(false);
    expect(isValidKickIvsSrc(42 as unknown)).toBe(false);
    expect(isValidKickIvsSrc("")).toBe(false);
  });

  it("rejects http (cleartext) and non-http protocols", () => {
    expect(isValidKickIvsSrc("http://stream.kick.com/a/master.m3u8")).toBe(false);
    expect(isValidKickIvsSrc("file:///etc/passwd")).toBe(false);
  });

  it("rejects every non-Kick host, including lookalikes and internal targets", () => {
    expect(isValidKickIvsSrc("https://evil.com/master.m3u8")).toBe(false);
    expect(isValidKickIvsSrc("https://stream.kick.com.evil.com/master.m3u8")).toBe(false);
    expect(isValidKickIvsSrc("https://kick.com/master.m3u8")).toBe(false);
    expect(isValidKickIvsSrc("https://localhost/master.m3u8")).toBe(false);
    expect(isValidKickIvsSrc("https://169.254.169.254/latest/meta-data/master.m3u8")).toBe(false);
  });

  it("rejects embedded credentials, explicit ports, and non-m3u8 paths", () => {
    expect(isValidKickIvsSrc("https://user:pw@stream.kick.com/master.m3u8")).toBe(false);
    expect(isValidKickIvsSrc("https://stream.kick.com:8443/master.m3u8")).toBe(false);
    expect(isValidKickIvsSrc("https://stream.kick.com/media/playlist.ts")).toBe(false);
    expect(isValidKickIvsSrc("https://stream.kick.com/")).toBe(false);
  });

  it("rejects absurdly long URLs", () => {
    expect(isValidKickIvsSrc("https://stream.kick.com/" + "a".repeat(2100) + "/m.m3u8")).toBe(false);
  });
});
