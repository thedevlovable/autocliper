/**
 * Face-follow reframing for vertical (9:16) clips — free, on-box, no paid API.
 *
 * How: sample the clip window at 2 fps as tiny 320x240 RGB frames (one cheap
 * ffmpeg decode), run the UltraFace RFB-320 ONNX detector (~1.2MB, MIT, CPU
 * ~10ms/frame via onnxruntime-node) on each frame, then turn the face-centre
 * timeline into a piecewise-constant crop path with short eased pans. The
 * final ffmpeg encode gets a crop x-EXPRESSION — no second encode pass.
 *
 * Design choices (deliberate):
 *  • Per-scene STATIC crop + 0.45s pans, not per-frame following: constant
 *    micro-panning looks amateur; podcasts are mostly static shots. A deadzone
 *    + minimum dwell keeps the frame rock-stable until the face really moves.
 *  • Largest face wins (closest/main speaker). Two-person side-by-side shots
 *    lock onto the bigger face rather than averaging (average = empty middle).
 *  • NEVER throws, and returns null on any doubt (model missing, <40% of
 *    frames have a face, content not wider than target). Callers fall back to
 *    the regular center-crop — a worse crop must never break clipping.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { CropRect } from "./clipFilter";

// Lazy import type only — onnxruntime-node is a native module; we load it at
// first use so a broken install can only disable reframing, never boot.
type OrtModule = typeof import("onnxruntime-node");
type OrtSession = import("onnxruntime-node").InferenceSession;

/** The model must resolve in every runtime shape: the esbuild bundle
 *  (__dirname = dist/ — build.mjs also copies the model to dist/assets/models
 *  and fails the build if it can't), the package root relative to dist/, and
 *  the src/lib tree that tests and tsx imports run from. The old single
 *  `../../` path silently broke in the bundle and disabled the feature. */
const MODEL_CANDIDATES = [
  path.join(__dirname, "assets/models/version-RFB-320.onnx"),        // next to the bundle (dist/)
  path.join(__dirname, "../assets/models/version-RFB-320.onnx"),     // dist/ → package root
  path.join(__dirname, "../../assets/models/version-RFB-320.onnx"),  // src/lib/ → package root
];

/** First existing model candidate, or null. Exported for the regression test
 *  that keeps a future bundler/layout change from silently killing reframing. */
export function resolveModelPath(): string | null {
  for (const p of MODEL_CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch { /* unreadable — keep looking */ }
  }
  return null;
}
const IN_W = 320, IN_H = 240;                 // UltraFace RFB-320 input
const FRAME_BYTES = IN_W * IN_H * 3;          // rawvideo rgb24
const SAMPLE_FPS = 2;
const MAX_FRAMES = 400;                       // 200s of clip — beyond any clip length
const SCORE_MIN = 0.62;
const MAX_SEGMENTS = 24;                      // keeps the ffmpeg expression sane

let ortLoad: Promise<{ ort: OrtModule; session: OrtSession } | null> | null = null;
let ortFailedAt = 0;
const ORT_RETRY_COOLDOWN_MS = 60_000;

/** May a previously failed detector load be retried yet? Exported for tests.
 *  A transient load failure (e.g. memory pressure during a traffic spike)
 *  must NOT disable face tracking until the next restart — that is exactly
 *  the "face tracking suddenly died in production" failure mode. */
export function shouldRetryDetectorLoad(failedAt: number, now: number, cooldownMs: number = ORT_RETRY_COOLDOWN_MS): boolean {
  return failedAt > 0 && now - failedAt >= cooldownMs;
}

/** Load onnxruntime + model once; null (and log) when unavailable. A failed
 *  load is retried after a cooldown instead of being cached forever. */
