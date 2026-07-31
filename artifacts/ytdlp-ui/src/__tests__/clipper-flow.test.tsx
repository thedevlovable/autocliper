/**
 * Tests for the core clip flow on ClipperPage.
 *
 * Covers:
 *  - URL submission form validation (submit disabled for empty/invalid input,
 *    enabled for http(s) URLs, source-platform auto-detection, clear button)
 *  - Clip progress rendering: in-progress (spinner + rotating message, input
 *    locked), done (clips grid + header), and failed (error box + Try again)
 *  - Download button behavior: per-clip download link href/name + Saving/Saved
 *    feedback, and "Download All" ZIP request
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

// ── Stub env before the module-level `API` constant is evaluated ─────────────
vi.stubEnv('VITE_API_URL', '');
vi.stubEnv('BASE_URL', '/');

// ClipperPage imports Clerk and wouter at module level; the pieces that use
// them are gated behind ClerkEnabledCtx (false by default), so stub them out.
vi.mock('@clerk/react', () => ({
  useUser: () => ({ isSignedIn: false, user: null }),
  useClerk: () => ({ signOut: vi.fn() }),
  Show: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));
vi.mock('wouter', () => ({
  useLocation: () => ['/', vi.fn()],
  Link: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));
// The job-polling helper is exercised in isolation; here we control it.
vi.mock('../lib/clipJob', () => {
  class ClipJobCancelledError extends Error {
    constructor() { super('Job cancelled'); this.name = 'ClipJobCancelledError'; }
  }
  return { requestClips: vi.fn(), cancelClipJob: vi.fn(), ClipJobCancelledError };
});

const { requestClips, cancelClipJob, ClipJobCancelledError } = await import('../lib/clipJob');
const ClipperPage = (await import('../pages/ClipperPage')).default;

const requestClipsMock = vi.mocked(requestClips);
const cancelClipJobMock = vi.mocked(cancelClipJob);

// ── Helpers ───────────────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const CLIPS = [
  {
    id: 'clip-1',
    name: 'clip-1.mp4',
    label: 'Clip 1',
    startTime: '0:10',
    endTime: '0:40',
    duration: '30s',
    size: 2_400_000,
  },
  {
    id: 'clip-2',
    name: 'clip-2.mp4',
    label: 'Clip 2',
    startTime: '1:05',
    endTime: '1:35',
    duration: '30s',
    size: 3_100_000,
  },
];

/** Mock global fetch: CookiesPanel status probe + optional extra routes. */
function mockFetch(extra?: (url: string, init?: RequestInit) => Response | null) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.includes('/ytdlp/cookies/status')) {
      return jsonResponse({ configured: false, source: null, youtubeCookieCount: 0 });
    }
    const handled = extra?.(url, init as RequestInit);
    if (handled) return handled;
    throw new Error(`unexpected fetch: ${url}`);
  });
}

function urlInput() {
  // The single type="url" input in the hero form.
  return document.querySelector('input[type="url"]') as HTMLInputElement;
}

function submitButton() {
  return screen.getByRole('button', { name: /get clips/i });
}

/** Type a URL and submit the form. */
async function submitUrl(user: ReturnType<typeof userEvent.setup>, url: string) {
  const input = urlInput();
  await user.click(input);
  await user.paste(url);
  await user.click(submitButton());
}

beforeEach(() => {
  mockFetch();
});

afterEach(() => {
  vi.restoreAllMocks();
  requestClipsMock.mockReset();
});

// ── URL submission form validation ───────────────────────────────────────────

describe('URL submission form', () => {
  it('disables submit for empty or non-http input and never calls the API', async () => {
    const user = userEvent.setup();
    render(<ClipperPage />);

    // Empty input → disabled.
    expect(submitButton()).toBeDisabled();

    // Non-URL text → still disabled.
    await user.click(urlInput());
    await user.paste('not a url');
    expect(submitButton()).toBeDisabled();

    // Submitting the form directly must also be a no-op.
    await user.keyboard('{Enter}');
    expect(requestClipsMock).not.toHaveBeenCalled();
  });

  it('enables submit once a http(s) URL is entered', async () => {
    const user = userEvent.setup();
    render(<ClipperPage />);

    await user.click(urlInput());
    await user.paste('https://www.youtube.com/watch?v=abc123');
    expect(submitButton()).toBeEnabled();
  });

  it('auto-detects the source platform from the pasted URL', async () => {
    const user = userEvent.setup();
    render(<ClipperPage />);

    await user.click(urlInput());
    await user.paste('https://kick.com/somechannel');

    // The Kick platform button becomes active (inline color style is applied).
    const kickBtn = screen.getByRole('button', { name: /kick/i });
    expect(kickBtn.getAttribute('style')).toContain('rgb');
  });

  it('submits the URL and settings to requestClips', async () => {
    requestClipsMock.mockResolvedValue({ clips: CLIPS, totalDuration: '12:34' });
    const user = userEvent.setup();
    render(<ClipperPage />);

    await submitUrl(user, 'https://youtu.be/xyz');

    await waitFor(() => expect(requestClipsMock).toHaveBeenCalledTimes(1));
    const [, body] = requestClipsMock.mock.calls[0];
    expect(body).toMatchObject({
      url: 'https://youtu.be/xyz',
      clipDuration: 30, // default duration
      clipCount: 5,     // default count
      platform: 'shorts', // default target platform
    });
  });

  it('clears the URL via the clear (X) button', async () => {
    const user = userEvent.setup();
    render(<ClipperPage />);

    await user.click(urlInput());
    await user.paste('https://youtu.be/xyz');
    expect(urlInput().value).toBe('https://youtu.be/xyz');

    // The clear button appears right after the input inside the input bar.
    const clearBtn = urlInput().parentElement!.querySelector(
      'button[type="button"]',
    ) as HTMLButtonElement;
    await user.click(clearBtn);
    expect(urlInput().value).toBe('');
    expect(submitButton()).toBeDisabled();
  });
});

