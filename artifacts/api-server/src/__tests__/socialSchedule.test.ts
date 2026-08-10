/**
 * Pure-logic tests for the bulk social scheduler — slot math, timezone
 * conversion, input validation and URL handling. No network, no DB writes.
 */
import { describe, it, expect } from "vitest";
import {
  zonedTimeToUtc,
  computeSlots,
  isRealDate,
  isBlockedHost,
  dropboxDirect,
  prettyName,
} from "../routes/socialSchedule";

describe("zonedTimeToUtc", () => {
  it("converts IST wall time (no DST) to UTC", () => {
    expect(zonedTimeToUtc("2026-08-11", "18:00", "Asia/Kolkata").toISOString())
      .toBe("2026-08-11T12:30:00.000Z");
  });
  it("handles US Eastern winter (EST, UTC-5)", () => {
    expect(zonedTimeToUtc("2026-01-15", "18:00", "America/New_York").toISOString())
      .toBe("2026-01-15T23:00:00.000Z");
  });
  it("handles US Eastern summer (EDT, UTC-4)", () => {
    expect(zonedTimeToUtc("2026-07-15", "18:00", "America/New_York").toISOString())
      .toBe("2026-07-15T22:00:00.000Z");
  });
  it("passes UTC through unchanged", () => {
    expect(zonedTimeToUtc("2026-08-11", "06:15", "UTC").toISOString())
      .toBe("2026-08-11T06:15:00.000Z");
  });
});

describe("computeSlots", () => {
  it("spreads videos day by day across sorted times", () => {
    const slots = computeSlots(5, "2027-01-01", ["18:00", "09:00"], "UTC");
    expect(slots).toHaveLength(5);
    expect(slots[0].toISOString()).toBe("2027-01-01T09:00:00.000Z");
    expect(slots[1].toISOString()).toBe("2027-01-01T18:00:00.000Z");
    expect(slots[2].toISOString()).toBe("2027-01-02T09:00:00.000Z");
    expect(slots[3].toISOString()).toBe("2027-01-02T18:00:00.000Z");
    expect(slots[4].toISOString()).toBe("2027-01-03T09:00:00.000Z");
  });
  it("skips slots already in the past and still fills the batch", () => {
    const slots = computeSlots(2, "2020-01-01", ["18:00"], "UTC");
    expect(slots).toHaveLength(2);
    expect(slots[0].getTime()).toBeGreaterThan(Date.now());
  });
  it("returns strictly ascending instants", () => {
    const slots = computeSlots(10, "2027-06-01", ["23:00", "01:00", "12:00"], "Asia/Kolkata");
    expect(slots).toHaveLength(10);
    for (let i = 1; i < slots.length; i++) {
      expect(slots[i].getTime()).toBeGreaterThan(slots[i - 1].getTime());
    }
  });
});

describe("isRealDate", () => {
  it.each(["2026-08-11", "2028-02-29", "2030-12-31"])("accepts real date %s", (s) => {
    expect(isRealDate(s)).toBe(true);
  });
  it.each([
    "2026-99-99", "2026-02-30", "2027-02-29", "2026-00-10",
    "2019-01-01", "2101-01-01", "not-a-date", "2026-8-1",
  ])("rejects %s", (s) => {
    expect(isRealDate(s)).toBe(false);
  });
});

describe("isBlockedHost", () => {
  it.each([
    "localhost", "127.0.0.1", "10.0.0.5", "172.16.9.1", "172.31.255.1",
    "192.168.1.1", "169.254.10.10", "100.64.0.1", "0.0.0.0", "224.0.0.1",
    "myserver", "foo.local", "api.internal", "::1", "fe80::1",
  ])("blocks private/internal host %s", (h) => {
    expect(isBlockedHost(h)).toBe(true);
  });
  it.each(["cdn.example.com", "8.8.8.8", "172.15.0.1", "172.32.0.1", "s3.amazonaws.com"])(
    "allows public host %s",
    (h) => { expect(isBlockedHost(h)).toBe(false); },
  );
});

describe("dropboxDirect", () => {
  it("converts a file share link to a direct-download URL", () => {
    const d = dropboxDirect("https://www.dropbox.com/scl/fi/abc123/My%20Video.mp4?rlkey=xyz&dl=0");
    expect(d).not.toBeNull();
    expect(d!.name).toBe("My Video.mp4");
    const u = new URL(d!.url);
    expect(u.hostname).toBe("dl.dropboxusercontent.com");
    expect(u.searchParams.get("dl")).toBeNull();
    expect(u.searchParams.get("rlkey")).toBe("xyz"); // needed for access
  });
  it("rejects folder links without ?preview (can't enumerate)", () => {
    expect(dropboxDirect("https://www.dropbox.com/scl/fo/folder123/h?rlkey=abc&dl=0")).toBeNull();
  });
  it("uses the ?preview file for folder links", () => {
    const d = dropboxDirect("https://www.dropbox.com/scl/fo/folder123/h?rlkey=abc&preview=clip.mp4");
    expect(d).not.toBeNull();
    expect(d!.name).toBe("clip.mp4");
    const u = new URL(d!.url);
    expect(u.hostname).toBe("dl.dropboxusercontent.com");
    expect(u.searchParams.get("preview")).toBeNull();
  });
  it("rejects non-video files", () => {
    expect(dropboxDirect("https://www.dropbox.com/scl/fi/abc/notes.pdf?rlkey=x")).toBeNull();
  });
});

describe("prettyName", () => {
  it("turns a file name into a readable caption", () => {
    expect(prettyName("my_best-clip_01.mp4")).toBe("my best clip 01");
  });
});
