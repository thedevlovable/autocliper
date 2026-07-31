/**
 * Per-account clip history — which videos a user clipped and with what
 * settings. Requires a signed-in session; rows live in the `clip_jobs` table.
 */
import { Router, type IRouter, type Response } from "express";
import { pool } from "../lib/db";
import { requireUser } from "../middlewares/sessionAuth";

const router: IRouter = Router();

function noDb(res: Response): void {
  res.status(503).json({ error: "History is not available — database is not configured." });
}

// ── GET /api/history ─────────────────────────────────────────────────────────
router.get("/history", requireUser, async (req, res): Promise<void> => {
  if (!pool) { noDb(res); return; }
  try {
    const { rows } = await pool.query(
      `SELECT id, source_url, platform, clip_duration, clip_count,
              total_duration, status, created_at
       FROM clip_jobs
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [req.currentUser!.id],
    );
    res.json({ jobs: rows });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── POST /api/history ────────────────────────────────────────────────────────
router.post("/history", requireUser, async (req, res): Promise<void> => {
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
      [req.currentUser!.id, sourceUrl, platform ?? "shorts", clipDuration ?? 60, clipCount ?? 10, totalDuration ?? null],
    );
    res.json({ id: rows[0].id });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── DELETE /api/history/:id ──────────────────────────────────────────────────
router.delete("/history/:id", requireUser, async (req, res): Promise<void> => {
  if (!pool) { noDb(res); return; }
  try {
    await pool.query(
      "DELETE FROM clip_jobs WHERE id = $1 AND user_id = $2",
      [req.params.id, req.currentUser!.id],
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
