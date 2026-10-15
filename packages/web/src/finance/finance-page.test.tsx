import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../App';
import { setDisplayCurrency } from '../currency/display';

import { FinancePage } from './FinancePage';
import {
  breakdown,
  credit,
  losingCredit,
  pnl,
  statistics,
  stubApi,
  type Call,
} from './test-finance';

/**
 * The Finance page as a container (SURFACE-03).
 *
 * What the issue asks of the page itself, rather than of its panels: defined
 * regions in a stated order with §14.4 first, **one** period control for the
 * whole page, `/api/finance/pnl` consumed with interest as its own line, no
 * second runway, every panel in all four states, and money through the
 * display-currency boundary.
 *
 * Every assertion that depends on a panel's data waits for that panel: the page
 * renders each panel's loading state at once and fills them as their reads
 * arrive — the "later effect races the first render" shape CLAUDE.md records.
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

function stubFinance(overrides: Record<string, unknown> = {}): Call[] {
  return stubApi({
    '/api/statistics': statistics(),
    '/api/finance/pnl': pnl(),
    '/api/credit': credit(),
    '/api/statistics/operating_profit/breakdown': breakdown('operating_profit'),
    ...overrides,
  });
}

async function renderFinance(): Promise<HTMLElement> {
  render(
    <MemoryRouter initialEntries={['/finance']}>
      <App />
    </MemoryRouter>,
  );
  await screen.findByRole('navigation', { name: 'Main' });
  return screen.findByRole('heading', { level: 1, name: 'Finance' });
}

beforeAll(async () => {
  // Warm the lazily-loaded route, so the first test is not timing a chunk load.
  await import('./FinancePage');
});

beforeEach(() => {
  localStorage.clear();
  setDisplayCurrency('USD', []);
});

afterEach(() => {
  localStorage.clear();
  setDisplayCurrency('USD', []);
  vi.restoreAllMocks();
});

describe('the regions', () => {
  it('are the page’s own, in the order §14.1’s questions are asked', async () => {
    stubFinance();
    await renderFinance();

    // The page's own region headings — the shell has headings of its own.
    const page = screen.getByRole('heading', { level: 1, name: 'Finance' }).closest('section')!;
    const regions = within(page)
      .getAllByRole('heading', { level: 2 })
      .map((heading) => heading.textContent);
    expect(regions).toEqual([
      'Where the money is made',
      'Headline figures',
      'What it is costing',
      'Borrowing',
      'Not on this page yet',
    ]);
  });

  it('puts §14.4’s profit-by-route chart first, above every table', async () => {
    stubFinance();
    await renderFinance();
    const chart = screen.getByLabelText('Profit by route');
    const statement = screen.getByLabelText('Profit and loss');
    // Document order: the chart precedes the statement.
    expect(
      chart.compareDocumentPosition(statement) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('names what is not here yet, and who owns the default ladder', async () => {
    stubFinance();
    await renderFinance();
    const gaps = screen.getByRole('heading', {
      level: 2,
      name: 'Not on this page yet',
    }).parentElement!;
    expect(gaps.textContent).toContain('cargo');
    expect(gaps.textContent).toContain('LEGACY-11');
  });
});

describe('one period for the whole page (§14.2)', () => {
  it('starts on a game month, and is one control rather than one per panel', async () => {
    stubFinance();
    await renderFinance();
    const control = screen.getByRole('group', { name: 'Period, in game days' });
    expect(within(control).getByRole('button', { name: '30 days' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getAllByRole('group', { name: /Period/ })).toHaveLength(1);
  });

  it('re-reads the P&L and the ranked chart over the period chosen', async () => {
    const calls = stubFinance();
    await renderFinance();
    await waitFor(() =>
      expect(calls.some((call) => call.url === '/api/finance/pnl?days=30')).toBe(true),
    );

    fireEvent.click(screen.getByRole('button', { name: '7 days' }));

    await waitFor(() =>
      expect(calls.some((call) => call.url === '/api/finance/pnl?days=7')).toBe(true),
    );
    expect(
      calls.some(
        (call) => call.url === '/api/statistics/operating_profit/breakdown?by=route&days=7',
      ),
    ).toBe(true);
    // And every headline tile now shows its movement over the same seven days.
    const unit = screen.getByLabelText('Unit economics');
    await waitFor(() => expect(within(unit).getByLabelText('RASK').textContent).toContain('7d'));
  });
});

describe('the P&L (§13.4)', () => {
  it('always shows interest as its own line — even when none was charged', async () => {
    // The fixture P&L carries no interest category at all.
    stubFinance();
    await renderFinance();
    const statement = screen.getByLabelText('Profit and loss');
    await within(statement).findByText('Operating profit');
    const interest = within(statement).getByRole('rowheader', { name: 'interest' });
    expect(interest.closest('tr')).toHaveAttribute('data-line', 'interest');
  });

  it('names OTHER-01’s lease rent for what it is, beside the other costs', async () => {
    stubFinance({
      '/api/finance/pnl': pnl({
        lines: [
          { category: 'ticket', amountMinor: 20_000_000, entryCount: 40 },
          { category: 'lease_finance', amountMinor: 8_500_000, entryCount: 1 },
        ],
      }),
    });
    await renderFinance();
    const statement = screen.getByLabelText('Profit and loss');
    const row = (
      await within(statement).findByRole('rowheader', { name: 'lease finance (aircraft rent)' })
    ).closest('tr') as HTMLElement;
    expect(row.textContent).toContain('$85,000.00');
  });

  it('shows the interest that was charged, on its line', async () => {
    stubFinance({
      '/api/finance/pnl': pnl({
        lines: [
          { category: 'ticket', amountMinor: 20_000_000, entryCount: 40 },
          { category: 'interest', amountMinor: 350_000, entryCount: 30 },
        ],
      }),
    });
    await renderFinance();
    const statement = screen.getByLabelText('Profit and loss');
    const row = (await within(statement).findByRole('rowheader', { name: 'interest' })).closest(
      'tr',
    ) as HTMLElement;
    expect(row.textContent).toContain('$3,500.00');
  });

  it('keeps borrowed money out of the totals and says so', async () => {
    stubFinance({
      '/api/finance/pnl': pnl({
        lines: [
          { category: 'ticket', amountMinor: 20_000_000, entryCount: 40 },
          { category: 'debt_draw', amountMinor: 25_000_000, entryCount: 1 },
        ],
      }),
    });
    await renderFinance();
    const statement = screen.getByLabelText('Profit and loss');
    expect(await within(statement).findByText('borrowed (outside the totals)')).toBeInTheDocument();
  });
});

describe('cash runway', () => {
  it('is not repeated: the status strip has the only one', async () => {
    stubFinance();
    const heading = await renderFinance();
    const page = heading.closest('section')!;
    await within(page).findByText('Operating profit');
    expect(within(page).queryByText('Runway')).toBeNull();
    expect(page.querySelector('.strip__item')).toBeNull();
    // The page points at the strip instead of copying it.
    expect(page.textContent).toContain('status strip');
  });
});

describe('the four states', () => {
  it('shows each panel loading on its own while its read is in flight', async () => {
    stubFinance({ '/api/finance/pnl': () => new Promise<never>(() => undefined) });
    await renderFinance();
    const statement = screen.getByLabelText('Profit and loss');
    expect(within(statement).getByText('Reading the ledger.')).toBeInTheDocument();
    // The others are not held up by it.
    await waitFor(() =>
      expect(within(screen.getByLabelText('Unit economics')).getByLabelText('RASK')).toBeTruthy(),
    );
  });

  it('says a period with nothing booked is empty, and why it might be', async () => {
    stubFinance({
      '/api/finance/pnl': pnl({
        lines: [],
        revenueMinor: 0,
        costMinor: 0,
        operatingProfitMinor: 0,
      }),
    });
    await renderFinance();
    const statement = screen.getByLabelText('Profit and loss');
    expect(
      await within(statement).findByText(/Nothing has been booked in the last 30 game days/),
    ).toBeInTheDocument();
  });

  it('says a panel is broken without taking the page with it', async () => {
    stubFinance({ '/api/credit': { tier: 'nope' } });
    await renderFinance();
    expect(await screen.findByText('Your credit standing could not be read.')).toBeInTheDocument();
    expect(
      await within(screen.getByLabelText('Profit and loss')).findByText('Operating profit'),
    ).toBeInTheDocument();
  });

  it('says what is refused, and why, in the formula’s terms', async () => {
    stubFinance({ '/api/credit': losingCredit() });
    await renderFinance();
    const capacity = await screen.findByLabelText('Borrowing capacity');
    expect(capacity.textContent).toContain('you cannot borrow at all');
  });
});

describe('money', () => {
  it('renders through the display currency, everywhere on the page', async () => {
    /*
     * The page on its own, with the formatters pointed at euros the way the
     * shell's currency provider points them — the M8-14 export test's harness.
     * Through the whole shell the page can render before the rates arrive,
     * which tests the provider's timing rather than this page.
     */
    setDisplayCurrency('EUR', [EUR]);
    stubFinance();
    render(
      <MemoryRouter>
        <FinancePage />
      </MemoryRouter>,
    );
    const statement = screen.getByLabelText('Profit and loss');
    // 20,000,000 USD minor at 0.5 → €100,000.00.
    expect(await within(statement).findAllByText('€100,000.00')).not.toHaveLength(0);
    const capacity = await screen.findByLabelText('Borrowing capacity');
    // 90,000,000 USD minor → €450,000.00.
    expect(capacity.textContent).toContain('€450,000.00');
    expect(capacity.textContent).not.toContain('$');
  });
});
