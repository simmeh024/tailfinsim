import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminOverviewResponse, MeResponse, VersionResponse } from '@tailfin/shared';

import { App } from '../App';

import { formatAgo } from './polling';

/**
 * The overview, kept current (M1A-09).
 *
 * The acceptance criteria, and the one that matters most is the failure path:
 * a refresh that blanks the page on a blip is worse than no refresh at all.
 *
 *   - refreshes without a page reload
 *   - says how old the data is
 *   - a failed refresh keeps the last good data and says so
 *   - a backgrounded tab does not poll
 *   - one request per refresh
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
  build: 224,
  commit: 'abc9999',
  environment: 'dev',
  startedAt: '2026-08-18T20:00:00.000Z',
  serverTime: '2026-08-19T12:00:00.000Z',
};

function overview(players: number, alerts: AdminOverviewResponse['alerts'] = []) {
  return {
    counts: { players, worlds: 1, admins: 1, airports: 85_915, auditEntries: 3 },
    backup: null,
    alerts,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

/** `answers` is consumed one per overview request; `null` means "fail this one". */
function stubApi(answers: (AdminOverviewResponse | null)[]) {
  const requested: string[] = [];
  let call = 0;

  const fetchMock = vi.fn((input: unknown) => {
    const url = String(input);
    requested.push(url);

    if (url === '/api/me') return Promise.resolve(jsonResponse(ADMIN));
    if (url === '/api/version') return Promise.resolve(jsonResponse(VERSION));
    if (url === '/api/admin/admins') return Promise.resolve(jsonResponse({ admins: [] }));

    if (url === '/api/admin/overview') {
      const answer = answers[Math.min(call, answers.length - 1)];
      call += 1;
      return answer === null
        ? Promise.reject(new Error('overview is down'))
        : Promise.resolve(jsonResponse(answer));
    }

    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });

  vi.stubGlobal('fetch', fetchMock);
  return { requested, overviewCalls: () => requested.filter((u) => u === '/api/admin/overview') };
}

function renderOverview() {
  return render(
    <MemoryRouter initialEntries={['/admin']}>
      <App />
    </MemoryRouter>,
  );
}

/** jsdom leaves `visibilityState` read-only, so it is redefined for the test. */
function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('formatAgo', () => {
  it('reads as a freshness cue rather than a stopwatch', () => {
    expect(formatAgo(0)).toBe('just now');
    expect(formatAgo(4_000)).toBe('just now');
    expect(formatAgo(40_000)).toBe('40s ago');
    expect(formatAgo(3 * 60_000)).toBe('3m ago');
    expect(formatAgo(5 * 60 * 60_000)).toBe('5h ago');
    expect(formatAgo(3 * 24 * 60 * 60_000)).toBe('3d ago');
  });
});

