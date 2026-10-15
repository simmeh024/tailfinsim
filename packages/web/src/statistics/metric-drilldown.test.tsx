import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Metric } from '@tailfin/shared';

import { App } from '../App';
import { setDisplayCurrency } from '../currency/display';
import { breakdown, credit, pnl, statistics, stubApi } from '../finance/test-finance';

import { HorizonProvider, type Horizon } from './horizon';
import { MetricDrillDown } from './MetricDrillDown';

/**
 * §14.1's drill-down, as one component (SURFACE-06).
 *
 * The component on its own — the interaction contract, the server registry as
 * the source of a metric's identity, the three horizons, the states — and then
 * its two real callers, the Finance page and the Executive dashboard, through
 * the whole app. The second half is the issue's generality test: a component
 * with one consumer is a page.
 */

const EUR = {
  code: 'EUR',
  name: 'Euro',
  symbol: '€',
  decimals: 2,
  rateE6: 500_000,
  refreshedAt: '1965-01-01T00:00:00.000Z',
  top: true,
};

const BREAKDOWN = {
  endpoint: '/api/statistics/:metricId/breakdown',
  label: 'by route',
};

function metric(id: Metric['id']): Metric {
  const found = statistics().metrics.find((entry) => entry.id === id);
  if (!found) throw new Error(`no fixture metric ${id}`);
  return found;
}

function renderDrill(
  props: Parameters<typeof MetricDrillDown>[0],
  horizon: Horizon = 30,
): { rerender: (next: Horizon) => void } {
  const ui = (value: Horizon) => (
    <MemoryRouter>
      <HorizonProvider value={value}>
        <MetricDrillDown {...props} />
      </HorizonProvider>
    </MemoryRouter>
  );
  const { rerender } = render(ui(horizon));
  return { rerender: (next) => rerender(ui(next)) };
}

beforeAll(async () => {
  await import('../finance/FinancePage');
  await import('../dashboard/ExecutivePage');
});

beforeEach(() => {
  localStorage.clear();
  setDisplayCurrency('USD', []);
});

afterEach(() => {
  setDisplayCurrency('USD', []);
  vi.restoreAllMocks();
});

