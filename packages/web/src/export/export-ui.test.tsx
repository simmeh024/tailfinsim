import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { setDisplayCurrency } from '../currency/display';
import { FinancePage } from '../finance/FinancePage';

/**
 * The acceptance criterion, tested against a rendered page (M8-14).
 *
 * > Exported figures match the on-screen values exactly.
 *
 * Testing `toCsv` alone cannot show that. The only way this criterion fails in
 * practice is a panel formatting one number for the screen and a different one
 * for the file — so the test renders the real page, reads the figure out of the
 * DOM, clicks export, and compares the two.
 *
 * The currency is deliberately **not** USD. A test in dollars would pass whether
 * or not the export converted at all, which is precisely the bug this feature
 * had to be designed around: money is stored in USD minor units and converted at
 * the client's render boundary, so a server-built CSV would have exported
 * dollars while the screen showed euros.
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

const PNL = {
  from: '1965-03-01T00:00:00.000Z',
  to: '1965-03-31T00:00:00.000Z',
  revenueMinor: 1_234_500,
  costMinor: 1_000_000,
  operatingProfitMinor: 234_500,
  lines: [{ category: 'ticket' as const, amountMinor: 1_234_500, entryCount: 42 }],
  byRoute: [
    {
      key: 'EHAM–EGLL',
      revenueMinor: 1_234_500,
      costMinor: 1_000_000,
      operatingProfitMinor: 234_500,
    },
  ],
  byAircraft: [],
  byHub: [],
  byCabinClass: [],
};

const EMPTY_STATS = { gameNow: '1965-03-31T00:00:00.000Z', metrics: [] };
const EMPTY_CREDIT = {
  tier: 'prime' as const,
  scoreBps: 9000,
  loans: [],
  offers: [],
  totalOutstandingMinor: 0,
  totalArrearsMinor: 0,
  dscr: null,
  maxAdditionalMinor: 0,
};
const EMPTY_BREAKDOWN = {
  metricId: 'operating_profit',
  label: 'Operating profit',
  unit: 'minor' as const,
  polarity: 'higher_is_better' as const,
  gameNow: '1965-03-31T00:00:00.000Z',
  rows: [],
};

/** Capture the CSV text `downloadCsv` would have handed the browser. */
function captureCsv(): { text: () => string } {
  let captured = '';
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: () => 'blob:test',
    revokeObjectURL: () => undefined,
  });
  const realCreate = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    const element = realCreate(tag) as HTMLAnchorElement;
    if (tag === 'a') element.click = () => undefined;
    return element;
  });
  // Blob's text() is async; read the parts synchronously instead.
  const RealBlob = globalThis.Blob;
  vi.stubGlobal(
    'Blob',
    class extends RealBlob {
      constructor(parts: BlobPart[], options?: BlobPropertyBag) {
        super(parts, options);
        captured = parts.map(String).join('');
      }
    },
  );
  return { text: () => captured };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setDisplayCurrency('USD', []);
});

function stubApi(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      const url = String(input);
      const body = url.includes('/api/finance/pnl')
        ? PNL
        : url.includes('/api/statistics/operating_profit/breakdown')
          ? EMPTY_BREAKDOWN
          : url.includes('/api/statistics')
            ? EMPTY_STATS
            : url.includes('/api/credit')
              ? EMPTY_CREDIT
              : {};
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    }),
  );
}

describe('CSV export matches the screen', () => {
  it('exports the P&L in the display currency the page is showing', async () => {
    setDisplayCurrency('EUR', [EUR]);
    stubApi();
    const csv = captureCsv();

    render(
      <MemoryRouter>
        <FinancePage />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('Profit and loss')).toBeInTheDocument());

    // What the page shows: 1,234,500 USD minor at 0.5 → €6,172.50.
    expect(screen.getAllByText('€6,172.50').length).toBeGreaterThan(0);

    fireEvent.click(screen.getAllByRole('button', { name: /Export CSV/ })[0]!);

    const text = csv.text();
    // The header names the currency the figures are in…
    expect(text).toContain('Amount (EUR)');
    // …and the figure is the same number the screen rendered, without the
    // symbol and grouping a spreadsheet cannot sum.
    expect(text).toContain('6172.5');
    // Not the underlying USD.
    expect(text).not.toContain('12345');
  });

  it('carries the statement’s own totals, so the file is not missing its bottom line', async () => {
    setDisplayCurrency('EUR', [EUR]);
    stubApi();
    const csv = captureCsv();

    render(
      <MemoryRouter>
        <FinancePage />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('Profit and loss')).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole('button', { name: /Export CSV/ })[0]!);

    const text = csv.text();
    expect(text).toContain('Revenue,6172.5');
    expect(text).toContain('Cost,5000');
    expect(text).toContain('Operating profit,1172.5');
  });

  it('exports a dimension rollup with the same contribution the row shows', async () => {
    setDisplayCurrency('EUR', [EUR]);
    stubApi();
    const csv = captureCsv();

    render(
      <MemoryRouter>
        <FinancePage />
      </MemoryRouter>,
    );
    /*
     * Found by the panel's own landmark, not by text: "By route" is both the
     * heading and the table's first column header, and picking "the last export
     * button" would silently follow whatever order the page happens to render.
     */
    const panel = await screen.findByRole('region', { name: 'By route' });
    fireEvent.click(within(panel).getByRole('button', { name: /Export CSV/ }));

    const text = csv.text();
    expect(text).toContain('EHAM–EGLL');
    // Contribution: 234,500 USD minor at 0.5 → €1,172.50, and the export carries
    // the signed number rather than the arrow the screen pairs with it.
    expect(text).toContain('1172.5');
  });

  it('offers no export on a panel with no rows', async () => {
    // An empty file is worse than no button: it reads as a broken export rather
    // than as an empty period.
    setDisplayCurrency('EUR', [EUR]);
    vi.stubGlobal(
      'fetch',
      vi.fn((input: unknown) => {
        const url = String(input);
        const body = url.includes('/api/finance/pnl')
          ? { ...PNL, lines: [], byRoute: [] }
          : url.includes('/api/statistics/operating_profit/breakdown')
            ? EMPTY_BREAKDOWN
            : url.includes('/api/statistics')
              ? EMPTY_STATS
              : url.includes('/api/credit')
                ? EMPTY_CREDIT
                : {};
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
      }),
    );

    render(
      <MemoryRouter>
        <FinancePage />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('Profit and loss')).toBeInTheDocument());

    expect(screen.queryAllByRole('button', { name: /Export CSV/ })).toHaveLength(0);
  });
});
