/**
 * Unit tests for the chunked device-upload client (lib/clipJob.ts).
 *
 * XMLHttpRequest is replaced with a scriptable fake so the tests can assert
 * sequential chunk ordering, progress reporting, retry-on-network-blip, abort,
 * and server-error propagation without any real network.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { uploadVideoFile, prettySource } from '../lib/clipJob';

// ── Scriptable fake XHR ───────────────────────────────────────────────────────

type FakeResponse = { status: number; body: unknown } | 'network';

class FakeXHR {
  static sent: FakeXHR[] = [];
  /** Shifted per send; empty → default 200 success. */
  static script: FakeResponse[] = [];
  static reset() {
    FakeXHR.sent = [];
    FakeXHR.script = [];
  }

  method = '';
  url = '';
  status = 0;
  responseText = '';
  withCredentials = false;
  headers: Record<string, string> = {};
  body: Blob | null = null;
  aborted = false;
  upload: { onprogress: ((e: { loaded: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  send(body: Blob) {
    this.body = body;
    FakeXHR.sent.push(this);
    queueMicrotask(() => {
      if (this.aborted) return;
      const next = FakeXHR.script.shift();
      if (next === 'network') {
        this.onerror?.();
        return;
      }
      this.upload.onprogress?.({ loaded: body.size });
      if (next) {
        this.status = next.status;
        this.responseText = JSON.stringify(next.body);
      } else {
        this.status = 200;
        this.responseText = JSON.stringify({ received: body.size, next: 1 });
      }
      this.onload?.();
    });
  }
}

// ── fetch mock (init + finish are plain JSON POSTs) ───────────────────────────

const CHUNK = 4 * 1024 * 1024;

function fetchMock(overrides?: {
  init?: { ok: boolean; status?: number; body?: unknown };
  finish?: { ok: boolean; status?: number; body?: unknown };
}) {
  return vi.fn(async (url: string) => {
    const isInit = String(url).includes('/video/upload/init');
    const cfg = isInit ? overrides?.init : overrides?.finish;
    const body =
      cfg?.body ??
      (isInit
        ? { uploadId: 'u123abc4', chunkBytes: CHUNK, maxBytes: 2 * 1024 ** 3 }
        : { url: 'upload://u123abc4/my%20video.mp4', durationSec: 42, name: 'my video.mp4' });
    return {
      ok: cfg?.ok ?? true,
      status: cfg?.status ?? 200,
      json: async () => body,
    } as Response;
  });
}

const makeFile = (bytes: number, name = 'my video.mp4') =>
  new File([new Uint8Array(bytes)], name, { type: 'video/mp4' });

beforeEach(() => {
  FakeXHR.reset();
  vi.stubGlobal('XMLHttpRequest', FakeXHR as unknown as typeof XMLHttpRequest);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('uploadVideoFile', () => {
  it('uploads sequential 4MB chunks with credentials and reports progress', async () => {
    vi.stubGlobal('fetch', fetchMock());
    const file = makeFile(10 * 1024 * 1024); // → 3 chunks: 4MB, 4MB, 2MB
    const seen: number[] = [];

    const out = await uploadVideoFile('/api', file, { onProgress: p => seen.push(p) });

    expect(FakeXHR.sent).toHaveLength(3);
    FakeXHR.sent.forEach((x, i) => {
      expect(x.url).toContain(`index=${i}`);
      expect(x.url).toContain('id=u123abc4');
      expect(x.withCredentials).toBe(true);
      expect(x.headers['Content-Type']).toBe('application/octet-stream');
    });
    expect(FakeXHR.sent[0].body?.size).toBe(CHUNK);
    expect(FakeXHR.sent[2].body?.size).toBe(2 * 1024 * 1024);

    // Progress is monotonic and ends at exactly 100.
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    expect(seen[seen.length - 1]).toBe(100);

    expect(out.url).toBe('upload://u123abc4/my%20video.mp4');
    expect(out.durationSec).toBe(42);
  });

  it('retries a chunk once after a network blip, then succeeds', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', fetchMock());
    FakeXHR.script = ['network']; // first send dies, retry uses default success

    const p = uploadVideoFile('/api', makeFile(1024));
    await vi.advanceTimersByTimeAsync(5000); // drives the 1.5s retry backoff
    const out = await p;

    expect(FakeXHR.sent).toHaveLength(2); // original + one retry
    expect(out.name).toBe('my video.mp4');
  });

  it('retries once on a transient 503 (storage hiccup) and then succeeds', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', fetchMock());
    FakeXHR.script = [{ status: 503, body: { error: 'Storage busy' } }];

    const p = uploadVideoFile('/api', makeFile(1024));
    await vi.advanceTimersByTimeAsync(5000);
    const out = await p;

    expect(FakeXHR.sent).toHaveLength(2);
    expect(out.name).toBe('my video.mp4');
  });

  it('gives a friendly error when the retry also fails on network', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', fetchMock());
    FakeXHR.script = ['network', 'network'];

    const p = uploadVideoFile('/api', makeFile(1024));
    const guard = p.catch(e => e); // attach before advancing so no unhandled rejection
    await vi.advanceTimersByTimeAsync(5000);
    const err = await guard;
    expect(err).toBeInstanceOf(Error);
    expect(String(err.message)).toMatch(/internet connection/i);
  });

  it('propagates server chunk errors with status, without retrying', async () => {
    vi.stubGlobal('fetch', fetchMock());
    FakeXHR.script = [{ status: 413, body: { error: 'Chunk too large.' } }];

    const err = await uploadVideoFile('/api', makeFile(1024)).catch(e => e);
    expect(err.status).toBe(413);
    expect(err.message).toBe('Chunk too large.');
    expect(FakeXHR.sent).toHaveLength(1); // no retry on server errors
  });

  it('propagates init rejections (e.g. file too big) with the server message', async () => {
    vi.stubGlobal(
      'fetch',
      fetchMock({ init: { ok: false, status: 413, body: { error: 'File is larger than 2 GB.' } } }),
    );

    const err = await uploadVideoFile('/api', makeFile(1024)).catch(e => e);
    expect(err.status).toBe(413);
    expect(err.message).toBe('File is larger than 2 GB.');
    expect(FakeXHR.sent).toHaveLength(0); // never started chunking
  });

  it('honours an already-aborted signal before sending anything', async () => {
    vi.stubGlobal('fetch', fetchMock());
    const ac = new AbortController();
    ac.abort();

    const err = await uploadVideoFile('/api', makeFile(1024), { signal: ac.signal }).catch(e => e);
    expect(err.name).toBe('AbortError');
    expect(FakeXHR.sent).toHaveLength(0);
  });
});

describe('prettySource', () => {
  it('turns upload:// URLs into a friendly file label', () => {
    expect(prettySource('upload://abc12345/my%20video.mp4')).toBe('📁 my video.mp4');
  });
  it('leaves normal links untouched', () => {
    const yt = 'https://www.youtube.com/watch?v=xyz';
    expect(prettySource(yt)).toBe(yt);
  });
  it('survives malformed percent-encoding', () => {
    expect(prettySource('upload://abc12345/bad%zzname')).toBe('📁 bad%zzname');
  });
});
