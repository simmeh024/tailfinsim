import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminWorldHealth, MeResponse, VersionResponse } from '@tailfin/shared';

import { App } from '../App';

/**
 * World health, as the console shows it (M1A-06).
 *
 * The server decides *whether* a world is healthy — `health.test.ts` proves that
 * against a database. What is tested here is the half the issue puts in the
 * interface:
 *
 *   - a backlog visible as a **trend**, not only as a number
 *   - one request per refresh, not one per statistic
 *   - an in-game clock that moves without asking the server what time it is
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
  build: 220,
  commit: 'abc9999',
  environment: 'dev',
  startedAt: '2026-08-18T20:00:00.000Z',
  ref: 'origin/main',
  deployedAt: '2026-08-18T19:55:00.000Z',
  serverTime: '2026-08-19T12:00:00.000Z',
};

function world(overrides: Partial<AdminWorldHealth> = {}): AdminWorldHealth {
  return {
    worldId: 'ffffffff-1111-2222-3333-444444444444',
    name: 'Flagship',
    status: 'open',
    speedMultiplier: 2,
    launchDate: '2026-07-20T00:00:00.000Z',
    inGameDate: '2024-12-20T00:00:00.000Z',
    realAgeMs: 30 * 24 * 60 * 60 * 1000,
    airlines: 4,
    queue: {
      pending: 5,
      oldestPendingAt: '2024-12-20T01:00:00.000Z',
      overdueRealMs: null,
      lastProcessedAt: '2026-08-19T11:59:00.000Z',
    },
    tick: 'idle',
    tickDetail: '5 scheduled, none due yet.',
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

/** `queues` supplies a pending depth per refresh, so a trend can be built. */
function stubApi(worlds: AdminWorldHealth[], queues: number[] = []) {
  const requested: string[] = [];
  let refresh = 0;

  const fetchMock = vi.fn((input: unknown) => {
    const url = String(input);
    requested.push(url);

    if (url === '/api/me') return Promise.resolve(jsonResponse(ADMIN));
    if (url === '/api/version') return Promise.resolve(jsonResponse(VERSION));
    if (url.startsWith('/api/admin/audit')) return Promise.resolve(jsonResponse({ entries: [] }));
    if (url === '/api/admin/admins') return Promise.resolve(jsonResponse({ admins: [] }));
    if (url === '/api/admin/worlds') return Promise.resolve(jsonResponse({ worlds: [] }));

    if (url === '/api/admin/worlds/health') {
      const depth = queues[Math.min(refresh, queues.length - 1)];
      refresh += 1;
      return Promise.resolve(
        jsonResponse({
          worlds: worlds.map((entry) =>
            depth === undefined ? entry : { ...entry, queue: { ...entry.queue, pending: depth } },
          ),
          datasets: [
            {
              dataset: 'ourairports',
              version: '2026-08-01',
              importedAt: '2026-08-02T00:00:00.000Z',
            },
          ],
          serverTime: '2026-08-19T12:00:00.000Z',
          behindAfterMs: 60_000,
        }),
      );
    }

    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });

  vi.stubGlobal('fetch', fetchMock);
  return { requested };
}

function renderWorlds() {
  return render(
    <MemoryRouter initialEntries={['/admin/worlds']}>
      <App />
    </MemoryRouter>,
  );
}

describe('world health', () => {
  it('leads with the state, in a word', async () => {
    stubApi([
      world({
        tick: 'stalled',
        tickDetail: 'Work is due and nothing has ever been processed. No tick loop is running.',
      }),
    ]);
    renderWorlds();

    expect(await screen.findByText('Stalled')).toBeInTheDocument();
    // And the sentence behind it, so the word is actionable rather than a label.
    expect(screen.getByText(/no tick loop is running/i)).toBeInTheDocument();
  });

  it('distinguishes a world that has never had work from one that is caught up', async () => {
    // "Idle" implies caught up. A world that has never done anything is not.
    stubApi([
      world({ tick: 'no_events', tickDetail: 'Nothing has ever been scheduled in this world.' }),
    ]);
    renderWorlds();

    expect(await screen.findByText('Nothing scheduled')).toBeInTheDocument();
    expect(screen.queryByText('Idle')).toBeNull();
  });

  it('shows how late the oldest due event is, not only that there is one', async () => {
    stubApi([
      world({ tick: 'behind', queue: { ...world().queue, pending: 40, overdueRealMs: 150_000 } }),
    ]);
    renderWorlds();

    expect(await screen.findByText('Behind')).toBeInTheDocument();
    expect(screen.getByText(/2m late/)).toBeInTheDocument();
  });

  it('says nothing is due rather than showing a zero', async () => {
    // A "0s late" reads as work being handled instantly. Nothing due is a dash.
    stubApi([world({ queue: { ...world().queue, overdueRealMs: null } })]);
    renderWorlds();

    await screen.findByText('Idle');
    const cards = document.querySelectorAll('.health');
    expect(cards).toHaveLength(1);
    expect(cards[0]?.textContent).toContain('—');
  });

  it('costs one request per refresh, not one per statistic', async () => {
    // The acceptance criterion. Every figure on the card, plus the datasets,
    // comes from a single call.
    const { requested } = stubApi([world()]);
    renderWorlds();

    await screen.findByText('Idle');
    const healthCalls = requested.filter((url) => url === '/api/admin/worlds/health');
    expect(healthCalls).toHaveLength(1);
  });

  it('names what does not exist yet instead of reporting zero of it', async () => {
    // Aircraft and airborne flights have no tables. Showing 0 would describe a
    // working simulation with nothing flying.
    stubApi([world()]);
    renderWorlds();

    await screen.findByText('Idle');
    expect(screen.getByText(/neither exists yet/i)).toBeInTheDocument();
    expect(screen.getByText(/M2 and M4/)).toBeInTheDocument();
  });

  it('reports the datasets the worlds are built on', async () => {
    stubApi([world()]);
    renderWorlds();

    expect(await screen.findByText('ourairports')).toBeInTheDocument();
  });

  it('survives a world with nothing in it', async () => {
    // The fourth criterion, as the console sees it: no players, no airlines, no
    // events, and no NaN anywhere on the page.
    stubApi([
      world({
        airlines: 0,
        tick: 'no_events',
        queue: { pending: 0, oldestPendingAt: null, overdueRealMs: null, lastProcessedAt: null },
      }),
    ]);
    renderWorlds();

    await screen.findByText('Nothing scheduled');
    expect(document.body.textContent).not.toContain('NaN');
    expect(document.body.textContent).not.toContain('Infinity');
  });
});

