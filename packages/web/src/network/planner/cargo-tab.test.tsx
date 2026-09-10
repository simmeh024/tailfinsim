import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RouteCargoResponse } from '@tailfin/shared';

import { CargoTab } from './CargoTab';

/**
 * The Cargo tab (M8-15, §12.1, §12.2).
 *
 * The page computes nothing — invariant 1 makes the server authoritative and
 * `packages/web` may not import `@tailfin/sim` at all — so these prove it *shows*
 * what the server returned. Two claims in particular, because both are §12's own
 * and both would be easy to lose in a redesign:
 *
 *  - the **binding constraint** is named, not just the resulting tonnage;
 *  - **both legs' rates** are on screen, so a player cannot read the headhaul and
 *    assume the way home pays the same.
 */

function stubFetch(byUrl: Record<string, unknown>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      const url = String(input);
      for (const [suffix, body] of Object.entries(byUrl)) {
        if (url.endsWith(suffix)) {
          return Promise.resolve({ status: 200, json: () => Promise.resolve(body) });
        }
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A full narrowbody on a long sector: §12.1's "almost no belly capacity". */
const laden: RouteCargoResponse = {
  routeId: 'route-1',
  originIcao: 'QRAA',
  destinationIcao: 'QRAB',
  distanceNm: 2_400,
  direction: 'headhaul',
  imbalance: 1.9,
  ratePerTonneMinor: 69_100,
  reverseRatePerTonneMinor: 48_600,
  offeredTonnes: 12.4,
  reverseOfferedTonnes: 9.1,
  laneDetail: 'Headhaul — 1.9× more trade moves this way than back. Price the round trip.',
  belly: {
    airframeId: '00000000-0000-4000-8000-00000000a001',
    typeDesignation: 'A320neo',
    registration: 'PH-TFA',
    cargoVolumeFactor: 0.62,
    plannedPassengers: 180,
    fuelTonnes: 12.4,
    availableTonnes: 2,
    limit: 'structural',
    allowances: { weight: 4.5, structural: 2, volume: 2.7 },
    volume: { holdM3: 48, usableM3: 29.8, baggageM3: 22.2, freightM3: 7.6 },
    detail:
      '180 passengers and their bags leave 2.0 t of belly capacity, limited by the structural payload limit.',
    carriedTonnes: 2,
    revenueMinor: 138_200,
    reverseRevenueMinor: 97_200,
  },
};

describe('CargoTab', () => {
  it('names the binding constraint rather than only the tonnage (§12.1)', async () => {
    stubFetch({ '/api/routes/route-1/cargo': laden });
    render(<CargoTab routeId="route-1" />);

    await waitFor(() => {
      expect(screen.getByText('Belly capacity')).toBeTruthy();
    });

    // The constraint is the decision. "2.0 t" on its own — which appears three
    // times on this panel, as the capacity, the tonnage carried and the
    // structural allowance — would leave a player unable to act on it.
    expect(screen.getByText('Binding')).toBeTruthy();
    expect(screen.getByText('Structural payload')).toBeTruthy();
    expect(screen.getByText('limited by structural payload')).toBeTruthy();
    // And all three limits, so the gap to the runner-up is visible.
    expect(screen.getByText('Takeoff weight')).toBeTruthy();
    expect(screen.getByText('Hold volume')).toBeTruthy();
  });

  it('shows both legs, so the round trip is priced (§12.2)', async () => {
    stubFetch({ '/api/routes/route-1/cargo': laden });
    render(<CargoTab routeId="route-1" />);

    await waitFor(() => {
      expect(screen.getByText('Headhaul')).toBeTruthy();
    });

    expect(screen.getByText('This leg')).toBeTruthy();
    expect(screen.getByText('Flying back')).toBeTruthy();
    expect(screen.getByText('1.9× imbalance')).toBeTruthy();
    expect(screen.getByText(/Price the round trip/)).toBeTruthy();
  });

  it('says a belly tank gave hold space up for range', async () => {
    stubFetch({ '/api/routes/route-1/cargo': laden });
    render(<CargoTab routeId="route-1" />);

    await waitFor(() => {
      expect(screen.getByText(/62% of standard/)).toBeTruthy();
    });
    // The bags are in the hold, and saying so is what makes §12.1's "direct
    // competition with your own passengers" legible.
    expect(screen.getByText(/passenger baggage/)).toBeTruthy();
  });

  it('reads a fleetless airline as an empty state, not a broken one', async () => {
    stubFetch({ '/api/routes/route-1/cargo': { ...laden, belly: null } });
    render(<CargoTab routeId="route-1" />);

    await waitFor(() => {
      expect(screen.getByText(/no aircraft in service to measure/)).toBeTruthy();
    });
    // The lane still answers: it is a fact about the market, not about the fleet.
    expect(screen.getByText('Freight offered')).toBeTruthy();
  });

  it('reads a balanced lane as balanced rather than as a direction', async () => {
    stubFetch({
      '/api/routes/route-1/cargo': {
        ...laden,
        direction: 'balanced',
        imbalance: 1,
        reverseRatePerTonneMinor: laden.ratePerTonneMinor,
        laneDetail: 'Trade runs about evenly both ways on this lane.',
      },
    });
    render(<CargoTab routeId="route-1" />);

    await waitFor(() => {
      expect(screen.getByText('Balanced')).toBeTruthy();
    });
    expect(screen.getByText('Even both ways')).toBeTruthy();
  });

  it('says so when the figures cannot be loaded', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline'))),
    );
    render(<CargoTab routeId="route-1" />);

    await waitFor(() => {
      expect(screen.getByText(/Could not load this route’s cargo figures/)).toBeTruthy();
    });
  });
});
