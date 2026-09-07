import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  CreditStandingResponse,
  ExecutiveDashboardResponse,
  FinancePnlResponse,
  MeResponse,
  MetricTrend,
  StatisticsResponse,
} from '@tailfin/shared';

import { App } from '../App';

/**
 * §14.3's two dashboards, and M8-10's three acceptance criteria.
 *
 * The third one — *"renders usefully on a 390px-wide screen"* — is the awkward
 * one to test honestly. jsdom has no layout engine, so no assertion here can
 * prove something *looks* right at 390px. What it can prove is the two things
 * that actually break a narrow screen, and both are decidable from the source:
 *
 * 1. **the grids collapse without a breakpoint** — `auto-fit` with a `minmax`
 *    floor that fits inside 390px, rather than a media query somebody has to
 *    maintain, and
 * 2. **a wide table scrolls inside its own box** rather than pushing the page
 *    sideways, which is the failure that moves the navigation off screen.
 *
 * So the layout assertions read `dashboard.css`, the way
 * `hq/shared-classes.test.ts` reads `shell.css`. A visual check belongs in the
 * post-deploy browser smoke, and is named as such in the PR.
 */

const CSS = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'dashboard.css'), 'utf8');

const SIGNED_IN: MeResponse = {
  player: {
    id: '11111111-2222-3333-4444-555555555555',
    displayName: 'Dashboard Tester',
    avatarUrl: null,
    displayCurrency: 'USD',
    createdAt: '2026-08-17T09:00:00.000Z',
  },
  registrationOpen: false,
  signInProviders: [],
  isAdmin: false,
};

const AIRLINE = {
  airline: {
    id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    worldId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
    playerId: SIGNED_IN.player?.id,
    name: 'Dash Air',
    iataCode: 'DA',
    icaoCode: 'DSH',
    callsign: 'DASH',
    baseCountry: 'NL',
    cash: 50_000_000,
    reputation: 0.42,
    status: 'active',
    statusChangedAt: '2026-08-17T10:00:00.000Z',
    ceasedAt: null,
    createdAt: '2026-08-17T10:00:00.000Z',
  },
  rebrand: { costMinor: 2_500_000, mutableFields: ['name'], immutableFields: ['iataCode'] },
};

function trend(overrides: Partial<MetricTrend> = {}): MetricTrend {
  return {
    days: 30,
    value: 0.82,
    previousValue: 0.78,
    changePct: 0.0513,
    changeAbsolute: 0.04,
    direction: 'up',
    ...overrides,
  };
}

function executive(): ExecutiveDashboardResponse {
  const drill = {
    endpoint: '/api/finance/pnl',
    by: 'ledger_category' as const,
    label: 'in the P&L',
  };
  return {
    gameNow: '2027-03-10T00:00:00.000Z',
    creditTier: 'C',
    headlines: [
      {
        id: 'cash',
        label: 'Cash',
        unit: 'minor',
        polarity: 'higher_is_better',
        value: 50_000_000,
        text: null,
        trend: trend({ direction: 'unknown', changePct: null, changeAbsolute: null }),
        drillDown: drill,
      },
      {
        id: 'cash_runway',
        label: 'Cash runway',
        unit: 'days',
        polarity: 'higher_is_better',
        value: 184,
        text: null,
        trend: trend({ direction: 'unknown', changePct: null, changeAbsolute: null }),
        drillDown: { endpoint: '/api/finance/runway', by: 'record', label: 'what is committed' },
      },
      {
        id: 'net_worth',
        label: 'Net worth',
        unit: 'minor',
        polarity: 'higher_is_better',
        value: 120_000_000,
        text: null,
        trend: trend({ direction: 'unknown', changePct: null, changeAbsolute: null }),
        drillDown: { endpoint: '/api/credit', by: 'record', label: 'assets and debt' },
      },
      {
        id: 'load_factor',
        label: 'Load factor',
        unit: 'ratio',
        polarity: 'higher_is_better',
        value: 0.82,
        text: null,
        trend: trend(),
        drillDown: {
          endpoint: '/api/statistics/:metricId/breakdown',
          by: 'route',
          label: 'by route',
        },
      },
      {
        id: 'credit_rating',
        label: 'Credit rating',
        unit: 'text',
        polarity: 'higher_is_better',
        value: null,
        text: 'C',
        trend: trend({
          direction: 'unknown',
          value: null,
          previousValue: null,
          changePct: null,
          changeAbsolute: null,
        }),
        drillDown: { endpoint: '/api/credit', by: 'record', label: 'what you may borrow' },
      },
    ],
    monthToDate: {
      monthStart: '2027-03-01T00:00:00.000Z',
      daysElapsed: 9,
      actualMinor: 4_500_000,
      forecastMinor: 4_000_000,
      forecastLowMinor: 3_000_000,
      forecastHighMinor: 5_000_000,
      varianceMinor: 500_000,
      withinBand: true,
    },
    gainers: [
      {
        routeId: 'cccccccc-dddd-4eee-8fff-000000000001',
        label: 'EHAM–EGLL',
        valueMinor: 900_000,
        previousMinor: 400_000,
        changeMinor: 500_000,
        drillDown: { endpoint: '/api/routes/:routeId/flights', by: 'flight', label: 'by flight' },
      },
    ],
    losers: [],
  };
}

