// Submit a clip job in async mode and poll until it finishes.
//
// Long videos can take minutes to process — a plain fetch dies at the hosting
// proxy's ~120-second limit, so the server returns a jobId immediately and we
// poll GET /video/job/:id every few seconds instead.

export interface ClipJobResult {
  clips: any[];
  totalDuration: string;
  platform?: string;
  [key: string]: any;
}

const POLL_INTERVAL_MS = 3_000;
const MAX_WAIT_MS = 30 * 60 * 1000; // 30 minutes hard ceiling

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ClipJobStatusUpdate {
  status: string;
  /** 1-based number of jobs ahead when status === 'queued'; 0 otherwise. */
  queuePosition: number;
  /** Server-reported pipeline step ("Preparing HD source… 42%"), when known. */
  stage?: string;
}

/** Thrown when the job was cancelled (this tab or another) — not an error. */
export class ClipJobCancelledError extends Error {
  constructor() { super('Job cancelled'); this.name = 'ClipJobCancelledError'; }
}

/** Ask the server to remove a waiting job from the queue.
 *  Returns true when the job was cancelled; false when it already started
 *  processing (or finished) and can't be cancelled anymore. */
export async function cancelClipJob(api: string, jobId: string): Promise<boolean> {
  try {
    const res = await fetch(`${api}/video/job/${jobId}`, { method: 'DELETE' });
    return res.ok;
  } catch {
    return false; // network blip — job keeps running; caller decides what to show
  }
}

export async function requestClips(
  api: string,
  body: Record<string, unknown>,
  opts?: {
    signal?: AbortSignal;
    onStatus?: (u: ClipJobStatusUpdate) => void;
    /** Called once with the server-issued job id (async mode only) — lets the
     *  UI offer a Cancel button while the job waits in the queue. */
    onJobId?: (jobId: string) => void;
  },
): Promise<ClipJobResult> {
  const signal = opts?.signal;

  const res = await fetch(`${api}/video/clip`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, async: true }),
    signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Attach status/code so the UI can react (401 → login, 402 → pricing, …)
    const err = new Error(data.error || `Error ${res.status}`) as Error & {
      status?: number; code?: string; needed?: number; available?: number;
    };
    err.status = res.status;
    if (typeof data.code === 'string') err.code = data.code;
    if (typeof data.needed === 'number') err.needed = data.needed;
    if (typeof data.available === 'number') err.available = data.available;
    throw err;
  }

  // Old server / cache path may still answer synchronously
  if (!data.jobId) return data as ClipJobResult;
  opts?.onJobId?.(String(data.jobId));

  const deadline = Date.now() + MAX_WAIT_MS;
  // Tolerate brief network blips / server restarts, but never spin forever:
  // ~10 consecutive failures (≈30s) means the connection or job is really gone.
  const MAX_FAIL_STREAK = 10;
  let failStreak = 0;
  let notFoundStreak = 0;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    if (signal?.aborted) throw new DOMException('Polling cancelled', 'AbortError');

    let jr: Response;
    try {
      jr = await fetch(`${api}/video/job/${data.jobId}`, { signal });
    } catch (e) {
      if (signal?.aborted) throw e;
      if (++failStreak >= MAX_FAIL_STREAK) {
        throw new Error('Lost connection to the server. Check your internet and try again.');
      }
      continue; // transient network blip — keep polling
    }
    if (jr.status === 404) {
      // A single 404 can be a proxy blip during a server restart — require a
      // short streak before declaring the job gone (job store survives restarts).
      if (++notFoundStreak >= 3) {
        throw new Error('Lost track of this job. Please try again.');
      }
      continue;
    }
    notFoundStreak = 0;
    if (!jr.ok) {
      // 5xx — e.g. the server is restarting behind the proxy. Transient.
      if (++failStreak >= MAX_FAIL_STREAK) {
        throw new Error('The server had a problem with this job. Please try again.');
      }
      continue;
    }
    const job = await jr.json().catch(() => null);
    if (!job) {
      if (++failStreak >= MAX_FAIL_STREAK) {
        throw new Error('Lost track of this job. Please try again.');
      }
      continue;
    }
    failStreak = 0;
    if (job.status === 'done') return job as ClipJobResult;
    if (job.status === 'cancelled') throw new ClipJobCancelledError();
    if (job.status === 'error') {
      throw new Error(job.error || 'Clip generation failed. Please try again.');
    }
    // queued / processing — keep waiting; report queue position so the UI can
    // show "waiting — X jobs ahead of you" instead of a generic spinner.
    opts?.onStatus?.({
      status: String(job.status ?? 'processing'),
      queuePosition: job.status === 'queued' && typeof job.queuePosition === 'number' ? job.queuePosition : 0,
      ...(typeof job.stage === 'string' && job.stage ? { stage: job.stage } : {}),
    });
  }
  throw new Error('This video is taking too long to process. Please try again.');
}

