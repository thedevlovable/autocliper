/**
 * Integration test: GET /ytdlp/file/:jobId auth guard
 *
 * Verifies that:
 *  1. The endpoint returns 401 SESSION_EXPIRED (not the file) when no valid
 *     Clerk session is present — even when the jobId format looks valid.
 *  2. When auth passes, the endpoint proceeds to the job lookup (returning 404
 *     for a non-existent job, not a 401).
 *
 * @clerk/express is mocked so the test runs without a live Clerk service.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import * as http from "http";

// ── Mock @clerk/express before any route module is imported ───────────────────
vi.mock("@clerk/express", () => ({
  clerkMiddleware:
    () =>
    (_req: unknown, _res: unknown, next: () => void) =>
      next(),
  getAuth: vi.fn(),
}));

// Import getAuth *after* the mock is declared so we get the mocked version.
import { getAuth } from "@clerk/express";
import ytdlpRouter from "../routes/ytdlp.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function startServer(): Promise<{ server: http.Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use(ytdlpRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address() as { port: number };
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function stopServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /ytdlp/file/:jobId — auth guard", () => {
  let server: http.Server;
  let baseUrl: string;
  const VALID_JOB_ID = "12345678-1234-1234-1234-123456789abc";

  beforeAll(async () => {
    // Presence of CLERK_SECRET_KEY triggers the auth check inside the handler.
    process.env.CLERK_SECRET_KEY = "test-clerk-secret-key";
    ({ server, baseUrl } = await startServer());
  });

  afterAll(async () => {
    delete process.env.CLERK_SECRET_KEY;
    await stopServer(server);
  });

  it("returns 401 SESSION_EXPIRED when getAuth returns no userId", async () => {
    vi.mocked(getAuth).mockReturnValue({ userId: null } as ReturnType<typeof getAuth>);

    const res = await fetch(`${baseUrl}/ytdlp/file/${VALID_JOB_ID}`);
    const body = (await res.json()) as { error?: string; code?: string };

    expect(res.status).toBe(401);
    expect(body.code).toBe("SESSION_EXPIRED");
    expect(body.error).toMatch(/session expired/i);
  });

  it("does not serve the file without auth even when jobId format is valid", async () => {
    // getAuth returns an empty auth object — no userId
    vi.mocked(getAuth).mockReturnValue({} as ReturnType<typeof getAuth>);

    const res = await fetch(`${baseUrl}/ytdlp/file/${VALID_JOB_ID}`);

    // Auth guard must fire *before* the job map lookup, so we get 401, not 404.
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("SESSION_EXPIRED");
  });

  it("returns 401 SESSION_EXPIRED when getAuth throws (e.g. malformed token)", async () => {
    vi.mocked(getAuth).mockImplementation(() => {
      throw new Error("token verification failed");
    });

    const res = await fetch(`${baseUrl}/ytdlp/file/${VALID_JOB_ID}`);
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(401);
    expect(body.code).toBe("SESSION_EXPIRED");
  });

  it("proceeds past auth (returns 404 not 401) when a valid session is present", async () => {
    vi.mocked(getAuth).mockReturnValue({
      userId: "user_test_123",
      sessionClaims: { userId: "user_test_123" },
    } as unknown as ReturnType<typeof getAuth>);

    // Use a UUID that will never exist in the jobs map
    const res = await fetch(`${baseUrl}/ytdlp/file/00000000-0000-0000-0000-000000000000`);

    // Auth passed → job lookup → 404 because job doesn't exist.
    // This proves the file endpoint is reachable with valid auth.
    expect(res.status).toBe(404);
  });
});