function statistics(): StatisticsResponse {
  const mk = (
    id: StatisticsResponse['metrics'][number]['id'],
    label: string,
    unit: StatisticsResponse['metrics'][number]['unit'],
    value: number | null,
  ): StatisticsResponse['metrics'][number] => ({
    id,
    label,
    description: `What ${label} means, in one sentence.`,
    unit,
    polarity:
      id === 'cask' || id === 'breakeven_load_factor' ? 'lower_is_better' : 'higher_is_better',
    value,
    trends: [trend({ days: 7 }), trend({ days: 30 }), trend({ days: 90 })],
    forecasts: [{ horizonDays: 30, mid: 1, low: 0.5, high: 1.5, observations: 12 }],
    drillDown: { endpoint: '/api/statistics/:metricId/breakdown', by: 'route', label: 'by route' },
  });
  return {
    gameNow: '2027-03-10T00:00:00.000Z',
    windowDays: 30,
    metrics: [
      mk('rask', 'RASK', 'minor_per_ask', 10.25),
      mk('cask', 'CASK', 'minor_per_ask', 8.5),
      mk('yield', 'Yield', 'minor_per_rpk', 12.5),
      mk('breakeven_load_factor', 'Breakeven load', 'ratio', 0.68),
      mk('load_factor', 'Load factor', 'ratio', 0.82),
    ],
  };
}

function pnl(): FinancePnlResponse {
  return {
    from: '2027-02-08T00:00:00.000Z',
    to: '2027-03-10T00:00:00.000Z',
    revenueMinor: 20_000_000,
    costMinor: 16_000_000,
    operatingProfitMinor: 4_000_000,
    lines: [
      { category: 'ticket', amountMinor: 20_000_000, entryCount: 40 },
      { category: 'fuel', amountMinor: 9_000_000, entryCount: 40 },
      { category: 'interest', amountMinor: 350_000, entryCount: 30 },
    ],
    byRoute: [
      {
        key: 'EHAM–EGLL',
        revenueMinor: 12_000_000,
        costMinor: 9_000_000,
        operatingProfitMinor: 3_000_000,
      },
      { key: null, revenueMinor: 1_000_000, costMinor: 1_500_000, operatingProfitMinor: -500_000 },
    ],
    byAircraft: [],
    byHub: [],
    byCabinClass: [],
  };
}

function credit(): CreditStandingResponse {
  return {
    tier: 'C',
    earnedTier: 'C',
    annualRateBps: 1_000,
    termMonths: 36,
    limits: {
      tierCapMinor: 500_000_000,
      profitMultipleMinor: 200_000_000,
      assetAdvanceMinor: 90_000_000,
    },
    maxTotalDebtMinor: 90_000_000,
    outstandingDebtMinor: 25_000_000,
    headroomMinor: 65_000_000,
    bindingConstraint: 'asset_advance',
    dscr: 1.9,
    minimumDscr: 1.25,
    canBorrow: true,
    refusal: null,
    trailing: {
      operatingProfitMinor: 60_000_000,
      ebitdaMinor: 80_000_000,
      tangibleAssetValueMinor: 150_000_000,
      annualDebtServiceMinor: 42_000_000,
      profitableMonths: 8,
      routes: 6,
      hubs: 1,
    },
    standing: {
      stage: 'none',
      stageEnteredAt: null,
      cureByAt: null,
      arrearsMinor: 0,
      restricted: false,
      message: null,
      dailyInterestMinor: 11_806,
    },
    loans: [
      {
        id: 'dddddddd-eeee-4fff-8000-000000000001',
        instrument: 'working_capital',
        principalMinor: 25_000_000,
        outstandingMinor: 25_000_000,
        arrearsMinor: 0,
        interestAccruedThroughAt: '2027-03-09T00:00:00.000Z',
        dailyInterestMinor: 11_806,
        annualRateBps: 1_700,
        termMonths: 36,
        tierAtDraw: 'C',
        status: 'active',
        drawnAt: '2027-01-01T00:00:00.000Z',
        securedAirframeId: null,
      },
    ],
  };
}

