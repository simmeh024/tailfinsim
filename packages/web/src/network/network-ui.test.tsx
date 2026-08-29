import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FareWaterfallResponse, FarePreviewResponse, SetFaresResponse } from '@tailfin/shared';

import { NetworkPage } from './NetworkPage';

/**
 * The Network workspace (M2/M3).
 *
 * The redesign moved fares into a Pricing tab and opened a route from the rail,
 * but the acceptance criteria are unchanged: the page computes nothing, so these
 * tests are about whether it *shows* what the server said — the floor a refusal
 * must explain, the PriceRel, and A.9's decomposition. The navigation is new; the
 * assertions are the same ones M3-09 and M3-10 have always required.
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

const WATERFALL: FareWaterfallResponse = {
  routeId: 'route-1',
  cabin: 'economy',
  rivalId: 'a',
  rivals: [
    { id: 'a', cabins: ['economy'] },
    { id: 'b', cabins: ['economy'] },
  ],
  bySegment: [
    {
      segment: 'business',
      factors: [
        { factor: 'product', delta: 0.528 },
        { factor: 'frequency', delta: -0.817 },
        { factor: 'price', delta: -0.283 },
        { factor: 'reputation', delta: 0.14 },
      ],
      netDelta: -0.432,
      shareRatio: 0.649,
      yourShare: 0.233,
      theirShare: 0.359,
    },
    {
      segment: 'leisure',
      factors: [
        { factor: 'price', delta: -0.77 },
        { factor: 'frequency', delta: -0.46 },
        { factor: 'product', delta: 0.192 },
        { factor: 'reputation', delta: 0.05 },
      ],
      netDelta: -0.988,
      shareRatio: 0.372,
      yourShare: 0.243,
      theirShare: 0.654,
    },
    {
      segment: 'vfr',
      factors: [
        { factor: 'price', delta: -0.616 },
        { factor: 'frequency', delta: -0.409 },
        { factor: 'product', delta: 0.144 },
        { factor: 'reputation', delta: 0.07 },
      ],
      netDelta: -0.811,
      shareRatio: 0.444,
      yourShare: 0.256,
      theirShare: 0.576,
    },
  ],
};

/** Serve the fleet endpoint the page loads for the planner's aircraft rows. */
function fleetResponse(): { status: number; json: () => Promise<unknown> } {
  return { status: 200, json: () => Promise.resolve({ airframes: [] }) };
}

