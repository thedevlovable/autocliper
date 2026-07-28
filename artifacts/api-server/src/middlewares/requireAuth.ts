/**
 * requireAuth — Express middleware that enforces a valid Clerk session.
 *
 * Must be placed AFTER clerkMiddleware() in the middleware chain (configured
 * in app.ts) so that req.auth is already populated.
 *
 * Returns HTTP 401 when no authenticated session is present, allowing the
 * request to proceed otherwise.
 */

import type { Request, Response, NextFunction } from "express";
import { getAuth } from "@clerk/express";

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const auth = getAuth(req);
  const userId = auth?.sessionClaims?.userId || auth?.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  // Attach userId for downstream handlers that want it
  (req as Request & { userId: string }).userId = userId as string;
  next();
}
