import { Router, type IRouter } from "express";
import { Pool } from "pg";
import { requireAuth } from "../middlewares/requireAuth";

const router: IRouter = Router();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ── JIT user upsert ───────────────────────────────────────────────────────────
// Called after sign-in so user row exists before history writes
router.post("/history/sync-user", requireAuth, async (req: any, res): Promise<void> => {
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

// ── GET /api/history — list clip jobs for current user ───────────────────────
router.get("/history", requireAuth, async (req: any, res): Promise<void> => {
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

// ── POST /api/history — save a completed clip job ────────────────────────────
router.post("/history", requireAuth, async (req: any, res): Promise<void> => {
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
router.delete("/history/:id", requireAuth, async (req: any, res): Promise<void> => {
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
