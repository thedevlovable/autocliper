---
name: Clip section download approach
description: How the clip job downloads video — per-section, not full file
---

## Approach
The `/api/video/clip` handler no longer downloads the full video. Instead:
1. `yt-dlp --dump-json` fetches metadata only (fast, ~2s)
2. Per clip: `yt-dlp --download-sections "*start-end"` downloads only the needed seconds
3. ffmpeg cuts from the section with 3s lead padding for clean keyframes

## Why
- Eliminates the old 7200s (2h) hard cap — any video length works
- A 3h video only requires ~30s of download per clip instead of gigabytes
- Faster for all videos, not just long ones

## Key details
- Section args: `--download-sections "*{sectionStart}-{sectionEnd}"` with 3s padding
- ffmpeg offset: `-ss {padBefore}` to skip the lead padding
- yt-dlp may append section stamps to output filename — scan dir to find the file
- Timeout: 180s per section download, 120s per ffmpeg clip
- `--merge-output-format mp4` ensures consistent container

**How to apply:** Any future clip processing changes must keep the section-based approach. Never revert to full-video download.
