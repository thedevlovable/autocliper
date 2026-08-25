/**
 * Unit tests for lib/concatClips.ts — the "full edit" merge helper.
 *
 * Covered:
 *   1. chronologicalOrder — merged edits replay the source video in order.
 *   2. buildConcatList — demuxer directive escaping (quotes, newlines).
 *   3. concatClipFiles — stream-copy first, re-encode fallback, never throws.
 */
import { describe, it, expect, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { buildConcatList, chronologicalOrder, concatClipFiles, type ConcatExec } from "../lib/concatClips";

describe("chronologicalOrder", () => {
  it("orders clip indices by start time", () => {
    expect(chronologicalOrder([120, 30, 400, 0])).toEqual([3, 1, 0, 2]);
  });
  it("is stable for identical starts", () => {
    expect(chronologicalOrder([50, 50, 10])).toEqual([2, 0, 1]);
  });
  it("handles empty input", () => {
    expect(chronologicalOrder([])).toEqual([]);
  });
});

describe("buildConcatList", () => {
  it("writes one file directive per path with a trailing newline", () => {
    expect(buildConcatList(["/a/clip_000.mp4", "/a/clip_001.mp4"]))
      .toBe("file '/a/clip_000.mp4'\nfile '/a/clip_001.mp4'\n");
  });
  it("escapes single quotes so a path can't close the directive", () => {
    expect(buildConcatList(["/tmp/it's here/c.mp4"]))
      .toBe(`file '/tmp/it'\\''s here/c.mp4'\n`);
  });
  it("strips newlines so no path can inject extra directives", () => {
    expect(buildConcatList(["/tmp/a\nfile 'evil'/b.mp4"]))
      .toBe("file '/tmp/afile '\\''evil'\\''/b.mp4'\n");
  });
});

describe("concatClipFiles", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "concat-test-"));
  const inputs = [path.join(tmp, "a.mp4"), path.join(tmp, "b.mp4")];
  const output = path.join(tmp, "out.mp4");
  const base = { inputs, output, ffmpegPath: "ffmpeg", encode: { preset: "veryfast", crf: "23" } };

  it("returns false without touching ffmpeg when fewer than 2 inputs", async () => {
    const exec = vi.fn(async () => ({}));
    expect(await concatClipFiles({ ...base, inputs: [inputs[0]], execImpl: exec })).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });

  it("stream-copies on the first pass and writes the list file", async () => {
    const exec = vi.fn<ConcatExec>(async () => ({}));
    expect(await concatClipFiles({ ...base, execImpl: exec })).toBe(true);
    expect(exec).toHaveBeenCalledTimes(1);
    const args = exec.mock.calls[0][1];
    expect(args).toContain("concat");
    expect(args).toContain("copy");
    // The list file sits next to the output and holds both inputs in order.
    expect(fs.readFileSync(`${output}.txt`, "utf8")).toBe(buildConcatList(inputs));
  });

  it("falls back to a re-encode when stream copy fails", async () => {
    const exec = vi.fn()
      .mockRejectedValueOnce(new Error("copy failed"))
      .mockResolvedValueOnce({});
    const warns: string[] = [];
    expect(
      await concatClipFiles({ ...base, execImpl: exec as unknown as ConcatExec, warn: (m) => warns.push(m) }),
    ).toBe(true);
    expect(exec).toHaveBeenCalledTimes(2);
    const args = exec.mock.calls[1][1] as string[];
    expect(args).toContain("libx264");
    // The fallback mirrors the clip encode profile.
    expect(args).toContain("veryfast");
    expect(args).toContain("23");
    expect(warns.some((w) => w.includes("stream-copy"))).toBe(true);
  });

  it("never throws — both passes failing just returns false", async () => {
    const exec = vi.fn(async () => { throw new Error("boom"); });
    expect(await concatClipFiles({ ...base, execImpl: exec })).toBe(false);
    expect(exec).toHaveBeenCalledTimes(2);
  });
});
