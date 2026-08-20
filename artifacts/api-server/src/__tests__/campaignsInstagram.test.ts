/**
 * Instagram source for Auto-Pilot campaigns — integration tests.
 *
 * The Zyla Instagram engine is mocked via a global fetch stub — these tests
 * must NEVER hit the paid API (real keys may be exported in the dev env; the
 * stub throws on any unexpected zylalabs call). DB-backed cases run against
 * the real dev database through the full express app (like
 * campaignRetryClip.test.ts) and are skipped without DATABASE_URL.
 *
 * Covered:
 *   - igRelayToken: roundtrip (dotted usernames), expiry, tamper, garbage
 *   - igItemsToFiles/igFileName: oldest-first ordering + caption naming
 *   - detect: explicit instagram kind, auto-detect from a profile link,
 *     videos-only counting, 30-min list cache (no double billing)
 *   - create: items land oldest-first as ig:<user>:<kind>:<id>, canonical
 *     source_url, invalid usernames rejected
 *   - materializer rescan: a NEW reel discovered later jumps the queue
 *     (negative sort_order, posted at the next slot before the backlog)
 *   - PATCH: profile change blocked, other edits still fine
 *   - /ig/relay/:token: streams fresh CDN bytes (no auth cookie — token IS
 *     the auth), 403 on invalid/expired, 404 when media is gone
 */
import { describe, it, expect, afterAll, vi } from "vitest";
import request from "supertest";
import crypto from "crypto";

// Skip real DNS in the SSRF re-check — the literal host allowlist is what we
// exercise here. isSafePublicUrl stays real.
vi.mock("../lib/ssrfGuard", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../lib/ssrfGuard")>();
  return { ...mod, urlResolvesPublic: vi.fn(async () => true) };
});

// Campaign create + materialize need PFM "configured" and account ownership —
// both are provider round-trips in production. Everything else stays real.
vi.mock("../lib/postforme", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../lib/postforme")>();
  return {
    ...mod,
    isPfmConfigured: () => true,
    verifyAccountOwnership: async (_userId: string, ids: string[]) => ({
      owned: ids.map((id) => ({ pfmAccountId: id, platform: "youtube" })),
      foreign: [] as string[],
    }),
  };
});

// Fake keys BEFORE any request: setup.ts deletes ZYLA_API_KEY but the dev env
// may still export ZYLA_IG_API_KEY — never let a real key near a real call.
process.env["ZYLA_API_KEY"] = "zyla-test-key";
process.env["ZYLA_IG_API_KEY"] = "zyla-ig-test-key";
process.env["SESSION_SECRET"] ||= "test-session-secret";

// ── Zyla + CDN fetch stub ─────────────────────────────────────────────────────
// Endpoint ids: posts 23417, reels 23418, post-details 23420, reel-details 23421.
type ZylaReply = { status: number; body: unknown };
const zylaRoutes = new Map<string, ZylaReply>(); // "<epId>:<param>" → reply
let zylaCalls = 0;
const cdnFiles = new Map<string, Buffer>();      // pathname → bytes

function zylaKeyOf(url: string): string | null {
  const m = url.match(/\/api\/\d+\/[^/]*\/(\d+)\/[^?]*\?(?:username|idOrUrl)=([^&]+)/);
  return m ? `${m[1]}:${decodeURIComponent(m[2])}` : null;
}

vi.stubGlobal("fetch", vi.fn(async (input: string | URL): Promise<Response> => {
  const url = String(input);
  if (url.includes("zylalabs.com")) {
    zylaCalls++;
    const key = zylaKeyOf(url);
    const reply = key ? zylaRoutes.get(key) : undefined;
    if (!reply) throw new Error(`unexpected zyla call in test: ${url}`);
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      text: async () => JSON.stringify(reply.body),
    } as unknown as Response;
  }
  if (/cdninstagram\.com|fbcdn\.net/.test(url)) {
    const bytes = cdnFiles.get(new URL(url).pathname);
    if (!bytes) {
      return { ok: false, status: 404, headers: new Headers(), body: null } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "video/mp4", "content-length": String(bytes.length) }),
      body: new ReadableStream({
        start(c) { c.enqueue(new Uint8Array(bytes)); c.close(); },
      }),
    } as unknown as Response;
  }
  throw new Error(`unexpected fetch in test: ${url}`);
}));

const HAS_DB = !!process.env.DATABASE_URL;