function stubFetch(overrides: Record<string, unknown> = {}): void {
  const bodies: Record<string, unknown> = {
    '/api/me': SIGNED_IN,
    '/api/airlines/me': AIRLINE,
    '/api/statistics/executive': executive(),
    '/api/statistics': statistics(),
    '/api/finance/pnl': pnl(),
    '/api/credit': credit(),
    ...overrides,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      const url = String(input).split('?')[0] ?? '';
      const body = bodies[url] ?? {};
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    }),
  );
}

async function renderAt(path: string) {
  const result = render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
  await screen.findByRole('navigation', { name: 'Main' });
  return result;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('the Executive dashboard', () => {
  it('is reachable from the rail, and leads it', async () => {
    stubFetch();
    await renderAt('/dashboard');
    const rail = screen.getByRole('navigation', { name: 'Main' });
    const links = [...rail.querySelectorAll('a')].map((a) => a.textContent);
    // §14 calls the dashboard the game's main interface after the first week.
    expect(links[0]).toContain('Dashboard');
  });

  it('shows a level and a rate of change on every headline (AC1)', async () => {
    stubFetch();
    await renderAt('/dashboard');

    const tiles = await screen.findByLabelText('Headline figures');
    const cards = [...tiles.querySelectorAll('.tile')];
    expect(cards).toHaveLength(5);

    for (const card of cards) {
      // §14.6: the value *and* the movement, on every one. A tile with only the
      // level hides the "falling more slowly" story the section is about.
      expect(card.querySelector('.tile__value')?.textContent?.trim()).not.toBe('');
      expect(card.querySelector('.tile__trend')?.textContent?.trim()).not.toBe('');
    }

    const loadFactor = within(tiles).getByLabelText('Load factor');
    expect(loadFactor.textContent).toContain('82.0%');
    expect(loadFactor.textContent).toContain('5.1%');
    expect(loadFactor.textContent).toContain('vs prior 30d');
  });

  it('renders a rating as a word rather than forcing it into a number', async () => {
    stubFetch();
    await renderAt('/dashboard');
    const rating = await screen.findByLabelText('Credit rating');
    expect(rating.textContent).toContain('C');
  });

  it('links each figure to the server’s own drill-down (AC2)', async () => {
    stubFetch();
    await renderAt('/dashboard');
    const tiles = await screen.findByLabelText('Headline figures');
    const loadFactor = within(tiles).getByLabelText('Load factor');
    // The endpoint is the server's; the href is this build's page for it.
    expect(loadFactor.querySelector('a')?.getAttribute('href')).toBe('/finance');
  });

  it('says a variance is inside the band rather than raising an alarm', async () => {
    stubFetch();
    await renderAt('/dashboard');
    const panel = await screen.findByLabelText('Month to date');
    expect(within(panel).getByText('within band')).toBeInTheDocument();
    expect(panel.textContent).toContain('9 game days into the month');
  });

  it('ranks movers on the change, and links the route', async () => {
    stubFetch();
    await renderAt('/dashboard');
    const gained = await screen.findByLabelText('Gained this week');
    expect(within(gained).getByText('EHAM–EGLL').getAttribute('href')).toContain('/network?route=');
    const lost = screen.getByLabelText('Lost this week');
    expect(lost.textContent).toContain('No route did worse');
  });

  it('says the dashboard is broken rather than showing an empty airline', async () => {
    stubFetch({ '/api/statistics/executive': { headlines: 'nope' } });
    await renderAt('/dashboard');
    await waitFor(() =>
      expect(screen.getByText(/dashboard could not be read/i)).toBeInTheDocument(),
    );
  });
});

describe('the Financial dashboard', () => {
  it('shows the P&L, its lines and its dimensional rollups', async () => {
    stubFetch();
    await renderAt('/finance');

    const statement = await screen.findByLabelText('Profit and loss');
    expect(within(statement).getByText('Operating profit')).toBeInTheDocument();
    expect(statement.textContent).toContain('ticket');
    // §13.4's interest is its own line, and this is where a player sees it.
    expect(statement.textContent).toContain('interest');

    const byRoute = screen.getByLabelText('By route');
    expect(byRoute.textContent).toContain('EHAM–EGLL');
    // A null key is attributed rather than dropped, so the columns still add up.
    expect(byRoute.textContent).toContain('Unattributed');
  });

  it('shows the four unit economics as tiles with movement (AC1)', async () => {
    stubFetch();
    await renderAt('/finance');
    const panel = await screen.findByLabelText('Unit economics');
    for (const label of ['RASK', 'CASK', 'Yield', 'Breakeven load']) {
      expect(within(panel).getByLabelText(label)).toBeInTheDocument();
    }
    // Per-kilometre money keeps its decimals: rounded to a minor unit every
    // unit economic in the game would read as zero.
    expect(within(panel).getByLabelText('CASK').textContent).toContain('8.500¢/km');
  });

  it('shows the debt with DSCR and §13.4’s daily interest drain', async () => {
    stubFetch();
    await renderAt('/finance');
    const debt = await screen.findByLabelText('Debt and interest');
    expect(debt.textContent).toContain('1.90');
    expect(debt.textContent).toContain('/ game day');
    expect(debt.textContent).toContain('working capital');
    // Honest about what it is not.
    expect(debt.textContent).toContain('not an amortisation schedule');
  });

  it('names cargo as absent rather than inventing a column', async () => {
    stubFetch();
    const { container } = await renderAt('/finance');
    await screen.findByLabelText('Profit and loss');
    /*
     * §14.3 lists profitability by cargo and settlement splits no revenue
     * between passengers and freight, so the page says so instead of putting an
     * invented number in the middle of a real table.
     */
    const note = container.querySelector('.page__note');
    expect(note?.textContent).toContain('cargo');
    expect(note?.textContent).toContain('invented number');
    // And no cargo column has quietly appeared in the rollups.
    expect(screen.queryByLabelText('By cargo')).toBeNull();
  });

  it('reports each panel’s failure separately', async () => {
    // The P&L is unreadable and the metrics are fine: one panel says so, and
    // the other still renders. A page-level failure would lose both.
    stubFetch({ '/api/finance/pnl': { lines: 7 } });
    await renderAt('/finance');
    await waitFor(() => expect(screen.getByText(/P&L could not be read/i)).toBeInTheDocument());
    expect(screen.getByLabelText('Unit economics')).toBeInTheDocument();
  });
});

describe('narrow screens (AC3)', () => {
  it('collapses its grids by auto-fit rather than by a breakpoint', () => {
    /*
     * The floor has to fit inside 390px once the shell's padding is taken off,
     * and `auto-fit` then reflows to a single column with no media query to
     * maintain. A fixed column count with a `@media` override is the version
     * that rots: the next person adds a tile and the query is now wrong.
     */
    expect(CSS).toMatch(/\.tiles\s*\{[^}]*repeat\(auto-fit,\s*minmax\(13rem,\s*1fr\)\)/);
    expect(CSS).toMatch(/\.panel-pair\s*\{[^}]*repeat\(auto-fit,\s*minmax\(18rem,\s*1fr\)\)/);
  });

  it('scrolls a wide table inside its own box, never the page', () => {
    // The real 390px failure: a four-column money table pushing the page
    // sideways takes the navigation off screen to show one more column.
    expect(CSS).toMatch(/\.table-scroll\s*\{[^}]*overflow-x:\s*auto/);
  });

  it('lets a long money string wrap instead of widening a column', () => {
    expect(CSS).toMatch(/\.tile__value\s*\{[^}]*overflow-wrap:\s*anywhere/);
  });

  it('carries every table on the two pages in a scroll container', async () => {
    stubFetch();
    const { container } = await renderAt('/finance');
    await screen.findByLabelText('Profit and loss');
    const tables = [...container.querySelectorAll('table')];
    expect(tables.length).toBeGreaterThan(0);
    for (const table of tables) {
      expect(table.closest('.table-scroll')).not.toBeNull();
    }
  });
});
