/**
 * Buffer OAuth 2.0 routes — per-user Buffer account connections.
 *
 * Required env vars (set in Buffer API settings → App Clients):
 *   BUFFER_CLIENT_ID     – OAuth app client ID
 *   BUFFER_CLIENT_SECRET – OAuth app client secret
 *   PUBLIC_APP_URL       – e.g. https://autocliper.pro  (used to build redirect_uri)
 *
 * Flow:
 *   1. GET  /api/auth/buffer          → redirects to Buffer OAuth page
 *   2. GET  /api/auth/buffer/callback → exchanges code, saves token, redirects to /buffer
 *   3. DELETE /api/auth/buffer        → disconnect (delete token + channels)
 *   4. POST /api/auth/buffer/sync     → re-sync channels from user's Buffer account
 */

import { Router, type Request } from "express";
import crypto from "crypto";
import { requireUser } from "../middlewares/sessionAuth";
import { requireDb } from "../lib/db";
import { fetchAndSaveUserChannels } from "../lib/buffer";

const router = Router();

function buildRedirectUri(req: Request): string {
  const base = (process.env.PUBLIC_APP_URL ?? "").trim().replace(/\/$/, "")
    || `https://${req.hostname}`;
  return `${base}/api/auth/buffer/callback`;
}

// ── GET /auth/buffer ── initiate OAuth ────────────────────────────────────────
router.get("/auth/buffer", requireUser, async (req, res): Promise<void> => {
  const clientId = (process.env.BUFFER_CLIENT_ID ?? "").trim();
  if (!clientId) {
    res.status(503).json({ error: "Buffer OAuth not configured — BUFFER_CLIENT_ID is missing" });
    return;
  }
  const userId = req.currentUser!.id;
  const state = crypto.randomUUID();
  try {
    await requireDb().query(
      `INSERT INTO buffer_oauth_states (state, user_id, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '10 minutes')`,
      [state, userId],
    );
  } catch {
    res.status(500).json({ error: "Could not create OAuth state" });
    return;
  }
  const url = new URL("https://bufferapp.com/oauth2/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", buildRedirectUri(req));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  res.redirect(url.toString());
});

// ── GET /auth/buffer/callback ── OAuth callback ───────────────────────────────
router.get("/auth/buffer/callback", async (req, res): Promise<void> => {
  const { code, state, error: oauthErr } = req.query as Record<string, string>;

  if (oauthErr || !code || !state) {
    res.redirect("/buffer?error=access_denied");
    return;
  }

  // Verify state (atomic DELETE prevents replay attacks)
  let userId: string;
  try {
    const { rows } = await requireDb().query<{ user_id: string }>(
      `DELETE FROM buffer_oauth_states
       WHERE state = $1 AND expires_at > NOW() RETURNING user_id`,
      [state],
    );
    if (rows.length === 0) { res.redirect("/buffer?error=invalid_state"); return; }
    userId = rows[0].user_id;
  } catch { res.redirect("/buffer?error=db_error"); return; }

  // Exchange authorization code for access token
  let accessToken: string;
  try {
    const tokenRes = await fetch("https://api.buffer.com/1/oauth2/token.json", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id:     process.env.BUFFER_CLIENT_ID ?? "",
        client_secret: process.env.BUFFER_CLIENT_SECRET ?? "",
        redirect_uri:  buildRedirectUri(req),
        code,
        grant_type:    "authorization_code",
      }).toString(),
    });
    const json = await tokenRes.json() as { access_token?: string; error?: string };
    if (!json.access_token) { res.redirect("/buffer?error=no_token"); return; }
    accessToken = json.access_token;
  } catch { res.redirect("/buffer?error=token_exchange_failed"); return; }

  // Persist token + sync channels
  try {
    await requireDb().query(
      `INSERT INTO user_buffer_tokens (user_id, access_token, connected_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id) DO UPDATE SET access_token = $2, connected_at = NOW()`,
      [userId, accessToken],
    );
    await fetchAndSaveUserChannels(userId, accessToken);
  } catch { res.redirect("/buffer?error=sync_failed"); return; }

  res.redirect("/buffer?connected=1");
});

// ── DELETE /auth/buffer ── disconnect ─────────────────────────────────────────
router.delete("/auth/buffer", requireUser, async (req, res): Promise<void> => {
  const userId = req.currentUser!.id;
  try {
    await requireDb().query(`DELETE FROM user_buffer_tokens WHERE user_id = $1`, [userId]);
    await requireDb().query(`DELETE FROM user_buffer_own_channels WHERE user_id = $1`, [userId]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── POST /auth/buffer/sync ── re-sync channels ────────────────────────────────
router.post("/auth/buffer/sync", requireUser, async (req, res): Promise<void> => {
  const userId = req.currentUser!.id;
  try {
    const { rows } = await requireDb().query<{ access_token: string }>(
      `SELECT access_token FROM user_buffer_tokens WHERE user_id = $1`, [userId],
    );
    if (rows.length === 0) { res.status(400).json({ error: "Buffer not connected" }); return; }
    const ids = await fetchAndSaveUserChannels(userId, rows[0].access_token);
    res.json({ ok: true, channelCount: ids.length });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
