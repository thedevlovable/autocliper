/**
 * YouTube cookies management routes.
 *
 * POST   /ytdlp/cookies         — upload/paste a cookies.txt (body: { cookies: string })
 * GET    /ytdlp/cookies/status  — { configured, source, youtubeCookieCount, updatedAt }
 * DELETE /ytdlp/cookies         — remove uploaded cookies
 *
 * Cookie contents are never echoed back in any response.
 */
import { Router, type IRouter } from "express";
import type { Request, Response } from "express";
import { getAuth } from "@clerk/express";
import {
  saveCookies,
  deleteCookies,
  getCookieStatus,
  restoreCookiesFromStorage,
} from "../lib/cookieStore";

const router: IRouter = Router();

// Restore persisted cookies once at startup (async, non-blocking).
restoreCookiesFromStorage().catch((err: unknown) =>
  console.warn("[cookies] startup restore error:", (err as Error).message),
);

// Same auth guard pattern as ytdlp.ts — enforced only when Clerk is configured.
function requireAuth(req: Request, res: Response): boolean {
  if (!process.env.CLERK_SECRET_KEY) return true;
  let auth;
  try {
    auth = getAuth(req);
  } catch {
    res.status(401).json({ error: "Session expired — please refresh and try again", code: "SESSION_EXPIRED" });
    return false;
  }
  const userId = auth?.sessionClaims?.userId || auth?.userId;
  if (!userId) {
    res.status(401).json({ error: "Session expired — please refresh and try again", code: "SESSION_EXPIRED" });
    return false;
  }
  return true;
}

router.get("/ytdlp/cookies/status", (req, res): void => {
  if (!requireAuth(req, res)) return;
  res.json(getCookieStatus());
});

router.post("/ytdlp/cookies", async (req, res): Promise<void> => {
  if (!requireAuth(req, res)) return;

  const { cookies } = req.body as { cookies?: string };
  if (!cookies || typeof cookies !== "string") {
    res.status(400).json({ error: "Missing required field: cookies (cookies.txt content)" });
    return;
  }

  const result = await saveCookies(cookies);
  if (!result.ok) {
    res.status(422).json({ error: result.error, code: "INVALID_COOKIES" });
    return;
  }

  req.log.info({ youtubeCookieCount: result.youtubeCookieCount, persisted: result.persisted }, "YouTube cookies saved");
  res.json({
    ok: true,
    youtubeCookieCount: result.youtubeCookieCount,
    persisted: result.persisted,
    status: getCookieStatus(),
  });
});

router.delete("/ytdlp/cookies", async (req, res): Promise<void> => {
  if (!requireAuth(req, res)) return;
  await deleteCookies();
  req.log.info("YouTube cookies removed");
  res.json({ ok: true, status: getCookieStatus() });
});

export default router;
