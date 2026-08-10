/**
 * Database schema — single source of truth, safe to run repeatedly
 * (IF NOT EXISTS everywhere).
 *
 * Used from two places:
 *   1. Server startup (src/index.ts) — so every environment (dev, VM deploy)
 *      self-heals its schema before serving requests. Without this, publishing
 *      new code that expects a new column breaks until someone runs db:init.
 *   2. The manual `pnpm run db:init` script (src/db-init.ts).
 */
import type { Pool } from "pg";

const SCHEMA_SQL = `
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
    ADD COLUMN IF NOT EXISTS topup_credits  INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS referral_code  TEXT,
    ADD COLUMN IF NOT EXISTS referred_by    TEXT;

  CREATE UNIQUE INDEX IF NOT EXISTS users_referral_code_idx ON users (referral_code);

  -- Referral program: one row per referred signup. rewarded_at is set exactly
  -- once — when the referred user's first plan purchase pays the referrer.
  CREATE TABLE IF NOT EXISTS referrals (
    id             SERIAL      PRIMARY KEY,
    referrer_id    TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    referred_id    TEXT        NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    status         TEXT        NOT NULL DEFAULT 'signed_up',   -- signed_up | rewarded
    reward_credits INTEGER,
    created_at     TIMESTAMPTZ DEFAULT NOW(),
    rewarded_at    TIMESTAMPTZ
  );
  CREATE INDEX IF NOT EXISTS referrals_referrer_idx ON referrals (referrer_id, created_at DESC);


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
  -- can re-download their clips from any device.
  ALTER TABLE clip_jobs
    ADD COLUMN IF NOT EXISTS clips JSONB;

  -- Rows written after clips became permanent (no storage TTL). Legacy rows
  -- keep FALSE and show the honest "expired" state after their 2h window.
  ALTER TABLE clip_jobs
    ADD COLUMN IF NOT EXISTS files_permanent BOOLEAN NOT NULL DEFAULT FALSE;

  -- Auto-expiry: NULL = saved forever (files_permanent=TRUE clips).
  -- Non-null = timestamp after which the clip files are auto-deleted by the
  -- periodic cleanup job. Default 14 days from creation for new rows.
  ALTER TABLE clip_jobs
    ADD COLUMN IF NOT EXISTS clip_expires_at TIMESTAMPTZ;

  CREATE INDEX IF NOT EXISTS clip_jobs_expires_idx
    ON clip_jobs (clip_expires_at)
    WHERE clip_expires_at IS NOT NULL AND clips IS NOT NULL;

  -- Email verification OTP tokens sent on signup.
  ALTER TABLE users
    ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;

  CREATE TABLE IF NOT EXISTS email_verif_tokens (
    id         SERIAL      PRIMARY KEY,
    user_id    TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code       TEXT        NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used       BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS email_verif_tokens_user_idx ON email_verif_tokens (user_id);
  -- Clean up expired tokens automatically
  CREATE INDEX IF NOT EXISTS email_verif_tokens_expires_idx ON email_verif_tokens (expires_at);

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

  -- Whop payment ids are the idempotency key. A replay can never grant twice.
  CREATE TABLE IF NOT EXISTS whop_payments (
    payment_id      TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan_id         TEXT NOT NULL,
    payment_status  TEXT NOT NULL,
    paid_at         TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS whop_payments_user_idx ON whop_payments (user_id, created_at DESC);

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

  -- Resolved download-engine mirrors (direct media links, valid ~7 days).
  -- Durable + shared across instances, so ONE paid conversion serves every
  -- restart and every autoscale instance for the link's whole lifetime
  -- (the in-memory cache dies on restart; see lib/zylaCache.ts).
  CREATE TABLE IF NOT EXISTS zyla_cache (
    video_id     TEXT NOT NULL,
    format       TEXT NOT NULL,
    download_url TEXT NOT NULL,
    title        TEXT,
    expires_at   TIMESTAMPTZ NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (video_id, format)
  );
  CREATE INDEX IF NOT EXISTS zyla_cache_expires_idx ON zyla_cache (expires_at);

  -- ZapUPI (Indian UPI gateway) payment orders — one row per payment attempt.
  -- status: pending → paid | failed | review. "review" means an admin must
  -- look (amount mismatch / test-environment event); it is NEVER auto-granted.
  -- All state lives here so webhook + return-page confirms are race-safe
  -- across autoscale instances (row lock in confirmZapupiOrder).
  CREATE TABLE IF NOT EXISTS upi_orders (
    order_id      TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan          TEXT NOT NULL,
    plan_interval TEXT NOT NULL DEFAULT 'monthly',
    amount_inr    INTEGER NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending',
    payment_url   TEXT,
    txn_id        TEXT,
    utr           TEXT,
    provider_env  TEXT,
    fail_reason   TEXT,
    paid_at       TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS upi_orders_user_idx ON upi_orders (user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS upi_orders_status_idx ON upi_orders (status, created_at DESC);

  -- Short-lived share tokens that allow Buffer (and similar external services)
  -- to fetch a private clip video without user session auth.
  -- Tokens are valid for 24 hours and cleaned up lazily on read.
  CREATE TABLE IF NOT EXISTS clip_share_tokens (
    token      TEXT PRIMARY KEY,
    clip_id    TEXT NOT NULL,
    owner_id   TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS clip_share_tokens_expires_idx ON clip_share_tokens (expires_at);

  -- bundle.social: one team per AutoCliper user (admin's org key handles everything)
  CREATE TABLE IF NOT EXISTS bundle_teams (
    user_id    TEXT PRIMARY KEY,
    team_id    TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  -- Per-user per-account enabled/disabled preference (defaults to enabled=true)
  CREATE TABLE IF NOT EXISTS bundle_account_prefs (
    user_id    TEXT NOT NULL,
    account_id TEXT NOT NULL,
    enabled    BOOLEAN NOT NULL DEFAULT true,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, account_id)
  );

  -- Master auto-post preference per user (default = auto-post enabled)
  CREATE TABLE IF NOT EXISTS bundle_user_prefs (
    user_id           TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    auto_post_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  -- Track which clips were auto- or manually posted to social platforms
  CREATE TABLE IF NOT EXISTS clip_social_posts (
    id        SERIAL      PRIMARY KEY,
    user_id   TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    clip_id   TEXT        NOT NULL,
    platform  TEXT        NOT NULL,
    posted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS clip_social_posts_clip_idx
    ON clip_social_posts (user_id, clip_id, posted_at DESC);

  -- One post per (user, clip, platform): rows double as claim markers that make
  -- posting idempotent (auto-post + manual click can never double-post).
  -- Dedupe legacy duplicate rows first so the unique index builds on existing DBs.
  DELETE FROM clip_social_posts a USING clip_social_posts b
    WHERE a.user_id = b.user_id AND a.clip_id = b.clip_id
      AND a.platform = b.platform AND a.id > b.id;
  CREATE UNIQUE INDEX IF NOT EXISTS clip_social_posts_unique
    ON clip_social_posts (user_id, clip_id, platform);

  -- Bulk social scheduler: each row = one video scheduled to post via
  -- bundle.social. The media itself lives on bundle.social (their servers
  -- fetch it straight from the user's public Drive/Dropbox URL) and they
  -- publish at post_at — we keep only this small metadata row.
  CREATE TABLE IF NOT EXISTS scheduled_social_posts (
    id               TEXT        PRIMARY KEY,
    user_id          TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    batch_id         TEXT        NOT NULL,
    source_url       TEXT        NOT NULL,
    file_name        TEXT        NOT NULL,
    caption          TEXT        NOT NULL,
    account_ids      TEXT[]      NOT NULL,
    platforms        TEXT[]      NOT NULL DEFAULT '{}',
    post_at          TIMESTAMPTZ NOT NULL,
    status           TEXT        NOT NULL DEFAULT 'queued',
    attempts         INT         NOT NULL DEFAULT 0,
    bundle_upload_id TEXT,
    bundle_post_id   TEXT,
    error            TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS ssp_user_idx  ON scheduled_social_posts (user_id, post_at);
  CREATE INDEX IF NOT EXISTS ssp_queue_idx ON scheduled_social_posts (status, post_at)
    WHERE status = 'queued';
`;

/** Create/upgrade all tables. Idempotent; throws on hard failures. */
export async function ensureSchema(pool: Pool): Promise<void> {
  await pool.query(SCHEMA_SQL);

  // Case-insensitive email uniqueness. Legacy rows may contain duplicate
  // emails — report them instead of aborting the whole init.
  try {
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email))`);
  } catch (err) {
    const dupes = await pool.query(
      `SELECT lower(email) AS email, COUNT(*)::int AS n FROM users GROUP BY lower(email) HAVING COUNT(*) > 1 LIMIT 5`,
    );
    console.error(
      "[schema] could not create unique email index — fix these duplicate emails manually:",
      (err as Error).message, dupes.rows,
    );
  }
}
