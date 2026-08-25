/**
 * Prompt-guided clip moment matching (Gemini).
 *
 * The user types a natural-language instruction ("clip every goal", "only the
 * parts about cricket") and this module asks Gemini to pick the best-matching
 * moments from a timed transcript. Contract mirrors lib/gemini.ts:
 *   - NEVER throws — every failure returns null so the route falls back to
 *     the standard picker with an honest note (silent ignores are banned).
 *   - The API key travels in a request header, never the URL.
 *   - Pure helpers (formatting, chunking, parsing, merging) are exported for
 *     unit tests; only matchPromptMoments does I/O.
 */
import type { TranscriptSegment } from "./highlightPicker";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// 2000 chars: clippers paste entire campaign rule sheets (Whop "Content
// Rewards" docs) into the prompt — 500 cut them off mid-requirements.
export const MAX_PROMPT_LEN = 2000;

/** Collapse whitespace and trim. Null when not a usable non-empty string.
 *  Does NOT cap length — the route rejects over-long prompts with a clear
 *  message instead of silently truncating the user's instruction. */
export function sanitizePrompt(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const p = raw.replace(/\s+/g, " ").trim();
  return p.length > 0 ? p : null;
}

// ── Transcript → model input ──────────────────────────────────────────────────

/** Merge segments into ~15s "[m:ss] text" lines — compact enough that hours
 *  of speech fit the model budget, precise enough to land clips on the moment. */
export const TRANSCRIPT_BUCKET_SEC = 15;

export function formatTranscriptLines(segments: TranscriptSegment[]): string[] {
  const buckets = new Map<number, { text: string; speaker?: number }[]>();
  for (const s of segments) {
    if (!(s.start >= 0)) continue;
    const text = s.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const b = Math.floor(s.start / TRANSCRIPT_BUCKET_SEC);
    const item = { text, ...(typeof s.speaker === "number" ? { speaker: s.speaker } : {}) };
    const arr = buckets.get(b);
    if (arr) arr.push(item);
    else buckets.set(b, [item]);
  }
  const lines: string[] = [];
  for (const b of [...buckets.keys()].sort((a, z) => a - z)) {
    const t = b * TRANSCRIPT_BUCKET_SEC;
    const m = Math.floor(t / 60);
    // Diarized segments carry a voice label: prefix "S<n>:" at each speaker
    // switch so the model can tell who says what. Label-free transcripts
    // (captions) render exactly as before.
    const parts: string[] = [];
    let lastSpeaker: number | null = null;
    let labeled = false;
    for (const item of buckets.get(b)!) {
      if (typeof item.speaker === "number" && (!labeled || item.speaker !== lastSpeaker)) {
        parts.push(`S${item.speaker + 1}: ${item.text}`);
        lastSpeaker = item.speaker;
        labeled = true;
      } else {
        parts.push(item.text);
      }
    }
    lines.push(`[${m}:${String(t % 60).padStart(2, "0")}] ${parts.join(" ")}`);
  }
  return lines;
}

/** Split transcript lines into ≤maxChunks chunks of ≤budget chars each. Lines
 *  beyond the last chunk are dropped — at the default budget that's ~4 hours
 *  of dense speech, which also bounds what we spend on model input. */
export const CHUNK_CHAR_BUDGET = 24_000;
export const MAX_CHUNKS = 4;

export function chunkTranscript(lines: string[], budget = CHUNK_CHAR_BUDGET, maxChunks = MAX_CHUNKS): string[] {
  const chunks: string[] = [];
  let cur: string[] = [];
  let curLen = 0;
  for (const line of lines) {
    if (curLen + line.length + 1 > budget && cur.length > 0) {
      chunks.push(cur.join("\n"));
      if (chunks.length >= maxChunks) return chunks;
      cur = [];
      curLen = 0;
    }
    cur.push(line);
    curLen += line.length + 1;
  }
  if (cur.length > 0 && chunks.length < maxChunks) chunks.push(cur.join("\n"));
  return chunks;
}

// ── Model reply → validated moments ───────────────────────────────────────────

export interface MomentCandidate {
  start: number;
  reason: string;
  score: number;
}

/** 90 | "90" | "1:30" | "1:02:03" → seconds. Null on garbage. */
export function parseStartValue(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  if (typeof v === "string") {
    const t = v.trim();
    if (/^\d+(\.\d+)?$/.test(t)) return parseFloat(t);
    const m = t.match(/^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})(?:\.\d+)?$/);
    if (m) {
      const h = m[1] ? parseInt(m[1], 10) : 0;
      return h * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
    }
  }
  return null;
}

/** Parse one model reply. Strict JSON is requested, but code fences, a bare
 *  top-level array, and alternate key names are all tolerated — models drift. */
export function parseMomentsReply(raw: string): MomentCandidate[] {
  const cleaned = raw.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { moments?: unknown }).moments;
  if (!Array.isArray(list)) return [];
  const out: MomentCandidate[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const start = parseStartValue(rec.start_seconds ?? rec.start ?? rec.startSec ?? rec.time);
    if (start === null) continue;
    const reason = String(rec.reason ?? rec.label ?? "").replace(/\s+/g, " ").trim().slice(0, 90);
    const scoreRaw = rec.relevance ?? rec.score;
    const score = typeof scoreRaw === "number" && Number.isFinite(scoreRaw)
      ? Math.max(0, Math.min(100, scoreRaw))
      : 50;
    out.push({ start, reason, score });
  }
  return out;
}