describe('keeping the overview current', () => {
  beforeEach(() => {
    setVisibility('visible');
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    setVisibility('visible');
  });

  it('says when the data was last checked', async () => {
    stubApi([overview(4)]);
    renderOverview();

    await screen.findByText('4');
    expect(screen.getByText(/checked/i)).toBeInTheDocument();
    expect(screen.getByText(/just now/i)).toBeInTheDocument();
  });

  it('refreshes on a timer, without a page reload', async () => {
    const api = stubApi([overview(4), overview(9)]);
    renderOverview();

    await screen.findByText('4');
    expect(api.overviewCalls()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(30_000);

    expect(await screen.findByText('9')).toBeInTheDocument();
    expect(api.overviewCalls()).toHaveLength(2);
  });

  it('costs one request per refresh', async () => {
    // Not one per statistic. The admin list is deliberately not on the timer:
    // grants change rarely and are audited when they do.
    const api = stubApi([overview(4), overview(4), overview(4)]);
    renderOverview();

    await screen.findByText('4');
    await vi.advanceTimersByTimeAsync(30_000);
    await waitFor(() => {
      expect(api.overviewCalls()).toHaveLength(2);
    });

    const adminCalls = api.requested.filter((u) => u === '/api/admin/admins');
    expect(adminCalls).toHaveLength(1);
  });

  it('keeps the last good figures when a refresh fails, and says so', async () => {
    // The criterion that matters most. A blip must not empty the console.
    stubApi([overview(4), null]);
    renderOverview();

    await screen.findByText('4');
    await vi.advanceTimersByTimeAsync(30_000);

    const warning = await screen.findByText(/last refresh failed/i);
    expect(warning).toBeInTheDocument();
    // The numbers are still there.
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.queryByText(/could not load the overview/i)).toBeNull();
  });

  it('recovers quietly once a refresh succeeds again', async () => {
    stubApi([overview(4), null, overview(11)]);
    renderOverview();

    await screen.findByText('4');
    await vi.advanceTimersByTimeAsync(30_000);
    await screen.findByText(/last refresh failed/i);

    await vi.advanceTimersByTimeAsync(30_000);

    expect(await screen.findByText('11')).toBeInTheDocument();
    expect(screen.queryByText(/last refresh failed/i)).toBeNull();
  });

  it('still says it could not load when the very first attempt fails', async () => {
    // Nothing to keep, so this is the honest empty case rather than stale data.
    stubApi([null]);
    renderOverview();

    expect(await screen.findByText(/could not load the overview/i)).toBeInTheDocument();
  });

  it('does not poll a tab nobody is looking at', async () => {
    // A forgotten tab is a request a minute, per admin, for ever.
    const api = stubApi([overview(4), overview(9)]);
    renderOverview();

    await screen.findByText('4');
    expect(api.overviewCalls()).toHaveLength(1);

    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(90_000);
    expect(api.overviewCalls()).toHaveLength(1);
  });

  it('refreshes once when the tab comes back, because that is when it is looked at', async () => {
    const api = stubApi([overview(4), overview(9)]);
    renderOverview();

    await screen.findByText('4');
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.overviewCalls()).toHaveLength(1);

    setVisibility('visible');
    await waitFor(() => {
      expect(api.overviewCalls()).toHaveLength(2);
    });
    expect(await screen.findByText('9')).toBeInTheDocument();
  });

  it('refreshes on demand, because the first thing anyone does after a fix is look again', async () => {
    const api = stubApi([overview(4), overview(9)]);
    renderOverview();

    await screen.findByText('4');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(await screen.findByText('9')).toBeInTheDocument();
    expect(api.overviewCalls()).toHaveLength(2);
    // The manual one does re-read the admin list — the button means "look again
    // at everything", not "look again at some of it".
    expect(api.requested.filter((u) => u === '/api/admin/admins')).toHaveLength(2);
  });

  it('shows an alert that appears between refreshes', async () => {
    // The whole point: a stale alerts panel is worse than none, because "no
    // alerts" from twenty minutes ago reads exactly like "no alerts" from now.
    stubApi([
      overview(4),
      overview(4, [
        {
          code: 'backup.stale',
          severity: 'warning',
          message: 'No backup has completed in 30 hours.',
          detail: null,
        },
      ]),
    ]);
    renderOverview();

    await screen.findByText(/nothing wants attention/i);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(await screen.findByText(/no backup has completed/i)).toBeInTheDocument();
    expect(screen.queryByText(/nothing wants attention/i)).toBeNull();
  });
});

describe('the overview stops claiming things are unbuilt', () => {
  it('no longer lists players or world health as missing', async () => {
    stubApi([overview(4)]);
    renderOverview();

    await screen.findByText('4');
    expect(screen.queryByText(/Browse players and airlines/)).toBeNull();
    expect(screen.queryByText(/World health, tick loop and queue depth/)).toBeNull();
    // The one that really is outstanding stays.
    expect(screen.getByText(/Deployment and version visibility/)).toBeInTheDocument();
  });
});
