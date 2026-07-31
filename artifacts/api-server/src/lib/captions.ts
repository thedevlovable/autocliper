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

/** Hook lines — energetic EN + Hinglish mix, one per clip (rotated). */
const HOOKS = [
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
  "Yeh moment miss mat karna 🔥",
  "Itna clean moment, bas dekhte raho 🤌",
  "Aaj ka best scene, seedha yahan 🎯",
  "Skip kiya toh regret pakka 😬",
  "Full paisa-vasool moment 💯",
  "Ye wala part sabse zyada viral hua 🚀",
];

/** Optional second line — grounded in the clip's real duration. */
const SPICE = [
  (d: number) => `${d} seconds of pure chaos.`,
  (d: number) => `${d} seconds you'll watch twice.`,
  (d: number) => `Only ${d} seconds — blink and you'll miss it.`,
  (d: number) => `${d} sec hai, par kaafi hai.`,
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

  // Rotate hooks per clip so every clip in a job gets a different opener.
  const hook = HOOKS[(jobHash + input.clipIndex) % HOOKS.length];

  // ~50% of captions get a duration-grounded second line.
  const lines = [hook];
  if (input.durationSec >= 5 && (clipHash & 1) === 1) {
    const spice = SPICE[(clipHash >>> 1) % SPICE.length];
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