function loadSession(log?: Logger): Promise<{ ort: OrtModule; session: OrtSession } | null> {
  if (!ortLoad && (ortFailedAt === 0 || shouldRetryDetectorLoad(ortFailedAt, Date.now()))) {
    const attempt = (async () => {
      try {
        const modelPath = resolveModelPath();
        if (!modelPath) throw new Error(`model not found; tried: ${MODEL_CANDIDATES.join(" | ")}`);
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const ort = require("onnxruntime-node") as OrtModule;
        const session = await ort.InferenceSession.create(modelPath, {
          logSeverityLevel: 3, intraOpNumThreads: 2,
        });
        ortFailedAt = 0;
        return { ort, session };
      } catch (err) {
        log?.("[face] detector unavailable — reframe disabled (will retry)", { err: String((err as Error).message ?? err) });
        ortFailedAt = Date.now();
        return null;
      }
    })();
    ortLoad = attempt;
    // Clear the cached promise AFTER settlement (a .then, so it cannot race
    // the assignment above even when the attempt fails synchronously) — the
    // next call after the cooldown makes a fresh attempt. Successes stay
    // cached for the process lifetime.
    void attempt.then((res) => { if (res === null && ortLoad === attempt) ortLoad = null; });
  }
  return ortLoad ?? Promise.resolve(null);
}

type Logger = (msg: string, extra?: Record<string, unknown>) => void;

export interface FaceSample { t: number; cx: number | null }  // cx: 0..1 in CONTENT width
export interface PathSeg { start: number; cx: number }

/** Why a REQUESTED reframe didn't happen (geometry no-ops don't count —
 *  content that isn't wider than the target has nothing to follow). */
export type FaceSkipReason = "detector-unavailable" | "sampling-failed" | "low-coverage" | "error";

/** Decode one UltraFace output pair → centre-x (0..1, padded-frame coords) of
 *  the largest face above threshold, or null. Exported for tests. */
export function pickFaceCx(scores: Float32Array, boxes: Float32Array): number | null {
  let bestArea = 0, bestCx: number | null = null;
  const n = Math.min(scores.length / 2, boxes.length / 4);
  for (let i = 0; i < n; i++) {
    const score = scores[i * 2 + 1];
    if (score < SCORE_MIN) continue;
    const x1 = boxes[i * 4], y1 = boxes[i * 4 + 1], x2 = boxes[i * 4 + 2], y2 = boxes[i * 4 + 3];
    const area = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    if (area > bestArea) { bestArea = area; bestCx = (x1 + x2) / 2; }
  }
  return bestCx;
}

/**
 * Face-centre timeline → stable piecewise path.
 * Gap-fill (carry last), EMA smooth, then segment: a new segment starts only
 * after `breach` consecutive samples outside the deadzone AND `minDwell`s
 * since the last switch. Null when face coverage is too thin to trust (<40%).
 */
export function buildFacePath(
  samples: FaceSample[],
  cfg = { deadzone: 0.07, minDwell: 1.5, breach: 2, alpha: 0.45 },
): PathSeg[] | null {
  if (samples.length === 0) return null;
  const known = samples.filter((s) => s.cx != null);
  if (known.length / samples.length < 0.4) return null;

  let last = known[0].cx!;
  const filled = samples.map((s) => { if (s.cx != null) last = s.cx; return last; });

  let e = filled[0];
  const ema = filled.map((v) => { e = e + cfg.alpha * (v - e); return e; });

  const segs: PathSeg[] = [{ start: samples[0].t, cx: ema[0] }];
  let breachCount = 0, breachIdx = -1, lastSwitchT = samples[0].t;
  for (let i = 1; i < ema.length; i++) {
    if (Math.abs(ema[i] - segs[segs.length - 1].cx) > cfg.deadzone) {
      breachCount++;
      if (breachIdx < 0) breachIdx = i;
      if (breachCount >= cfg.breach && samples[i].t - lastSwitchT >= cfg.minDwell && segs.length < MAX_SEGMENTS) {
        // Land on the MEDIAN of the raw positions since the breach began —
        // the lagging EMA would land short and force a second catch-up pan.
        const win = filled.slice(breachIdx, i + 1).sort((a, b) => a - b);
        const target = win.length % 2
          ? win[(win.length - 1) / 2]
          : (win[win.length / 2 - 1] + win[win.length / 2]) / 2;
        // Oscillation guard: if the median lands where we already are (pure
        // back-and-forth flicker), it's noise — don't emit a no-op segment.
        if (Math.abs(target - segs[segs.length - 1].cx) > cfg.deadzone) {
          segs.push({ start: samples[breachIdx].t, cx: target });
          lastSwitchT = samples[breachIdx].t;
        }
        breachCount = 0; breachIdx = -1;
      }
    } else { breachCount = 0; breachIdx = -1; }
  }
  return segs;
}

