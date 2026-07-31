/**
 * Database initialisation — creates/updates the tables needed by AutoCliper.
 * Safe to run multiple times (IF NOT EXISTS everywhere).
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
      id          TEXT PRIMARY KEY,               -- usr_<random>
      email       TEXT        NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS password_hash  TEXT,
      ADD COLUMN IF NOT EXISTS name           TEXT,
      ADD COLUMN IF NOT EXISTS role           TEXT NOT NULL DEFAULT 'user',
      ADD COLUMN IF NOT EXISTS status         TEXT NOT NULL DEFAULT 'active',
      ADD COLUMN IF NOT EXISTS plan           TEXT NOT NULL DEFAULT 'none',
      ADD COLUMN IF NOT EXISTS plan_interval  TEXT,
      ADD COLUMN IF NOT EXISTS plan_status    TEXT NOT NULL DEFAULT 'none',
      ADD COLUMN IF NOT EXISTS paid_until     TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS next_refill_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS sub_credits    INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS topup_credits  INTEGER NOT NULL DEFAULT 0;


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

    -- Finished clip files (object-storage ids + metadata) so a signed-in user
    -- can re-download their clips from any device while the files are alive.
    ALTER TABLE clip_jobs
      ADD COLUMN IF NOT EXISTS clips JSONB;

    CREATE TABLE IF NOT EXISTS credit_ledger (
      id         SERIAL PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      delta      INTEGER NOT NULL,
      bucket     TEXT NOT NULL,
      reason     TEXT NOT NULL,
      meta       JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS credit_ledger_user_idx ON credit_ledger (user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS billing_requests (
      id            SERIAL PRIMARY KEY,
      user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind          TEXT NOT NULL,
      plan          TEXT,
      plan_interval TEXT,
      pack_id       TEXT,
      credits       INTEGER NOT NULL,
      amount_usd    NUMERIC(10,2) NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      note          TEXT,
      admin_note    TEXT,
      decided_by    TEXT,
      decided_at    TIMESTAMPTZ,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS billing_requests_status_idx ON billing_requests (status, created_at DESC);
    CREATE INDEX IF NOT EXISTS billing_requests_user_idx ON billing_requests (user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS password_resets (
      id         SERIAL PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,             -- sha256 of the raw token
      expires_at TIMESTAMPTZ NOT NULL,
      used_at    TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS password_resets_user_idx ON password_resets (user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS session (
      sid    VARCHAR NOT NULL PRIMARY KEY,
      sess   JSON NOT NULL,
      expire TIMESTAMP(6) NOT NULL
    );
    CREATE INDEX IF NOT EXISTS session_expire_idx ON session (expire);
  `);

  console.log("DB init complete — tables: users, clip_jobs, credit_ledger, billing_requests, session");
  // Case-insensitive email uniqueness. Legacy rows may contain duplicate
  // emails — report them instead of aborting the whole init.
  try {
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email))`);
  } catch (err) {
    const dupes = await pool.query(
      `SELECT lower(email) AS email, COUNT(*)::int AS n FROM users GROUP BY lower(email) HAVING COUNT(*) > 1 LIMIT 5`,
    );
    console.error(
      "[db-init] could not create unique email index — fix these duplicate emails manually:",
      (err as Error).message, dupes.rows,
    );
  }

  await pool.end();
}

main().catch((err) => {
  console.error("DB init failed:", err);
  process.exit(1);
});
