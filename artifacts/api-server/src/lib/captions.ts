/**
 * Viral-style caption generator — one ready-to-paste caption (hook line +
 * hashtags) per finished clip.
 *
 * Deliberately template-based, NOT an LLM call: captions must be free,
 * instant, offline-safe, and behave identically in dev and on autoscale
 * prod. Variety comes from a hash of the source URL (per-job flavor) plus a
 * per-clip rotation, so the same job always produces the same captions
 * (stable across polls, cache hits, and instance handoffs — the value is
 * stored on the clip record anyway) while different sources feel different.
 */

export interface ClipCaptionInput {
  /** Source kind: youtube | twitch | kick | drive | dropbox | upload | unknown. */
  srcKind: string;
  /** Output format the user picked (shorts | original). */
  outputFormat: string;
  clipIndex: number;   // 0-based
  clipCount: number;
  durationSec: number; // this clip's length in seconds
  /** Original filename for device uploads — the best topic hint we have. */
  sourceName?: string;
  /** Stable seed — the source URL is a good choice. */
  seed: string;
  /** Detected language of the source speech/title. Defaults to a best-effort
   * detection from sourceName, then English. */
  language?: CaptionLanguage;
}

export type CaptionLanguage = "en" | "hi";

const DEVANAGARI_RE = /[\u0900-\u097f]/u;
const HINDI_LATIN_WORDS = new Set([
  "aap", "aaj", "achha", "acha", "aur", "badiya", "bhai", "bas", "dekho",
  "dekhe", "hai", "hain", "hoga", "kaise", "karna", "karo", "kya", "lagega",
  "mat", "mera", "meri", "nahi", "nahin", "paisa", "pक्का", "pakka", "phir",
  "sabse", "sahi", "wala", "wali", "yeh", "ye", "zabardast",
]);

/** Best-effort, local language detection for generated social captions.
 * Devanagari is authoritative; romanized Hindi is detected from common
 * function/hype words. If there is no usable text, keep the supplied fallback. */
export function detectCaptionLanguage(text?: string, fallback: CaptionLanguage = "en"): CaptionLanguage {
  const value = (text ?? "").trim();
  if (!value) return fallback;
  const letters = [...value].filter(ch => /\p{L}/u.test(ch));
  if (letters.length > 0 && letters.filter(ch => DEVANAGARI_RE.test(ch)).length >= 2) return "hi";

  const words = value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  const hindiHits = words.filter(word => HINDI_LATIN_WORDS.has(word)).length;
  return hindiHits >= 2 ? "hi" : "en";
}

// FNV-1a 32-bit — tiny, deterministic, good spread for template picks.
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Deterministic PRNG for the hashtag shuffle.
function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hook lines for English content. */
const EN_HOOKS = [
  "Wait for it… 🤯",
  "This part broke the internet 🔥",
  "POV: you can't stop rewatching this 👀",
  "Sound ON for this one 🔊",
  "The ending is INSANE ⚡",
  "Nobody talks about this moment 🤫",
  "Watch till the end, trust me 🚀",
  "Bro really did that 💀",
  "This went 0 to 100 real quick 📈",
  "Certified rewatch moment 🔁",
  "You weren't ready for this one 😳",
  "Main character energy only 😤",
];

/** Hook lines for Hindi content. */
const HI_HOOKS = [
  "रुको, ये हिस्सा मिस मत करना… 🤯",
  "इस पल ने सबको हैरान कर दिया 🔥",
  "इसे बार-बार देखने से खुद को रोक नहीं पाओगे 👀",
  "आवाज़ बढ़ा दो 🔊",
  "अंत में जो हुआ, वो जबरदस्त है ⚡",
  "इस पल की कोई बात नहीं करता 🤫",
  "अंत तक देखना, भरोसा रखो 🚀",
  "भाई ने सच में कर दिखाया 💀",
  "ये पल अचानक 0 से 100 हो गया 📈",
  "फिर से देखने लायक पल 🔁",
  "इसके लिए तुम तैयार नहीं थे 😳",
  "सिर्फ मुख्य किरदार वाली ऊर्जा 😤",
  "ये पल बिल्कुल मिस मत करना 🔥",
  "आज का सबसे बढ़िया सीन 🎯",
  "स्किप किया तो पछताओगे 😬",
  "पूरा पैसा वसूल पल 💯",
  "ये हिस्सा सबसे ज्यादा वायरल हुआ 🚀",
];

