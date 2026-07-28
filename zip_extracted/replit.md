# yt-dlp API Server

A REST API that wraps yt-dlp to fetch video metadata, list download formats, and download video/audio from YouTube and other supported sites.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)
- yt-dlp: installed as system dependency via Nix

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/ytdlp/info?url=<URL>` | Video metadata (title, duration, uploader, etc.) |
| GET | `/api/ytdlp/formats?url=<URL>` | All available download formats |
| POST | `/api/ytdlp/download` | Download video/audio, streams the file |

### Download request body
```json
{
  "url": "https://youtube.com/watch?v=...",
  "format": "best",
  "audio_only": false
}
```

## Where things live

- API routes: `artifacts/api-server/src/routes/ytdlp.ts`
- OpenAPI spec: `lib/api-spec/openapi.yaml`
- Generated hooks: `lib/api-client-react/src/generated/`

## Architecture decisions

- URL validation is done before spawning yt-dlp to prevent command injection (only http/https allowed)
- Download files are written to a temp directory then streamed back; temp dir is cleaned up after stream closes
- Direct format URLs are not exposed in the `/formats` response for security

## Gotchas

- yt-dlp must be installed as a Nix system dependency (`yt-dlp`)
- ffmpeg is available at runtime (pre-installed in Replit runtime)
- `--no-playlist` flag is always used to avoid accidentally downloading entire playlists

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