/**
 * Path → ffmpeg crop x-expression (piecewise-constant with `panSec` linear
 * eases at boundaries), clamped to [0, contentW-cropW], commas escaped for
 * embedding straight into a -vf chain. Exported for tests.
 */
export function faceCropXExpr(segs: PathSeg[], cropW: number, contentW: number, panSec = 0.45): string {
  const maxX = Math.max(0, contentW - cropW);
  const xs = segs.map((s) => {
    const x = Math.min(maxX, Math.max(0, s.cx * contentW - cropW / 2));
    return Math.round(x * 10) / 10;
  });
  let expr = String(xs[xs.length - 1]);
  for (let k = xs.length - 2; k >= 0; k--) {
    const b = Math.round(segs[k + 1].start * 100) / 100;
    const bEnd = Math.round((b + panSec) * 100) / 100;
    expr =
      `if(lt(t,${b}),${xs[k]},` +
      `if(lt(t,${bEnd}),${xs[k]}+(${xs[k + 1]}-(${xs[k]}))*(t-${b})/${panSec},${expr}))`;
  }
  return expr.replace(/,/g, "\\,");
}

/** Run ffmpeg → raw 320x240 rgb24 frames at SAMPLE_FPS for the clip window.
 *  `preCrop` confines decoding to the active picture so detector coords match
 *  the content space the final crop runs in. */
