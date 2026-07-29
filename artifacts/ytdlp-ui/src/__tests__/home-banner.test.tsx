/**
 * Tests for the API-unreachable banner in home.tsx
 *
 * The banner is shown when the /healthz endpoint is unreachable (network
 * failure or a non-2xx response).  When /healthz responds with 200 OK the
 * banner must be absent and the FETCH button must be enabled.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, afterEach } from 'vitest';

// home.tsx reads `import.meta.env.VITE_API_URL` and `import.meta.env.BASE_URL`
// at module evaluation time.  We stub those before the first import so the
// module-level `API` constant is predictable in tests.
vi.stubEnv('VITE_API_URL', '');
// Vitest sets BASE_URL to '/' by default; ensure it's present.
vi.stubEnv('BASE_URL', '/');

// Dynamically import after stubbing env so the module-level `API` constant
// picks up the stubs.
const { default: Home } = await import('../pages/home');

const BANNER_HEADING = 'API_SERVER_UNREACHABLE';
const FETCH_BUTTON_TEXT = 'FETCH';

// ── helpers ───────────────────────────────────────────────────────────────────

/** Returns a minimal Response-like object recognised by the component. */
function okResponse(): Response {
  return new Response('ok', { status: 200 });
}

function notOkResponse(status = 503): Response {
  return new Response('', { status });
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe('API-unreachable banner', () => {
  it('shows the banner when /healthz throws a network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('Network error')));

    render(<Home />);

    await waitFor(() => {
      expect(screen.getByText(BANNER_HEADING)).toBeInTheDocument();
    });
  });

  it('shows the banner when /healthz returns a non-ok HTTP status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(notOkResponse(503)));

    render(<Home />);

    await waitFor(() => {
      expect(screen.getByText(BANNER_HEADING)).toBeInTheDocument();
    });
  });

  it('shows the banner when /healthz times out (AbortError)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(
      Object.assign(new Error('AbortError'), { name: 'AbortError' }),
    ));

    render(<Home />);

    await waitFor(() => {
      expect(screen.getByText(BANNER_HEADING)).toBeInTheDocument();
    });
  });

  it('does NOT show the banner when /healthz responds 200 OK', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(okResponse()));

    render(<Home />);

    // Wait for the health check to resolve and confirm the banner is absent.
    await waitFor(() => {
      expect(screen.queryByText(BANNER_HEADING)).not.toBeInTheDocument();
    });
  });

  it('FETCH button is disabled while checking reachability', () => {
    // fetch never resolves → apiStatus stays 'checking'
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));

    render(<Home />);

    // While checking, the button shows a spinner and has title="Checking API server…"
    const fetchBtn = screen.getByTitle('Checking API server…');
    // Button is disabled because apiStatus !== 'ok'
    expect(fetchBtn).toBeDisabled();
  });

  it('FETCH button becomes enabled after a successful health check when a URL is typed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(okResponse()));

    render(<Home />);

    // Wait for the health-check to pass.
    await waitFor(() => {
      expect(screen.queryByText(BANNER_HEADING)).not.toBeInTheDocument();
    });

    // Type a URL so the "!urlInput.trim()" guard is also cleared.
    const input = screen.getByPlaceholderText(/Target URL/i);
    await userEvent.type(input, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');

    const fetchBtn = screen.getByRole('button', { name: FETCH_BUTTON_TEXT });
    expect(fetchBtn).not.toBeDisabled();
  });

  it('FETCH button remains disabled after a failed health check even with a URL typed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('Network error')));

    render(<Home />);

    await waitFor(() => {
      expect(screen.getByText(BANNER_HEADING)).toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText(/Target URL/i);
    await userEvent.type(input, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');

    const fetchBtn = screen.getByRole('button', { name: FETCH_BUTTON_TEXT });
    expect(fetchBtn).toBeDisabled();
  });
});