// ── Clip progress rendering ───────────────────────────────────────────────────

describe('clip progress rendering', () => {
  it('shows the in-progress state while the job runs, then the results', async () => {
    let resolveJob!: (v: { clips: typeof CLIPS; totalDuration: string }) => void;
    requestClipsMock.mockImplementation(
      () => new Promise((res) => { resolveJob = res; }),
    );
    const user = userEvent.setup();
    render(<ClipperPage />);

    await submitUrl(user, 'https://youtu.be/xyz');

    // In-progress UI: rotating message + warning copy; input + submit locked.
    expect(await screen.findByText(/downloading video/i)).toBeInTheDocument();
    expect(screen.getByText(/don't close this tab/i)).toBeInTheDocument();
    expect(urlInput()).toBeDisabled();
    expect(submitButton()).toBeDisabled();

    // Job finishes → done state renders the clips.
    resolveJob({ clips: CLIPS, totalDuration: '12:34' });
    expect(await screen.findByText(/2 clips ready/i)).toBeInTheDocument();
    expect(screen.queryByText(/downloading video/i)).not.toBeInTheDocument();
    expect(screen.getByText(/from a 12:34 video/i)).toBeInTheDocument();
    expect(screen.getByText('Clip 1')).toBeInTheDocument();
    expect(screen.getByText('Clip 2')).toBeInTheDocument();
    // Sizes are formatted.
    expect(screen.getByText('2.4 MB')).toBeInTheDocument();
  });

  it('does not double-submit while a job is already loading', async () => {
    requestClipsMock.mockImplementation(() => new Promise(() => {}));
    const user = userEvent.setup();
    render(<ClipperPage />);

    await submitUrl(user, 'https://youtu.be/xyz');
    expect(await screen.findByText(/downloading video/i)).toBeInTheDocument();

    // Try to submit again via the form (button is disabled; use Enter on form).
    const form = urlInput().closest('form')!;
    form.requestSubmit();
    await waitFor(() => expect(requestClipsMock).toHaveBeenCalledTimes(1));
  });

  it('shows the failed state with the job error and recovers via Try again', async () => {
    requestClipsMock.mockRejectedValue(
      new Error('Lost track of this job. Please try again.'),
    );
    const user = userEvent.setup();
    render(<ClipperPage />);

    await submitUrl(user, 'https://youtu.be/xyz');

    // Failed UI: heading + exact error message from the job layer.
    expect(await screen.findByText(/something went wrong/i)).toBeInTheDocument();
    expect(
      screen.getByText(/lost track of this job\. please try again\./i),
    ).toBeInTheDocument();

    // "Try again" resets to the idle state.
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(screen.queryByText(/something went wrong/i)).not.toBeInTheDocument();
    expect(urlInput().value).toBe('');
    // Idle-only marketing sections are back.
    expect(screen.getByText(/ai finds moments/i)).toBeInTheDocument();
  });

  it('shows a Cancel button while queued and leaves the line when clicked', async () => {
    cancelClipJobMock.mockResolvedValue(true);
    requestClipsMock.mockImplementation((_api, _body, opts) => {
      opts?.onJobId?.('job-123');
      opts?.onStatus?.({ status: 'queued', queuePosition: 2 });
      // Never settles on its own — cancellation aborts the wait.
      return new Promise((_res, reject) => {
        opts?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    });
    const user = userEvent.setup();
    render(<ClipperPage />);

    await submitUrl(user, 'https://youtu.be/xyz');

    // Queue message + Cancel button are shown while waiting in line.
    expect(await screen.findByText(/2 jobs ahead of you/i)).toBeInTheDocument();
    const cancelBtn = await screen.findByRole('button', { name: /leave the line/i });

    await user.click(cancelBtn);
    expect(cancelClipJobMock).toHaveBeenCalledWith(expect.any(String), 'job-123');

    // Back to the idle form — no error, no spinner.
    await waitFor(() => expect(screen.queryByText(/jobs ahead of you/i)).not.toBeInTheDocument());
    expect(screen.queryByText(/something went wrong/i)).not.toBeInTheDocument();
    expect(screen.getByText(/ai finds moments/i)).toBeInTheDocument();
  });

  it('hides the Cancel button once the job starts processing', async () => {
    requestClipsMock.mockImplementation((_api, _body, opts) => {
      opts?.onJobId?.('job-456');
      opts?.onStatus?.({ status: 'queued', queuePosition: 1 });
      return new Promise(() => {});
    });
    const user = userEvent.setup();
    render(<ClipperPage />);

    await submitUrl(user, 'https://youtu.be/xyz');
    expect(await screen.findByRole('button', { name: /leave the line/i })).toBeInTheDocument();

    // Server grants the slot → processing → cancel disappears.
    const opts = requestClipsMock.mock.calls[0][2];
    opts?.onStatus?.({ status: 'processing', queuePosition: 0 });
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /leave the line/i })).not.toBeInTheDocument(),
    );
  });

  it('resets quietly when the job is cancelled from elsewhere', async () => {
    requestClipsMock.mockRejectedValue(new ClipJobCancelledError());
    const user = userEvent.setup();
    render(<ClipperPage />);

    await submitUrl(user, 'https://youtu.be/xyz');

    await waitFor(() => expect(screen.getByText(/ai finds moments/i)).toBeInTheDocument());
    expect(screen.queryByText(/something went wrong/i)).not.toBeInTheDocument();
  });
});

