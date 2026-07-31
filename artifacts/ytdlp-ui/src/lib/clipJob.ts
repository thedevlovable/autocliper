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
