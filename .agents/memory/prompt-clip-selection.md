---
name: Prompt-guided clip selection
description: Gemini prompt→moment matching on clip jobs — key gating, transcript sourcing, cache identity, dev-vs-VPS testability
---

**Rule:** In prompt-guided selection, check `isGeminiConfigured()` BEFORE acquiring any transcript. Transcript acquisition can bill Deepgram (full-video STT) — never spend that when the matcher can't run anyway.
**Why:** originally GEMINI_API_KEY existed only on the VPS; wrong gate order would burn Deepgram money on dev/misconfigured servers just to fall back. Since 2026-08-25 the dev workspace ALSO has GEMINI_API_KEY, but the gate-order rule stands — any server without the key must fall back before spending on STT.
**How to apply:** Any new AI-matching entry point: gate on the model key first, then captions (free), then STT (paid). The matcher itself: unit tests with injected `fetchImpl`, plus cheap live verification by calling `matchPromptMoments` directly with a synthetic transcript (no Zyla/Deepgram spend).

**Model retirement:** gemini-2.5-flash 404s for newer API keys ("no longer available to new users"). Default is now gemini-3.6-flash (kept in lockstep in lib/gemini.ts + lib/promptMatch.ts, GEMINI_MODEL env overrides). Older keys (VPS) can still use new models, so bumping the default is safe everywhere; when a Gemini call 404s, check model retirement before blaming the key.

**Prompt constraints are strict filters (owner decision 2026-08-25, after the Raj Shamani failure):**
- No filler top-up on prompt jobs: fewer honest clips beat padded off-prompt ones (filler broke "first 15 minutes only"). Billing settles on produced count → auto refund.
- Zero-match semantics: matchPromptMoments returns null = matcher couldn't run (fallback + note allowed) vs [] = model ran, nothing matched (job FAILS with a no-charge message, full refund — never fall back to the standard picker, that's the "it ignored my prompt" bug).
- Full-video STT runs diarize=true; segments carry `speaker`, transcript lines prefix S1:/S2: at voice switches, and the Gemini prompt has HARD RULES (time windows strict; speaker attribution via labels, else textual evidence, else EXCLUDE).
- LIMIT: YouTube captions (tried first, free) have NO speaker labels — "only when X speaks" on YouTube relies on textual evidence and may honestly return few/zero moments. Real fix = diarized-audio path before selection (follow-up task filed). Face-identity ("show only X's face") is NOT implemented — face-follow crops whoever is on camera.

Other durable choices (task-independent):
- The prompt is part of result identity → hashed into the clip cache key (same pattern as the Kick `ksrc` hint). Different prompts must never share cached clips.
- Prompt picks get NO intro/outro margin — users explicitly ask for cold opens/endings; only clamp to [0, duration−clipLen] and enforce gap ≥ clipLen.
- Full-video STT for matching skips the Latin-only filter (that filter exists solely for subtitle font burning; Gemini reads any script). Mono 16 kHz Opus @24kbps keeps 90 min ≈ 16 MB upload.
- Fallbacks are honest, never silent: ai-unavailable / no-transcript / ai-failed push a user-visible fallback note and `promptApplied` is recorded on the job. no-matches is NOT a fallback — it fails the job with a no-charge message (see zero-match semantics above).