// ── Download button behavior ──────────────────────────────────────────────────

describe('download buttons', () => {
  async function renderDone(user: ReturnType<typeof userEvent.setup>) {
    requestClipsMock.mockResolvedValue({ clips: CLIPS, totalDuration: '12:34' });
    render(<ClipperPage />);
    await submitUrl(user, 'https://youtu.be/xyz');
    await screen.findByText(/2 clips ready/i);
  }

  it('renders a per-clip download link with the file URL and name', async () => {
    const user = userEvent.setup();
    await renderDone(user);

    const links = screen.getAllByRole('link', { name: /download/i });
    // 2 clip-card download buttons.
    const clip1Link = links.find(l => l.getAttribute('href')?.includes('clip-1'))!;
    expect(clip1Link).toBeTruthy();
    expect(clip1Link).toHaveAttribute('href', '/api/video/file/clip-1');
    expect(clip1Link).toHaveAttribute('download', 'clip-1.mp4');
  });

  it('shows Saving… then Saved! feedback after clicking Download', async () => {
    const user = userEvent.setup();
    await renderDone(user);

    const clip1Link = screen
      .getAllByRole('link', { name: /download/i })
      .find(l => l.getAttribute('href')?.includes('clip-1'))!;

    await user.click(clip1Link);
    expect(within(clip1Link as HTMLElement).getByText(/saving/i)).toBeInTheDocument();

    // After the feedback delay it flips to "Saved!".
    await waitFor(
      () => expect(within(clip1Link as HTMLElement).getByText(/saved!/i)).toBeInTheDocument(),
      { timeout: 3000 },
    );
  });

  it('Download All checks the ZIP endpoint with all clip ids', async () => {
    const user = userEvent.setup();
    // Re-mock fetch to also serve the ZIP availability check.
    vi.restoreAllMocks();
    const fetchMock = mockFetch((url) =>
      url.includes('/video/zip') ? jsonResponse({ ok: true }) : null,
    );
    await renderDone(user);

    await user.click(screen.getByRole('button', { name: /download all/i }));

    await waitFor(() => {
      const zipCall = fetchMock.mock.calls.find(([input]) =>
        String(input).includes('/video/zip'),
      );
      expect(zipCall).toBeTruthy();
      expect(String(zipCall![0])).toContain('ids=clip-1,clip-2');
      expect(String(zipCall![0])).toContain('check=1');
    });
  });

  it('falls back to per-file downloads when the ZIP check fails', async () => {
    const user = userEvent.setup();
    vi.restoreAllMocks();
    mockFetch((url) =>
      url.includes('/video/zip') ? jsonResponse({ error: 'nope' }, 500) : null,
    );
    await renderDone(user);

    // Spy on programmatic anchor clicks used by the staggered fallback.
    const clicked: string[] = [];
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      clicked.push(this.getAttribute('href') ?? '');
    };
    try {
      await user.click(screen.getByRole('button', { name: /download all/i }));
      await waitFor(
        () => {
          expect(clicked).toContain('/api/video/file/clip-1');
          expect(clicked).toContain('/api/video/file/clip-2');
        },
        { timeout: 3000 },
      );
    } finally {
      HTMLAnchorElement.prototype.click = origClick;
    }
  });
});
