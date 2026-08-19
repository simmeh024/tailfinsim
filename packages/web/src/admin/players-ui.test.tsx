import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import type {
  AdminPlayerDetail,
  AdminPlayerSummary,
  MeResponse,
  VersionResponse,
} from '@tailfin/shared';

import { App } from '../App';

/**
 * The Players section (M1A-08).
 *
 * The server owns the data and the rules; `admin/players.test.ts` proves those
 * against a database. What is tested here is the half that only exists in the
 * interface:
 *
 *   - one search box that takes whatever support was handed
 *   - a detail view that never renders anything that could sign somebody in
 *   - an honest statement that looking is recorded, made *before* looking
 *   - nothing that edits, bans or impersonates
 */

const ADMIN: MeResponse = {
  player: {
    id: '11111111-2222-3333-4444-555555555555',
    displayName: 'Amelia Hart',
    avatarUrl: null,
    createdAt: '2026-08-17T09:00:00.000Z',
  },
  registrationOpen: false,
  isAdmin: true,
};

const VERSION: VersionResponse = {
  build: 214,
  commit: 'abc9999',
  environment: 'dev',
  startedAt: '2026-08-18T20:00:00.000Z',
  ref: 'origin/main',
  deployedAt: '2026-08-18T19:55:00.000Z',
  serverTime: '2026-08-18T20:05:00.000Z',
};

const ROWS: AdminPlayerSummary[] = [
  {
    id: 'aaaaaaaa-1111-2222-3333-444444444444',
    displayName: 'Amelia Hart',
    createdAt: '2026-08-17T09:00:00.000Z',
    lastSeenAt: '2026-08-18T20:00:00.000Z',
    airlines: 2,
    isAdmin: true,
  },
  {
    id: 'bbbbbbbb-1111-2222-3333-444444444444',
    displayName: 'Never Seen',
    createdAt: '2026-08-16T09:00:00.000Z',
    lastSeenAt: null,
    airlines: 0,
    isAdmin: false,
  },
];

