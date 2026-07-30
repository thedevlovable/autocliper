/**
 * Tests for the HistoryPanel component (ClipperPage).
 *
 * Covers:
 *  - loading state: spinner shown while GET /history is in flight
 *  - empty state: "No clips yet" message when the server returns zero jobs
 *  - listing jobs: job rows rendered from GET /history response
 *  - deleting a job: X button calls DELETE /history/:id and removes the row
 *  - re-run callback: "Regenerate" populates the form via onRerun
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, afterEach } from 'vitest';

// ── Stub env before the module-level `API` constant is evaluated ─────────────
vi.stubEnv('VITE_API_URL', '');
vi.stubEnv('BASE_URL', '/');

// HistoryPanel lives in ClipperPage which imports Clerk, wouter, and clipJob
// at the module level; none are used by HistoryPanel itself, so stub them out.
vi.mock('@clerk/react', () => ({
  useUser: () => ({ isSignedIn: false, user: null }),
  useClerk: () => ({ signOut: vi.fn() }),
  Show: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));
vi.mock('wouter', () => ({
  useLocation: () => ['/', vi.fn()],
  Link: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../lib/clipJob', () => ({ requestClips: vi.fn() }));

const { HistoryPanel } = await import('../pages/ClipperPage');

// ── Helpers ───────────────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const JOBS = [
  {
    id: 'job-1',
    source_url: 'https://youtube.com/watch?v=aaa',
    platform: 'shorts',
    clip_duration: 30,
    clip_count: 3,
    total_duration: '5:00',
    created_at: '2024-01-15T10:00:00Z',
  },
  {
    id: 'job-2',
    source_url: 'https://twitch.tv/videos/123456789',
    platform: 'reels',
    clip_duration: 60,
    clip_count: 5,
    total_duration: '12:34',
    created_at: '2024-01-14T09:00:00Z',
  },
];

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Loading state ─────────────────────────────────────────────────────────────

describe('HistoryPanel — loading state', () => {
  it('shows a spinner while the history fetch is in flight', () => {
    // Never resolves — keeps the component in the loading state.
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));

    const onRerun = vi.fn();
    render(<HistoryPanel onRerun={onRerun} />);

    // The Loader2 icon renders as an svg; the parent div has animate-spin class.
    const spinner = document.querySelector('.animate-spin');
    expect(spinner).toBeTruthy();

    // Neither the empty state nor any job rows should be present yet.
    expect(screen.queryByText(/no clips yet/i)).not.toBeInTheDocument();
  });
});

// ── Empty state ───────────────────────────────────────────────────────────────

describe('HistoryPanel — empty state', () => {
  it('shows "No clips yet" when the server returns zero jobs', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ jobs: [] }),
    );

    render(<HistoryPanel onRerun={vi.fn()} />);

    expect(await screen.findByText(/no clips yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/regenerate/i)).not.toBeInTheDocument();
  });
});

// ── Listing jobs ──────────────────────────────────────────────────────────────

describe('HistoryPanel — listing jobs', () => {
  it('renders a row for every job returned by GET /history', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ jobs: JOBS }),
    );

    render(<HistoryPanel onRerun={vi.fn()} />);

    // Both source URLs (truncated) appear.
    expect(await screen.findByText(/youtube\.com\/watch/i)).toBeInTheDocument();
    expect(screen.getByText(/twitch\.tv\/videos/i)).toBeInTheDocument();

    // Clip-count and duration metadata appear for each job.
    expect(screen.getByText(/3 clips · 30s/i)).toBeInTheDocument();
    expect(screen.getByText(/5 clips · 60s/i)).toBeInTheDocument();

    // A "Regenerate" button exists for each row.
    const regenBtns = screen.getAllByRole('button', { name: /regenerate/i });
    expect(regenBtns).toHaveLength(2);
  });
});

// ── Deleting a job ────────────────────────────────────────────────────────────

describe('HistoryPanel — deleting a job', () => {
  it('calls DELETE /history/:id and removes the row from the list', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';

      if (url.includes('/history') && method === 'GET') {
        return jsonResponse({ jobs: JOBS });
      }
      if (url.includes('/history/job-1') && method === 'DELETE') {
        return jsonResponse({ ok: true });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    const user = userEvent.setup();
    render(<HistoryPanel onRerun={vi.fn()} />);

    // Wait for rows to appear.
    await screen.findByText(/youtube\.com\/watch/i);

    // Two delete (X) buttons — click the first one (job-1).
    const deleteBtns = screen.getAllByRole('button', { name: '' }).filter(
      btn => btn.querySelector('svg'),
    );
    // Find the X buttons (not Regenerate).
    const xBtns = screen
      .getAllByRole('button')
      .filter(btn => !btn.textContent?.includes('Regenerate'));
    await user.click(xBtns[0]);

    // DELETE was called with the right id.
    await waitFor(() => {
      const deleteCall = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url).includes('/history/job-1') &&
          (init as RequestInit)?.method === 'DELETE',
      );
      expect(deleteCall).toBeTruthy();
    });

    // The job-1 row is gone; job-2 row remains.
    expect(screen.queryByText(/youtube\.com\/watch/i)).not.toBeInTheDocument();
    expect(screen.getByText(/twitch\.tv\/videos/i)).toBeInTheDocument();
  });
});

// ── Re-run callback ───────────────────────────────────────────────────────────

describe('HistoryPanel — re-run callback', () => {
  it('calls onRerun with the correct params when Regenerate is clicked', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ jobs: JOBS }),
    );

    const onRerun = vi.fn();
    const user = userEvent.setup();
    render(<HistoryPanel onRerun={onRerun} />);

    await screen.findByText(/youtube\.com\/watch/i);

    // Click Regenerate on the first job (job-1).
    const regenBtns = screen.getAllByRole('button', { name: /regenerate/i });
    await user.click(regenBtns[0]);

    expect(onRerun).toHaveBeenCalledTimes(1);
    expect(onRerun).toHaveBeenCalledWith(
      JOBS[0].source_url,
      JOBS[0].platform,
      JOBS[0].clip_duration,
      JOBS[0].clip_count,
    );
  });

  it("calls onRerun with the second job's params when its Regenerate is clicked", async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ jobs: JOBS }),
    );

    const onRerun = vi.fn();
    const user = userEvent.setup();
    render(<HistoryPanel onRerun={onRerun} />);

    await screen.findByText(/twitch\.tv\/videos/i);

    const regenBtns = screen.getAllByRole('button', { name: /regenerate/i });
    await user.click(regenBtns[1]);

    expect(onRerun).toHaveBeenCalledWith(
      JOBS[1].source_url,
      JOBS[1].platform,
      JOBS[1].clip_duration,
      JOBS[1].clip_count,
    );
  });
});
