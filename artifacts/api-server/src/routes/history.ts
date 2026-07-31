/**
 * Per-account clip history — which videos a user clipped and with what
 * settings. Requires a signed-in session; rows live in the `clip_jobs` table.
 *
 * Finished clip files (object-storage ids + metadata) are stored on the row
 * too, so a signed-in user can re-download clips from any device while the
 * files are still within their storage TTL — without burning credits on a
 * regenerate.
 */
import { Router, type IRouter, type Response } from "express";
import { pool } from "../lib/db";
import { requireUser } from "../middlewares/sessionAuth";

const router: IRouter = Router();

// Must match the storage TTL in lib/fileStore.ts (expiresMs = store time + 2h).
// created_at is written moments after the files are stored, so it's an
// accurate-enough anchor for "are the files still alive?".
export const CLIP_FILE_TTL_MS = 2 * 60 * 60 * 1000;

function noDb(res: Response): void {
  res.status(503).json({ error: "History is not available — database is not configured." });
}

// ── Server-side sanitising of client-posted clip metadata ────────────────────
// The client posts what the clip pipeline returned to it, but never trust the
// shape: cap counts/lengths and keep only the fields the History UI needs.
// Thumbnails (base64 data URLs) are deliberately dropped — they'd bloat rows.
interface StoredClip {
  id: string;
  name: string;
  label: string;
  startTime: string;
  endTime: string;
  duration: string;
  size: number;
  caption?: string;
}

const MAX_CLIPS = 30;
const str = (v: unknown, max: number): string =>
  typeof v === "string" ? v.slice(0, max) : "";

export function sanitizeClips(raw: unknown): StoredClip[] | null {
  if (!Array.isArray(raw)) return null;
  const out: StoredClip[] = [];
  for (const c of raw.slice(0, MAX_CLIPS)) {
    if (!c || typeof c !== "object") continue;
    const r = c as Record<string, unknown>;
    const id = str(r.id, 128);
    // File ids are hex/uuid-ish tokens — refuse anything that could be a path.
    if (!/^[\w.-]{8,128}$/.test(id)) continue;
    const clip: StoredClip = {
      id,
      name: str(r.name, 128) || "clip.mp4",
      label: str(r.label, 64) || "Clip",
      startTime: str(r.startTime, 32),
      endTime: str(r.endTime, 32),
      duration: str(r.duration, 32),
      size: typeof r.size === "number" && Number.isFinite(r.size) ? Math.max(0, Math.floor(r.size)) : 0,
    };
    const caption = str(r.caption, 2000);
    if (caption) clip.caption = caption;
    out.push(clip);
  }
  return out.length > 0 ? out : null;
}

// ── GET /api/history ─────────────────────────────────────────────────────────
router.get("/history", requireUser, async (req, res): Promise<void> => {
  if (!pool) { noDb(res); return; }
  try {
    const { rows } = await pool.query(
      `SELECT id, source_url, platform, clip_duration, clip_count,
              total_duration, status, created_at, clips
       FROM clip_jobs
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [req.currentUser!.id],
    );
    const now = Date.now();
    const jobs = rows.map((r) => {
      const createdMs = Date.parse(r.created_at);
      const alive =
        Array.isArray(r.clips) && r.clips.length > 0 &&
        Number.isFinite(createdMs) && now - createdMs < CLIP_FILE_TTL_MS;
      return {
        ...r,
        // Only ship download info while the files can still be served;
        // afterwards the UI shows an honest "expired" state instead.
        clips: alive ? r.clips : null,
        clips_expired: Array.isArray(r.clips) && r.clips.length > 0 && !alive,
        clips_expire_at: alive && Number.isFinite(createdMs)
          ? new Date(createdMs + CLIP_FILE_TTL_MS).toISOString()
          : null,
      };
    });
    res.json({ jobs });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── POST /api/history ────────────────────────────────────────────────────────
router.post("/history", requireUser, async (req, res): Promise<void> => {
  if (!pool) { noDb(res); return; }
  const { sourceUrl, platform, clipDuration, clipCount, totalDuration, clips } =
    req.body as {
      sourceUrl?: string;
      platform?: string;
      clipDuration?: number;
      clipCount?: number;
      totalDuration?: string;
      clips?: unknown;
    };
  if (!sourceUrl) { res.status(400).json({ error: "sourceUrl required" }); return; }
  const storedClips = sanitizeClips(clips);
  try {
    const { rows } = await pool.query(
      `INSERT INTO clip_jobs (user_id, source_url, platform, clip_duration, clip_count, total_duration, clips)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        req.currentUser!.id,
        sourceUrl,
        platform ?? "shorts",
        clipDuration ?? 60,
        clipCount ?? 10,
        totalDuration ?? null,
        storedClips ? JSON.stringify(storedClips) : null,
      ],
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
