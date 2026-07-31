/**
 * Styled subtitle burning for platform clips.
 *
 * Turns the transcript segments the highlight picker already fetches into
 * per-clip ASS subtitle files that ffmpeg (libass) burns straight onto the
 * video. Everything here is pure string/number logic so it unit-tests without
 * ffmpeg — the burn itself is just `,subtitles=…` appended to the clip's
 * -vf chain by the route layer.
 *
 * Fonts: the runtime ships DejaVu (Sans/Serif/Mono) only, so every style maps
 * onto those. No Devanagari/CJK fonts are installed — the transcript fetch is
 * English-only (`--sub-langs en…`), which keeps glyph coverage safe.
 *
 * ASS colours are &HAABGR (blue-green-red, alpha first, 00 = opaque).
 */
import type { TranscriptSegment } from "./highlightPicker";

export interface SubCue { start: number; end: number; text: string }

/** Keep ids in lockstep with SUB_STYLES in the frontend clipper page. */
export const SUBTITLE_STYLE_IDS = [
  "basic", "modern", "hormozi", "classic", "heat", "icy", "ghost",
  "editorial", "tallboy", "elegant", "clean", "highlight", "roundtable",
  "matrix", "bubbly", "funky", "miner",
] as const;
export type SubtitleStyleId = (typeof SUBTITLE_STYLE_IDS)[number];

/** Body shape is untrusted — accept `{ style: "heat" }`-ish objects only. */
export function normalizeSubtitleStyle(raw: unknown): SubtitleStyleId | null {
  if (!raw || typeof raw !== "object") return null;
  const style = (raw as { style?: unknown }).style;
  return (SUBTITLE_STYLE_IDS as readonly unknown[]).includes(style)
    ? (style as SubtitleStyleId)
    : null;
}

const MAX_WORDS_PER_CUE = 3;
const MIN_CUE_SECONDS = 0.35;