const DETAIL: AdminPlayerDetail = {
  id: 'aaaaaaaa-1111-2222-3333-444444444444',
  displayName: 'Amelia Hart',
  avatarUrl: null,
  createdAt: '2026-08-17T09:00:00.000Z',
  isAdmin: true,
  identities: [
    {
      provider: 'google',
      subject: '108124019283740192837',
      email: 'amelia@example.com',
      createdAt: '2026-08-17T09:00:00.000Z',
    },
  ],
  sessions: [
    {
      id: 'cccccccc-1111-2222-3333-444444444444',
      createdAt: '2026-08-18T08:00:00.000Z',
      expiresAt: '2026-09-17T08:00:00.000Z',
      lastSeenAt: '2026-08-18T20:00:00.000Z',
      expired: false,
    },
    {
      id: 'dddddddd-1111-2222-3333-444444444444',
      createdAt: '2026-07-01T08:00:00.000Z',
      expiresAt: '2026-07-31T08:00:00.000Z',
      lastSeenAt: '2026-07-20T20:00:00.000Z',
      expired: true,
    },
  ],
  airlines: [
    {
      id: 'eeeeeeee-1111-2222-3333-444444444444',
      worldId: 'ffffffff-1111-2222-3333-444444444444',
      worldName: 'Flagship',
      name: 'Hart Air',
      iataCode: 'HA',
      icaoCode: 'XHA',
      callsign: 'HARTAIR',
      cashMinor: 50_000_000,
      reputation: 0.35,
      createdAt: '2026-08-17T10:00:00.000Z',
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

function stubApi(options: { rows?: AdminPlayerSummary[]; detail?: AdminPlayerDetail | null } = {}) {
  const requested: string[] = [];
  const rows = options.rows ?? ROWS;
  const fetchMock = vi.fn((input: unknown) => {
    const url = String(input);
    requested.push(url);

    if (url === '/api/me') return Promise.resolve(jsonResponse(ADMIN));
    if (url === '/api/version') return Promise.resolve(jsonResponse(VERSION));
    if (url.startsWith('/api/admin/audit')) return Promise.resolve(jsonResponse({ entries: [] }));
    if (url === '/api/admin/admins') return Promise.resolve(jsonResponse({ admins: [] }));
    if (url === '/api/admin/worlds/health')
      return Promise.resolve(
        jsonResponse({
          worlds: [],
          datasets: [],
          serverTime: '2026-08-19T12:00:00.000Z',
          behindAfterMs: 60000,
        }),
      );

    if (url.startsWith('/api/admin/players/')) {
      const detail = options.detail === undefined ? DETAIL : options.detail;
      return Promise.resolve(
        detail === null
          ? jsonResponse({ code: 'player_not_found', message: 'No player with that id.' }, 404)
          : jsonResponse({ player: detail }),
      );
    }

    if (url.startsWith('/api/admin/players')) {
      const query = new URL(url, 'http://x').searchParams.get('q') ?? '';
      const matched =
        query === ''
          ? rows
          : rows.filter((row) => row.displayName.toLowerCase().includes(query.toLowerCase()));
      return Promise.resolve(
        jsonResponse({
          players: matched,
          total: matched.length,
          query,
          limit: 50,
          offset: 0,
        }),
      );
    }

    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
  vi.stubGlobal('fetch', fetchMock);
  return { requested };
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe('the players section', () => {
  it('is in the console nav, at /admin/players', async () => {
    stubApi();
    renderAt('/admin');

    const nav = await screen.findByRole('navigation', { name: /admin sections/i });
    const link = within(nav).getByRole('link', { name: 'Players' });
    expect(link).toHaveAttribute('href', '/admin/players');
  });

  it('lists who exists, and what they hold', async () => {
    stubApi();
    renderAt('/admin/players');

    expect(await screen.findByRole('link', { name: 'Amelia Hart' })).toBeInTheDocument();
    const table = screen.getByRole('table');
    expect(within(table).getByText('2026-08-18 20:00')).toBeInTheDocument();
    // An account that has never signed in says so rather than showing a blank.
    expect(within(table).getByText('never')).toBeInTheDocument();
  });

  it('says it is read-only, and which milestone owns the rest', async () => {
    // Otherwise an admin hunts for a suspend button that was never built.
    stubApi();
    renderAt('/admin/players');

    expect(await screen.findByText(/read-only/i)).toBeInTheDocument();
    expect(screen.getByText(/M11-06/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /suspend|ban|delete|impersonate/i })).toBeNull();
  });

  it('warns that opening a player is recorded, before it is opened', async () => {
    // Being told afterwards is not being told.
    stubApi();
    renderAt('/admin/players');

    await screen.findByRole('link', { name: 'Amelia Hart' });
    expect(screen.getByText(/records a/i)).toHaveTextContent('player.viewed');
  });

  it('sends the search to the server rather than filtering what it already has', async () => {
    // The list is one page of many; filtering client-side would search the page
    // instead of the players.
    const { requested } = stubApi();
    renderAt('/admin/players');

    await screen.findByRole('link', { name: 'Amelia Hart' });
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'never' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    await waitFor(() => {
      expect(requested.some((url) => url.includes('q=never'))).toBe(true);
    });
    expect(await screen.findByRole('link', { name: 'Never Seen' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Amelia Hart' })).toBeNull();
  });

  it('says plainly when a search matches nobody', async () => {
    stubApi();
    renderAt('/admin/players');

    await screen.findByRole('link', { name: 'Amelia Hart' });
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'nobody' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    expect(await screen.findByText(/nothing matches .nobody./i)).toBeInTheDocument();
  });

  it('offers one box for a name, an airline or a code', async () => {
    stubApi();
    renderAt('/admin/players');

    const input = await screen.findByLabelText('Search');
    expect(input.getAttribute('aria-describedby')).toBeTruthy();
    expect(screen.getByText(/IATA\/ICAO code/i)).toBeInTheDocument();
  });
});

describe('one player in detail', () => {
  it('shows identities, sessions and airlines', async () => {
    stubApi();
    renderAt('/admin/players/aaaaaaaa-1111-2222-3333-444444444444');

    expect(await screen.findByRole('heading', { name: 'Amelia Hart' })).toBeInTheDocument();
    expect(screen.getByText('amelia@example.com')).toBeInTheDocument();
    expect(screen.getByText('108124019283740192837')).toBeInTheDocument();
    expect(screen.getByText('Hart Air')).toBeInTheDocument();
    expect(screen.getByText('Flagship')).toBeInTheDocument();
    // Cash is integer minor units on the wire; the console is where it becomes
    // money a person can read.
    expect(screen.getByText('500,000')).toBeInTheDocument();
  });

  it('says which sessions are live and which have expired', async () => {
    stubApi();
    renderAt('/admin/players/aaaaaaaa-1111-2222-3333-444444444444');

    await screen.findByRole('heading', { name: 'Amelia Hart' });
    expect(screen.getByText('live')).toBeInTheDocument();
    expect(screen.getByText('expired')).toBeInTheDocument();
  });

  it('renders nothing that could sign anyone in', async () => {
    stubApi();
    renderAt('/admin/players/aaaaaaaa-1111-2222-3333-444444444444');

    await screen.findByRole('heading', { name: 'Amelia Hart' });
    // Session ids are uuids, which are fine — a 64-character hex string would be
    // the token hash, and there is nowhere for one to come from.
    expect(/[0-9a-f]{64}/.test(document.body.textContent ?? '')).toBe(false);
    expect(screen.getByText(/never stored/i)).toBeInTheDocument();
  });

  it('tells the admin the view was recorded', async () => {
    stubApi();
    renderAt('/admin/players/aaaaaaaa-1111-2222-3333-444444444444');

    expect(await screen.findByText(/recorded in the audit log/i)).toBeInTheDocument();
  });

  it('handles a player that is not there without looking broken', async () => {
    stubApi({ detail: null });
    renderAt('/admin/players/aaaaaaaa-1111-2222-3333-444444444444');

    expect(await screen.findByText(/no player with that id/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to players/i })).toBeInTheDocument();
  });

  it('has a URL of its own, so a support conversation can link to it', async () => {
    stubApi();
    renderAt('/admin/players');

    const link = await screen.findByRole('link', { name: 'Amelia Hart' });
    expect(link).toHaveAttribute('href', '/admin/players/aaaaaaaa-1111-2222-3333-444444444444');
  });
});

describe('the audit log and views', () => {
  it('leaves views out until they are asked for', async () => {
    // The visible half of the decision: recorded, and not in the way.
    const { requested } = stubApi();
    renderAt('/admin/audit');

    // Waiting for the heading is not enough, and this flaked in CI because of
    // it: React renders first and runs effects afterwards, so the heading can be
    // on screen before the fetch it triggers has been made. Wait for the request
    // itself — the thing actually being asserted on.
    await waitFor(() => {
      expect(requested.some((url) => url === '/api/admin/audit')).toBe(true);
    });
    expect(requested.some((url) => url.includes('includeViews=true'))).toBe(false);

    fireEvent.click(screen.getByLabelText(/include views/i));

    await waitFor(() => {
      expect(requested.some((url) => url.includes('includeViews=true'))).toBe(true);
    });
  });

  it('explains why they are hidden rather than just hiding them', async () => {
    stubApi();
    renderAt('/admin/audit');

    await screen.findByRole('heading', { name: /audit log/i });
    expect(screen.getByText(/bury the ones that changed something/i)).toBeInTheDocument();
  });
});
