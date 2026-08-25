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
  const buckets = new Map<number, string[]>();
  for (const s of segments) {
    if (!(s.start >= 0)) continue;
    const text = s.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const b = Math.floor(s.start / TRANSCRIPT_BUCKET_SEC);
    const arr = buckets.get(b);
    if (arr) arr.push(text);
    else buckets.set(b, [text]);
  }
  const lines: string[] = [];
  for (const b of [...buckets.keys()].sort((a, z) => a - z)) {
    const t = b * TRANSCRIPT_BUCKET_SEC;
    const m = Math.floor(t / 60);
    lines.push(`[${m}:${String(t % 60).padStart(2, "0")}] ${buckets.get(b)!.join(" ")}`);
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

  const askChunk = async (transcript: string): Promise<MomentCandidate[]> => {
    const text =
      `You pick video clip moments. Below is a timed transcript (each line starts with [minutes:seconds]) and a user instruction.\n` +
      `Find up to ${perChunk} moments that BEST match the instruction. Each clip runs ${Math.round(opts.clipDuration)} seconds from its start, so choose starts where the matching content begins.\n` +
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
        return [];
      }
      const data = (await resp.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      const reply = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim();
      return parseMomentsReply(reply);
    } catch (e) {
      log(`[prompt] Gemini request failed: ${(e as Error).message}`);
      return [];
    } finally {
      clearTimeout(timer);
    }
  };

  const results = await Promise.all(chunks.map(askChunk));
  const all = results.flat();
  if (all.length === 0) {
    log("[prompt] no matching moments returned", { chunks: chunks.length });
    return null;
  }
  const picked = pickPromptMoments(all, opts.totalDuration, opts.clipDuration, opts.count);
  log("[prompt] AI matched moments", { asked: opts.count, matched: picked.length, chunks: chunks.length });
  return picked.length > 0 ? picked : null;
}
