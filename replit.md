# ClipAI — YouTube/TikTok Video to Short Clips Converter

A full-stack app that converts long YouTube/TikTok videos into short viral clips using ffmpeg and a Railway-hosted yt-dlp API.

## Run & Operate

- **Frontend (port 5000):** `PORT=5000 BASE_PATH=/ pnpm --filter @workspace/ytdlp-ui run dev`
- **API server (port 8080):** `PORT=8080 pnpm --filter @workspace/api-server run dev`
- Use the two configured workflows: `artifacts/ytdlp-ui: web` and `artifacts/api-server: API Server`

## Stack

- pnpm workspaces, Node.js 20, TypeScript 5.9
- **Frontend:** React 19, Vite 7, Tailwind CSS v4, shadcn/ui, Clerk auth
- **Backend:** Express 5, Node.js, ffmpeg (via Nix), yt-dlp (via Nix)
- **Auth:** Clerk (VITE_CLERK_PUBLISHABLE_KEY + CLERK_SECRET_KEY)
- **DB:** PostgreSQL (Replit managed) — `users` and `clip_jobs` tables
- **Video download:** Railway API at `https://yt-api-railway-production-7709.up.railway.app/download?url=...`

## Required Secrets

Set these in Tools → Secrets:
- `CLERK_SECRET_KEY` — from clerk.com → your app → API Keys
- `CLERK_PUBLISHABLE_KEY` — from clerk.com → your app → API Keys  
- `VITE_CLERK_PUBLISHABLE_KEY` — same value as CLERK_PUBLISHABLE_KEY
- `SESSION_SECRET` — any random 32+ character string
- `DATABASE_URL` — auto-managed by Replit

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/ytdlp/info?url=<URL>` | Video metadata |
| GET | `/api/ytdlp/formats?url=<URL>` | Available download formats |
| POST | `/api/ytdlp/download` | Download video/audio |
| POST | `/api/video/clip` | Generate short clips from a video |
| POST | `/api/video/trim` | Trim video to a range |
| POST | `/api/video/crop-vertical` | Crop to 9:16 vertical |
| POST | `/api/video/extract-audio` | Extract audio as MP3 |
| POST | `/api/video/transcript` | Fetch subtitles via yt-dlp |
| GET | `/api/video/file/:id` | Serve a stored file (supports Range) |
| GET | `/api/history` | List clip history (auth required) |
| POST | `/api/history` | Save a clip job (auth required) |
| DELETE | `/api/history/:id` | Delete a history entry |

## Database Schema

```sql
-- users.id = Clerk user ID (TEXT)
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE clip_jobs (
  id SERIAL PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  source_url TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'shorts',
  clip_duration INTEGER NOT NULL DEFAULT 60,
  clip_count INTEGER NOT NULL DEFAULT 10,
  total_duration TEXT,
  status TEXT DEFAULT 'done',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

## Where Things Live

- Frontend pages: `artifacts/ytdlp-ui/src/pages/`
- Clip generation: `artifacts/api-server/src/routes/videoTools.ts`
- History routes: `artifacts/api-server/src/routes/history.ts`
- yt-dlp routes: `artifacts/api-server/src/routes/ytdlp.ts`

## Architecture Notes

- Video clips stored in `/tmp/clipai-serve/` with 2-hour TTL (disk-based)
- Clip jobs use async semaphore (max 4 concurrent, 12 queued)
- ffmpeg auto-detected from Nix store if not in PATH
- Vite dev server proxies `/api` → `localhost:8080`
- Clerk proxy only active in production
- `users.id` uses Clerk user ID (TEXT), not SERIAL integer

## Technical Notes

- Video download uses Railway API — no setup needed, hardcoded in videoTools.ts
- ffmpeg is auto-detected from nix store at startup
- Files served from /tmp/clipai-serve/ with 2-hour TTL
- Clips processed per-segment only — never re-encodes the full video
- Default: 5 clips, 30s each, ultrafast preset, CRF 28
