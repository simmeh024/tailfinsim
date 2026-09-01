import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import type { MeResponse, VersionResponse, WorldClock } from '@tailfin/shared';

import { App } from '../App';

import { LoginPage } from './LoginPage';
import { SessionProvider } from './SessionProvider';

import type { ReactNode } from 'react';

/**
 * Sign-in, the login wall, and the account control (M0-11, M0-12).
 *
 * These drive the whole app through `MemoryRouter` rather than testing
 * components in isolation, because the behaviours worth protecting are
 * integration behaviours: that the app is not reachable without a session, that
 * the badge appears in the rail, and that `?auth_error=` survives the redirect.
 */

const PLAYER: MeResponse = {
  player: {
    id: '11111111-2222-3333-4444-555555555555',
    displayName: 'Amelia Hart',
    avatarUrl: 'https://example.test/avatar.png',
    createdAt: '2026-08-17T09:00:00.000Z',
    displayCurrency: 'USD',
  },
  registrationOpen: false,
  isAdmin: false,
};

const ANONYMOUS: MeResponse = { player: null, registrationOpen: false, isAdmin: false };

const VERSION: VersionResponse = {
  build: 137,
  commit: 'abc1234',
  environment: 'dev',
  startedAt: '2026-08-17T20:00:00.000Z',
  ref: 'origin/main',
  deployedAt: '2026-08-18T19:55:00.000Z',
  serverTime: '2026-08-17T20:05:00.000Z',
};

const WORLD_CLOCK: WorldClock = {
  worldId: '00000000-0000-4000-8000-000000000001',
  serverTime: VERSION.serverTime,
  inGameTime: '2024-10-20T06:00:00.000Z',
  speedMultiplier: 2,
};

/**
 * A hand-rolled response rather than the platform `Response`, so the tests do
 * not depend on which fetch globals the jsdom environment happens to expose.
 */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

