---
name: Subtitle burn pipeline
description: How burned captions work in the clip pipeline — transcript sourcing, timing sync, font limits
---

# Subtitle burn pipeline

- **Transcript must come from the canonical page URL, never the resolved media URL.** Zyla direct links and Kick IVS m3u8s have no subtitle endpoint — passing them to the transcript fetch silently produces caption-less clips on the whole YouTube fast path.
  **Why:** review caught prod-path bug: `allowTranscript: sectionSourceUrl === url` disabled subs whenever the mirror was active (i.e. nearly every YouTube job).
  **How to apply:** any new picking/burning code path takes a separate `transcriptUrl` (canonical) alongside the media URL.

- **Caption sync rule: clip starts must be whole seconds when burning.** yt-dlp `--download-sections` cuts at integer bounds; fractional pick times desync every cue by up to 1s. Floor timestamps when subtitles are on, and pass `--force-keyframes-at-cuts` (gated to subs jobs — it re-encodes, slower).

- **Cue shaping:** ≤3-word chunks, linear time interpolation inside a segment, min display 0.35s but never past the next cue's start or clip end (else cues stack on screen).

- **Fonts:** environment has DejaVu only — `fc-list :lang=hi` is EMPTY, so Hindi/Devanagari captions render as boxes. English captions only until a Devanagari font (e.g. Noto Sans Devanagari) is installed in dev AND prod images.

- **ASS/libass verified working** in Nix ffmpeg 7.1.1 (`subtitles=` filter + fontconfig). Visual smoke: lavfi source + handwritten .ass + extract frame → view PNG.

- No transcript ⇒ no subs (Kick live, device uploads, bot-blocked YouTube): burning skips silently per-clip with a log line, job still succeeds.