/** Highest-relevance first, clamped to [0, totalDuration - clipDuration],
 *  non-overlapping (gap ≥ clipDuration). No intro/outro margins here — when a
 *  user's prompt matches the first minute, they get the first minute.
 *  Returns ≤count moments sorted by start time. */
export function pickPromptMoments(
  cands: MomentCandidate[],
  totalDuration: number,
  clipDuration: number,
  count: number,
): { start: number; reason: string }[] {
  const hi = Math.max(0, totalDuration - clipDuration);
  const sorted = [...cands].sort((a, b) => b.score - a.score);
  const picked: { start: number; reason: string }[] = [];
  for (const c of sorted) {
    if (picked.length >= count) break;
    const start = Math.max(0, Math.min(c.start, hi));
    if (picked.every((p) => Math.abs(p.start - start) >= clipDuration)) {
      picked.push({ start, reason: c.reason });
    }
  }
  return picked.sort((a, b) => a.start - b.start);
}

// ── The one I/O function ──────────────────────────────────────────────────────

export interface PromptMatchOpts {
  prompt: string;
  segments: TranscriptSegment[];
  totalDuration: number;
  clipDuration: number;
  count: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

/** Ask Gemini for the moments best matching the user's prompt. Long
 *  transcripts are chunked; chunk results merge by relevance. Null when the
 *  key is missing, every request failed, or nothing matched — the caller
 *  falls back to standard selection with an honest note. Never throws. */
export async function matchPromptMoments(
  opts: PromptMatchOpts,
): Promise<{ start: number; reason: string }[] | null> {
  const key = process.env.GEMINI_API_KEY;
  const log = opts.log ?? (() => {});
  if (!key) {
    log("[prompt] no Gemini key configured — cannot match");
    return null;
  }
  const lines = formatTranscriptLines(opts.segments);
  if (lines.length === 0) return null;
  const chunks = chunkTranscript(lines);
  // Kept in lockstep with lib/gemini.ts — 2.5-flash 404s on newer API keys.
  const model = process.env.GEMINI_MODEL || "gemini-3.6-flash";
  const doFetch = opts.fetchImpl ?? fetch;
  // Ask each chunk for a few extras so the cross-chunk merge has choices.
  const perChunk = Math.min(10, Math.max(opts.count + 2, 4));

  // null = the request failed (HTTP/parse/abort); [] = Gemini answered "nothing matches".
  const askChunk = async (transcript: string): Promise<MomentCandidate[] | null> => {
    const text =
      `You pick video clip moments. Below is a timed transcript (each line starts with [minutes:seconds]) and a user instruction.\n` +
      `Find up to ${perChunk} moments that BEST match the instruction. Each clip runs ${Math.round(opts.clipDuration)} seconds from its start, so choose starts where the matching content begins.\n` +
      `HARD RULES — never return a moment that breaks one, even if that means returning fewer or zero moments:\n` +
      `1. Explicit constraints in the instruction are strict filters, not suggestions: time windows (e.g. "first 15 minutes" = start_seconds under 900), named people, topics, languages.\n` +
      `2. Some transcripts label voices as S1:, S2:, ... (automatic diarization). If the instruction limits clips to one person, first decide which label is that person — self-introductions, how others address them, who hosts vs who guests — then only return moments where that label is the one speaking for the whole clip window.\n` +
      `3. Without speaker labels, attribute speech only from clear textual evidence (self-references, being addressed by name). If you cannot tell who is speaking, EXCLUDE the moment.\n` +
      `Reply with STRICT JSON only: {"moments":[{"start_seconds":<number>,"reason":"<short label, max 10 words, same language as the instruction>","relevance":<0-100>}]}\n` +
      `Only include moments genuinely matching the instruction — reply {"moments":[]} if nothing matches.\n\n` +
      `USER INSTRUCTION: ${opts.prompt}\n\nTRANSCRIPT:\n${transcript}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 25_000);
    try {
      const resp = await doFetch(`${GEMINI_BASE}/${model}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text }] }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 4000,
            responseMimeType: "application/json",
          },
        }),
        signal: ctrl.signal,
      });
      if (!resp.ok) {
        log(`[prompt] Gemini HTTP ${resp.status}`);
        return null;
      }
      const data = (await resp.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      const reply = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim();
      return parseMomentsReply(reply);
    } catch (e) {
      log(`[prompt] Gemini request failed: ${(e as Error).message}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const results = await Promise.all(chunks.map(askChunk));
  const succeeded = results.filter((r): r is MomentCandidate[] => r !== null);
  if (succeeded.length === 0) {
    log("[prompt] every Gemini request failed", { chunks: chunks.length });
    return null;
  }
  const all = succeeded.flat();
  if (all.length === 0) {
    // The model ran fine and matched NOTHING — that's an answer, not a
    // failure. Callers must treat [] as "zero clips", never fall back to
    // off-prompt picks (that's exactly what users report as "it ignored
    // my prompt").
    log("[prompt] model matched zero moments", { chunks: chunks.length });
    return [];
  }
  const picked = pickPromptMoments(all, opts.totalDuration, opts.clipDuration, opts.count);
  log("[prompt] AI matched moments", { asked: opts.count, matched: picked.length, chunks: chunks.length });
  return picked;
}