function sampleFrames(opts: {
  ffmpegPath: string; srcPath: string; seekSec: number; durationSec: number; preCrop: CropRect | null;
}): Promise<Buffer> {
  const vf =
    (opts.preCrop ? `crop=${opts.preCrop.w}:${opts.preCrop.h}:${opts.preCrop.x}:${opts.preCrop.y},` : "") +
    `fps=${SAMPLE_FPS},scale=${IN_W}:${IN_H}:force_original_aspect_ratio=decrease,` +
    `pad=${IN_W}:${IN_H}:(ow-iw)/2:(oh-ih)/2`;
  const args = [
    "-hide_banner", "-loglevel", "error",
    "-ss", opts.seekSec.toFixed(3), "-t", opts.durationSec.toFixed(3),
    "-i", opts.srcPath, "-vf", vf,
    "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
  ];
  return new Promise<Buffer>((resolve, reject) => {
    const proc = spawn(opts.ffmpegPath, args, { stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let total = 0;
    const cap = (MAX_FRAMES + 2) * FRAME_BYTES;
    const timer = setTimeout(() => { proc.kill("SIGKILL"); reject(new Error("frame sampling timed out")); }, 60_000);
    proc.stdout.on("data", (c: Buffer) => {
      total += c.length;
      if (total <= cap) chunks.push(c);
      else proc.kill("SIGKILL"); // enough frames — stop decoding
    });
    proc.on("error", (err) => { clearTimeout(timer); reject(err); });
    proc.on("close", () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
  });
}

// ── Sampling concurrency gate ─────────────────────────────────────────────────
// One sampling window buffers up to (MAX_FRAMES+2) raw 320x240 frames ≈ 93 MB.
// Unbounded concurrency (jobs × clips) is what pushed small servers into OOM —
// which then also knocked the detector load out. Two slots keep the worst case
// under ~190 MB while still overlapping sampling with encodes.
const FACE_SAMPLE_PARALLEL = Math.max(1, Number.parseInt(process.env.FACE_SAMPLE_PARALLEL ?? "2", 10) || 1);
let faceSlotsBusy = 0;
const faceSlotWaiters: Array<() => void> = [];
async function withFaceSlot<T>(fn: () => Promise<T>): Promise<T> {
  // Re-check after every wake-up: a fresh caller can slip in synchronously
  // between a slot being freed and this waiter's microtask running.
  while (faceSlotsBusy >= FACE_SAMPLE_PARALLEL) {
    await new Promise<void>((resolve) => faceSlotWaiters.push(resolve));
  }
  faceSlotsBusy += 1;
  try {
    return await fn();
  } finally {
    faceSlotsBusy -= 1;
    faceSlotWaiters.shift()?.();
  }
}

/**
 * Main entry: compute the face-follow crop for one clip window.
 * Returns `{ xExpr, cropW }` for buildClipVf, or null → caller keeps the
 * regular center-crop. Never throws.
 */
export async function computeFaceCropExpr(opts: {
  srcPath: string; seekSec: number; durationSec: number;
  active: CropRect | null; srcW: number | null; srcH: number | null;
  targetW: number; targetH: number;
  ffmpegPath: string; log?: Logger;
  /** Detector-unavailable is a WARNING (the user asked for a feature the
   *  server can't deliver), not chatter — route it above info level. */
  warn?: Logger;
  /** Fired when the user asked for face tracking and it could have applied
   *  (wide content) but didn't — lets the job surface an honest note instead
   *  of silently shipping center crops. */
  onSkip?: (reason: FaceSkipReason) => void;
}): Promise<{ xExpr: string; cropW: number } | null> {
  try {
    const contentW = opts.active?.w ?? opts.srcW;
    const contentH = opts.active?.h ?? opts.srcH;
    if (!contentW || !contentH || contentW <= 0 || contentH <= 0) return null;
    // Only useful when the content is meaningfully WIDER than the target —
    // otherwise there is no horizontal room to follow anything.
    if (contentW / contentH <= (opts.targetW / opts.targetH) * 1.02) return null;
    const cropW = Math.floor(Math.min(contentW, (contentH * opts.targetW) / opts.targetH) / 2) * 2;
    if (contentW - cropW < 8) return null;

    const loaded = await loadSession(opts.warn ?? opts.log);
    if (!loaded) { opts.onSkip?.("detector-unavailable"); return null; }
    const { ort, session } = loaded;

    // Sampling + inference hold a face slot — see the gate above for why.
    return await withFaceSlot(async () => {
      const raw = await sampleFrames({
        ffmpegPath: opts.ffmpegPath, srcPath: opts.srcPath,
        seekSec: opts.seekSec, durationSec: opts.durationSec, preCrop: opts.active,
      });
      const frameCount = Math.min(Math.floor(raw.length / FRAME_BYTES), MAX_FRAMES);
      if (frameCount < 2) { opts.onSkip?.("sampling-failed"); return null; }

      // Letterbox mapping: content is drawn centred at scale s inside 320x240.
      const s = Math.min(IN_W / contentW, IN_H / contentH);
      const drawW = Math.max(1, Math.round(contentW * s));
      const padX = (IN_W - drawW) / 2;

      const samples: FaceSample[] = [];
      const input = new Float32Array(3 * IN_H * IN_W);
      for (let f = 0; f < frameCount; f++) {
        const base = f * FRAME_BYTES;
        // HWC rgb24 → CHW float, (v-127)/128 (UltraFace preprocessing)
        for (let p = 0; p < IN_H * IN_W; p++) {
          input[p] = (raw[base + p * 3] - 127) / 128;
          input[IN_H * IN_W + p] = (raw[base + p * 3 + 1] - 127) / 128;
          input[2 * IN_H * IN_W + p] = (raw[base + p * 3 + 2] - 127) / 128;
        }
        const out = await session.run({ input: new ort.Tensor("float32", input, [1, 3, IN_H, IN_W]) });
        const cxPad = pickFaceCx(out.scores.data as Float32Array, out.boxes.data as Float32Array);
        const cx = cxPad == null ? null : Math.min(1, Math.max(0, (cxPad * IN_W - padX) / drawW));
        samples.push({ t: f / SAMPLE_FPS, cx });
      }

      const found = samples.filter((sm) => sm.cx != null).length;
      const segs = buildFacePath(samples);
      opts.log?.("[face] sampled", { frames: frameCount, withFace: found, segments: segs?.length ?? 0 });
      if (!segs) { opts.onSkip?.("low-coverage"); return null; }
      return { xExpr: faceCropXExpr(segs, cropW, contentW), cropW };
    });
  } catch (err) {
    (opts.warn ?? opts.log)?.("[face] reframe failed — using center crop", { err: String((err as Error).message ?? err) });
    opts.onSkip?.("error");
    return null;
  }
}