/** Strip HTML-ish tags/whitespace down to plain renderable words. */
function cleanText(t: string): string {
  return t.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Cut the video-wide transcript down to one clip's window and re-chunk it into
 * short, punchy cues (≤3 words) with linearly interpolated timings — the
 * standard shorts-caption cadence. Result times are relative to the clip's
 * own t=0.
 */
export function cuesForClip(
  segments: TranscriptSegment[],
  clipStart: number,
  clipEnd: number,
): SubCue[] {
  const cues: SubCue[] = [];
  for (const seg of segments) {
    if (seg.end <= clipStart || seg.start >= clipEnd) continue;
    const text = cleanText(seg.text);
    if (!text) continue;
    const words = text.split(" ");
    const segDur = Math.max(0.001, seg.end - seg.start);
    let consumed = 0; // words consumed — keeps interpolation exact on the uneven last chunk
    for (let i = 0; i < words.length; i += MAX_WORDS_PER_CUE) {
      const chunk = words.slice(i, i + MAX_WORDS_PER_CUE);
      const s = seg.start + (consumed / words.length) * segDur;
      consumed += chunk.length;
      const e = seg.start + (consumed / words.length) * segDur;
      const start = Math.max(s, clipStart);
      const end = Math.min(e, clipEnd);
      if (end - start < 0.05) continue;
      cues.push({ start: start - clipStart, end: end - clipStart, text: chunk.join(" ") });
    }
  }
  cues.sort((a, b) => a.start - b.start);
  // Enforce a minimum on-screen time. A cue may grow toward MIN_CUE_SECONDS
  // but never past the next cue's start or the clip's end — and never shrink.
  for (let i = 0; i < cues.length; i++) {
    const maxEnd = Math.min(
      i + 1 < cues.length ? cues[i + 1].start : Infinity,
      clipEnd - clipStart,
    );
    const target = Math.min(cues[i].start + MIN_CUE_SECONDS, maxEnd);
    if (target > cues[i].end) cues[i].end = target;
  }
  return cues;
}

interface AssStyle {
  font: "DejaVu Sans" | "DejaVu Serif" | "DejaVu Sans Mono";
  size: number;
  primary: string;
  outline: string;
  back: string;
  bold: 0 | -1;
  italic: 0 | -1;
  scaleY: number;
  spacing: number;
  /** 1 = outline+shadow, 3 = opaque box behind the text. */
  borderStyle: 1 | 3;
  outlineW: number;
  shadow: number;
  uppercase?: boolean;
}

/** Visual map for every gallery style — tuned for 1080×1920 canvases. */
const STYLES: Record<SubtitleStyleId, AssStyle> = {
  basic:      { font: "DejaVu Sans", size: 60, primary: "&H00FFFFFF", outline: "&H00101010", back: "&H00101010", bold: -1, italic: 0,  scaleY: 100, spacing: 0, borderStyle: 3, outlineW: 10, shadow: 0 },
  modern:     { font: "DejaVu Sans", size: 62, primary: "&H00FFFFFF", outline: "&H82000000", back: "&H00000000", bold: -1, italic: 0,  scaleY: 100, spacing: 0, borderStyle: 1, outlineW: 2,  shadow: 0 },
  hormozi:    { font: "DejaVu Sans", size: 76, primary: "&H00FFFFFF", outline: "&H00000000", back: "&H00000000", bold: -1, italic: 0,  scaleY: 100, spacing: 0, borderStyle: 1, outlineW: 6,  shadow: 2, uppercase: true },
  classic:    { font: "DejaVu Sans", size: 64, primary: "&H0000E1FF", outline: "&H00000000", back: "&H00000000", bold: -1, italic: -1, scaleY: 100, spacing: 0, borderStyle: 1, outlineW: 3,  shadow: 1 },
  heat:       { font: "DejaVu Sans", size: 68, primary: "&H000095FF", outline: "&H000030B0", back: "&H00000000", bold: -1, italic: 0,  scaleY: 100, spacing: 0, borderStyle: 1, outlineW: 3,  shadow: 1 },
  icy:        { font: "DejaVu Sans", size: 66, primary: "&H00FFE87D", outline: "&H00A05A00", back: "&H00000000", bold: -1, italic: 0,  scaleY: 100, spacing: 0, borderStyle: 1, outlineW: 3,  shadow: 0 },
  ghost:      { font: "DejaVu Sans", size: 64, primary: "&H50FFFFFF", outline: "&H50000000", back: "&H00000000", bold: -1, italic: 0,  scaleY: 100, spacing: 0, borderStyle: 1, outlineW: 1,  shadow: 0 },
  editorial:  { font: "DejaVu Sans", size: 46, primary: "&H00D9D9D9", outline: "&H00000000", back: "&H00000000", bold: 0,  italic: 0,  scaleY: 100, spacing: 6, borderStyle: 1, outlineW: 2,  shadow: 0, uppercase: true },
  tallboy:    { font: "DejaVu Sans", size: 62, primary: "&H00FFFFFF", outline: "&H00000000", back: "&H00000000", bold: -1, italic: 0,  scaleY: 150, spacing: 0, borderStyle: 1, outlineW: 4,  shadow: 1, uppercase: true },
  elegant:    { font: "DejaVu Serif", size: 60, primary: "&H00C9E9F5", outline: "&H00403020", back: "&H00000000", bold: 0, italic: -1, scaleY: 100, spacing: 1, borderStyle: 1, outlineW: 2,  shadow: 0 },
  clean:      { font: "DejaVu Sans", size: 62, primary: "&H00FFFFFF", outline: "&H00202020", back: "&H00000000", bold: -1, italic: 0,  scaleY: 100, spacing: 0, borderStyle: 1, outlineW: 2,  shadow: 0 },
  highlight:  { font: "DejaVu Sans", size: 62, primary: "&H00000000", outline: "&H0017FED1", back: "&H0017FED1", bold: -1, italic: 0,  scaleY: 100, spacing: 0, borderStyle: 3, outlineW: 10, shadow: 0 },
  roundtable: { font: "DejaVu Sans", size: 60, primary: "&H00000000", outline: "&H005EC522", back: "&H005EC522", bold: -1, italic: 0,  scaleY: 100, spacing: 0, borderStyle: 3, outlineW: 10, shadow: 0 },
  matrix:     { font: "DejaVu Sans Mono", size: 60, primary: "&H0055FF22", outline: "&H00003300", back: "&H00000000", bold: -1, italic: 0, scaleY: 100, spacing: 0, borderStyle: 1, outlineW: 2, shadow: 0 },
  bubbly:     { font: "DejaVu Sans", size: 68, primary: "&H00D25FFF", outline: "&H00FFFFFF", back: "&H00000000", bold: -1, italic: 0,  scaleY: 100, spacing: 0, borderStyle: 1, outlineW: 3,  shadow: 1 },
  funky:      { font: "DejaVu Sans", size: 68, primary: "&H00FF3CC8", outline: "&H0000D6FF", back: "&H00000000", bold: -1, italic: 0,  scaleY: 100, spacing: 0, borderStyle: 1, outlineW: 3,  shadow: 1 },
  miner:      { font: "DejaVu Sans", size: 66, primary: "&H0014FF39", outline: "&H00003B06", back: "&H00000000", bold: -1, italic: 0,  scaleY: 100, spacing: 0, borderStyle: 1, outlineW: 3,  shadow: 0 },
};

function assTime(t: number): string {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
}

/** ASS override braces / backslashes would inject style tags — strip them. */
function escapeAssText(t: string): string {
  return t.replace(/[\\{}]/g, "").replace(/\r?\n/g, " ");
}

/** Build a complete .ass document for one clip's cues in the given style. */
export function buildAss(
  cues: SubCue[],
  styleId: SubtitleStyleId,
  opts?: { playResX?: number; playResY?: number },
): string {
  const st = STYLES[styleId];
  const w = opts?.playResX ?? 1080;
  const h = opts?.playResY ?? 1920;
  // Captions sit in the lower fifth — clear of platform UI overlays.
  const marginV = Math.round(h * 0.19);
  const header = [
    "[Script Info]",
    "; AutoCliper burned captions",
    "ScriptType: v4.00+",
    `PlayResX: ${w}`,
    `PlayResY: ${h}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Cap,${st.font},${st.size},${st.primary},&H000000FF,${st.outline},${st.back},${st.bold},${st.italic},0,0,100,${st.scaleY},${st.spacing},0,${st.borderStyle},${st.outlineW},${st.shadow},2,90,90,${marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const lines = cues.map((c) => {
    const text = escapeAssText(st.uppercase ? c.text.toUpperCase() : c.text);
    return `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Cap,,0,0,0,,${text}`;
  });
  return header.concat(lines).join("\n") + "\n";
}

/** ffmpeg -vf argument burning `assPath` — escaped for the filter parser. */
export function subtitlesVfArg(assPath: string): string {
  const esc = assPath.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return `subtitles=filename='${esc}'`;
}
