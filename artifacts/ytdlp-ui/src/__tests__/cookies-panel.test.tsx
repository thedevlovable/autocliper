/**
 * Tests for the CookiesPanel component (ClipperPage).
 *
 * Covers:
 *  - successful upload shows the "Cookies saved" message and active status
 *  - a rejected upload (422 from the server) surfaces the server's error text
 *  - the Remove button deletes uploaded cookies and shows "Cookies removed."
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, afterEach } from 'vitest';

// ── Stub env before the module-level `API` constant is evaluated ─────────────
vi.stubEnv('VITE_API_URL', '');
vi.stubEnv('BASE_URL', '/');

// ClipperPage imports Clerk, wouter, and the clip-job helper at module level;
// none of them are used by CookiesPanel, so stub them out.
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

const { CookiesPanel } = await import('../pages/ClipperPage');

// ── Helpers ───────────────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const UNCONFIGURED = {
  configured: false,
  source: null,
  youtubeCookieCount: 0,
};
const UPLOADED = {
  configured: true,
  source: 'uploaded',
  youtubeCookieCount: 3,
};

/** Renders the panel and expands it (content is behind a toggle button). */
async function renderOpenPanel() {
  const user = userEvent.setup();
  render(<CookiesPanel />);
  await user.click(screen.getByRole('button', { name: /youtube cookies/i }));
  return user;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('CookiesPanel', () => {
  it('shows a success message and active status after a valid upload', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.includes('/ytdlp/cookies/status')) return jsonResponse(UNCONFIGURED);
        if (url.includes('/ytdlp/cookies') && init?.method === 'POST') {
          return jsonResponse({ ok: true, youtubeCookieCount: 3, persisted: true, status: UPLOADED });
        }
        throw new Error(`unexpected fetch: ${url}`);
      });

    const user = await renderOpenPanel();

    const textarea = screen.getByPlaceholderText(/netscape http cookie file/i);
    await user.click(textarea);
    await user.paste('.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tabc');
    await user.click(screen.getByRole('button', { name: /save cookies/i }));

    await waitFor(() =>
      expect(
        screen.getByText(/cookies saved — 3 youtube cookies detected\./i),
      ).toBeInTheDocument(),
    );
    // Status block reflects the new active state.
    expect(screen.getByText(/cookies active — 3 youtube cookies\./i)).toBeInTheDocument();
    // Textarea is cleared after a successful save.
    expect((textarea as HTMLTextAreaElement).value).toBe('');
    // The POST body carried the pasted cookies.
    const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(postCall).toBeTruthy();
    expect(String(postCall![1]!.body)).toContain('.youtube.com');
  });

  it('shows the server error message when the upload is rejected', async () => {
    const serverError = 'No youtube.com cookies found in the file.';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/ytdlp/cookies/status')) return jsonResponse(UNCONFIGURED);
      if (url.includes('/ytdlp/cookies') && init?.method === 'POST') {
        return jsonResponse({ error: serverError, code: 'INVALID_COOKIES' }, 422);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const user = await renderOpenPanel();

    const textarea = screen.getByPlaceholderText(/netscape http cookie file/i);
    await user.click(textarea);
    await user.paste('not real cookies');
    await user.click(screen.getByRole('button', { name: /save cookies/i }));

    await waitFor(() => expect(screen.getByText(serverError)).toBeInTheDocument());
    // No success status is shown.
    expect(screen.queryByText(/cookies active/i)).not.toBeInTheDocument();
  });

  it('removes uploaded cookies via the Remove button', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/ytdlp/cookies/status')) return jsonResponse(UPLOADED);
      if (url.includes('/ytdlp/cookies') && init?.method === 'DELETE') {
        return jsonResponse({ ok: true, status: UNCONFIGURED });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const user = await renderOpenPanel();

    // Configured state is visible, with a Remove button.
    const removeBtn = await screen.findByRole('button', { name: /remove/i });
    expect(screen.getByText(/cookies active — 3 youtube cookies\./i)).toBeInTheDocument();

    await user.click(removeBtn);

    await waitFor(() => expect(screen.getByText(/cookies removed\./i)).toBeInTheDocument());
    expect(screen.queryByText(/cookies active/i)).not.toBeInTheDocument();
  });

  it('shows an error when the remove request fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/ytdlp/cookies/status')) return jsonResponse(UPLOADED);
      if (init?.method === 'DELETE') throw new Error('network down');
      throw new Error(`unexpected fetch: ${url}`);
    });

    const user = await renderOpenPanel();
    await user.click(await screen.findByRole('button', { name: /remove/i }));

    await waitFor(() =>
      expect(screen.getByText(/could not remove cookies\./i)).toBeInTheDocument(),
    );
  });
});