function stubWaterfall(
  answer: unknown = WATERFALL,
  status = 200,
): { calls: string[]; answered: () => number } {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.includes('/fleet/airframes')) return Promise.resolve(fleetResponse());
      if (url.includes('/waterfall')) {
        return Promise.resolve({ status, json: () => Promise.resolve(answer) });
      }
      if (url === '/api/routes') {
        return Promise.resolve({ status: 200, json: () => Promise.resolve({ routes: [ROUTE] }) });
      }
      if (url.endsWith('/fares/preview')) {
        return Promise.resolve({ status: 200, json: () => Promise.resolve(PREVIEW) });
      }
      if (url.endsWith('/fares')) {
        return Promise.resolve({
          status: 200,
          json: () => Promise.resolve({ ok: true, fares: ROUTE.fares }),
        });
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }),
  );
  return { calls, answered: () => calls.filter((c) => c.includes('/waterfall')).length };
}

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
      if (url.includes('/fleet/airframes')) return Promise.resolve(fleetResponse());

      if (url.startsWith('/api/routes/') && init?.method === 'DELETE') {
        return Promise.resolve({
          status: 200,
          json: () => Promise.resolve({ ok: true, routeId: 'route-1' }),
        });
      }

      if (url === '/api/routes' && init?.method === 'POST') {
        if (opened.kind === 'no-airline') {
          return Promise.resolve({
            status: 409,
            json: () =>
              Promise.resolve({
                code: 'airline_required',
                message: 'Found an airline in the active world before using this feature',
              }),
          });
        }
        if (opened.kind === 'active-world-required') {
          return Promise.resolve({
            status: 409,
            json: () =>
              Promise.resolve({
                code: 'active_world_required',
                message: 'Choose an active world before using this feature',
              }),
          });
        }
        if (opened.kind === 'duplicate') {
          return Promise.resolve({
            status: 409,
            json: () =>
              Promise.resolve({ code: 'duplicate_route', message: 'You already fly that pair' }),
          });
        }
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

/** Wait for the route to load, then open its Pricing tab. */
async function openPricing(): Promise<void> {
  await screen.findByText('EHAM → LEBL');
  fireEvent.click(screen.getByRole('tab', { name: 'Pricing' }));
}

/** Open the Pricing tab and click through to the chart. */
async function openWaterfall(): Promise<void> {
  render(<NetworkPage />);
  await openPricing();
  await vi.advanceTimersByTimeAsync(500);
  const toggle = await screen.findByRole('button', { name: /why am i losing/i });
  fireEvent.click(toggle);
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the pricing tab', () => {
  it('shows the market average and the position against it', async () => {
    stub();
    render(<NetworkPage />);
    await openPricing();
    await vi.advanceTimersByTimeAsync(500);

    await waitFor(() => {
      expect(screen.getByText('107%')).toBeInTheDocument();
    });
    expect(screen.getByText('280.00')).toBeInTheDocument();
    expect(screen.getByText('61.0%')).toBeInTheDocument();
  });

  it('shows the projected passengers and the change against what is saved', async () => {
    stub();
    render(<NetworkPage />);
    await openPricing();
    await vi.advanceTimersByTimeAsync(500);

    await waitFor(() => {
      expect(screen.getByText('88')).toBeInTheDocument();
    });
    expect(screen.getByText(/14 against what is saved/)).toBeInTheDocument();
  });

  it('explains the floor when a fare is refused — the acceptance criterion', async () => {
    stub(REFUSAL);
    render(<NetworkPage />);
    await openPricing();
    await vi.advanceTimersByTimeAsync(500);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /save fares/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /save fares/i }));

    const message = await screen.findByRole('alert');
    expect(message).toHaveTextContent(/94\.61/);
    expect(message).toHaveTextContent(/60%/);
    expect(message).toHaveTextContent(/157\.68/);
    expect(message).toHaveTextContent(/93\.61/);
  });

  it('marks the refused cabin’s field, not just the message', async () => {
    stub(REFUSAL);
    render(<NetworkPage />);
    await openPricing();
    await vi.advanceTimersByTimeAsync(500);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /save fares/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /save fares/i }));

    await waitFor(() => {
      expect(screen.getByLabelText('Economy fare')).toHaveAttribute('aria-invalid', 'true');
    });
    expect(screen.getByLabelText('Business fare')).toHaveAttribute('aria-invalid', 'false');
  });

  it('asks the server for the preview rather than working it out', async () => {
    const calls = stub();
    render(<NetworkPage />);
    await openPricing();
    await vi.advanceTimersByTimeAsync(500);

    await waitFor(() => {
      expect(calls).toContain('POST /api/routes/route-1/fares/preview');
    });
  });

  it('does not ask on every keystroke', async () => {
    const calls = stub();
    render(<NetworkPage />);
    await openPricing();
    await vi.advanceTimersByTimeAsync(500);

    await waitFor(() => {
      expect(screen.getByLabelText('Economy fare')).toBeInTheDocument();
    });

    const before = calls.filter((c) => c.includes('preview')).length;
    fireEvent.change(screen.getByLabelText('Economy fare'), { target: { value: '99.00' } });
    expect(calls.filter((c) => c.includes('preview'))).toHaveLength(before);

    await vi.advanceTimersByTimeAsync(500);
    await waitFor(() => {
      expect(calls.filter((c) => c.includes('preview')).length).toBeGreaterThan(before);
    });
  });

  it('disables a cabin the aircraft does not have', async () => {
    stub();
    render(<NetworkPage />);
    await openPricing();
    await vi.advanceTimersByTimeAsync(500);

    await waitFor(() => {
      expect(screen.getByLabelText('Economy fare')).toBeEnabled();
    });
    expect(screen.queryByLabelText('First fare')).toBeNull();
  });
});