/** Stubs the endpoints the client calls, and fails loudly on any other. */
function stubApi(me: MeResponse | 'error', worldClock: WorldClock | null = WORLD_CLOCK) {
  const calls: string[] = [];
  const fetchMock = vi.fn((input: unknown) => {
    const url = String(input);
    calls.push(url);
    if (url === '/api/me') {
      return Promise.resolve(
        me === 'error' ? jsonResponse({ code: 'internal_error' }, 500) : jsonResponse(me),
      );
    }
    if (url === '/api/version') return Promise.resolve(jsonResponse(VERSION));
    if (url === '/api/world/clock') {
      return Promise.resolve(
        worldClock === null
          ? jsonResponse({ code: 'active_world_required' }, 409)
          : jsonResponse(worldClock),
      );
    }
    if (url === '/api/auth/logout') return Promise.resolve(jsonResponse({ signedOut: true }));
    if (url === '/api/auth/logout-all')
      return Promise.resolve(jsonResponse({ signedOut: true, revokedSessions: 2 }));
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

/** Renders the router's current path, so a redirect can be asserted on. */
function LocationProbe(): ReactNode {
  const { pathname, search } = useLocation();
  return <span data-testid="location">{pathname + search}</span>;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe('the login wall', () => {
  it('shows the front door instead of the app when signed out', async () => {
    stubApi(ANONYMOUS);
    renderAt('/world');

    expect(await screen.findByRole('link', { name: /sign in with google/i })).toBeInTheDocument();
    // The app itself must not be rendered behind it.
    expect(screen.queryByRole('navigation', { name: 'Main' })).not.toBeInTheDocument();
    expect(screen.queryByRole('main', { name: 'World' })).not.toBeInTheDocument();
  });

  it('gates every route, not just the index', async () => {
    // Route-by-route gating means each new route is a chance to forget one.
    stubApi(ANONYMOUS);
    for (const path of ['/fleet', '/finance', '/board', '/nonsense']) {
      const { unmount } = renderAt(path);
      expect(await screen.findByRole('link', { name: /sign in with google/i })).toBeInTheDocument();
      expect(screen.queryByRole('navigation', { name: 'Main' })).not.toBeInTheDocument();
      unmount();
    }
  });

  it('opens the app once there is a session', async () => {
    stubApi(PLAYER);
    renderAt('/world');

    expect(await screen.findByRole('navigation', { name: 'Main' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /sign in with google/i })).not.toBeInTheDocument();
  });

  it('does not flash the login page while the session is still unknown', () => {
    // The default stub never settles, so the session stays in `loading`.
    renderAt('/world');
    expect(screen.queryByRole('link', { name: /sign in with google/i })).not.toBeInTheDocument();
    expect(screen.getByText(/checking your sign-in/i)).toBeInTheDocument();
  });

  it('says the server is unreachable rather than offering a sign-in that cannot work', async () => {
    stubApi('error');
    renderAt('/world');

    expect(await screen.findByRole('alert')).toHaveTextContent(/cannot reach tailfin/i);
    expect(screen.queryByRole('link', { name: /sign in with google/i })).not.toBeInTheDocument();
  });

  it('offers sign-in as a link, not a button', async () => {
    // It must be a real navigation: /api/auth/google 302s to Google's consent
    // screen, which an XHR cannot follow.
    stubApi(ANONYMOUS);
    renderAt('/world');

    expect(await screen.findByRole('link', { name: /sign in with google/i })).toHaveAttribute(
      'href',
      '/api/auth/google',
    );
  });

  it('asks the server who it is exactly once on mount', async () => {
    const { calls } = stubApi(ANONYMOUS);
    renderAt('/world');
    await screen.findByRole('link', { name: /sign in with google/i });
    expect(calls.filter((url) => url === '/api/me')).toHaveLength(1);
  });

  it('says whether new accounts are being created', async () => {
    stubApi(ANONYMOUS);
    renderAt('/world');
    expect(await screen.findByText(/not open for new accounts/i)).toBeInTheDocument();
  });

  it('says so when registration is open', async () => {
    stubApi({ player: null, registrationOpen: true, isAdmin: false });
    renderAt('/world');
    expect(await screen.findByText(/new accounts are open/i)).toBeInTheDocument();
  });
});

describe('signed in', () => {
  it('shows the display name and avatar in the rail', async () => {
    stubApi(PLAYER);
    renderAt('/world');

    expect(await screen.findByText('Amelia Hart')).toBeInTheDocument();

    // Decorative: the name beside it already carries the meaning, so alt text
    // would be read out twice.
    const avatar = document.querySelector('img.account__avatar');
    expect(avatar).toHaveAttribute('src', 'https://example.test/avatar.png');
    expect(avatar).toHaveAttribute('alt', '');
    expect(avatar).toHaveAttribute('referrerpolicy', 'no-referrer');
  });

  it('falls back to an initial when the account has no picture', async () => {
    stubApi({ ...PLAYER, player: { ...PLAYER.player!, avatarUrl: null } });
    renderAt('/world');

    await screen.findByText('Amelia Hart');
    expect(document.querySelector('img.account__avatar')).toBeNull();
    expect(screen.getByText('A')).toBeInTheDocument();
  });

  it('signs out through the server, then returns to the front door', async () => {
    const { calls } = stubApi(PLAYER);
    renderAt('/world');

    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));

    // The POST matters: clearing the cookie client-side would leave the session
    // alive on the server.
    await waitFor(() => {
      expect(calls).toContain('/api/auth/logout');
    });
    expect(await screen.findByRole('link', { name: /sign in with google/i })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Main' })).not.toBeInTheDocument();
  });

  it('can end every session through the server', async () => {
    const { calls } = stubApi(PLAYER);
    renderAt('/world');

    fireEvent.click(await screen.findByRole('button', { name: 'Sign out everywhere' }));

    await waitFor(() => {
      expect(calls).toContain('/api/auth/logout-all');
    });
    expect(await screen.findByRole('link', { name: /sign in with google/i })).toBeInTheDocument();
  });
});

describe('auth_error in the query string', () => {
  it('explains a refused registration in words, not a slug', async () => {
    stubApi(ANONYMOUS);
    renderAt('/world?auth_error=registration_closed');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Tailfin is not open for new accounts yet.');
    expect(alert).not.toHaveTextContent('registration_closed');
  });

  it('survives the callback landing on /', async () => {
    // The callback redirects to `/?auth_error=…`, which is a different route
    // from where the message is read.
    stubApi(ANONYMOUS);
    renderAt('/?auth_error=provider_error');

    expect(await screen.findByRole('alert')).toHaveTextContent(/google did not complete/i);
  });

  it('clears the code from the URL so a refresh does not resurrect it', async () => {
    stubApi(ANONYMOUS);
    // The login page on its own here, with a probe for the router's location —
    // `App` gives no way to observe the URL, and asserting on `window.location`
    // would pass vacuously since MemoryRouter never touches it.
    render(
      <MemoryRouter initialEntries={['/world?auth_error=state_mismatch']}>
        <SessionProvider>
          <LoginPage />
          <LocationProbe />
        </SessionProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('expired');

    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('/world');
    });
    expect(screen.getByTestId('location').textContent).not.toContain('auth_error');
    // The message stays on screen; only the URL is tidied.
    expect(screen.getByRole('alert')).toHaveTextContent('expired');
  });

  it('falls back to a generic message for a code it does not know', async () => {
    stubApi(ANONYMOUS);
    renderAt('/world?auth_error=something_new');

    expect(await screen.findByRole('alert')).toHaveTextContent('Sign-in failed');
  });
});

describe('the build badge', () => {
  it('reports the build the server says it is, not one baked into the bundle', async () => {
    stubApi(PLAYER);
    renderAt('/world');

    expect(await screen.findByText('build 137')).toBeInTheDocument();
    expect(screen.getByText('dev')).toBeInTheDocument();
  });

  it('appears on the login page too, where there is no status strip', async () => {
    const { calls } = stubApi(ANONYMOUS);
    renderAt('/world');

    await screen.findByRole('link', { name: /sign in with google/i });
    expect(await screen.findByText('build 137')).toBeInTheDocument();
    expect(screen.queryByLabelText('In-game time')).not.toBeInTheDocument();
    expect(calls).not.toContain('/api/world/clock');
  });

  it('sits at the end of the status strip — the bottom right of the page', async () => {
    stubApi(PLAYER);
    renderAt('/world');

    await screen.findByText('build 137');
    const strip = screen.getByLabelText('Status');
    const badge = strip.querySelector('.build');
    expect(badge).not.toBeNull();
    // Last element in the strip, after the spacer that pushes it right.
    expect(strip.lastElementChild).toBe(badge);
  });

  it('carries the commit in a tooltip rather than on screen', async () => {
    stubApi(PLAYER);
    renderAt('/world');

    const badge = (await screen.findByText('build 137')).closest('.build');
    expect(badge).toHaveAttribute('title', expect.stringContaining('abc1234'));
    expect(badge).not.toHaveTextContent('abc1234');
  });

  it('shows the in-game clock to the left of the build label', async () => {
    stubApi(PLAYER);
    renderAt('/world');

    // Waits for the clock itself, not just for the badge. The clock arrives in a
    // separate request from the version, so waiting on the build
    // number races it — a race this won locally every time and lost on CI.
    await screen.findByText('build 137');
    await screen.findByLabelText('In-game time');

    const badge = document.querySelector('.build')!;
    const clock = badge.querySelector('.build__clock');
    expect(clock).not.toBeNull();
    // Order matters: date and time first, then environment, then build.
    expect(badge.firstElementChild).toBe(clock);
  });

  it('shows in-game time, not server wall time or the browser clock', async () => {
    vi.setSystemTime(new Date('2020-01-01T00:00:00.000Z'));
    try {
      stubApi(PLAYER);
      renderAt('/world');

      const clock = await screen.findByLabelText('In-game time');
      expect(clock.textContent).toContain('2024-10-20 06:00');
      expect(clock.textContent).not.toContain('2026');
      expect(clock.textContent).not.toContain('2020');
    } finally {
      vi.useRealTimers();
    }
  });

  it('formats as an unambiguous UTC stamp', async () => {
    stubApi(PLAYER);
    renderAt('/world');
    const clock = await screen.findByLabelText('In-game time');
    expect(clock.textContent).toMatch(
      /^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2} UTC$/,
    );
  });

  it('advances the footer at the world speed between syncs', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setInterval', 'clearInterval'] });
    const monotonic = vi.spyOn(performance, 'now').mockReturnValue(0);
    try {
      stubApi(PLAYER);
      renderAt('/finance');
      const clock = await screen.findByLabelText('In-game time');
      expect(clock).toHaveTextContent('2024-10-20 06:00:00 UTC');
      monotonic.mockReturnValue(5000);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(clock).toHaveTextContent('2024-10-20 06:00:10 UTC');
    } finally {
      monotonic.mockRestore();
      vi.useRealTimers();
    }
  });

  it('keeps the build details but hides the clock when no world is available', async () => {
    const { calls } = stubApi(PLAYER, null);
    renderAt('/finance');
    await screen.findByText('build 137');
    await waitFor(() => expect(calls).toContain('/api/world/clock'));
    expect(screen.queryByLabelText('In-game time')).not.toBeInTheDocument();
    expect(document.querySelector('.build')).not.toHaveTextContent('2026-08-17');
  });

  it('renders nothing at all when the version endpoint says nothing', async () => {
    // A corner label is not worth a layout shift or an error message.
    const fetchMock = vi.fn((input: unknown) =>
      String(input) === '/api/me'
        ? Promise.resolve(jsonResponse(PLAYER))
        : Promise.reject(new Error('down')),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderAt('/world');

    await screen.findByRole('navigation', { name: 'Main' });
    expect(document.querySelector('.build')).toBeNull();
  });
});