const app = (await import("../app")).default;
const { pool } = await import("../lib/db");
const { materializeOne, igItemsToFiles, igFileName } = await import("../routes/campaigns");
const { createIgRelayToken, verifyIgRelayToken } = await import("../lib/igRelayToken");
const { __clearIgCacheForTests } = await import("../routes/instagram");

const TEST_DOMAIN = "ig-autopilot.clipai.dev";
const uniq = () => crypto.randomBytes(5).toString("hex");
const email = (tag: string) => `${tag}-${uniq()}@${TEST_DOMAIN}`;
const todayUtc = () => new Date().toISOString().slice(0, 10);

const vid = (id: string, caption?: string) => ({
  id,
  mediaType: "VIDEO",
  downloadUrl: `https://scontent.cdninstagram.com/v/${id}.mp4`,
  ...(caption ? { caption } : {}),
});
const photo = (id: string) => ({
  id,
  mediaType: "PHOTO",
  downloadUrl: `https://scontent.cdninstagram.com/p/${id}.jpg`,
});
const setLists = (username: string, reels: unknown[], posts: unknown[]): void => {
  zylaRoutes.set(`23418:${username}`, { status: 200, body: { data: reels } });
  zylaRoutes.set(`23417:${username}`, { status: 200, body: { data: posts } });
};

const campaignIds: string[] = [];

/** materializeOne skips silently (SKIP LOCKED) if the dev server's own sweep
 *  briefly holds the campaign row — the dev DB is shared. Retry until the
 *  expected day is consumed so the race can't flake the assertions. */
async function materializeDay(cid: string, now: Date, wantDate: string): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await materializeOne(cid, now);
    const { rows } = await pool!.query(
      `SELECT last_planned_date::text AS d FROM social_campaigns WHERE id = $1`, [cid]);
    if (rows[0]?.d === wantDate) return;
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`campaign ${cid} never planned ${wantDate}`);
}

afterAll(async () => {
  vi.unstubAllGlobals();
  if (pool) {
    if (campaignIds.length > 0) {
      await pool.query(`DELETE FROM social_posts WHERE batch_id = ANY($1)`, [campaignIds]);
      await pool.query(`DELETE FROM social_campaign_items WHERE campaign_id = ANY($1)`, [campaignIds]);
      await pool.query(`DELETE FROM social_campaigns WHERE id = ANY($1)`, [campaignIds]);
    }
    await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`%@${TEST_DOMAIN}`]);
    await pool.end();
  }
});

// ── Pure units (no DB) ────────────────────────────────────────────────────────

describe("igRelayToken", () => {
  it("roundtrips post + reel refs, dotted usernames included", () => {
    for (const ref of [
      { username: "chai.wala_99", kind: "reel" as const, mediaId: "3967266982361430113" },
      { username: "abc.r", kind: "post" as const, mediaId: "DAbc-12_x" },
    ]) {
      const token = createIgRelayToken(ref);
      expect(verifyIgRelayToken(token)).toEqual(ref);
    }
  });

  it("rejects expired tokens (ttl clamps to 30 days min)", () => {
    const ref = { username: "old.timer", kind: "reel" as const, mediaId: "12345" };
    const token = createIgRelayToken(ref, Date.now() - 40 * 24 * 3600 * 1000);
    expect(verifyIgRelayToken(token)).toBeNull();
  });

  it("rejects tampered payloads and garbage", () => {
    const token = createIgRelayToken({ username: "tamper.me", kind: "post", mediaId: "99999" });
    const parts = token.split("~");
    parts[2] = "88888"; // different media id, original signature
    expect(verifyIgRelayToken(parts.join("~"))).toBeNull();
    expect(verifyIgRelayToken(token.slice(0, -4) + "AAAA")).toBeNull();
    expect(verifyIgRelayToken("not-a-token")).toBeNull();
    expect(verifyIgRelayToken("")).toBeNull();
  });

  it("refuses to mint tokens for junk refs", () => {
    expect(() => createIgRelayToken({ username: "bad name!", kind: "post", mediaId: "12345" })).toThrow();
    expect(() => createIgRelayToken({ username: "fine", kind: "post", mediaId: "x" })).toThrow();
  });
});

