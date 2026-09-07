import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  MeResponse,
  MetricBreakdownResponse,
  RouteCause,
  RouteDiagnosisResponse,
} from '@tailfin/shared';

import { App } from '../App';

/**
 * §14.4's chart and its drill-down — M8-11's three acceptance criteria.
 *
 * The one that needs care is the second: *"works with 5 routes and with 300
 * routes"*. jsdom has no layout, so what is provable is that both render every
 * route, that the ranking puts the extremes at the ends, and that the list — not
 * the page — is what scrolls. The last of those is read out of the stylesheet,
 * the way M8-10's narrow-screen assertions are.
 */

const CSS = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dashboard', 'dashboard.css'),
  'utf8',
);

const SIGNED_IN: MeResponse = {
  player: {
    id: '11111111-2222-3333-4444-555555555555',
    displayName: 'Chart Tester',
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
    name: 'Chart Air',
    iataCode: 'CH',
    icaoCode: 'CHT',
    callsign: 'CHART',
    baseCountry: 'NL',
    cash: 50_000_000,
    reputation: 0.4,
    status: 'active',
    statusChangedAt: '2026-08-17T10:00:00.000Z',
    ceasedAt: null,
    createdAt: '2026-08-17T10:00:00.000Z',
  },
  rebrand: { costMinor: 2_500_000, mutableFields: ['name'], immutableFields: ['iataCode'] },
};

/** A breakdown of `n` routes, alternating profit and loss, biggest first. */
function breakdown(n: number): MetricBreakdownResponse {
  const rows = Array.from({ length: n }, (_, index) => {
    const magnitude = (n - index) * 100_000;
    const loss = index % 2 === 1;
    return {
      key: `route-${String(index).padStart(3, '0')}`,
      label: `R${String(index).padStart(3, '0')}–XXX`,
      value: loss ? -magnitude : magnitude,
      share: null,
      drillDown: {
        endpoint: '/api/routes/:routeId/flights' as const,
        by: 'flight' as const,
        label: 'by flight',
      },
    };
  });
  return {
    metric: 'operating_profit',
    by: 'route',
    gameNow: '2027-03-10T00:00:00.000Z',
    windowDays: 30,
    total: 0,
    rows,
  };
}

function diagnosis(overrides: Partial<RouteDiagnosisResponse> = {}): RouteDiagnosisResponse {
  return {
    routeId: 'route-001',
    label: 'R001–XXX',
    windowDays: 30,
    gameNow: '2027-03-10T00:00:00.000Z',
    flights: 24,
    cause: 'cost',
    action: 're-gauge',
    contributionMinor: -400_000,
    loadFactor: 0.61,
    breakevenLoadFactor: 1.24,
    unfillable: true,
    rivalShare: 0.2,
    rivalShareThreshold: 0.6,
    peerRoutes: 8,
    gaps: {
      yield: { worthMinor: 0, own: 11.2, peer: 11.0 },
      cost: { worthMinor: 620_000, own: 13.9, peer: 8.4 },
      load: { worthMinor: 180_000, own: 0.61, peer: 0.78 },
    },
    ...overrides,
  };
}

function stubFetch(routes: number, diag: RouteDiagnosisResponse | null = diagnosis()): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      const url = String(input).split('?')[0] ?? '';
      let body: unknown = {};
      if (url === '/api/me') body = SIGNED_IN;
      else if (url === '/api/airlines/me') body = AIRLINE;
      else if (url === '/api/statistics/operating_profit/breakdown') body = breakdown(routes);
      else if (url.endsWith('/diagnosis')) body = diag ?? {};
      else if (url === '/api/finance/pnl') {
        body = {
          from: '2027-02-08T00:00:00.000Z',
          to: '2027-03-10T00:00:00.000Z',
          revenueMinor: 0,
          costMinor: 0,
          operatingProfitMinor: 0,
          lines: [],
          byRoute: [],
          byAircraft: [],
          byHub: [],
          byCabinClass: [],
        };
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    }),
  );
}