// ── Device file upload (chunked) ──────────────────────────────────────────────
// A single multi-GB request would die at proxy body-size/time limits, so the
// file goes up in 8MB parts: init → chunk×N → finish. Parts are pipelined:
// part N+1 starts uploading the moment part N's body is on the wire, while
// the server is still mirroring part N to storage — so the connection never
// sits idle. Dispatch stays strictly in order (the server requires it); a
// window of two parts is enough to keep the uplink saturated. The server
// answers with an upload:// URL that /video/clip accepts like any other source.

export interface UploadedSource {
  url: string;
  durationSec: number;
  name: string;
}

/** Human-friendly label for a job source ("upload://…" → "📁 filename"). */
export function prettySource(u: string): string {
  if (u.startsWith('upload://')) {
    const name = u.split('/').slice(3).join('/');
    try { return '📁 ' + (decodeURIComponent(name) || 'uploaded video'); }
    catch { return '📁 ' + (name || 'uploaded video'); }
  }
  return u;
}

async function postJson(url: string, body: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body ?? {}),
    signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Error ${res.status}`) as Error & { status?: number; code?: string };
    err.status = res.status;
    if (typeof data.code === 'string') err.code = data.code;
    throw err;
  }
  return data as Record<string, unknown>;
}

/**
 * POST one chunk via XHR (fetch has no upload-progress events).
 * `onLoaded` reports absolute bytes of THIS chunk handed to the network;
 * `onBodySent` fires once when the whole body is on the wire — the signal
 * that the next chunk may start uploading while this one awaits its ack.
 */
function sendChunkOnce(
  api: string,
  id: string,
  index: number,
  blob: Blob,
  onLoaded: (loaded: number) => void,
  onBodySent: () => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const onAbort = () => xhr.abort();
    if (signal) {
      if (signal.aborted) { reject(new DOMException('Upload cancelled', 'AbortError')); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    let sentAll = false;
    const markBodySent = () => {
      if (!sentAll) { sentAll = true; onBodySent(); }
    };
    xhr.open('POST', `${api}/video/upload/chunk?id=${encodeURIComponent(id)}&index=${index}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = e => {
      const loaded = Math.min(e.loaded, blob.size);
      onLoaded(loaded);
      if (loaded >= blob.size) markBodySent();
    };
    xhr.onload = () => {
      cleanup();
      onLoaded(blob.size);
      markBodySent(); // fallback — some environments skip upload progress events
      if (xhr.status >= 200 && xhr.status < 300) { resolve(); return; }
      let msg = `Upload failed (${xhr.status}).`;
      try {
        const d = JSON.parse(xhr.responseText) as { error?: string };
        if (d?.error) msg = d.error;
      } catch { /* keep the generic message */ }
      const err = new Error(msg) as Error & { status?: number };
      err.status = xhr.status;
      reject(err);
    };
    xhr.onerror = () => { cleanup(); reject(new Error('NETWORK')); };
    xhr.onabort = () => { cleanup(); reject(new DOMException('Upload cancelled', 'AbortError')); };
    xhr.send(blob);
  });
}

/**
 * Send one chunk with bounded retries:
 * - one resend after a pure network blip or a transient 503 (storage hiccup);
 * - one resend after a 409 when parts are pipelined — a 409 usually means our
 *   predecessor's ack is still in flight, so wait for it and send again.
 * User aborts and all other server errors pass through untouched.
 */