describe("igItemsToFiles / igFileName", () => {
  it("reverses newest-first lists so campaigns post oldest-first", () => {
    const files = igItemsToFiles("creator", [
      { id: "300", kind: "reel", downloadUrl: "https://x/300.mp4" },       // newest
      { id: "200", kind: "post", downloadUrl: "https://x/200.mp4" },
      { id: "100", kind: "reel", downloadUrl: "https://x/100.mp4" },       // oldest
    ]);
    expect(files.map((f) => f.url)).toEqual([
      "ig:creator:reel:100", "ig:creator:post:200", "ig:creator:reel:300",
    ]);
  });

  it("names items from the caption, stripping tags — else a stable fallback", () => {
    expect(igFileName("creator", {
      id: "1", kind: "reel", downloadUrl: "u",
      caption: "Sunset drone shot over Goa #travel #reels @friend",
    })).toBe("Sunset drone shot over Goa");
    expect(igFileName("creator", { id: "987654321", kind: "reel", downloadUrl: "u", caption: "#fyp" }))
      .toBe("@creator reel 654321");
  });
});

// ── DB-backed flows ───────────────────────────────────────────────────────────

describe.skipIf(!HAS_DB)("Instagram Auto-Pilot (DB)", () => {
  const agent = request.agent(app);
  let userId = "";

  it("setup: account", async () => {
    const r = await agent.post("/api/auth/signup").send({ email: email("ig"), password: "hunter2222!" });
    expect(r.status).toBe(200);
    userId = r.body.user.id;
  });

  it("detect counts VIDEOS only and reuses the cached lists", async () => {
    const u = `campdetect${uniq()}`.slice(0, 28);
    setLists(u, [vid("r2", "Fresh reel about chai"), vid("r1")], [photo("ph1"), vid("p1")]);

    const before = zylaCalls;
    const r1 = await agent.post("/api/social/campaigns/detect")
      .send({ source: `@${u}`, sourceKind: "instagram" });
    expect(r1.status).toBe(200);
    expect(r1.body.ig).toBe(true);
    expect(r1.body.username).toBe(u);
    expect(r1.body.count).toBe(3); // 2 reel videos + 1 feed video, photo skipped
    expect(r1.body.names[0]).toBe("Fresh reel about chai");
    expect(zylaCalls - before).toBe(2); // posts + reels, once each

    // Same profile pasted as a URL, no explicit kind → auto-detected, cache hit.
    const r2 = await agent.post("/api/social/campaigns/detect")
      .send({ source: `https://www.instagram.com/${u}/` });
    expect(r2.status).toBe(200);
    expect(r2.body.ig).toBe(true);
    expect(zylaCalls - before).toBe(2); // no new upstream calls

    const bad = await agent.post("/api/social/campaigns/detect")
      .send({ source: "not a profile!!", sourceKind: "instagram" });
    expect(bad.status).toBe(400);
  });

  it("create ingests items oldest-first with canonical source_url", async () => {
    const u = `campcreate${uniq()}`.slice(0, 28);
    setLists(u, [vid("902", "Newest reel"), vid("901", "Older reel")], []);

    const r = await agent.post("/api/social/campaigns").send({
      source: `@${u}`, sourceKind: "instagram",
      accountIds: ["acc-ig-test"], times: ["23:59"], perSlot: 1,
      startDate: todayUtc(), endDate: todayUtc().slice(0, 8) + "28", // later this month… may equal today
      timezone: "UTC", caption: "", aiCaptions: false, name: "IG repost",
    });
    // endDate guard: build a safe end date instead if the slice trick landed in the past
    if (r.status === 400 && /past|end date/i.test(String(r.body.error))) {
      throw new Error(`date setup bug in test: ${r.body.error}`);
    }
    expect(r.status).toBe(200);
    expect(r.body.detected).toBe(2);
    campaignIds.push(r.body.id);

    const { rows: camp } = await pool!.query(
      `SELECT source_url, source_kind FROM social_campaigns WHERE id = $1`, [r.body.id]);
    expect(camp[0].source_kind).toBe("instagram");
    expect(camp[0].source_url).toBe(`https://www.instagram.com/${u}/`);

    const { rows: items } = await pool!.query(
      `SELECT url, file_name FROM social_campaign_items WHERE campaign_id = $1 ORDER BY sort_order, id`,
      [r.body.id]);
    expect(items.map((i) => i.url)).toEqual([`ig:${u}:reel:901`, `ig:${u}:reel:902`]);
    expect(items[0].file_name).toBe("Older reel");

    // Cleanup any same-day planned rows fast — the dev server's drain shares
    // this database. (kickMaterializer is a no-op under NODE_ENV=test, so
    // there should be none — this is belt and braces.)
    await pool!.query(`DELETE FROM social_posts WHERE batch_id = $1`, [r.body.id]);

    const rejected = await agent.post("/api/social/campaigns").send({
      source: "definitely not instagram", sourceKind: "instagram",
      accountIds: ["acc-ig-test"], times: ["23:59"], perSlot: 1,
      startDate: todayUtc(), endDate: todayUtc(), timezone: "UTC",
    });
    expect(rejected.status).toBe(400);
  });

  it("PATCH blocks profile swaps but allows schedule edits", async () => {
    const cid = campaignIds[0];
    const swap = await agent.patch(`/api/social/campaigns/${cid}`).send({ source: "@someone_else" });
    expect(swap.status).toBe(400);
    expect(String(swap.body.error)).toMatch(/tied to its profile/i);

    const times = await agent.patch(`/api/social/campaigns/${cid}`).send({ times: ["10:00", "18:00"] });
    expect(times.status).toBe(200);
  });

  it("daily rescan discovers a NEW reel and posts it before the backlog", async () => {
    const u = `camprescan${uniq()}`.slice(0, 28);
    const cid = crypto.randomUUID();
    campaignIds.push(cid);
    await pool!.query(
      `INSERT INTO social_campaigns
         (id, user_id, name, source_url, account_ids, times, per_slot,
          start_date, end_date, timezone, caption, ai_captions, source_kind, enabled, status)
       VALUES ($1,$2,'IG rescan',$3,'{acc-ig-test}','{23:58}',1,$4,'2099-12-31','UTC','',FALSE,'instagram',TRUE,'active')`,
      [cid, userId, `https://www.instagram.com/${u}/`, todayUtc()],
    );
    await pool!.query(
      `INSERT INTO social_campaign_items (campaign_id, url, file_name, sort_order)
       VALUES ($1,$2,'old one',0), ($1,$3,'old two',1)`,
      [cid, `ig:${u}:reel:801`, `ig:${u}:reel:802`],
    );
    // The profile NOW lists a brand-new reel on top of the two known ones.
    setLists(u, [vid("803", "Brand new reel"), vid("802"), vid("801")], []);

    await materializeDay(cid, new Date(), todayUtc());

    const { rows: items } = await pool!.query(
      `SELECT url, sort_order, post_row_id FROM social_campaign_items
       WHERE campaign_id = $1 ORDER BY sort_order, id`, [cid]);
    expect(items.map((i) => i.url)).toEqual([
      `ig:${u}:reel:803`, `ig:${u}:reel:801`, `ig:${u}:reel:802`,
    ]);
    expect(items[0].sort_order).toBeLessThan(0); // jumped the queue

    // Exactly one slot today (per_slot 1 × one time) → the NEW reel got it.
    const { rows: posts } = await pool!.query(
      `SELECT media_url, file_name, status FROM social_posts WHERE batch_id = $1`, [cid]);
    expect(posts).toHaveLength(1);
    expect(posts[0].media_url).toBe(`ig:${u}:reel:803`);
    expect(posts[0].file_name).toBe("Brand new reel");
    expect(items[0].post_row_id).not.toBeNull();
    expect(items[1].post_row_id).toBeNull();

    const { rows: camp } = await pool!.query(
      `SELECT last_planned_date::text AS d, status FROM social_campaigns WHERE id = $1`, [cid]);
    expect(camp[0].d).toBe(todayUtc());
    expect(camp[0].status).toBe("active");

    // Remove queued rows immediately — shared dev DB, see note above.
    await pool!.query(`DELETE FROM social_posts WHERE batch_id = $1`, [cid]);
  });

  it("relay streams fresh CDN bytes without auth; 403/404 on bad tokens/media", async () => {
    const u = `camprelay${uniq()}`.slice(0, 28);
    const bytes = Buffer.from("MP4-FAKE-BYTES-FOR-RELAY");
    setLists(u, [vid("70701")], []);
    cdnFiles.set("/v/70701.mp4", bytes);

    const token = createIgRelayToken({ username: u, kind: "reel", mediaId: "70701" });
    // No agent — the posting provider has no session cookie. Token IS the auth.
    const ok = await request(app).get(`/api/ig/relay/${token}`);
    expect(ok.status).toBe(200);
    expect(ok.headers["content-type"]).toContain("video/mp4");
    expect(ok.headers["content-disposition"]).toContain("attachment");
    expect(ok.headers["content-disposition"]).toContain(`instagram_${u}_70701`);
    expect(Buffer.from(ok.body).equals(bytes)).toBe(true);

    const bad = await request(app).get("/api/ig/relay/totally-bogus");
    expect(bad.status).toBe(403);

    const expired = createIgRelayToken(
      { username: u, kind: "reel", mediaId: "70701" }, Date.now() - 40 * 24 * 3600 * 1000);
    expect((await request(app).get(`/api/ig/relay/${expired}`)).status).toBe(403);

    // Media vanished: lists empty, details 404 → 404 with a clear code.
    const u2 = `camprelgone${uniq()}`.slice(0, 28);
    setLists(u2, [], []);
    zylaRoutes.set("23421:777777", { status: 404, body: { error: "not found" } });
    const gone = createIgRelayToken({ username: u2, kind: "reel", mediaId: "777777" });
    const r404 = await request(app).get(`/api/ig/relay/${gone}`);
    expect(r404.status).toBe(404);
    expect(r404.body.code).toBe("IG_MEDIA_GONE");
  });

  it("an up-to-date profile never goes 'exhausted' — it keeps watching daily", async () => {
    const u = `campalive${uniq()}`.slice(0, 28);
    const cid = crypto.randomUUID();
    campaignIds.push(cid);
    const day1 = new Date();
    const dayAfter = (n: number) => new Date(day1.getTime() + n * 24 * 3600 * 1000);
    await pool!.query(
      `INSERT INTO social_campaigns
         (id, user_id, name, source_url, account_ids, times, per_slot,
          start_date, end_date, timezone, caption, ai_captions, source_kind, enabled, status)
       VALUES ($1,$2,'IG alive',$3,'{acc-ig-test}','{23:57}',1,$4,'2099-12-31','UTC','',FALSE,'instagram',TRUE,'active')`,
      [cid, userId, `https://www.instagram.com/${u}/`, todayUtc()],
    );
    await pool!.query(
      `INSERT INTO social_campaign_items (campaign_id, url, file_name, sort_order)
       VALUES ($1,$2,'only one',0)`,
      [cid, `ig:${u}:reel:601`],
    );
    setLists(u, [vid("601")], []); // day 1: rescan sees nothing new

    // Day 1 plans the LAST known item — the campaign must stay active
    // (a folder campaign would flip to 'exhausted' here and never rescan).
    await materializeDay(cid, day1, todayUtc());
    let camp = (await pool!.query(
      `SELECT status FROM social_campaigns WHERE id = $1`, [cid])).rows[0];
    expect(camp.status).toBe("active");
    await pool!.query(`DELETE FROM social_posts WHERE batch_id = $1`, [cid]);

    // Day 2: a reel appeared overnight. Clear the 30-min list cache the way
    // real elapsed time would, then materialize "tomorrow" — the new reel
    // must be discovered and get the day's slot.
    setLists(u, [vid("602", "Overnight reel"), vid("601")], []);
    __clearIgCacheForTests();
    await materializeDay(cid, dayAfter(1), dayAfter(1).toISOString().slice(0, 10));
    const { rows: posts } = await pool!.query(
      `SELECT media_url FROM social_posts WHERE batch_id = $1`, [cid]);
    expect(posts.map((p) => p.media_url)).toEqual([`ig:${u}:reel:602`]);
    camp = (await pool!.query(
      `SELECT status FROM social_campaigns WHERE id = $1`, [cid])).rows[0];
    expect(camp.status).toBe("active"); // backlog empty again — still watching
    await pool!.query(`DELETE FROM social_posts WHERE batch_id = $1`, [cid]);

    // Day 3: nothing new — the day is consumed quietly, no posts, still active.
    __clearIgCacheForTests();
    await materializeDay(cid, dayAfter(2), dayAfter(2).toISOString().slice(0, 10));
    camp = (await pool!.query(
      `SELECT status, last_planned_date::text AS d FROM social_campaigns WHERE id = $1`, [cid])).rows[0];
    expect(camp.status).toBe("active");
    expect(camp.d).toBe(dayAfter(2).toISOString().slice(0, 10));
    const n = (await pool!.query(
      `SELECT COUNT(*)::int AS n FROM social_posts WHERE batch_id = $1`, [cid])).rows[0].n;
    expect(n).toBe(0);
  });
});
