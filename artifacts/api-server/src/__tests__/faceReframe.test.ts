/**
 * Face-follow reframe — pure math only (path smoothing, crop expression,
 * detector output picking). Model inference itself is exercised by a manual
 * smoke script, not unit tests — no face imagery in the repo.
 */
import { describe, it, expect } from "vitest";
import { buildFacePath, faceCropXExpr, pickFaceCx, resolveModelPath, shouldRetryDetectorLoad, type FaceSample } from "../lib/faceReframe";

import fs from "node:fs";
import { buildClipVf } from "../lib/clipFilter";

describe("shouldRetryDetectorLoad (transient failures must not disable reframing forever)", () => {
  it("never retries when there was no failure", () => {
    expect(shouldRetryDetectorLoad(0, Date.now())).toBe(false);
  });
  it("holds during the cooldown, retries after it", () => {
    const t0 = 1_000_000;
    expect(shouldRetryDetectorLoad(t0, t0 + 59_000)).toBe(false);
    expect(shouldRetryDetectorLoad(t0, t0 + 60_000)).toBe(true);
    expect(shouldRetryDetectorLoad(t0, t0 + 30_000, 20_000)).toBe(true);
  });
});

const mk = (vals: Array<number | null>, dt = 0.5): FaceSample[] =>
  vals.map((cx, i) => ({ t: i * dt, cx }));

describe("buildFacePath", () => {
  it("null when face coverage is under 40% (music video → center crop)", () => {
    expect(buildFacePath(mk([0.5, null, null, null, null, null, null, 0.5]))).toBeNull();
    expect(buildFacePath([])).toBeNull();
  });

  it("stable face → exactly one segment (rock-steady frame)", () => {
    const segs = buildFacePath(mk([0.5, 0.51, 0.49, 0.5, 0.52, 0.5, 0.49, 0.5]))!;
    expect(segs).toHaveLength(1);
    expect(segs[0].cx).toBeGreaterThan(0.4);
    expect(segs[0].cx).toBeLessThan(0.6);
  });

  it("jitter inside the deadzone never moves the crop", () => {
    const segs = buildFacePath(mk([0.5, 0.53, 0.47, 0.52, 0.48, 0.51, 0.5, 0.53]))!;
    expect(segs).toHaveLength(1);
  });

  it("a real move (speaker walks) creates a second segment near the move", () => {
    const segs = buildFacePath(mk([0.3, 0.3, 0.3, 0.3, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7]))!;
    expect(segs.length).toBe(2);
    expect(segs[1].cx).toBeGreaterThan(0.5);
    expect(segs[1].start).toBeGreaterThanOrEqual(1.5); // after min-dwell
  });

  it("gaps carry the last known position (brief look-away ≠ crop jump)", () => {
    const segs = buildFacePath(mk([0.4, 0.4, null, null, 0.4, 0.4, 0.4, 0.4]))!;
    expect(segs).toHaveLength(1);
  });

  it("rapid flip-flop is rate-limited by min-dwell", () => {
    const vals: number[] = [];
    for (let i = 0; i < 24; i++) vals.push(i % 2 === 0 ? 0.2 : 0.8);
    const segs = buildFacePath(mk(vals))!;
    // 12s of alternating every 0.5s with 1.5s dwell → far fewer than 24 segments
    expect(segs.length).toBeLessThanOrEqual(8);
  });
});

describe("faceCropXExpr", () => {
  it("single segment → plain clamped number, no commas", () => {
    const expr = faceCropXExpr([{ start: 0, cx: 0.5 }], 606, 1920);
    expect(expr).toBe(String((0.5 * 1920 - 303).toFixed(1).replace(/\.0$/, "")));
    expect(expr).not.toContain(",");
  });

  it("clamps to [0, contentW-cropW] at the edges", () => {
    expect(faceCropXExpr([{ start: 0, cx: 0 }], 606, 1920)).toBe("0");
    expect(faceCropXExpr([{ start: 0, cx: 1 }], 606, 1920)).toBe("1314");
  });

  it("two segments → if()-pan expression with escaped commas only", () => {
    const expr = faceCropXExpr([{ start: 0, cx: 0.3 }, { start: 4, cx: 0.7 }], 606, 1920);
    expect(expr).toContain("if(lt(t");
    expect(expr).toContain("\\,");
    expect(expr.replace(/\\,/g, "")).not.toContain(","); // every comma escaped
  });
});

describe("pickFaceCx", () => {
  it("picks the largest face above threshold, ignores low scores", () => {
    // two anchors: small face score .9 at x-center .25; big face score .8 at .75
    const scores = new Float32Array([0.1, 0.9, 0.2, 0.8]);
    const boxes = new Float32Array([
      0.2, 0.2, 0.3, 0.35,   // small
      0.6, 0.1, 0.9, 0.7,    // large
    ]);
    expect(pickFaceCx(scores, boxes)).toBeCloseTo(0.75, 5);
  });

  it("null when nothing clears the threshold", () => {
    const scores = new Float32Array([0.9, 0.1]);
    const boxes = new Float32Array([0.2, 0.2, 0.4, 0.4]);
    expect(pickFaceCx(scores, boxes)).toBeNull();
  });
});

describe("buildClipVf + faceCrop", () => {
  const base = { active: null, srcW: 1920, srcH: 1080, targetW: 1080, targetH: 1920, fps: 30 };

  it("uses the face x-expression instead of the static center crop", () => {
    const vf = buildClipVf({ ...base, faceCrop: { xExpr: "42.5", cropW: 606 } });
    expect(vf).toContain("crop=606:1080:42.5:0");
    expect(vf).not.toContain("crop=min(");
    expect(vf).toContain("scale=1080:1920");
  });

  it("without faceCrop the legacy center crop is untouched", () => {
    const vf = buildClipVf(base);
    expect(vf).toContain("crop=min(iw\\,ih*1080/1920):ih");
  });

  it("narrow content ignores faceCrop (blur-fill branch wins)", () => {
    const vf = buildClipVf({ ...base, srcW: 720, srcH: 1600, faceCrop: { xExpr: "10", cropW: 606 } });
    expect(vf).toContain("boxblur");
    expect(vf).not.toContain("crop=606");
  });
});

describe("resolveModelPath (regression: a layout change must not silently disable reframing)", () => {
  it("finds a real UltraFace model file from the src tree", () => {
    const p = resolveModelPath();
    expect(p).toBeTruthy();
    expect(p!).toMatch(/version-RFB-320\.onnx$/);
    // Not just present — actually the model, not a truncated placeholder.
    expect(fs.statSync(p!).size).toBeGreaterThan(100_000);
  });
});
