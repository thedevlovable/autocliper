/**
 * Database initialisation — creates the tables needed by ClipAI if they do
 * not already exist.  Safe to run multiple times (all statements use
 * IF NOT EXISTS).
 *
 * Usage:
 *   pnpm --filter @workspace/api-server run db:init
 */
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  console.log("Running DB init…");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id          TEXT PRIMARY KEY,          -- Clerk user ID (e.g. user_abc123)
      email       TEXT        NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS clip_jobs (
      id             SERIAL      PRIMARY KEY,
      user_id        TEXT        REFERENCES users(id) ON DELETE CASCADE,
      source_url     TEXT        NOT NULL,
      platform       TEXT        NOT NULL DEFAULT 'shorts',
      clip_duration  INTEGER     NOT NULL DEFAULT 60,
      clip_count     INTEGER     NOT NULL DEFAULT 10,
      total_duration TEXT,
      status         TEXT                 DEFAULT 'done',
      created_at     TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  console.log("DB init complete — tables: users, clip_jobs");
  await pool.end();
}

main().catch((err) => {
  console.error("DB init failed:", err);
  process.exit(1);
});