async function sendChunkReliably(
  api: string,
  id: string,
  index: number,
  blob: Blob,
  prevAck: Promise<void> | null,
  onLoaded: (loaded: number) => void,
  onBodySent: () => void,
  signal?: AbortSignal,
): Promise<void> {
  let usedTransientRetry = false;
  let usedOrderRetry = false;
  for (;;) {
    try {
      await sendChunkOnce(api, id, index, blob, onLoaded, onBodySent, signal);
      return;
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e;
      const status = (e as Error & { status?: number }).status;
      const isNetwork = e instanceof Error && e.message === 'NETWORK';
      if (status === 409 && prevAck && !usedOrderRetry) {
        usedOrderRetry = true;
        try { await prevAck; } catch { throw e; } // predecessor failed — surface ours
        if (signal?.aborted) throw new DOMException('Upload cancelled', 'AbortError');
        continue;
      }
      if ((isNetwork || status === 503) && !usedTransientRetry) {
        usedTransientRetry = true;
        await new Promise(r => setTimeout(r, 1500));
        if (signal?.aborted) throw new DOMException('Upload cancelled', 'AbortError');
        continue;
      }
      if (isNetwork) {
        throw new Error('Upload failed — check your internet connection and try again.');
      }
      throw e;
    }
  }
}

export async function uploadVideoFile(
  api: string,
  file: File,
  opts?: { signal?: AbortSignal; onProgress?: (pct: number) => void },
): Promise<UploadedSource> {
  const { signal, onProgress } = opts ?? {};
  const init = await postJson(
    `${api}/video/upload/init`,
    { name: file.name, size: file.size, mime: file.type },
    signal,
  ) as { uploadId?: string; chunkBytes?: number };
  if (!init.uploadId) throw new Error('Upload failed to start — please try again.');
  const uploadId = init.uploadId;
  const chunkBytes = typeof init.chunkBytes === 'number' && init.chunkBytes > 0
    ? init.chunkBytes
    : 8 * 1024 * 1024;

  // One failed/cancelled part must cancel every in-flight part, so all XHRs
  // run off this internal controller, chained to the caller's signal.
  const ctl = new AbortController();
  const onOuterAbort = () => ctl.abort();
  if (signal) {
    if (signal.aborted) throw new DOMException('Upload cancelled', 'AbortError');
    signal.addEventListener('abort', onOuterAbort, { once: true });
  }

  // Aggregate progress across in-flight parts. A retry briefly rewinds its
  // own part's counter, so never report a smaller percentage than before.
  const sentByChunk: number[] = [];
  let lastPct = 0;
  const report = () => {
    if (!onProgress || file.size <= 0) return;
    const sent = sentByChunk.reduce((a, b) => a + b, 0);
    const pct = Math.min(99, (sent / file.size) * 100);
    if (pct > lastPct) { lastPct = pct; onProgress(pct); }
  };

  const acks: Promise<void>[] = [];
  let fatal: unknown = null;
  const noteFatal = (e: unknown) => { if (fatal === null) fatal = e; };

  try {
    let prevAck: Promise<void> | null = null;   // part N-1's server ack
    let olderAck: Promise<void> | null = null;  // part N-2's server ack
    let prevBodySent: Promise<void> | null = null;

    for (let index = 0, off = 0; off < file.size; index++, off += chunkBytes) {
      // Pipeline gates: the previous part's body must be fully on the wire,
      // and the part before THAT must be acked — at most two parts in flight.
      if (prevBodySent) await prevBodySent;
      if (olderAck) await olderAck.catch(() => undefined);
      if (fatal !== null) break;
      if (ctl.signal.aborted) throw new DOMException('Upload cancelled', 'AbortError');

      const blob = file.slice(off, Math.min(off + chunkBytes, file.size));
      const myIndex = index;
      let releaseBody!: () => void;
      const bodySent = new Promise<void>(res => { releaseBody = res; });
      const ack = sendChunkReliably(
        api, uploadId, myIndex, blob, prevAck,
        loaded => { sentByChunk[myIndex] = loaded; report(); },
        releaseBody,
        ctl.signal,
      ).finally(releaseBody); // a failed part must never wedge the pipeline gate
      ack.catch(noteFatal);
      acks.push(ack);
      olderAck = prevAck;
      prevAck = ack;
      prevBodySent = bodySent;
    }

    await Promise.all(acks);
  } catch (e) {
    noteFatal(e);
  } finally {
    signal?.removeEventListener('abort', onOuterAbort);
  }
  if (fatal !== null) {
    ctl.abort(); // kill anything still in flight
    throw fatal;
  }

  const fin = await postJson(`${api}/video/upload/finish?id=${encodeURIComponent(uploadId)}`, {}, signal) as unknown as UploadedSource;
  onProgress?.(100);
  return fin;
}
