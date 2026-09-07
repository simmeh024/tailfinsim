import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Alert, AlertsResponse, DigestResponse, MeResponse } from '@tailfin/shared';

import { App } from '../App';
import { NAV_ITEMS } from '../shell/AppShell';

import { alertHref, ALERT_SCREENS } from './link';

/**
 * §14.5's alerts and §3.2's digest on screen — M8-13's third criterion (M8-13).
 *
 * *"Each alert links directly to the screen where it can be acted on"* is the
 * one criterion a render assertion alone cannot hold, because it has two halves
 * that fail differently:
 *
 * - a rule can name a **screen this map does not cover**, which the type system
 *   catches only while the switch stays exhaustive; and
 * - the map can name a **path the router does not serve**, which nothing catches
 *   — the link renders, the click navigates, and the player lands on a page that
 *   cannot answer. M8-10 already learned that a drill-down to a page which
 *   cannot answer is how a drill-down rots; this suite makes the same mistake
 *   impossible for an alert.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_CSS = readFileSync(resolve(here, '..', 'dashboard', 'dashboard.css'), 'utf8');
const SHELL_CSS = readFileSync(resolve(here, '..', 'shell', 'shell.css'), 'utf8');
const UI_CSS = readFileSync(resolve(here, '..', 'ui', 'ui.css'), 'utf8');
const APP_SOURCE = readFileSync(resolve(here, '..', 'App.tsx'), 'utf8');

const SIGNED_IN: MeResponse = {
  player: {
    id: '11111111-2222-3333-4444-555555555555',
    displayName: 'Alert Tester',
    avatarUrl: null,
    displayCurrency: 'USD',
    createdAt: '2026-08-17T09:00:00.000Z',
  },
  registrationOpen: false,
  isAdmin: false,
};

const AIRLINE = {
  airline: {
    id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    worldId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
    playerId: SIGNED_IN.player?.id,
    name: 'Alert Air',
    iataCode: 'AL',
    icaoCode: 'ALT',
    callsign: 'ALERT',
    baseCountry: 'NL',
    cash: 50_000_000,
    reputation: 0.44,
    status: 'active',
    statusChangedAt: '2026-08-17T10:00:00.000Z',
    ceasedAt: null,
    createdAt: '2026-08-17T10:00:00.000Z',
  },
  rebrand: { costMinor: 2_500_000, mutableFields: ['name'], immutableFields: ['iataCode'] },
};

const ROUTE_ID = 'cccccccc-dddd-4eee-8fff-000000000001';

function alertRow(overrides: Partial<Alert> = {}): Alert {
  return {
    id: 'dddddddd-eeee-4fff-8000-000000000001',
    kind: 'route_loss_making',
    severity: 'critical',
    subjectType: 'route',
    subjectId: ROUTE_ID,
    subjectLabel: 'EGLL–KJFK',
    title: 'EGLL–KJFK is losing money',
    detail: 'Every one of the 4 day(s) it flew in the last 7 lost money.',
    screen: 'network',
    raisedAt: '2027-03-08T00:00:00.000Z',
    ...overrides,
  };
}

function digest(overrides: Partial<DigestResponse> = {}): DigestResponse {
  return {
    window: {
      fromAt: '2027-03-03T00:00:00.000Z',
      toAt: '2027-03-10T00:00:00.000Z',
      days: 7,
      truncated: false,
      first: false,
    },
    activity: {
      flightsFlown: 42,
      flightsCancelled: 1,
      passengers: 5_040,
      onTimeRate: 0.87,
      revenueMinor: 12_400_000,
      costMinor: 9_800_000,
      cashChangeMinor: 2_100_000,
    },
    raised: [alertRow()],
    resolved: [],
    open: [alertRow()],
    ...overrides,
  };
}

function alerts(overrides: Partial<AlertsResponse> = {}): AlertsResponse {
  return {
    alerts: [alertRow()],
    gameNow: '2027-03-10T00:00:00.000Z',
    evaluatedAt: '2027-03-10T00:00:00.000Z',
    ...overrides,
  };
}

function mountAlerts(options: { digest?: DigestResponse | null; alerts?: AlertsResponse } = {}) {
  const fetchMock = vi.fn((input: unknown) => {
    const url = String(input).split('?')[0] ?? '';

    // The digest is the one read that has to be able to fail, so it answers a
    // 500 rather than an unshaped 200 — a page that renders `broken` is the
    // criterion, not a page that renders NaN.
    if (url === '/api/digest' && options.digest === null) {
      return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
    }
    // Neither the runway nor the office exists for these fixtures. 409 is what
    // the real endpoints answer for an airline that has not got one.
    if (url === '/api/finance/runway' || url === '/api/office' || url === '/api/office/executive') {
      return Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({}) });
    }

    const payload =
      url === '/api/me'
        ? SIGNED_IN
        : url === '/api/airlines/me'
          ? AIRLINE
          : url === '/api/alerts'
            ? (options.alerts ?? alerts())
            : url === '/api/digest'
              ? (options.digest ?? digest())
              : url === '/api/currencies'
                ? { base: 'USD', asOf: '2027-03-10T00:00:00.000Z', rates: [] }
                : {};
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) });
  });
  vi.stubGlobal('fetch', fetchMock);

  render(
    <MemoryRouter initialEntries={['/alerts']}>
      <App />
    </MemoryRouter>,
  );
  return fetchMock;
}

describe('the alerts page', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows the open alerts and what changed while you were away', async () => {
    mountAlerts();

    expect(await screen.findByRole('heading', { name: 'Alerts', level: 1 })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getAllByText('EGLL–KJFK is losing money').length).toBeGreaterThan(0);
    });

    expect(screen.getByText(/7 game days since you last looked/i)).toBeInTheDocument();
    // The activity behind the feed, so the alerts sit in a context.
    expect(screen.getByText('Flights flown')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
  });

  /** AC3, rendered: the row is a link and it points at the route's own page. */
  it('links each alert to the screen that can act on it (AC3)', async () => {
    mountAlerts();

    const links = await screen.findAllByRole('link', { name: /EGLL–KJFK is losing money/ });
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link).toHaveAttribute('href', `/network?route=${ROUTE_ID}`);
    }
  });

  /** Severity must not be carried by colour alone (§14.6, H.7). */
  it('names the severity in words, not only in a hue', async () => {
    mountAlerts();
    await waitFor(() => {
      expect(screen.getAllByText('Critical').length).toBeGreaterThan(0);
    });
  });

  it('says the page is broken rather than showing an airline with nothing wrong', async () => {
    mountAlerts({ digest: null });
    expect(await screen.findByText(/could not be read/i)).toBeInTheDocument();
  });

  /**
   * The missing-worker trap, on screen.
   *
   * An empty list has two meanings and the page has to say which. On a node with
   * no worker `evaluatedAt` is null for ever, and rendering that as a clean bill
   * of health is the failure every other §14 surface has a note about.
   */
  it('says an empty list may mean nothing has run', async () => {
    mountAlerts({
      digest: digest({ raised: [], resolved: [], open: [] }),
    });
    expect(await screen.findByText(/no worker has evaluated it/i)).toBeInTheDocument();
  });

  it('names the two of §14.5’s nine alerts the game cannot answer', async () => {
    mountAlerts();
    await waitFor(() => {
      expect(screen.getByText(/leases a gate/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/world event announcement/i)).toBeInTheDocument();
  });
});

