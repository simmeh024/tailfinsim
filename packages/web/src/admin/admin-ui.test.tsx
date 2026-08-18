import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import type {
  AdminAuditResponse,
  AdminListResponse,
  MeResponse,
  VersionResponse,
} from '@tailfin/shared';

import { App } from '../App';

/**
 * The admin link and the console behind it (M1A-01).
 *
 * The behaviour worth protecting is that the link is *offered* to the right
 * people and sits where it was asked to sit. It is not a security test — the
 * console's data is protected by `requireAdmin` on the server, and
 * `admin.test.ts` is where that is proven. Hiding the link keeps a control
 * nobody else can use out of everybody else's way; it does not keep anyone out.
 */

const PLAYER: MeResponse = {
  player: {
    id: '11111111-2222-3333-4444-555555555555',
    displayName: 'Amelia Hart',
    avatarUrl: null,
    createdAt: '2026-08-17T09:00:00.000Z',
  },
  registrationOpen: false,
  isAdmin: false,
};

const ADMIN: MeResponse = { ...PLAYER, isAdmin: true };

const VERSION: VersionResponse = {
  build: 204,
  commit: 'def5678',
  environment: 'dev',
  startedAt: '2026-08-18T20:00:00.000Z',
  serverTime: '2026-08-18T20:05:00.000Z',
};

const AUDIT: AdminAuditResponse = {
  entries: [
    {
      id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      at: '2026-08-18T19:00:00.000Z',
      actorPlayerId: null,
      actorLabel: 'bootstrap (command line)',
      action: 'admin.granted',
      subjectType: 'player',
      subjectId: '11111111-2222-3333-4444-555555555555',
      before: { admin: false },
      after: { admin: true },
      requestId: null,
    },
  ],
};

const ADMINS: AdminListResponse = {
  admins: [
    {
      playerId: '11111111-2222-3333-4444-555555555555',
      displayName: 'Amelia Hart',
      grantedAt: '2026-08-18T19:00:00.000Z',
      grantedByPlayerId: null,
      grantedByLabel: null,
    },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

/**
 * Stubs the endpoints, and answers 403 to the admin routes for a non-admin —
 * the same thing the server does, so a test cannot pass by talking to a server
 * more generous than the real one.
 */
function stubApi(me: MeResponse) {
  const fetchMock = vi.fn((input: unknown) => {
    const url = String(input);
    if (url === '/api/me') return Promise.resolve(jsonResponse(me));
    if (url === '/api/version') return Promise.resolve(jsonResponse(VERSION));
    if (url === '/api/auth/logout') return Promise.resolve(jsonResponse({ signedOut: true }));
    if (url.startsWith('/api/admin/')) {
      if (!me.isAdmin) return Promise.resolve(jsonResponse({ code: 'forbidden' }, 403));
      if (url === '/api/admin/audit') return Promise.resolve(jsonResponse(AUDIT));
      if (url === '/api/admin/admins') return Promise.resolve(jsonResponse(ADMINS));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe('the admin link', () => {
  it('is not offered to an ordinary player', async () => {
    stubApi(PLAYER);
    renderAt('/world');

    await screen.findByText('build 204');
    expect(screen.queryByRole('link', { name: 'admin' })).toBeNull();
  });

  it('is offered to an admin', async () => {
    stubApi(ADMIN);
    renderAt('/world');

    const link = await screen.findByRole('link', { name: 'admin' });
    expect(link).toHaveAttribute('href', '/admin');
  });

  it('sits between the server clock and the build label', async () => {
    // Where it was asked to go. Asserted on the order of the badge's children
    // rather than on pixels, which is the part that can actually regress.
    stubApi(ADMIN);
    renderAt('/world');

    // Both, before looking. The clock arrives in a second effect after the badge
    // itself renders, so waiting only for the build number races it — locally it
    // won, in CI it lost.
    await screen.findByText('build 204');
    await screen.findByText(/UTC$/);
    await screen.findByRole('link', { name: 'admin' });

    const badge = document.querySelector('.build');
    expect(badge).not.toBeNull();

    const order = Array.from(badge?.children ?? []).map((el) => el.className.split(' ')[0]);
    expect(order).toEqual(['build__clock', 'build__admin', 'build__env', 'build__number']);
  });

  it('disappears when the admin signs out', async () => {
    // A shared machine must not be left with the console door visibly ajar.
    stubApi(ADMIN);
    renderAt('/world');

    await screen.findByRole('link', { name: 'admin' });
    screen.getByRole('button', { name: /sign out/i }).click();

    await waitFor(() => {
      expect(screen.queryByRole('link', { name: 'admin' })).toBeNull();
    });
  });
});

describe('the admin console', () => {
  it('shows the audit log and who holds a grant', async () => {
    stubApi(ADMIN);
    renderAt('/admin');

    expect(await screen.findByRole('heading', { name: /admin console/i })).toBeInTheDocument();
    expect(await screen.findByText('admin.granted')).toBeInTheDocument();
    expect(await screen.findByText('bootstrap (command line)')).toBeInTheDocument();
  });

  it('says the log cannot be edited, because that is the point of it', async () => {
    stubApi(ADMIN);
    renderAt('/admin');
    expect(await screen.findByText(/append-only/i)).toBeInTheDocument();
  });

  it('names what is not built yet rather than mocking it up', async () => {
    // A disabled "Reset world" button implies a button that will work. Saying it
    // is not built costs nothing and misleads nobody.
    stubApi(ADMIN);
    renderAt('/admin');

    expect(await screen.findByText(/not built yet/i)).toBeInTheDocument();
    expect(screen.getByText(/Open, lock, archive and reset a world/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reset/i })).toBeNull();
  });

  it('refuses an ordinary player who navigates straight to it', async () => {
    stubApi(PLAYER);
    renderAt('/admin');

    expect(
      await screen.findByRole('heading', { name: /administrators only/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /audit log/i })).toBeNull();
  });

  it('does not ask the server for admin data when it knows it will be refused', async () => {
    // The page checks the session before it fetches. Firing two requests it
    // knows will 403 would put a warning in the server log every time someone
    // wandered onto the URL.
    const fetchMock = stubApi(PLAYER);
    renderAt('/admin');

    await screen.findByRole('heading', { name: /administrators only/i });
    const adminCalls = fetchMock.mock.calls.filter((call) =>
      String(call[0]).startsWith('/api/admin/'),
    );
    expect(adminCalls).toHaveLength(0);
  });
});