describe('the interaction contract', () => {
  it('is a labelled control that says whether it is open', () => {
    stubApi({});
    renderDrill({ metricId: 'load_factor', metric: metric('load_factor'), drillDown: BREAKDOWN });
    const trigger = screen.getByRole('button', { name: 'by route →' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('opens in place, moves focus into the breakdown, and shows the rows', async () => {
    const calls = stubApi({
      '/api/statistics/load_factor/breakdown': breakdown('load_factor'),
    });
    renderDrill({ metricId: 'load_factor', metric: metric('load_factor'), drillDown: BREAKDOWN });

    fireEvent.click(screen.getByRole('button', { name: 'by route →' }));

    const region = screen.getByRole('region', { name: /Load factor by route/ });
    // Focus follows the change of context, so a screen reader announces it.
    expect(document.activeElement).toBe(within(region).getByRole('heading'));
    expect(await within(region).findByText('EHAM–EGLL')).toBeInTheDocument();
    // Each row leads to its own next rung, where the server says there is one.
    expect(within(region).getAllByRole('link', { name: 'by flight' })[0]).toHaveAttribute(
      'href',
      '/network?route=cccccccc-dddd-4eee-8fff-000000000000',
    );
    expect(calls.map((call) => call.url)).toContain(
      '/api/statistics/load_factor/breakdown?by=route&days=30',
    );
    expect(screen.getByRole('button', { name: 'Close by route' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('gives a player the way back: Escape or Close, with focus returned', async () => {
    stubApi({ '/api/statistics/load_factor/breakdown': breakdown('load_factor') });
    renderDrill({ metricId: 'load_factor', metric: metric('load_factor'), drillDown: BREAKDOWN });
    const trigger = screen.getByRole('button', { name: 'by route →' });

    fireEvent.click(trigger);
    const region = screen.getByRole('region', { name: /Load factor/ });
    fireEvent.keyDown(region, { key: 'Escape' });
    expect(screen.queryByRole('region')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('region')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

describe('identity from the server’s registry', () => {
  it('reads the metric from /api/statistics when the caller does not hold it', async () => {
    const calls = stubApi({
      '/api/statistics': statistics(),
      '/api/statistics/load_factor/breakdown': breakdown('load_factor'),
    });
    renderDrill({ metricId: 'load_factor', drillDown: BREAKDOWN });

    fireEvent.click(screen.getByRole('button', { name: 'by route →' }));

    // The label is the server's, not a client table's.
    expect(await screen.findByRole('region', { name: /Load factor by route/ })).toBeInTheDocument();
    expect(calls.some((call) => call.url === '/api/statistics')).toBe(true);
  });
});

describe('the three horizons are the component’s', () => {
  it('shows now, the trend and the forecast band for the page’s period, and re-reads the rows', async () => {
    const calls = stubApi({
      '/api/statistics/load_factor/breakdown': breakdown('load_factor'),
    });
    const { rerender } = renderDrill({
      metricId: 'load_factor',
      metric: metric('load_factor'),
      drillDown: BREAKDOWN,
    });
    fireEvent.click(screen.getByRole('button', { name: 'by route →' }));
    const region = screen.getByRole('region');
    expect(region.textContent).toContain('Now');
    expect(region.textContent).toContain('vs prior 30d');
    // A band, never a single number.
    expect(region.textContent).toContain('70.0% – 90.0% in 30 days');

    rerender(7);
    await waitFor(() =>
      expect(calls.map((call) => call.url)).toContain(
        '/api/statistics/load_factor/breakdown?by=route&days=7',
      ),
    );
    expect(screen.getByRole('region').textContent).toContain('vs prior 7d');
    expect(screen.getByRole('region').textContent).toContain('75.0% – 85.0% in 7 days');
  });

  it('says there is no forecast rather than drawing one through too little history', () => {
    stubApi({ '/api/statistics/load_factor/breakdown': breakdown('load_factor') });
    renderDrill(
      { metricId: 'load_factor', metric: metric('load_factor'), drillDown: BREAKDOWN },
      90,
    );
    fireEvent.click(screen.getByRole('button', { name: 'by route →' }));
    expect(screen.getByRole('region').textContent).toContain('not enough history to forecast');
  });
});

describe('a metric with no breakdown here', () => {
  it('links to the page that explains it rather than opening an empty panel', () => {
    stubApi({});
    renderDrill({
      metricId: 'revenue',
      metric: metric('revenue'),
      drillDown: { endpoint: '/api/finance/pnl', label: 'in the P&L' },
    });
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByRole('link', { name: 'in the P&L →' })).toHaveAttribute('href', '/finance');
  });

  it('names where the answer lives when no page consumes it yet', () => {
    stubApi({});
    renderDrill({
      metricId: 'revenue',
      metric: metric('revenue'),
      drillDown: { endpoint: '/api/somewhere/new', label: 'by something new' },
    });
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('by something new')).toBeInTheDocument();
  });
});

describe('the states', () => {
  it('says an empty breakdown is empty, and why, rather than drawing an empty table', async () => {
    stubApi({ '/api/statistics/load_factor/breakdown': breakdown('load_factor', 30, 0) });
    renderDrill({ metricId: 'load_factor', metric: metric('load_factor'), drillDown: BREAKDOWN });
    fireEvent.click(screen.getByRole('button', { name: 'by route →' }));
    expect(
      await screen.findByText(/Nothing has flown in the last 30 game days/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('says a breakdown it could not read is broken', async () => {
    stubApi({ '/api/statistics/load_factor/breakdown': { rows: 'nope' } });
    renderDrill({ metricId: 'load_factor', metric: metric('load_factor'), drillDown: BREAKDOWN });
    fireEvent.click(screen.getByRole('button', { name: 'by route →' }));
    expect(await screen.findByText('The breakdown could not be read.')).toBeInTheDocument();
  });

  it('shows itself loading while the rows are in flight', () => {
    stubApi({
      '/api/statistics/load_factor/breakdown': () => new Promise<never>(() => undefined),
    });
    renderDrill({ metricId: 'load_factor', metric: metric('load_factor'), drillDown: BREAKDOWN });
    fireEvent.click(screen.getByRole('button', { name: 'by route →' }));
    expect(screen.getByText('Breaking the figure down.')).toBeInTheDocument();
  });
});

describe('money', () => {
  it('renders a money breakdown in the display currency', async () => {
    setDisplayCurrency('EUR', [EUR]);
    stubApi({
      '/api/statistics/operating_profit/breakdown': breakdown('operating_profit'),
    });
    renderDrill({
      metricId: 'operating_profit',
      metric: metric('operating_profit'),
      drillDown: BREAKDOWN,
    });
    fireEvent.click(screen.getByRole('button', { name: 'by route →' }));
    // 3,000,000 USD minor at 0.5 → €15,000.00.
    expect(await screen.findByText('€15,000.00')).toBeInTheDocument();
  });
});

describe('two real callers (the generality test)', () => {
  async function renderAt(path: string): Promise<void> {
    render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    );
    await screen.findByRole('navigation', { name: 'Main' });
  }

  it('opens from a Finance page tile', async () => {
    stubApi({
      '/api/statistics': statistics(),
      '/api/finance/pnl': pnl(),
      '/api/credit': credit(),
      '/api/statistics/operating_profit/breakdown': breakdown('operating_profit'),
      '/api/statistics/rask/breakdown': breakdown('rask'),
    });
    await renderAt('/finance');
    const panel = await screen.findByLabelText('Unit economics');
    const rask = await within(panel).findByLabelText('RASK');
    fireEvent.click(within(rask).getByRole('button', { name: 'by route →' }));
    expect(await within(rask).findByRole('region', { name: /RASK by route/ })).toBeInTheDocument();
  });

  it('opens from an Executive dashboard tile, which holds no metric of its own', async () => {
    const calls = stubApi({
      '/api/statistics/executive': {
        gameNow: '2027-03-10T00:00:00.000Z',
        creditTier: 'C',
        headlines: [
          {
            id: 'load_factor',
            label: 'Load factor',
            unit: 'ratio',
            polarity: 'higher_is_better',
            value: 0.82,
            text: null,
            trend: statistics().metrics[0]!.trends[1]!,
            drillDown: { ...BREAKDOWN, by: 'route' },
          },
        ],
        monthToDate: {
          monthStart: '2027-03-01T00:00:00.000Z',
          daysElapsed: 9,
          actualMinor: 0,
          forecastMinor: null,
          forecastLowMinor: null,
          forecastHighMinor: null,
          varianceMinor: null,
          withinBand: true,
        },
        gainers: [],
        losers: [],
      },
      '/api/statistics': statistics(),
      '/api/statistics/load_factor/breakdown': breakdown('load_factor'),
    });
    await renderAt('/dashboard');
    const tile = await screen.findByLabelText('Load factor');
    await act(async () => {
      fireEvent.click(within(tile).getByRole('button', { name: 'by route →' }));
      await Promise.resolve();
    });
    expect(
      await within(tile).findByRole('region', { name: /Load factor by route/ }),
    ).toBeInTheDocument();
    // No period control on that page: the headline's own month.
    expect(calls.map((call) => call.url)).toContain(
      '/api/statistics/load_factor/breakdown?by=route&days=30',
    );
  });
});