async function renderFinance() {
  const result = render(
    <MemoryRouter initialEntries={['/finance']}>
      <App />
    </MemoryRouter>,
  );
  await screen.findByRole('navigation', { name: 'Main' });
  await screen.findByLabelText('Profit by route');
  return result;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('§14.4’s ranked chart', () => {
  it('ranks every route around a breakeven line, five of them', async () => {
    stubFetch(5);
    await renderFinance();

    const chart = await screen.findByLabelText('Profit by route, ranked');
    const rows = chart.querySelectorAll('.profit-chart__row');
    expect(rows).toHaveLength(5);

    /*
     * Ranked by profit, so the best route is first and the worst is last —
     * which is what makes the chart readable without a filter. The fixture
     * alternates sign with a falling magnitude, so the deepest loss (R001, the
     * largest odd-indexed magnitude) lands at the bottom rather than the last
     * route the server happened to send.
     */
    const labels = [...rows].map((row) => row.querySelector('.profit-chart__label')?.textContent);
    expect(labels[0]).toBe('R000–XXX');
    expect(labels[labels.length - 1]).toBe('R001–XXX');
    expect(labels).toEqual(['R000–XXX', 'R002–XXX', 'R004–XXX', 'R003–XXX', 'R001–XXX']);

    // And it says how many are below the line rather than leaving it to be counted.
    expect(screen.getByLabelText('Profit by route').textContent).toContain(
      '2 below the breakeven line',
    );
  });

  it('renders all three hundred, and scrolls the list rather than the page (AC2)', async () => {
    stubFetch(300);
    await renderFinance();

    const chart = await screen.findByLabelText('Profit by route, ranked');
    // Every route, not a top-ten that hides the airline's worst route on page 31.
    expect(chart.querySelectorAll('.profit-chart__row')).toHaveLength(300);

    /*
     * The failure at 300 rows is not rendering, it is 12,000px of page. jsdom
     * cannot measure that, so the assertion is on the rule that prevents it.
     */
    expect(CSS).toMatch(/\.profit-chart__rows\s*\{[^}]*max-height:/);
    expect(CSS).toMatch(/\.profit-chart__rows\s*\{[^}]*overflow-y:\s*auto/);
  });

  it('pairs the loss colour with a hatch and a glyph (AC3)', async () => {
    stubFetch(5);
    const { container } = await renderFinance();

    const chart = await screen.findByLabelText('Profit by route, ranked');
    const lossBars = chart.querySelectorAll('.profit-chart__bar--loss');
    expect(lossBars.length).toBe(2);

    // Signal two: a hatch, in the stylesheet rather than a colour swap.
    expect(CSS).toMatch(/\.profit-chart__bar--loss\s*\{[^}]*repeating-linear-gradient/);
    // Signal three: the row's own text carries a direction glyph and a sign.
    const worst = [...chart.querySelectorAll('.profit-chart__row')].at(-1);
    expect(worst?.textContent).toContain('▼');
    /*
     * And the legend says the hatch is doing work, so it is not decoration —
     * without naming the hue, which is a different red in each theme and absent
     * in a monochrome print. `theme/tokens.test.ts` caught the first draft for
     * exactly that: the word "red" in the copy tripped the colour-literal guard.
     */
    expect(container.textContent).toContain('hatched, not colour alone');
  });

  it('draws the breakeven line as a rule down the middle of every track', () => {
    // A border rather than a drawn axis: exactly one pixel in every theme, and
    // it needs no measuring.
    expect(CSS).toMatch(/\.profit-chart__track::before\s*\{[^}]*left:\s*50%/);
    expect(CSS).toMatch(/\.profit-chart__bar\s*\{[^}]*left:\s*50%/);
    expect(CSS).toMatch(/\.profit-chart__bar--loss\s*\{[^}]*right:\s*50%/);
  });

  it('says so plainly when nothing has flown', async () => {
    stubFetch(0);
    await renderFinance();
    const panel = screen.getByLabelText('Profit by route');
    expect(panel.textContent).toContain('No route has settled a flight');
    // The production shape, named rather than left as an empty chart.
    expect(panel.textContent).toContain('Only the worker settles a flight');
  });
});

describe('§14.4’s drill-down', () => {
  it('names a specific cause and a specific action, not a breakdown (AC1)', async () => {
    stubFetch(5);
    await renderFinance();

    const chart = await screen.findByLabelText('Profit by route, ranked');
    const rows = [...chart.querySelectorAll('button')];
    fireEvent.click(rows[1] as HTMLElement);

    const panel = await screen.findByLabelText('Route diagnosis');
    await waitFor(() => expect(panel.textContent).toContain('costs more per seat offered'));
    // The action, as an instruction rather than a number.
    expect(within(panel).getByText('Re-gauge')).toBeInTheDocument();
    expect(panel.textContent).toContain('a smaller or cheaper aeroplane');
    // The distinction the chart exists to draw.
    expect(panel.textContent).toContain('no load factor pays');
  });

  it('shows the working under the answer, never instead of it', async () => {
    stubFetch(5);
    await renderFinance();
    fireEvent.click(
      [
        ...(await screen.findByLabelText('Profit by route, ranked')).querySelectorAll('button'),
      ][1] as HTMLElement,
    );

    const panel = await screen.findByLabelText('Route diagnosis');
    await waitFor(() => expect(within(panel).getByText('Re-gauge')).toBeInTheDocument());
    // Every lever quantified, so a player can argue with the recommendation.
    // Scoped to the table: "Load factor" is also one of the figures above it,
    // and an unscoped query would find two and report it as ambiguous.
    const table = panel.querySelector('.data-table');
    expect(table).not.toBeNull();
    for (const lever of ['Yield', 'Cost per seat-km', 'Load factor']) {
      expect(within(table as HTMLElement).getByText(lever)).toBeInTheDocument();
    }
    expect(panel.textContent).toContain('Your median');
  });

  it('gives each cause its own sentence, and never a generic one', async () => {
    const causes: RouteCause[] = ['none', 'yield', 'cost', 'load_factor', 'competitor'];
    const seen = new Set<string>();

    for (const cause of causes) {
      stubFetch(5, diagnosis({ cause, action: 'keep', unfillable: false }));
      const view = await renderFinance();
      fireEvent.click(
        [
          ...(await screen.findByLabelText('Profit by route, ranked')).querySelectorAll('button'),
        ][1] as HTMLElement,
      );
      const panel = await screen.findByLabelText('Route diagnosis');
      await waitFor(() => expect(panel.querySelector('.diagnosis__cause')).not.toBeNull());
      const sentence = panel.querySelector('.diagnosis__cause')?.textContent ?? '';
      expect(sentence.length).toBeGreaterThan(20);
      // Five distinct sentences: a shared one would be the generic breakdown
      // M8-11's first criterion rules out.
      expect(seen.has(sentence)).toBe(false);
      seen.add(sentence);
      view.unmount();
      vi.restoreAllMocks();
    }

    expect(seen.size).toBe(5);
  });

  it('refuses to diagnose a route nothing has flown', async () => {
    stubFetch(5, diagnosis({ flights: 0 }));
    await renderFinance();
    fireEvent.click(
      [
        ...(await screen.findByLabelText('Profit by route, ranked')).querySelectorAll('button'),
      ][1] as HTMLElement,
    );

    const panel = await screen.findByLabelText('Route diagnosis');
    // Naming a cause from an empty window would be an invented finding.
    await waitFor(() => expect(panel.textContent).toContain('nothing to diagnose yet'));
  });

  it('invites a click rather than diagnosing nothing', async () => {
    stubFetch(5);
    await renderFinance();
    const panel = screen.getByLabelText('Route diagnosis');
    expect(panel.textContent).toContain('Pick a route from the chart');
  });
});
