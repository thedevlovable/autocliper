/**
 * Tests for the "My clips" local history helpers on ClipperPage.
 *
 * Covers:
 *  - saveRecentJob: newest-first ordering, RECENT_MAX cap, dedupe by id
 *  - loadRecentJobs: corrupt/absent localStorage data → []
 *  - quota fallback: thumbnails are stripped instead of throwing when
 *    localStorage.setItem hits the quota
 *  - deleteRecentJob / clearRecentJobs
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Stub env before the module-level `API` constant is evaluated ─────────────
vi.stubEnv('VITE_API_URL', '');
vi.stubEnv('BASE_URL', '/');

// ClipperPage imports Clerk and wouter at module level; stub them out the same
// way the clip-flow tests do (we only exercise the exported helpers here).
vi.mock('@clerk/react', () => ({
  useUser: () => ({ isSignedIn: false, user: null }),
  useClerk: () => ({ signOut: vi.fn() }),
  Show: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));
vi.mock('wouter', () => ({
  useLocation: () => ['/', vi.fn()],
  Link: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

import {
  loadRecentJobs,
  saveRecentJob,
  deleteRecentJob,
  clearRecentJobs,
  RECENT_KEY,
  RECENT_MAX,
  type RecentJob,
} from '../pages/ClipperPage';

function makeJob(id: string, thumb = false): RecentJob {
  return {
    id,
    url: `https://youtube.com/watch?v=${id}`,
    platform: 'shorts',
    date: 1700000000000 + Number(id.replace(/\D/g, '') || 0),
    totalDuration: '21:03',
    clips: [
      {
        id: `clip-${id}`,
        name: `clip-${id}.mp4`,
        label: `Clip ${id}`,
        startTime: '0:10',
        endTime: '0:40',
        duration: '0:30',
        size: 7_400_000,
        ...(thumb ? { thumbnailDataUrl: 'data:image/jpeg;base64,AAAA' } : {}),
      },
    ],
  };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('recent clips local history', () => {
  it('saves newest first and caps the list at RECENT_MAX', () => {
    for (let i = 1; i <= RECENT_MAX + 2; i++) saveRecentJob(makeJob(String(i)));
    const jobs = loadRecentJobs();
    expect(jobs).toHaveLength(RECENT_MAX);
    expect(jobs[0].id).toBe(String(RECENT_MAX + 2)); // newest first
    expect(jobs.some(j => j.id === '1')).toBe(false); // oldest dropped
    expect(jobs.some(j => j.id === '2')).toBe(false);
  });

  it('dedupes by id, moving the re-saved job to the front', () => {
    saveRecentJob(makeJob('a'));
    saveRecentJob(makeJob('b'));
    saveRecentJob(makeJob('a'));
    const jobs = loadRecentJobs();
    expect(jobs.map(j => j.id)).toEqual(['a', 'b']);
  });

  it('returns [] for corrupt or non-array stored data', () => {
    localStorage.setItem(RECENT_KEY, 'not json {{{');
    expect(loadRecentJobs()).toEqual([]);
    localStorage.setItem(RECENT_KEY, '{"nope": true}');
    expect(loadRecentJobs()).toEqual([]);
  });

  it('strips thumbnails instead of throwing when localStorage quota is hit', () => {
    // jsdom's localStorage doesn't reliably route through a Storage.prototype
    // spy, so stub the whole global with a fake that fails the first two writes.
    const store: Record<string, string> = {};
    let failures = 2; // fail the first two attempts, then succeed
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => {
        if (k === RECENT_KEY && failures > 0) {
          failures--;
          throw new DOMException('quota', 'QuotaExceededError');
        }
        store[k] = v;
      },
      removeItem: (k: string) => { delete store[k]; },
      clear: () => { for (const k of Object.keys(store)) delete store[k]; },
      key: () => null,
      length: 0,
    });

    try {
      expect(() => saveRecentJob(makeJob('big', true))).not.toThrow();
      const jobs = loadRecentJobs();
      expect(jobs).toHaveLength(1);
      // After both fallback rounds every thumbnail is stripped
      expect(jobs[0].clips[0].thumbnailDataUrl).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('deleteRecentJob removes one job; clearRecentJobs empties the list', () => {
    saveRecentJob(makeJob('x'));
    saveRecentJob(makeJob('y'));
    const afterDelete = deleteRecentJob('x');
    expect(afterDelete.map(j => j.id)).toEqual(['y']);
    expect(loadRecentJobs().map(j => j.id)).toEqual(['y']);
    clearRecentJobs();
    expect(loadRecentJobs()).toEqual([]);
  });
});
