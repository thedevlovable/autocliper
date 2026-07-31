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
    });
  }
  throw new Error('This video is taking too long to process. Please try again.');
}

// ── Device file upload (chunked) ──────────────────────────────────────────────
// A single multi-GB request would die at proxy body-size/time limits, so the
// file goes up in small sequential parts: init → chunk×N → finish. The server
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

/** POST one chunk via XHR (fetch has no upload-progress events). */
function sendChunkOnce(
  api: string,
  id: string,
  index: number,
  blob: Blob,
  baseSent: number,
  totalBytes: number,
  signal?: AbortSignal,
  onProgress?: (pct: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const onAbort = () => xhr.abort();
    if (signal) {
      if (signal.aborted) { reject(new DOMException('Upload cancelled', 'AbortError')); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    xhr.open('POST', `${api}/video/upload/chunk?id=${encodeURIComponent(id)}&index=${index}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = e => {
      if (onProgress && totalBytes > 0) {
        onProgress(Math.min(99, ((baseSent + Math.min(e.loaded, blob.size)) / totalBytes) * 100));
      }
    };
    xhr.onload = () => {
      cleanup();
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
  const chunkBytes = typeof init.chunkBytes === 'number' && init.chunkBytes > 0
    ? init.chunkBytes
    : 4 * 1024 * 1024;

  for (let index = 0, off = 0; off < file.size; index++, off += chunkBytes) {
    const blob = file.slice(off, Math.min(off + chunkBytes, file.size));
    try {
      await sendChunkOnce(api, init.uploadId, index, blob, off, file.size, signal, onProgress);
    } catch (e) {
      // One retry per chunk on pure network blips or a transient 503 from the
      // server (storage hiccup) — other errors and user aborts pass through.
      const transient = e instanceof Error
        && (e.message === 'NETWORK' || (e as Error & { status?: number }).status === 503);
      if (!transient) throw e;
      await new Promise(r => setTimeout(r, 1500));
      if (signal?.aborted) throw new DOMException('Upload cancelled', 'AbortError');
      try {
        await sendChunkOnce(api, init.uploadId, index, blob, off, file.size, signal, onProgress);
      } catch (e2) {
        if (e2 instanceof Error && e2.message === 'NETWORK') {
          throw new Error('Upload failed — check your internet connection and try again.');
        }
        throw e2;
      }
    }
  }

  const fin = await postJson(`${api}/video/upload/finish?id=${encodeURIComponent(init.uploadId)}`, {}, signal) as unknown as UploadedSource;
  onProgress?.(100);
  return fin;
}
