/**
 * Integration test: auth guards on ytdlp endpoints
 *
 * Verifies that:
 *  1. GET /ytdlp/file/:jobId returns 401 SESSION_EXPIRED without a valid session.
 *  2. POST /ytdlp/download returns 401 SESSION_EXPIRED without a valid session.
 *  3. GET /ytdlp/progress/:jobId returns 401 SESSION_EXPIRED without a valid session.
 *  4. Each endpoint proceeds past auth when a valid session is present.
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

// ── Shared server across all describe blocks ──────────────────────────────────

let server: http.Server;
let baseUrl: string;
const VALID_JOB_ID = "12345678-1234-1234-1234-123456789abc";

// ── GET /ytdlp/file/:jobId ────────────────────────────────────────────────────

describe("GET /ytdlp/file/:jobId — auth guard", () => {
  beforeAll(async () => {
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
    vi.mocked(getAuth).mockReturnValue({} as ReturnType<typeof getAuth>);

    const res = await fetch(`${baseUrl}/ytdlp/file/${VALID_JOB_ID}`);

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

    const res = await fetch(`${baseUrl}/ytdlp/file/00000000-0000-0000-0000-000000000000`);

    expect(res.status).toBe(404);
  });
});

// ── POST /ytdlp/download ──────────────────────────────────────────────────────

describe("POST /ytdlp/download — auth guard", () => {
  beforeAll(async () => {
    process.env.CLERK_SECRET_KEY = "test-clerk-secret-key";
    ({ server, baseUrl } = await startServer());
  });

  afterAll(async () => {
    delete process.env.CLERK_SECRET_KEY;
    await stopServer(server);
  });

  it("returns 401 SESSION_EXPIRED when getAuth returns no userId", async () => {
    vi.mocked(getAuth).mockReturnValue({ userId: null } as ReturnType<typeof getAuth>);

    const res = await fetch(`${baseUrl}/ytdlp/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }),
    });
    const body = (await res.json()) as { error?: string; code?: string };

    expect(res.status).toBe(401);
    expect(body.code).toBe("SESSION_EXPIRED");
    expect(body.error).toMatch(/session expired/i);
  });

  it("returns 401 SESSION_EXPIRED when getAuth returns empty object", async () => {
    vi.mocked(getAuth).mockReturnValue({} as ReturnType<typeof getAuth>);

    const res = await fetch(`${baseUrl}/ytdlp/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }),
    });
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(401);
    expect(body.code).toBe("SESSION_EXPIRED");
  });

  it("returns 401 SESSION_EXPIRED when getAuth throws", async () => {
    vi.mocked(getAuth).mockImplementation(() => {
      throw new Error("token verification failed");
    });

    const res = await fetch(`${baseUrl}/ytdlp/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }),
    });
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(401);
    expect(body.code).toBe("SESSION_EXPIRED");
  });

  it("proceeds past auth (returns 400 not 401) when a valid session is present but url is missing", async () => {
    // Authenticated but no url body — should hit input validation, not auth.
    vi.mocked(getAuth).mockReturnValue({
      userId: "user_test_123",
      sessionClaims: { userId: "user_test_123" },
    } as unknown as ReturnType<typeof getAuth>);

    const res = await fetch(`${baseUrl}/ytdlp/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    // Auth passed → input validation → 400 (missing url), proving endpoint is reachable.
    expect(res.status).toBe(400);
  });
});

// ── GET /ytdlp/progress/:jobId ────────────────────────────────────────────────

describe("GET /ytdlp/progress/:jobId — auth guard", () => {
  beforeAll(async () => {
    process.env.CLERK_SECRET_KEY = "test-clerk-secret-key";
    ({ server, baseUrl } = await startServer());
  });

  afterAll(async () => {
    delete process.env.CLERK_SECRET_KEY;
    await stopServer(server);
  });

  it("returns 401 SESSION_EXPIRED when getAuth returns no userId", async () => {
    vi.mocked(getAuth).mockReturnValue({ userId: null } as ReturnType<typeof getAuth>);

    const res = await fetch(`${baseUrl}/ytdlp/progress/${VALID_JOB_ID}`);
    const body = (await res.json()) as { error?: string; code?: string };

    expect(res.status).toBe(401);
    expect(body.code).toBe("SESSION_EXPIRED");
    expect(body.error).toMatch(/session expired/i);
  });

  it("returns 401 SESSION_EXPIRED when getAuth returns empty object", async () => {
    vi.mocked(getAuth).mockReturnValue({} as ReturnType<typeof getAuth>);

    const res = await fetch(`${baseUrl}/ytdlp/progress/${VALID_JOB_ID}`);
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(401);
    expect(body.code).toBe("SESSION_EXPIRED");
  });

  it("returns 401 SESSION_EXPIRED when getAuth throws", async () => {
    vi.mocked(getAuth).mockImplementation(() => {
      throw new Error("token verification failed");
    });

    const res = await fetch(`${baseUrl}/ytdlp/progress/${VALID_JOB_ID}`);
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(401);
    expect(body.code).toBe("SESSION_EXPIRED");
  });

  it("proceeds past auth (returns 404 not 401) when a valid session is present", async () => {
    vi.mocked(getAuth).mockReturnValue({
      userId: "user_test_123",
      sessionClaims: { userId: "user_test_123" },
    } as unknown as ReturnType<typeof getAuth>);

    // Non-existent job — auth passes, then job lookup returns 404.
    const res = await fetch(`${baseUrl}/ytdlp/progress/00000000-0000-0000-0000-000000000000`);

    expect(res.status).toBe(404);
  });
});
