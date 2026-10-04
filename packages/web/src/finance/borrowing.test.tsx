import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CreditStandingResponse } from '@tailfin/shared';

import { setDisplayCurrency } from '../currency/display';

import { BorrowingPanel } from './BorrowingPanel';
import { credit, losingCredit, stubApi } from './test-finance';

/**
 * Borrowing (SURFACE-02, §13).
 *
 * The panel renders §13 and decides none of it. These prove the criteria that
 * live in the client: the binding constraint named from the API's own
 * `BorrowingConstraint`; a loss-making airline told why in §13.1's terms rather
 * than shown a greyed control; all five of §13.3's instruments; interest as a
 * share of profit; a draw that sends no rate and is never retried; a refusal
 * that leaves the standing on screen untouched; and money through the display
 * currency both ways. The server half — the refused draw leaving cash and the
 * ledger unchanged, and SEC-07's cases — is `finance-surface-routes.test.ts`.
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

function renderPanel(value: CreditStandingResponse = credit()) {
  const onChange = vi.fn();
  render(
    <MemoryRouter>
      <BorrowingPanel credit={value} onChange={onChange} />
    </MemoryRouter>,
  );
  return { onChange };
}

function rowOf(table: HTMLElement, text: RegExp): HTMLElement {
  const row = within(table)
    .getAllByRole('row')
    .find((candidate) => text.test(candidate.textContent ?? ''));
  if (!row) throw new Error(`no row matching ${String(text)}`);
  return row;
}

beforeEach(() => {
  setDisplayCurrency('USD', []);
});

afterEach(() => {
  setDisplayCurrency('USD', []);
  vi.restoreAllMocks();
});

describe('capacity (§13.1)', () => {
  it('shows all three limits and names the binding one from the API', () => {
    stubApi({});
    renderPanel();
    const capacity = screen.getByLabelText('Borrowing capacity');
    // The fixture's binding constraint is `asset_advance`.
    const assets = rowOf(capacity, /tangible assets/);
    expect(assets).toHaveAttribute('data-binding', 'true');
    expect(within(assets).getByText('binding')).toBeInTheDocument();
    expect(rowOf(capacity, /trailing operating profit/)).toHaveAttribute('data-binding', 'false');
    // The multipliers are the server's, shown as the formula.
    expect(capacity.textContent).toContain('3.0 × trailing operating profit');
    expect(capacity.textContent).toContain('0.60 × tangible assets');
    expect(capacity.textContent).toContain('$650,000.00');
  });

  it('tells a loss-making airline why it cannot borrow, in §13.1’s terms, with no form', () => {
    stubApi({});
    renderPanel(losingCredit());
    const capacity = screen.getByLabelText('Borrowing capacity');
    expect(capacity.textContent).toContain(
      '3.0 × your trailing operating profit of -$120,000.00 is $0.00, so you cannot borrow at all',
    );
    expect(capacity.textContent).toContain('the formula does');
    // Not a greyed button: there is no draw form at all.
    expect(screen.queryByLabelText('Draw a loan')).toBeNull();
    expect(screen.queryByRole('button', { name: /Review the loan/ })).toBeNull();
  });

  it('says the founder facility is exempt from the trading limits rather than showing them as binding', () => {
    stubApi({});
    renderPanel(credit({ tier: 'startup', bindingConstraint: 'tier_cap' }));
    const capacity = screen.getByLabelText('Borrowing capacity');
    expect(capacity.textContent).toContain('not applied');
    expect(capacity.textContent).toContain('founder facility is exempt');
  });
});

describe('standing (§13.2)', () => {
  it('shows the tier, what the next one asks for, and the asymmetry as a property', () => {
    stubApi({});
    renderPanel(credit({ earnedTier: 'B', rating: { goodReviews: 1, reviewsToRise: 2 } }));
    const standing = screen.getByLabelText('Credit standing');
    expect(standing.textContent).toContain('Ratings fall faster than they rise');
    expect(standing.textContent).toContain('1 of 2 so far');
    const next = within(standing).getByRole('table', { name: 'What B asks for' });
    expect(rowOf(next, /Hubs/).textContent).toContain('2');
  });
});

describe('the instruments (§13.3)', () => {
  it('presents all five with rate, security and purpose — the rates the server’s', () => {
    stubApi({});
    renderPanel();
    const table = screen.getByLabelText('Instruments');
    for (const name of [
      'Working capital line',
      'Aircraft finance',
      'Facility loan',
      'Sale-leaseback',
      'Bond issue',
    ]) {
      expect(within(table).getByRole('rowheader', { name })).toBeInTheDocument();
    }
    // The quote, not a client-side "tier + 3%".
    expect(rowOf(table, /Working capital/).textContent).toContain('13.0%');
    expect(rowOf(table, /Working capital/).textContent).toContain('tier +3.0 pts');
    expect(rowOf(table, /Aircraft finance/).textContent).toContain('The airframe');
    expect(rowOf(table, /Sale-leaseback/).textContent).toContain('not built yet');
    expect(rowOf(table, /Bond issue/).textContent).toContain('post-MVP');
  });
});

describe('what it costs (§13.4)', () => {
  it('shows interest per month and as a share of operating profit, loan by loan', () => {
    stubApi({});
    renderPanel();
    const debt = screen.getByLabelText('Debt and interest');
    expect(debt.textContent).toContain('Share of operating profit');
    expect(rowOf(debt, /working capital/).textContent).toContain('7%');
    expect(rowOf(debt, /working capital/).textContent).toContain('$3,541.67');
  });

  it('says there is no profit for the interest to be a share of, rather than inventing one', () => {
    stubApi({});
    renderPanel(credit({ interest: { monthlyMinor: 100, shareOfOperatingProfit: null } }));
    expect(screen.getByLabelText('Debt and interest').textContent).toContain(
      'no profit to be a share of',
    );
  });

  it('states the default ladder’s stage and stops there (LEGACY-11 owns the rest)', () => {
    stubApi({});
    renderPanel(
      credit({
        standing: {
          stage: 'warning',
          stageEnteredAt: '2027-03-01T00:00:00.000Z',
          cureByAt: '2027-03-08T00:00:00.000Z',
          arrearsMinor: 50_000,
          restricted: false,
          message: 'Clear the arrears to cure.',
          dailyInterestMinor: 11_806,
        },
      }),
    );
    const debt = screen.getByLabelText('Debt and interest');
    expect(debt.textContent).toContain('warning: Clear the arrears to cure.');
    expect(debt.textContent).toContain('Cure by 2027-03-08');
  });
});

describe('drawing (SEC-09)', () => {
  function fillAndConfirm(amount: string): void {
    const form = screen.getByLabelText('Draw a loan');
    fireEvent.change(within(form).getByLabelText(/Amount/), { target: { value: amount } });
    fireEvent.click(within(form).getByRole('button', { name: 'Review the loan' }));
    fireEvent.click(within(form).getByRole('button', { name: /Confirm — borrow/ }));
  }

  it('sends an instrument and an amount, and nothing the server decides', async () => {
    const after = credit({ outstandingDebtMinor: 35_000_000, headroomMinor: 55_000_000 });
    const calls = stubApi({
      '/api/credit/loans': () => ({ status: 201, body: after }),
    });
    const { onChange } = renderPanel();

    fillAndConfirm('100000');

    await waitFor(() => expect(onChange).toHaveBeenCalledWith(after));
    const draws = calls.filter((call) => call.method === 'POST');
    expect(draws).toHaveLength(1);
    expect(draws[0]?.body).toEqual({ instrument: 'working_capital', principalMinor: 10_000_000 });
    expect(await screen.findByRole('status')).toHaveTextContent('Borrowed $100,000.00');
  });

  it('takes two clicks: the first states the price, the second spends it', () => {
    const calls = stubApi({});
    renderPanel();
    const form = screen.getByLabelText('Draw a loan');
    fireEvent.change(within(form).getByLabelText(/Amount/), { target: { value: '5000' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Review the loan' }));
    expect(form.textContent).toContain('at 13.0%');
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    fireEvent.click(within(form).getByRole('button', { name: 'Keep' }));
    expect(within(form).getByRole('button', { name: 'Review the loan' })).toBeInTheDocument();
  });

  it('shows a refusal as the server gave it, and leaves the standing untouched', async () => {
    const calls = stubApi({
      '/api/credit/loans': () => ({
        status: 422,
        body: {
          code: 'refused',
          message:
            'You are at your borrowing limit. Capacity is a multiple of demonstrated profit.',
        },
      }),
    });
    const { onChange } = renderPanel();

    fillAndConfirm('999999999');

    expect(await screen.findByText(/You are at your borrowing limit/)).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    // The standing on screen is the one it was.
    expect(screen.getByLabelText('Borrowing capacity').textContent).toContain('$650,000.00');
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it('never retries a draw the network lost — a retried timeout could be two loans', async () => {
    const calls = stubApi({
      '/api/credit/loans': () => Promise.reject(new Error('timeout')),
    });
    const { onChange } = renderPanel();

    fillAndConfirm('1000');

    expect(await screen.findByText(/could not be reached/)).toBeInTheDocument();
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('asks aircraft finance for the airframe it is secured on', async () => {
    const calls = stubApi({
      '/api/fleet/airframes': {
        airframes: [
          {
            airframeId: 'eeeeeeee-ffff-4000-8000-000000000001',
            registration: 'PH-LGR',
            typeDesignation: 'ATR 72-600',
          },
        ],
      },
      '/api/credit/loans': () => ({ status: 201, body: credit() }),
    });
    renderPanel();
    const form = screen.getByLabelText('Draw a loan');
    fireEvent.change(within(form).getByLabelText('Instrument'), {
      target: { value: 'aircraft_finance' },
    });
    const secured = await within(form).findByLabelText('Secured on');
    fireEvent.change(secured, { target: { value: 'eeeeeeee-ffff-4000-8000-000000000001' } });
    fillAndConfirm('2000');

    await waitFor(() => expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1));
    expect(calls.find((call) => call.method === 'POST')?.body).toEqual({
      instrument: 'aircraft_finance',
      principalMinor: 200_000,
      securedAirframeId: 'eeeeeeee-ffff-4000-8000-000000000001',
    });
  });
});

describe('money (M8-02)', () => {
  it('shows every figure in the display currency, and reads an amount typed in it back to USD', async () => {
    setDisplayCurrency('EUR', [EUR]);
    const calls = stubApi({ '/api/credit/loans': () => ({ status: 201, body: credit() }) });
    renderPanel();

    const capacity = screen.getByLabelText('Borrowing capacity');
    // 65,000,000 USD minor left to draw at 0.5 → €325,000.00.
    expect(capacity.textContent).toContain('€325,000.00');
    expect(capacity.textContent).not.toContain('$');

    const form = screen.getByLabelText('Draw a loan');
    expect(within(form).getByLabelText('Amount (EUR)')).toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText('Amount (EUR)'), { target: { value: '100' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Review the loan' }));
    fireEvent.click(within(form).getByRole('button', { name: /Confirm — borrow/ }));

    // €100 at 0.5 EUR per USD is $200, which is 20,000 USD minor: the wire stays USD.
    await waitFor(() =>
      expect(calls.find((call) => call.method === 'POST')?.body).toEqual({
        instrument: 'working_capital',
        principalMinor: 20_000,
      }),
    );
  });
});
