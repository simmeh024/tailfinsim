import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import type { MeResponse } from '@tailfin/shared';

import { App } from '../App';

import { AccountBadge } from './AccountBadge';
import { SessionProvider } from './SessionProvider';

import type { ReactNode } from 'react';

/**
 * Sign-in UI tests (M0-11).
 *
 * These drive the whole app through `MemoryRouter`, not the badge in isolation,
 * because two of the behaviours worth protecting are integration behaviours: the
 * badge has to appear inside the rail, and `?auth_error=` has to survive the
 * `/` → `/world` redirect.
 */

const PLAYER: MeResponse = {
  player: {
    id: '11111111-2222-3333-4444-555555555555',
    displayName: 'Amelia Hart',
    avatarUrl: 'https://example.test/avatar.png',
    createdAt: '2026-08-17T09:00:00.000Z',
  },
  registrationOpen: false,
};

const ANONYMOUS: MeResponse = { player: null, registrationOpen: false };

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

/** Stubs the two endpoints the client calls, and fails loudly on any other. */
function stubApi(me: MeResponse | 'error') {
  const calls: string[] = [];
  const fetchMock = vi.fn((input: unknown) => {
    const url = String(input);
    calls.push(url);
    if (url === '/api/me') {
      return Promise.resolve(
        me === 'error' ? jsonResponse({ code: 'internal_error' }, 500) : jsonResponse(me),
      );
    }
    if (url === '/api/auth/logout') {
      return Promise.resolve(jsonResponse({ signedOut: true }));
    }
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

describe('signed out', () => {
  it('offers a Google sign-in link, not a button', async () => {
    // It must be a real navigation: /api/auth/google 302s to Google's consent
    // screen, which an XHR cannot follow.
    stubApi(ANONYMOUS);
    renderAt('/world');

    const link = await screen.findByRole('link', { name: /sign in with google/i });
    expect(link).toHaveAttribute('href', '/api/auth/google');
  });

  it('asks the server who it is exactly once on mount', async () => {
    const { calls } = stubApi(ANONYMOUS);
    renderAt('/world');
    await screen.findByRole('link', { name: /sign in with google/i });
    expect(calls.filter((url) => url === '/api/me')).toHaveLength(1);
  });
});

describe('signed in', () => {
  it('shows the display name and avatar in the rail', async () => {
    stubApi(PLAYER);
    renderAt('/world');

    expect(await screen.findByText('Amelia Hart')).toBeInTheDocument();

    // Decorative: the name beside it already carries the meaning, so an alt text
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

  it('hides the sign-in link', async () => {
    stubApi(PLAYER);
    renderAt('/world');
    await screen.findByText('Amelia Hart');
    expect(screen.queryByRole('link', { name: /sign in with google/i })).not.toBeInTheDocument();
  });

  it('signs out through the server, then shows the sign-in link again', async () => {
    const { calls } = stubApi(PLAYER);
    renderAt('/world');

    fireEvent.click(await screen.findByRole('button', { name: /sign out/i }));

    // The POST matters: clearing the cookie client-side would leave the session
    // alive on the server.
    await waitFor(() => {
      expect(calls).toContain('/api/auth/logout');
    });
    expect(await screen.findByRole('link', { name: /sign in with google/i })).toBeInTheDocument();
  });
});

describe('server unreachable', () => {
  it('says so instead of inviting a sign-in that cannot work', async () => {
    stubApi('error');
    renderAt('/world');

    expect(await screen.findByText(/server unreachable/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /sign in with google/i })).not.toBeInTheDocument();
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

  it('survives the / → /world redirect', async () => {
    // The callback redirects to `/?auth_error=…`. A redirect that dropped the
    // query string would swallow the reason the sign-in failed.
    stubApi(ANONYMOUS);
    renderAt('/?auth_error=registration_closed');

    expect(await screen.findByRole('alert')).toHaveTextContent('not open for new accounts');
    expect(screen.getByRole('heading', { level: 1, name: 'World' })).toBeInTheDocument();
  });

  it('clears the code from the URL so a refresh does not resurrect it', async () => {
    stubApi(ANONYMOUS);
    // The badge on its own here, with a probe for the router's location — `App`
    // gives no way to observe the URL, and asserting on `window.location` would
    // pass vacuously since MemoryRouter never touches it.
    render(
      <MemoryRouter initialEntries={['/world?auth_error=state_mismatch']}>
        <SessionProvider>
          <AccountBadge />
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
