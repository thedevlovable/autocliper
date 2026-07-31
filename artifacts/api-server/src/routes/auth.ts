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