describe('the alert count in the status strip', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('counts the critical ones, because a glance has to rank them', async () => {
    mountAlerts({
      alerts: alerts({
        alerts: [
          alertRow(),
          alertRow({
            id: 'dddddddd-eeee-4fff-8000-000000000002',
            kind: 'route_spill',
            severity: 'warning',
            title: 'EGLL–KJFK turned away 360 passenger(s)',
          }),
        ],
      }),
    });
    expect(await screen.findByText('1 critical')).toBeInTheDocument();
  });

  it('reads an unevaluated airline as unknown rather than as fine', async () => {
    mountAlerts({ alerts: alerts({ alerts: [], evaluatedAt: null }) });
    const strip = await screen.findByLabelText('Status');
    // An em dash, not "None": nothing has checked.
    await waitFor(() => {
      expect(strip.textContent).toContain('—');
    });
    expect(strip.textContent).not.toContain('None');
  });

  it('says None when the rules ran and found nothing', async () => {
    mountAlerts({ alerts: alerts({ alerts: [] }) });
    expect(await screen.findByText('None')).toBeInTheDocument();
  });
});

describe('every screen an alert can name (AC3)', () => {
  /**
   * The half nothing else catches: a path this map emits that the router does
   * not serve. The link would render, the click would navigate, and the player
   * would land nowhere.
   */
  it('resolves to a path the router serves', () => {
    const shellPaths = new Set(
      [...APP_SOURCE.matchAll(/<Route path="([a-z-]+)"/g)].map((match) => `/${match[1] ?? ''}`),
    );
    expect(shellPaths.size).toBeGreaterThan(5);

    for (const screenName of ALERT_SCREENS) {
      const href = alertHref({ screen: screenName, subjectType: 'airline', subjectId: 'x' });
      const path = href.split('?')[0] ?? '';
      expect(
        shellPaths,
        `alertHref('${screenName}') → ${path}, which the router does not serve`,
      ).toContain(path);
    }
  });

  it('sends a route alert to that route rather than to the list', () => {
    expect(alertHref({ screen: 'network', subjectType: 'route', subjectId: ROUTE_ID })).toBe(
      `/network?route=${ROUTE_ID}`,
    );
    // An airline-wide alert on the same screen has no route to open.
    expect(alertHref({ screen: 'network', subjectType: 'airline', subjectId: 'a' })).toBe(
      '/network',
    );
  });

  it('keeps the alerts page in the rail, so the count links somewhere', () => {
    expect(NAV_ITEMS.map((item) => item.to)).toContain('/alerts');
  });
});

