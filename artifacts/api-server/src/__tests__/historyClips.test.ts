import { describe, it, expect } from "vitest";
import { sanitizeClips, CLIP_FILE_TTL_MS } from "../routes/history";

describe("history clip sanitising", () => {
  const good = {
    id: "abcd1234efgh5678",
    name: "clip_1.mp4",
    label: "Clip 1",
    startTime: "0:10",
    endTime: "1:10",
    duration: "1:00",
    size: 12345,
    caption: "wow #viral",
  };

  it("keeps well-formed clips and drops thumbnails/extra fields", () => {
    const out = sanitizeClips([{ ...good, thumbnailDataUrl: "data:image/jpeg;base64,xxx" }]);
    expect(out).toHaveLength(1);
    expect(out![0]).toEqual(good);
    expect("thumbnailDataUrl" in out![0]).toBe(false);
  });

  it("rejects non-arrays and empty arrays", () => {
    expect(sanitizeClips(undefined)).toBeNull();
    expect(sanitizeClips("x")).toBeNull();
    expect(sanitizeClips([])).toBeNull();
    expect(sanitizeClips([null, 42, "clip"])).toBeNull();
  });

  it("drops clips with path-like or missing ids", () => {
    expect(sanitizeClips([{ ...good, id: "../../etc/passwd" }])).toBeNull();
    expect(sanitizeClips([{ ...good, id: "jobs/evil.json" }])).toBeNull();
    expect(sanitizeClips([{ ...good, id: "short" }])).toBeNull();
    expect(sanitizeClips([{ ...good, id: undefined }])).toBeNull();
  });

  it("caps clip count and coerces bad sizes", () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ ...good, id: `clipid${String(i).padStart(10, "0")}` }));
    expect(sanitizeClips(many)).toHaveLength(30);
    const out = sanitizeClips([{ ...good, size: "big", caption: 7 }]);
    expect(out![0].size).toBe(0);
    expect(out![0].caption).toBeUndefined();
  });

  it("carries the combined (full edit) marker only as a literal true", () => {
    const out = sanitizeClips([
      { ...good, combined: true },
      { ...good, id: "clipid2222efgh5678", combined: "yes" },
      { ...good, id: "clipid3333efgh5678" },
    ]);
    expect(out).toHaveLength(3);
    expect(out![0].combined).toBe(true);
    expect("combined" in out![1]).toBe(false);
    expect("combined" in out![2]).toBe(false);
  });

  it("TTL constant matches the 2-hour file store TTL", () => {
    expect(CLIP_FILE_TTL_MS).toBe(2 * 60 * 60 * 1000);
  });
});
