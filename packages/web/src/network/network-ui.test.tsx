import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FarePreviewResponse, SetFaresResponse } from '@tailfin/shared';

import { NetworkPage } from './NetworkPage';

/**
 * The pricing panel (M3-09).
 *
 * The page computes nothing, so these tests are about whether it *shows* what
 * the server said — particularly the floor, which M3-09 requires a refusal to
 * explain, and which is exactly the thing a UI is tempted to reduce to "too
 * low".
 */

const ROUTE = {
  id: 'route-1',
  originIcao: 'EHAM',
  destinationIcao: 'LEBL',
  greatCircleNm: 700,
  fares: { business: 30_000, economy: 12_000 },
  active: true,
};

const PREVIEW: FarePreviewResponse = {
  routeId: 'route-1',
  positions: [
    {
      cabin: 'business',
      yourFareMinor: 30_000,
      marketAverageMinor: 28_000,
      priceRel: 30_000 / 28_000,
      floorMinor: 9_461,
      projectedShare: 0.61,
      seats: 12,
    },
    {
      cabin: 'economy',
      yourFareMinor: 12_000,
      marketAverageMinor: 11_000,
      priceRel: 12_000 / 11_000,
      floorMinor: 9_461,
      projectedShare: 0.43,
      seats: 162,
    },
  ],
  projectedPassengers: 88,
  currentPassengers: 74,
};

const REFUSAL: SetFaresResponse = {
  ok: false,
  violations: [
    {
      cabin: 'economy',
      fareMinor: 100,
      floorMinor: 9_461,
      shortfallMinor: 9_361,
      variableCostPerSeatMinor: 15_768,
      ratio: 0.6,
    },
  ],
};

const OPENED = { ok: true as const, routeId: 'route-2', greatCircleNm: 700 };

