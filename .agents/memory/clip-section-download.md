---
name: Long-video clip pipeline (section downloads)
description: How the clip job avoids full-video downloads, and the yt-dlp/ffmpeg gotchas that break it
---

# Long-video clip pipeline

The clip job must NEVER download the whole video for yt-dlp-native platforms (YouTube/Twitch/generic):
1. probe duration via `yt-dlp --dump-json --skip-download` (metadata only)
2. pick timestamps, then `yt-dlp --download-sections "*start-end"` per clip (parallel, limited)
3. fall back to full download only for Drive/Dropbox/Kick, live streams, or when probe/sections fail

**Why:** a 2h+ video is gigabytes and 10+ minutes of download; sections make job time independent of video length (54-min VOD → 2 clips in ~29s, verified).

**How to apply:** if this logic is ever missing after a GitHub re-import (it was lost once — July 2026), re-implement rather than raising download timeouts.

## Gotchas (hard-won)
- **npm `ffmpeg-static` SEGFAULTS (exit -11) when yt-dlp uses it** as the HLS/section downloader. yt-dlp's `--ffmpeg-location` must point at the system/Nix ffmpeg **directory** (ffprobe lives alongside). The npm binary is fine for the app's own direct ffmpeg spawns.
- Standalone `yt-dlp_linux` binaries (used in `bin/` for dev + prod builds) do NOT auto-find ffmpeg like the Nix-wrapped yt-dlp does — always pass `--ffmpeg-location`.
- Section files start at the keyframe at/before the requested start → seek 0 within them; also fixes black-frame starts for stream-copy clips.
- **YouTube intermittently bot-blocks the VM IP** ("Sign in to confirm you're not a bot") — affects probe + downloads + sections regardless of yt-dlp version or player_client. Fallback chain (Railway/Vercel full download) keeps YouTube working but slower; the real fix is a user-provided YouTube cookies.txt — uploadable at runtime via `POST /ytdlp/cookies` (validated Netscape format, 0600 local file, persisted to private object storage, restored on startup; `YTDLP_COOKIES_FILE` env still wins when set). Cookie args must be resolved per yt-dlp call (`getCookieArgs()` in `lib/cookieStore`), never cached at module load. Note: `#HttpOnly_` lines in cookies.txt are real cookies, not comments.
- yt-dlp `--dump-json` output can exceed default 200KB maxBuffer on long videos — always set explicit large maxBuffer (64MB).