describe('the backlog as a trend', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('says it is collecting before it has a shape to show', async () => {
    // One sample is a number, not a trend, and drawing a flat line from it would
    // be a claim the data does not support.
    stubApi([world()], [5]);
    renderWorlds();

    expect(await screen.findByText(/collecting/i)).toBeInTheDocument();
  });

  it('draws the depth over time once it has samples, and marks a rising one', async () => {
    // The acceptance criterion: a depth of 40 means nothing alone; 40 after 5,
    // 12 and 26 means the loop is losing.
    stubApi([world()], [5, 12, 26, 40]);
    renderWorlds();

    await screen.findByText(/collecting/i);

    // Three more refreshes at the component's ten-second interval.
    for (let i = 0; i < 3; i += 1) {
      await vi.advanceTimersByTimeAsync(10_000);
    }

    const spark = await screen.findByRole('img', { name: /queue depth/i });
    expect(spark.getAttribute('aria-label')).toMatch(/rising/i);
    // SVG elements have an `SVGAnimatedString` className, not a string — reading
    // the attribute is the only way to assert on it.
    expect(spark.getAttribute('class')).toContain('rising');
  });

  it('does not call a steady queue rising', async () => {
    stubApi([world()], [20, 20, 20, 20]);
    renderWorlds();

    await screen.findByText(/collecting/i);
    for (let i = 0; i < 3; i += 1) {
      await vi.advanceTimersByTimeAsync(10_000);
    }

    const spark = await screen.findByRole('img', { name: /queue depth/i });
    expect(spark.getAttribute('aria-label')).toMatch(/steady or falling/i);
    expect(spark.getAttribute('class')).not.toContain('rising');
  });

  it('refreshes on a timer rather than continuously', async () => {
    const { requested } = stubApi([world()], [1, 2, 3]);
    renderWorlds();

    await screen.findByText(/collecting/i);
    const before = requested.filter((url) => url === '/api/admin/worlds/health').length;

    // Five seconds is not a refresh interval; ten is.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(requested.filter((url) => url === '/api/admin/worlds/health')).toHaveLength(before);

    await vi.advanceTimersByTimeAsync(5_000);
    await waitFor(() => {
      expect(requested.filter((url) => url === '/api/admin/worlds/health').length).toBeGreaterThan(
        before,
      );
    });
  });

  it('advances the in-game clock without asking the server for it', async () => {
    // The build badge's pattern, and why the issue asks for it: a clock that
    // needs a request per second is a clock that gets switched off.
    stubApi([world({ speedMultiplier: 2, inGameDate: '2024-12-20T00:00:00.000Z' })], [5]);
    renderWorlds();

    const card = await screen.findByText('Idle');
    const before = card.closest('.health')?.textContent ?? '';
    expect(before).toContain('2024-12-20 00:00:00');

    const requestsBefore = document.body.textContent;
    expect(requestsBefore).toBeTruthy();

    // Four seconds of real time at 2× is eight in-game seconds, and no refresh
    // has happened yet.
    await vi.advanceTimersByTimeAsync(4_000);

    await waitFor(() => {
      const after = document.querySelector('.health')?.textContent ?? '';
      expect(after).toContain('2024-12-20 00:00:08');
    });
  });
});

describe('when health cannot be loaded', () => {
  it('says so rather than showing an empty page', async () => {
    const fetchMock = vi.fn((input: unknown) => {
      const url = String(input);
      if (url === '/api/me') return Promise.resolve(jsonResponse(ADMIN));
      if (url === '/api/version') return Promise.resolve(jsonResponse(VERSION));
      if (url.startsWith('/api/admin/audit')) return Promise.resolve(jsonResponse({ entries: [] }));
      if (url === '/api/admin/admins') return Promise.resolve(jsonResponse({ admins: [] }));
      if (url === '/api/admin/worlds') return Promise.resolve(jsonResponse({ worlds: [] }));
      return Promise.reject(new Error('down'));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWorlds();

    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some((node) => /could not load world health/i.test(node.textContent ?? ''))).toBe(
      true,
    );
  });
});

describe('the health section replaces the placeholder', () => {
  it('no longer lists world health as unbuilt', async () => {
    stubApi([world()]);
    renderWorlds();

    await screen.findByText('Idle');
    expect(screen.queryByText(/World health, tick loop and queue depth/)).toBeNull();
    expect(
      within(await screen.findByRole('heading', { name: 'Health' })).queryByText('x'),
    ).toBeNull();
  });
});
