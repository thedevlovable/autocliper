# AutoCliper (ClipAI) — Long Videos → Short Viral Clips

Full-stack app that turns long YouTube/Kick/Twitch/Drive/Dropbox videos into short viral clips (ffmpeg + yt-dlp + paid Zyla engine for YouTube). Live at autocliper.com (Reserved VM).

## Run & Operate

- **Frontend (port 5000):** workflow `artifacts/ytdlp-ui: web` (Vite dev, proxies `/api` → 8080)
- **API server (port 8080):** workflow `artifacts/api-server: API Server` — esbuild bundles at start, so **restart this workflow after backend edits**
- Verification: `api-server-test`, `api-server-typecheck`, `ytdlp-ui-test`, `ytdlp-ui-typecheck`

## Stack

- pnpm workspaces, Node.js 20, TypeScript 5.9
- **Frontend:** React 19, Vite 7, Tailwind v4, wouter, react-query. Design: bg `#0d0d0d`, cards `#1a1a1a`, lime `#D1FE17`, font-black headings
- **Backend:** Express 5, Postgres (Replit managed), Replit Object Storage for clips
- **Auth:** custom email+password sessions (NO Clerk — fully removed July 2026). PG-backed session cookie `clipai.sid`
- **YouTube engine:** Zyla API (paid per download start — never run casual test jobs). Kick/Twitch/Drive/Dropbox via yt-dlp/direct

## Auth & Billing (manual payments, Stripe planned)

- **50 credits = 1 clip** (`CREDITS_PER_CLIP` in `src/lib/billing.ts`); the four one-shot tools (download/trim/crop/extract-audio) also cost 50 each and require login. Signup gives **150 free credits** (= 3 clips). Credits reserved before a job runs, refunded on failure/partial output (`reserveCredits`/`refundCredits`; every movement logged in `credit_ledger`).
- Plans: Starter $5/mo = 5,000 cr, Pro $10/mo = 12,500 cr; yearly = 2 months free ($50/$100). Sub credits refill monthly, expire with plan. Top-ups (boost2500 $3, boost5000 $5, boost12500 $12) never expire. Spend order: sub first, then top-up. Landing `PricingCards.tsx` mirrors these numbers by hand — keep in sync.
- **No payment gateway yet:** subscribe/topup create *pending* rows in `billing_requests`; an admin approves/rejects them in `/admin`. Approval calls `grantSubscription`/`grantTopupTx` — Stripe webhooks should later call these same functions.
- Admins: set `ADMIN_EMAILS` env (comma-separated) — those accounts get `role='admin'` on signup/login. Admin panel at `/admin` (stats, users, credit adjust, plan set/remove, request approve/reject, password reset).
- Clip endpoints require login (401 `AUTH_REQUIRED`, 402 `INSUFFICIENT_CREDITS {needed, available}`). `/api/yt/*` metadata + cookies endpoints are deliberately public.

## Key Files

- Billing/credits: `artifacts/api-server/src/lib/billing.ts`; schema in `src/db-init.ts` (idempotent, runs at boot; publish auto-migrates prod)
- Sessions/guards: `src/middlewares/sessionAuth.ts` (`requireUser`, `requireAdmin`)
- Routes: `src/routes/{auth,billing,admin,videoTools,history,ytdlp,cookies}.ts`
- Frontend auth state: `artifacts/ytdlp-ui/src/lib/auth.tsx` (`useAuth`, `apiFetch`); pages `Login/SignUp/Pricing/Account/Admin/ClipperPage`
- Integration test (real dev DB): `api-server/src/__tests__/authBilling.test.ts`

## Required Secrets

- `SESSION_SECRET` — session signing
- `ZYLA_API_KEY` — YouTube download engine (paid)
- `DATABASE_URL` — auto-managed
- `ADMIN_EMAILS` — comma-separated admin emails (set in dev AND production)

## Architecture Notes

- Clips stored in Replit Object Storage (5 GB cap, 2 h TTL); job records mirrored to Object Storage for multi-instance safety
- Async job queue: max 4 concurrent, 12 queued, per-IP cap; jobs cancellable while queued (`DELETE /api/video/job/:id`)
- Reserved VM prod = single process; **publish after backend changes** so autocliper.com gets new code + schema
- pg returns NUMERIC columns (e.g. `billing_requests.amount_usd`) as **strings**
