import { Router, type IRouter, type Request, type Response } from "express";
import { Pool } from "pg";

const router: IRouter = Router();

// ── Database pool (optional — history is disabled when DATABASE_URL is not set) ──
const DB_URL = process.env.DATABASE_URL ?? "";
const pool = DB_URL
  ? new Pool({
      connectionString: DB_URL,
      max: 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    })
  : null;

function noDb(res: Response): void {
  res.status(503).json({ error: "History is not available — DATABASE_URL is not configured." });
}

// ── JIT user upsert ───────────────────────────────────────────────────────────
router.post("/history/sync-user", async (req: any, res: Response): Promise<void> => {
  if (!pool) { noDb(res); return; }
  const { email } = req.body as { email?: string };
  if (!email) { res.status(400).json({ error: "email required" }); return; }
  try {
    await pool.query(
      `INSERT INTO users (id, email) VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
      [req.userId, email]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── GET /api/history ─────────────────────────────────────────────────────────
router.get("/history", async (req: any, res: Response): Promise<void> => {
  if (!pool) { noDb(res); return; }
  try {
    const { rows } = await pool.query(
      `SELECT id, source_url, platform, clip_duration, clip_count,
              total_duration, status, created_at
       FROM clip_jobs
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [req.userId]
    );
    res.json({ jobs: rows });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── POST /api/history ────────────────────────────────────────────────────────
router.post("/history", async (req: any, res: Response): Promise<void> => {
  if (!pool) { noDb(res); return; }
  const { sourceUrl, platform, clipDuration, clipCount, totalDuration } =
    req.body as {
      sourceUrl?: string;
      platform?: string;
      clipDuration?: number;
      clipCount?: number;
      totalDuration?: string;
    };
  if (!sourceUrl) { res.status(400).json({ error: "sourceUrl required" }); return; }
  try {
    const { rows } = await pool.query(
      `INSERT INTO clip_jobs (user_id, source_url, platform, clip_duration, clip_count, total_duration)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [req.userId, sourceUrl, platform ?? "shorts", clipDuration ?? 60, clipCount ?? 10, totalDuration ?? null]
    );
    res.json({ id: rows[0].id });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── DELETE /api/history/:id ──────────────────────────────────────────────────
router.delete("/history/:id", async (req: any, res: Response): Promise<void> => {
  if (!pool) { noDb(res); return; }
  try {
    await pool.query(
      "DELETE FROM clip_jobs WHERE id = $1 AND user_id = $2",
      [req.params.id, req.userId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
