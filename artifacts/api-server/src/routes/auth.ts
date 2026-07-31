/**
 * Account routes — email + password auth with server-side sessions.
 *
 *   POST /auth/signup   { email, password, name? }
 *   POST /auth/login    { email, password }
 *   POST /auth/logout
 *   GET  /auth/me       → { user | null }
 */
import { Router, type IRouter, type Request } from "express";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { pool } from "../lib/db";
import {
  SIGNUP_BONUS_CREDITS,
  grantTopup,
  refreshPlanState,
  toPublicUser,
  type DbUser,
} from "../lib/billing";
import { isBootstrapAdminEmail, SESSION_COOKIE_NAME } from "../middlewares/sessionAuth";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts — please wait a few minutes and try again." },
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function noDb(res: { status: (n: number) => { json: (b: unknown) => void } }): void {
  res.status(503).json({ error: "Accounts are not available — database is not configured." });
}

function regenerateSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
}

function saveSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.save((err) => (err ? reject(err) : resolve()));
  });
}

// ── POST /auth/signup ────────────────────────────────────────────────────────
router.post("/auth/signup", authLimiter, async (req, res): Promise<void> => {
  if (!pool) { noDb(res); return; }
  const { email, password, name } = (req.body ?? {}) as {
    email?: string; password?: string; name?: string;
  };
  const cleanEmail = (email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(cleanEmail) || cleanEmail.length > 254) {
    res.status(400).json({ error: "Please enter a valid email address." });
    return;
  }
  if (!password || password.length < 8 || password.length > 200) {
    res.status(400).json({ error: "Password must be at least 8 characters." });
    return;
  }
  const cleanName = (name ?? "").trim().slice(0, 80) || null;

  try {
    const existing = await pool.query(`SELECT 1 FROM users WHERE lower(email) = $1`, [cleanEmail]);
    if (existing.rowCount) {
      res.status(409).json({ error: "An account with this email already exists — try logging in." });
      return;
    }
    const id = `usr_${crypto.randomBytes(9).toString("base64url")}`;
    const hash = await bcrypt.hash(password, 10);
    const role = isBootstrapAdminEmail(cleanEmail) ? "admin" : "user";
    const { rows } = await pool.query<DbUser>(
      `INSERT INTO users (id, email, password_hash, name, role) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [id, cleanEmail, hash, cleanName, role],
    );
    let user = rows[0];
    if (SIGNUP_BONUS_CREDITS > 0) {
      user = await grantTopup(id, SIGNUP_BONUS_CREDITS, "signup_bonus");
    }
    await regenerateSession(req);
    req.session.userId = id;
    await saveSession(req);
    logger.info({ userId: id }, "account created");
    res.json({ user: toPublicUser(user) });
  } catch (err) {
    // Unique-index race → same friendly message
    if ((err as { code?: string }).code === "23505") {
      res.status(409).json({ error: "An account with this email already exists — try logging in." });
      return;
    }
    logger.error({ err }, "signup failed");
    res.status(500).json({ error: "Could not create the account. Please try again." });
  }
});

// ── POST /auth/login ─────────────────────────────────────────────────────────
router.post("/auth/login", authLimiter, async (req, res): Promise<void> => {
  if (!pool) { noDb(res); return; }
  const { email, password } = (req.body ?? {}) as { email?: string; password?: string };
  const cleanEmail = (email ?? "").trim().toLowerCase();
  if (!cleanEmail || !password) {
    res.status(400).json({ error: "Email and password are required." });
    return;
  }
  try {
    const { rows } = await pool.query<DbUser>(
      `SELECT * FROM users WHERE lower(email) = $1`,
      [cleanEmail],
    );
    const row = rows[0];
    const ok = row?.password_hash ? await bcrypt.compare(password, row.password_hash) : false;
    if (!row || !ok) {
      res.status(401).json({ error: "Wrong email or password." });
      return;
    }
    if (row.status === "disabled") {
      res.status(403).json({ error: "This account has been disabled. Contact support.", code: "ACCOUNT_DISABLED" });
      return;
    }
    // Bootstrap admins by email list (works for accounts created before the list was set)
    if (row.role !== "admin" && isBootstrapAdminEmail(cleanEmail)) {
      await pool.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [row.id]);
    }
    await regenerateSession(req);
    req.session.userId = row.id;
    await saveSession(req);
    const fresh = (await refreshPlanState(row.id)) ?? row;
    res.json({ user: toPublicUser(fresh) });
  } catch (err) {
    logger.error({ err }, "login failed");
    res.status(500).json({ error: "Could not log in. Please try again." });
  }
});

// ── Password reset ───────────────────────────────────────────────────────────
const RESET_TTL_MS = 30 * 60 * 1000; // 30 minutes

function sha256(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

/** Where the reset link should point — the frontend origin the request came from. */
function appOrigin(req: Request): string {
  const explicit = process.env.APP_BASE_URL?.replace(/\/$/, "");
  if (explicit) return explicit;
  const origin = req.get("origin") || req.get("referer");
  if (origin) {
    try { return new URL(origin).origin; } catch { /* fall through */ }
  }
  const host = req.get("x-forwarded-host") || req.get("host") || "localhost";
  const proto = req.get("x-forwarded-proto") || "https";
  return `${proto}://${host.split(",")[0].trim()}`;
}

// POST /auth/forgot-password { email }
router.post("/auth/forgot-password", authLimiter, async (req, res): Promise<void> => {
  if (!pool) { noDb(res); return; }
  const { email } = (req.body ?? {}) as { email?: string };
  const cleanEmail = (email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(cleanEmail)) {
    res.status(400).json({ error: "Please enter a valid email address." });
    return;
  }
  // Same reply whether or not the account exists — no account enumeration.
  const generic = { ok: true, message: "If an account exists for that email, a reset link is on its way." };
  try {
    const { rows } = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM users WHERE lower(email) = $1`,
      [cleanEmail],
    );
    const user = rows[0];
    if (!user || user.status === "disabled") { res.json(generic); return; }

    const token = crypto.randomBytes(32).toString("base64url");
    // Invalidate earlier unused tokens so only the newest link works.
    await pool.query(
      `UPDATE password_resets SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL`,
      [user.id],
    );
    await pool.query(
      `INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
      [user.id, sha256(token), new Date(Date.now() + RESET_TTL_MS)],
    );

    const link = `${appOrigin(req)}/reset-password?token=${token}`;
    const { sendEmail } = await import("../lib/mailer");
    await sendEmail({
      to: cleanEmail,
      subject: "Reset your AutoCliper password",
      text: `Someone (hopefully you) asked to reset your AutoCliper password.\n\nReset it here (link expires in 30 minutes):\n${link}\n\nIf you didn't ask for this, you can ignore this email — your password is unchanged.`,
      html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px">
  <h2 style="margin:0 0 12px">Reset your AutoCliper password</h2>
  <p style="color:#444">Someone (hopefully you) asked to reset your password. This link expires in <b>30 minutes</b> and can be used once.</p>
  <p style="margin:24px 0"><a href="${link}" style="background:#D1FE17;color:#000;font-weight:bold;padding:12px 20px;border-radius:10px;text-decoration:none">Choose a new password</a></p>
  <p style="color:#888;font-size:13px">If the button doesn't work, paste this into your browser:<br>${link}</p>
  <p style="color:#888;font-size:13px">Didn't ask for this? Ignore this email — your password is unchanged.</p>
</div>`,
    });
    logger.info({ userId: user.id }, "password reset email sent");
    res.json(generic);
  } catch (err) {
    logger.error({ err }, "forgot-password failed");
    res.status(502).json({ error: "Could not send the reset email right now. Please try again in a few minutes." });
  }
});

// POST /auth/reset-password { token, password }
router.post("/auth/reset-password", authLimiter, async (req, res): Promise<void> => {
  if (!pool) { noDb(res); return; }
  const { token, password } = (req.body ?? {}) as { token?: string; password?: string };
  if (!token || typeof token !== "string" || token.length > 200) {
    res.status(400).json({ error: "This reset link is invalid. Request a new one." });
    return;
  }
  if (!password || password.length < 8 || password.length > 200) {
    res.status(400).json({ error: "Password must be at least 8 characters." });
    return;
  }
  try {
    // Atomically consume the token — a second use finds used_at already set.
    const { rows } = await pool.query<{ user_id: string }>(
      `UPDATE password_resets
          SET used_at = NOW()
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()
        RETURNING user_id`,
      [sha256(token)],
    );
    const reset = rows[0];
    if (!reset) {
      res.status(400).json({ error: "This reset link is invalid or has expired. Request a new one." });
      return;
    }
    const hash = await bcrypt.hash(password, 10);
    await pool.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [hash, reset.user_id]);
    // Log out every existing session for this account.
    await pool.query(`DELETE FROM session WHERE sess->>'userId' = $1`, [reset.user_id]);
    logger.info({ userId: reset.user_id }, "password reset completed");
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "reset-password failed");
    res.status(500).json({ error: "Could not reset the password. Please try again." });
  }
});

// ── POST /auth/logout ────────────────────────────────────────────────────────
router.post("/auth/logout", (req, res): void => {
  req.session?.destroy(() => {
    res.clearCookie(SESSION_COOKIE_NAME);
    res.json({ ok: true });
  });
});

// ── GET /auth/me ─────────────────────────────────────────────────────────────
router.get("/auth/me", async (req, res): Promise<void> => {
  if (!pool) { res.json({ user: null }); return; }
  const userId = req.session?.userId;
  if (!userId) { res.json({ user: null }); return; }
  try {
    const fresh = await refreshPlanState(userId);
    if (!fresh || fresh.status === "disabled") {
      req.session.destroy(() => {});
      res.json({ user: null });
      return;
    }
    res.json({ user: toPublicUser(fresh) });
  } catch (err) {
    logger.error({ err }, "auth/me failed");
    res.status(500).json({ error: "Could not load your account." });
  }
});

export default router;