describe('one chart language', () => {
  it('declares no component class the shared stylesheets do not', () => {
    /*
     * M8-12's structural guard, applied to this directory. Every `className`
     * these files write must already be declared in `dashboard.css`,
     * `shell.css` or `ui.css`. A page with its own `.alert-card` looks fine in
     * jsdom and is a second visual vocabulary in the product.
     */
    const declared = `${DASHBOARD_CSS}\n${SHELL_CSS}\n${UI_CSS}`;
    const sources = readdirSync(here)
      .filter((name) => name.endsWith('.tsx') && !name.endsWith('.test.tsx'))
      .map((name) => readFileSync(join(here, name), 'utf8'));
    expect(sources.length).toBeGreaterThan(0);

    const undeclared = new Set<string>();
    for (const source of sources) {
      for (const match of source.matchAll(/className=(?:"([^"]+)"|\{'([^']+)'\})/g)) {
        for (const token of (match[1] ?? match[2] ?? '').split(/\s+/)) {
          if (token === '' || token.startsWith('${')) continue;
          if (!declared.includes(`.${token}`)) undeclared.add(token);
        }
      }
    }

    expect(
      [...undeclared],
      'These classes are written by the alerts page and declared by none of the ' +
        'shared stylesheets. §14.6 asks for one chart language across every ' +
        'dashboard; a page with its own is how a second one starts:\n  ' +
        [...undeclared].join('\n  '),
    ).toEqual([]);
  });

  it('adds no stylesheet of its own', () => {
    expect(readdirSync(here).filter((name) => name.endsWith('.css'))).toEqual([]);
  });
});
