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

export async function requestClips(
  api: string,
  body: Record<string, unknown>,
  opts?: { signal?: AbortSignal },
): Promise<ClipJobResult> {
  const signal = opts?.signal;

  const res = await fetch(`${api}/video/clip`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, async: true }),
    signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);

  // Old server / cache path may still answer synchronously
  if (!data.jobId) return data as ClipJobResult;

  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    if (signal?.aborted) throw new DOMException('Polling cancelled', 'AbortError');

    let jr: Response;
    try {
      jr = await fetch(`${api}/video/job/${data.jobId}`, { signal });
    } catch (e) {
      if (signal?.aborted) throw e;
      continue; // transient network blip — keep polling
    }
    const job = await jr.json().catch(() => null);
    if (!jr.ok || !job) {
      throw new Error(job?.error || 'Lost track of this job. Please try again.');
    }
    if (job.status === 'done') return job as ClipJobResult;
    if (job.status === 'error') {
      throw new Error(job.error || 'Clip generation failed. Please try again.');
    }
    // queued / processing — keep waiting
  }
  throw new Error('This video is taking too long to process. Please try again.');
}