describe('opening a route from the rail', () => {
  it('says so when there are no routes yet, and offers to open one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: unknown) => {
        const url = String(input);
        if (url.includes('/fleet/airframes')) return Promise.resolve(fleetResponse());
        return Promise.resolve({ status: 200, json: () => Promise.resolve({ routes: [] }) });
      }),
    );
    render(<NetworkPage />);

    expect(await screen.findByText(/No routes yet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^open$/i })).toBeInTheDocument();
  });

  it('names the check that refused a route — App. B.4', async () => {
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

  it('asks multi-world players to choose instead of guessing an airline', async () => {
    stub(undefined, { ok: false, kind: 'active-world-required' });
    render(<NetworkPage />);
    await screen.findByText('EHAM → LEBL');

    fireEvent.change(screen.getByLabelText('Origin ICAO'), { target: { value: 'EHAM' } });
    fireEvent.change(screen.getByLabelText('Destination ICAO'), { target: { value: 'LEBL' } });
    fireEvent.click(screen.getByRole('button', { name: /^open$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Choose which world/i);
  });

  it('will not submit a code that is not four letters', async () => {
    stub();
    render(<NetworkPage />);
    await screen.findByText('EHAM → LEBL');

    fireEvent.change(screen.getByLabelText('Origin ICAO'), { target: { value: 'EH' } });
    expect(screen.getByRole('button', { name: /^open$/i })).toBeDisabled();
  });

  it('closes a route from the header after a confirm, and the workspace empties', async () => {
    const calls = stub();
    render(<NetworkPage />);
    await screen.findByText('EHAM → LEBL');

    // First press asks to confirm rather than closing straight away.
    fireEvent.click(screen.getByRole('button', { name: 'Close route' }));
    expect(await screen.findByText('Close this route?')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close route' }));

    await waitFor(() => {
      expect(calls).toContain('DELETE /api/routes/route-1');
    });
    await screen.findByText('No routes yet');
  });
});

describe('the waterfall — “why am I losing?” (M3-10, App. A.9)', () => {
  it('is one click from the pricing tab, not behind a page', async () => {
    stubWaterfall();
    render(<NetworkPage />);
    await openPricing();
    await vi.advanceTimersByTimeAsync(500);

    const toggle = await screen.findByRole('button', { name: /why am i losing/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(toggle);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /why am i losing/i })).toHaveAttribute(
        'aria-expanded',
        'true',
      );
    });
  });

  it('draws A.9’s published factors — the acceptance criterion', async () => {
    stubWaterfall();
    await openWaterfall();

    await waitFor(() => {
      expect(screen.getByText(/-0\.770/)).toBeInTheDocument();
    });
    expect(screen.getByText(/-0\.460/)).toBeInTheDocument();
    expect(screen.getByText(/0\.192/)).toBeInTheDocument();
    expect(screen.getByText(/0\.050/)).toBeInTheDocument();
  });

  it('shows the net and the two shares it produces', async () => {
    stubWaterfall();
    await openWaterfall();

    await waitFor(() => {
      expect(screen.getByText('-0.988')).toBeInTheDocument();
    });
    expect(screen.getByText('24.3%')).toBeInTheDocument();
    expect(screen.getByText('65.4%')).toBeInTheDocument();
  });

  it('shows all three segments, because the answer differs between them', async () => {
    stubWaterfall();
    await openWaterfall();

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Leisure' })).toBeInTheDocument();
    });
    expect(screen.getByRole('heading', { name: 'Business' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'VFR' })).toBeInTheDocument();
  });

  it('marks the sign with a glyph as well as a colour', async () => {
    stubWaterfall();
    await openWaterfall();

    await waitFor(() => {
      expect(screen.getByText(/▼ -0\.770/)).toBeInTheDocument();
    });
    expect(screen.getByText(/▲ 0\.192/)).toBeInTheDocument();
  });

  it('names every factor the model can produce, never a raw key', async () => {
    stubWaterfall({
      ...WATERFALL,
      bySegment: [
        {
          segment: 'leisure',
          factors: [
            { factor: 'schedule', delta: -0.24 },
            { factor: 'connectionPenalty', delta: -0.5 },
            { factor: 'loyalty', delta: 0.11 },
            { factor: 'alliance', delta: 0.07 },
          ],
          netDelta: -0.56,
          shareRatio: 0.571,
          yourShare: 0.2,
          theirShare: 0.35,
        },
      ],
    });
    await openWaterfall();

    await waitFor(() => {
      expect(screen.getByText('Schedule fit')).toBeInTheDocument();
    });
    expect(screen.getByText('Connection')).toBeInTheDocument();
    expect(screen.getByText('Loyalty')).toBeInTheDocument();
    expect(screen.getByText('Alliance')).toBeInTheDocument();
    expect(screen.queryByText('connectionPenalty')).toBeNull();
  });

  it('says you have the route to yourself rather than drawing an empty chart', async () => {
    stubWaterfall({ ok: false, kind: 'no-rival', rivals: [] }, 422);
    await openWaterfall();

    expect(await screen.findByText(/route to yourself/i)).toBeInTheDocument();
  });

  it('keeps the cabin picker when a cabin is not contested', async () => {
    stubWaterfall(
      {
        ok: false,
        kind: 'cabin-not-contested',
        cabin: 'economy',
        rivals: [{ id: 'a', cabins: ['business'] }],
      },
      422,
    );
    await openWaterfall();

    expect(await screen.findByText(/Nobody else sells economy/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Cabin')).toBeInTheDocument();
  });

  it('lets the player choose which rival, and asks the server again', async () => {
    const { calls, answered } = stubWaterfall();
    await openWaterfall();

    const picker = await screen.findByLabelText('Compare against');
    const before = answered();
    fireEvent.change(picker, { target: { value: 'b' } });

    await waitFor(() => {
      expect(answered()).toBeGreaterThan(before);
    });
    expect(calls.some((c) => c.includes('rival=b'))).toBe(true);
  });

  it('asks the server for the decomposition rather than working it out', async () => {
    const { calls } = stubWaterfall();
    await openWaterfall();

    await waitFor(() => {
      expect(calls.some((c) => c.startsWith('GET /api/routes/route-1/waterfall'))).toBe(true);
    });
    expect(calls.some((c) => c.includes('cabin=economy'))).toBe(true);
  });
});