function stub(
  save: SetFaresResponse = { ok: true, fares: ROUTE.fares },
  opened: { ok: boolean } & Record<string, unknown> = OPENED,
) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? 'GET'} ${url}`);

      if (url === '/api/routes' && init?.method === 'POST') {
        return Promise.resolve({
          status: opened.ok ? 201 : 422,
          json: () => Promise.resolve(opened),
        });
      }
      if (url === '/api/routes') {
        return Promise.resolve({ status: 200, json: () => Promise.resolve({ routes: [ROUTE] }) });
      }
      if (url.endsWith('/fares/preview')) {
        return Promise.resolve({ status: 200, json: () => Promise.resolve(PREVIEW) });
      }
      if (url.endsWith('/fares')) {
        return Promise.resolve({
          status: save.ok ? 200 : 422,
          json: () => Promise.resolve(save),
        });
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }),
  );
  return calls;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the pricing panel', () => {
  it('shows the market average and the position against it', async () => {
    stub();
    render(<NetworkPage />);

    expect(await screen.findByText('EHAM → LEBL')).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(500);

    // 30,000 against a 28,000 average is 107% — A.3's PriceRel, shown as the
    // logit's own input rather than a rephrasing of it.
    await waitFor(() => {
      expect(screen.getByText('107%')).toBeInTheDocument();
    });
    expect(screen.getByText('280.00')).toBeInTheDocument();
    expect(screen.getByText('61.0%')).toBeInTheDocument();
  });

  it('shows the projected passengers and the change against what is saved', async () => {
    stub();
    render(<NetworkPage />);
    await screen.findByText('EHAM → LEBL');
    await vi.advanceTimersByTimeAsync(500);

    await waitFor(() => {
      expect(screen.getByText('88')).toBeInTheDocument();
    });
    // 88 against 74 saved. The delta is what a player can act on; the absolute
    // is a number nobody can calibrate.
    expect(screen.getByText(/14 against what is saved/)).toBeInTheDocument();
  });

  it('explains the floor when a fare is refused — the acceptance criterion', async () => {
    stub(REFUSAL);
    render(<NetworkPage />);
    await screen.findByText('EHAM → LEBL');
    await vi.advanceTimersByTimeAsync(500);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /save fares/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /save fares/i }));

    // Not "too low". The floor, the ratio, the cost it is a share of, and the
    // shortfall — every number the player needs to choose a legal fare.
    const message = await screen.findByRole('alert');
    expect(message).toHaveTextContent(/94\.61/);
    expect(message).toHaveTextContent(/60%/);
    expect(message).toHaveTextContent(/157\.68/);
    expect(message).toHaveTextContent(/93\.61/);
  });

  it('marks the refused cabin’s field, not just the message', async () => {
    stub(REFUSAL);
    render(<NetworkPage />);
    await screen.findByText('EHAM → LEBL');
    await vi.advanceTimersByTimeAsync(500);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /save fares/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /save fares/i }));

    await waitFor(() => {
      expect(screen.getByLabelText('Economy fare')).toHaveAttribute('aria-invalid', 'true');
    });
    // And the business field, which cleared, is untouched.
    expect(screen.getByLabelText('Business fare')).toHaveAttribute('aria-invalid', 'false');
  });

  it('asks the server for the preview rather than working it out', async () => {
    // The architectural criterion, asserted as a request. There is no economics
    // in this package to compute a share with — ESLint refuses the client an
    // import of `@tailfin/sim` — so the only way a number appears is if the
    // server sent it.
    const calls = stub();
    render(<NetworkPage />);
    await screen.findByText('EHAM → LEBL');
    await vi.advanceTimersByTimeAsync(500);

    await waitFor(() => {
      expect(calls).toContain('POST /api/routes/route-1/fares/preview');
    });
  });

  it('does not ask on every keystroke', async () => {
    const calls = stub();
    render(<NetworkPage />);
    await screen.findByText('EHAM → LEBL');
    await vi.advanceTimersByTimeAsync(500);

    // The rows only exist once the first preview has come back.
    await waitFor(() => {
      expect(screen.getByLabelText('Economy fare')).toBeInTheDocument();
    });

    const before = calls.filter((c) => c.includes('preview')).length;
    fireEvent.change(screen.getByLabelText('Economy fare'), { target: { value: '99.00' } });
    // Mid-debounce: nothing yet.
    expect(calls.filter((c) => c.includes('preview'))).toHaveLength(before);

    await vi.advanceTimersByTimeAsync(500);
    await waitFor(() => {
      expect(calls.filter((c) => c.includes('preview')).length).toBeGreaterThan(before);
    });
  });

  it('disables a cabin the aircraft does not have', async () => {
    stub();
    render(<NetworkPage />);
    await screen.findByText('EHAM → LEBL');
    await vi.advanceTimersByTimeAsync(500);

    await waitFor(() => {
      expect(screen.getByLabelText('Economy fare')).toBeEnabled();
    });
    // Only business and economy are in the preview, so first and premium
    // economy have no row at all — the panel shows what the aeroplane has.
    expect(screen.queryByLabelText('First fare')).toBeNull();
  });

  it('says so when there are no routes yet, and offers to open one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ status: 200, json: () => Promise.resolve({ routes: [] }) })),
    );
    render(<NetworkPage />);

    expect(await screen.findByText(/No routes yet/)).toBeInTheDocument();
    // The empty state has to be actionable. Naming a milestone at the player
    // was honest while nothing could be done about it and is not any more.
    expect(screen.getByRole('button', { name: /^open$/i })).toBeInTheDocument();
  });

  it('names the check that refused a route — App. B.4', async () => {
    // "Never a generic unavailable." A route refused for range needs a
    // different aeroplane; one refused for a curfew needs a different time.
    stub(undefined, {
      ok: false,
      kind: 'unreachable',
      reachability: { reason: 'range', detail: '1,850 nm required, 1,500 nm available' },
    });
    render(<NetworkPage />);
    await screen.findByText('EHAM → LEBL');

    fireEvent.change(screen.getByLabelText('Origin ICAO'), { target: { value: 'EHAM' } });
    fireEvent.change(screen.getByLabelText('Destination ICAO'), { target: { value: 'KJFK' } });
    fireEvent.click(screen.getByRole('button', { name: /^open$/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Out of range/);
    expect(alert).toHaveTextContent(/1,850 nm required/);
  });

  it('refuses a pair already flown, differently from a rule refusal', async () => {
    stub(undefined, { ok: false, kind: 'duplicate' });
    render(<NetworkPage />);
    await screen.findByText('EHAM → LEBL');

    fireEvent.change(screen.getByLabelText('Origin ICAO'), { target: { value: 'EHAM' } });
    fireEvent.change(screen.getByLabelText('Destination ICAO'), { target: { value: 'LEBL' } });
    fireEvent.click(screen.getByRole('button', { name: /^open$/i }));

    expect(await screen.findByText(/already fly that pair/i)).toBeInTheDocument();
  });

  it('says you have no airline rather than blaming the airport', async () => {
    // The bug this replaced: a player with no airline was told "No airport
    // with the code EHAM", which is false and unactionable. Found by checking
    // dev rather than by a test, which is why there is now a test.
    stub(undefined, { ok: false, kind: 'no-airline' });
    render(<NetworkPage />);
    await screen.findByText('EHAM → LEBL');

    fireEvent.change(screen.getByLabelText('Origin ICAO'), { target: { value: 'EHAM' } });
    fireEvent.change(screen.getByLabelText('Destination ICAO'), { target: { value: 'LEBL' } });
    fireEvent.click(screen.getByRole('button', { name: /^open$/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/do not have an airline/i);
    expect(alert).not.toHaveTextContent(/No airport with the code/i);
  });

  it('will not submit a code that is not four letters', async () => {
    stub();
    render(<NetworkPage />);
    await screen.findByText('EHAM → LEBL');

    fireEvent.change(screen.getByLabelText('Origin ICAO'), { target: { value: 'EH' } });
    expect(screen.getByRole('button', { name: /^open$/i })).toBeDisabled();
  });
});