/** Optional English second line — grounded in the clip's real duration. */
const EN_SPICE = [
  (d: number) => `${d} seconds of pure chaos.`,
  (d: number) => `${d} seconds you'll watch twice.`,
  (d: number) => `Only ${d} seconds — blink and you'll miss it.`,
];

/** Optional Hindi second line — grounded in the clip's real duration. */
const HI_SPICE = [
  (d: number) => `${d} सेकंड का पूरा बवाल।`,
  (d: number) => `${d} सेकंड, दोबारा जरूर देखोगे।`,
  (d: number) => `सिर्फ ${d} सेकंड — पलक झपकी तो मिस हो जाएगा।`,
  (d: number) => `${d} सेकंड हैं, लेकिन काफी हैं।`,
];

const CORE_TAGS = [
  "#viral", "#trending", "#fyp", "#foryou", "#explore",
  "#viralvideo", "#reels", "#shorts", "#reelsinstagram", "#trendingnow",
];

const SRC_TAGS: Record<string, string[]> = {
  youtube: ["#youtube", "#youtubeshorts"],
  twitch:  ["#twitch", "#twitchclips", "#streamer"],
  kick:    ["#kick", "#kickstreamer", "#livestream"],
};

/** Filler words that make useless hashtags (EN + romanized HI). */
const STOP_WORDS = new Set([
  "the", "and", "for", "with", "this", "that", "from", "video", "videos",
  "clip", "clips", "final", "edit", "copy", "new", "file", "full", "part",
  "aur", "wala", "wali", "mera", "meri", "kaa", "kii", "kee", "hai", "con",
  // Machine/file noise that survives the digit filter as pure words:
  "whatsapp", "untitled", "export", "output", "recording", "record",
  "screen", "movie", "media", "audio", "track", "hevc", "uhd", "hdr",
  // Camera/app filename prefixes (IMG_2024…, DSC_, VID_, GoPro, DJI…):
  "img", "dsc", "vid", "mov", "mvi", "cam", "raw", "tmp", "temp",
  "obs", "dji", "gopro",
]);

/** Pull up to two topic hashtags out of an uploaded file's name. */
function topicTags(name?: string): string[] {
  if (!name) return [];
  const base = name.replace(/\.[a-z0-9]{2,5}$/i, ""); // drop the extension
  const words = base
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(w =>
      // Human topics only: any digit marks a machine token (IMG_2024, x264,
      // 1080p, UUID fragments like 41d4) — none of those make a hashtag you'd
      // want under a reel. Overly long tokens are opaque ids, not words.
      w.length >= 3 && w.length <= 16 && !STOP_WORDS.has(w) && !/\d/.test(w),
    );
  const uniq = [...new Set(words)];
  uniq.sort((a, b) => b.length - a.length); // longest words carry the topic
  return uniq.slice(0, 2).map(w => `#${w}`);
}

/** Build the full caption (hook + optional duration line + hashtags). */
export function buildClipCaption(input: ClipCaptionInput): string {
  const jobHash = hash32(input.seed);
  const clipHash = hash32(`${input.seed}#${input.clipIndex}`);
  const language = input.language ?? detectCaptionLanguage(input.sourceName);

  // Rotate hooks per clip so every clip in a job gets a different opener.
  const hooks = language === "hi" ? HI_HOOKS : EN_HOOKS;
  const hook = hooks[(jobHash + input.clipIndex) % hooks.length];

  // ~50% of captions get a duration-grounded second line.
  const lines = [hook];
  if (input.durationSec >= 5 && (clipHash & 1) === 1) {
    const spiceList = language === "hi" ? HI_SPICE : EN_SPICE;
    const spice = spiceList[(clipHash >>> 1) % spiceList.length];
    lines.push(spice(Math.round(input.durationSec)));
  }

  // Hashtags: topic first (most specific), then source, then a seeded pick
  // of the core viral pool. Dedupe, cap at 12.
  const rnd = mulberry32(jobHash ^ Math.imul(input.clipIndex + 1, 0x9e3779b9));
  const core = [...CORE_TAGS];
  for (let i = core.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [core[i], core[j]] = [core[j], core[i]];
  }
  const tags: string[] = [];
  for (const t of [
    ...topicTags(input.sourceName),
    ...(SRC_TAGS[input.srcKind] ?? []),
    ...core.slice(0, 7),
  ]) {
    if (!tags.includes(t)) tags.push(t);
    if (tags.length >= 12) break;
  }

  return `${lines.join("\n")}\n\n${tags.join(" ")}`;
}
