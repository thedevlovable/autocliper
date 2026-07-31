/**
 * CookiePanel — YouTube cookies upload panel (admin-only, on the Clipper page).
 *
 * Contract with the API server (routes/cookies.ts):
 *   GET  /ytdlp/cookies/status → status chip
 *   POST /ytdlp/cookies { cookies } → saves and returns the fresh status
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import CookiePanel from '../components/CookiePanel';

const notConfigured = {
  configured: false,
  source: null,
  youtubeCookieCount: 0,
  updatedAt: null,
  likelyExpired: false,
  likelyExpiredAt: null,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('CookiePanel', () => {
  it('shows the Not connected chip from the status endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify(notConfigured), { status: 200 }),
    ));
    render(<CookiePanel api="/api" />);
    await waitFor(() => expect(screen.getByText('Not connected')).toBeTruthy());
  });

  it('saves pasted cookies via POST and confirms the count', async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push([String(url), init]);
      if (String(url).includes('/status')) {
        return new Response(JSON.stringify(notConfigured), { status: 200 });
      }
      return new Response(JSON.stringify({
        ok: true,
        youtubeCookieCount: 12,
        status: { ...notConfigured, configured: true, source: 'uploaded', youtubeCookieCount: 12 },
      }), { status: 200 });
    }));

    render(<CookiePanel api="/api" />);
    fireEvent.click(screen.getByRole('button', { name: /YouTube cookies/i }));
    fireEvent.change(screen.getByPlaceholderText(/paste the contents/i), {
      target: { value: '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tabc' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save cookies/i }));

    await waitFor(() => expect(screen.getByText(/12 YouTube cookies saved/i)).toBeTruthy());
    const post = calls.find(([, init]) => init?.method === 'POST');
    expect(post?.[0]).toBe('/api/ytdlp/cookies');
    expect(JSON.parse(String(post?.[1]?.body)).cookies).toContain('.youtube.com');
    // Active chip reflects the fresh status returned by the save.
    expect(screen.getByText(/Active · 12 cookies/i)).toBeTruthy();
  });

  it('surfaces a 422 validation error from the server', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({ error: 'No YouTube cookies found in that file.' }), { status: 422 });
      }
      return new Response(JSON.stringify(notConfigured), { status: 200 });
    }));

    render(<CookiePanel api="/api" />);
    fireEvent.click(screen.getByRole('button', { name: /YouTube cookies/i }));
    fireEvent.change(screen.getByPlaceholderText(/paste the contents/i), { target: { value: 'garbage' } });
    fireEvent.click(screen.getByRole('button', { name: /Save cookies/i }));
    await waitFor(() => expect(screen.getByText(/No YouTube cookies found/i)).toBeTruthy());
  });
});
