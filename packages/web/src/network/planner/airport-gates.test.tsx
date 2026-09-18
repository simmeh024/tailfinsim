import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AirportGatesResponse, AirportStand, StandKind } from '@tailfin/shared';

import { AirportGatesView } from './AirportGatesView';

/**
 * The Gates view, wired to `/api/airports/:icao/gates` (M7-06, App. B.6).
 *
 * The page computes nothing. These prove it shows the server's apron, leases a
 * stand and reflects the fresh picture the server returns, reports App. B.6's
 * per-gate utilisation, and — the two that matter most — makes an exclusive
 * lease visibly somebody else's rather than merely unavailable, and tells a world
 * with no flights apart from an airline that needs no gates.
 */

function stand(overrides: Partial<AirportStand> = {}): AirportStand {
  return {
    position: 'A1',
    kind: 'contact_gate',
    holders: [],
    yourContract: null,
    exclusivelyHeld: false,
    available: true,
    utilisation: null,
    annualFeeMinor: { common_use: 0, preferential: 21_600_000, exclusive: 54_000_000 },
    commonUseTurnFeeMinor: 25_200,
    ...overrides,
  };
}

function airport(overrides: Partial<AirportGatesResponse> = {}): AirportGatesResponse {
  return {
    icao: 'EHAM',
    name: 'Schiphol',
    tier: 'flagship',
    stands: [stand(), stand({ position: 'A2' })],
    requirement: {
      contactGates: 1,
      contactGatesHeld: 0,
      overnightPositions: 1,
      overnightPositionsHeld: 0,
      percentileConcurrency: 1,
      peakConcurrency: 1,
      turns: 3,
      sampledGameDate: '1970-01-02T00:00:00.000Z',
    },
    monthlyFeeMinor: 0,
    leaseBreakevenTurnsPerMonth: 71.43,
    ...overrides,
  };
}

function stub(routes: (url: string, method: string) => { status: number; body: unknown }): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: { method?: string }) => {
      const { status, body } = routes(String(input), init?.method ?? 'GET');
      return Promise.resolve({ status, json: () => Promise.resolve(body) });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AirportGatesView', () => {
  it('asks for a route first when the airline flies nowhere', () => {
    stub(() => ({ status: 404, body: {} }));
    render(<AirportGatesView airports={[]} />);
    expect(screen.getByText(/Open a route first/)).toBeInTheDocument();
  });

  it('shows the apron and what the schedule needs against what is held', async () => {
    stub(() => ({ status: 200, body: airport() }));
    render(<AirportGatesView airports={['EHAM']} />);

    expect(await screen.findByText(/Schiphol \(EHAM\)/)).toBeInTheDocument();
    expect(screen.getByText('A1')).toBeInTheDocument();
    expect(screen.getByText('Contact gates needed')).toBeInTheDocument();
    // §14 decision support: the crossover, so "you use it 12% of the time" is
    // actionable rather than merely true.
    expect(screen.getByText(/72 turns a month/)).toBeInTheDocument();
  });

  it("reports App. B.6's per-gate utilisation, and flags an idle one", async () => {
    stub(() => ({
      status: 200,
      body: airport({
        stands: [
          stand({
            position: 'A1',
            yourContract: 'preferential',
            holders: [
              {
                airlineId: 'a',
                name: 'You Air',
                iataCode: 'YA',
                contract: 'preferential',
                isYou: true,
              },
            ],
            utilisation: { turns: 3, occupiedMinutes: 120, fraction: 0.12, belowFloor: false },
          }),
          stand({
            position: 'A2',
            yourContract: 'preferential',
            holders: [
              {
                airlineId: 'a',
                name: 'You Air',
                iataCode: 'YA',
                contract: 'preferential',
                isYou: true,
              },
            ],
            utilisation: { turns: 0, occupiedMinutes: 0, fraction: 0, belowFloor: true },
          }),
        ],
      }),
    }));
    render(<AirportGatesView airports={['EHAM']} />);

    // The worked example's own figure: 3 turns, 2.0 h of 17 h.
    expect(await screen.findByText('12%')).toBeInTheDocument();
    // And the one to give back, named rather than left to arithmetic.
    expect(screen.getByText('Idle')).toBeInTheDocument();
  });

  it("makes a rival's exclusive lease visible, not merely unavailable", async () => {
    // App. B.7: "you can see exactly who holds what". A denial nobody can
    // attribute reads like a bug.
    stub(() => ({
      status: 200,
      body: airport({
        stands: [
          stand({
            position: 'A1',
            exclusivelyHeld: true,
            available: false,
            holders: [
              {
                airlineId: 'b',
                name: 'Rival Air',
                iataCode: 'RV',
                contract: 'exclusive',
                isYou: false,
              },
            ],
          }),
        ],
      }),
    }));
    render(<AirportGatesView airports={['EHAM']} />);

    expect(await screen.findByText(/RV \(exclusive\)/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Lease' })).toBeDisabled();
  });

  it('leases a stand and shows the server’s fresh picture', async () => {
    const leased = airport({
      stands: [
        stand({
          position: 'A1',
          yourContract: 'preferential',
          holders: [
            {
              airlineId: 'a',
              name: 'You Air',
              iataCode: 'YA',
              contract: 'preferential',
              isYou: true,
            },
          ],
          utilisation: { turns: 3, occupiedMinutes: 120, fraction: 0.12, belowFloor: false },
        }),
      ],
      monthlyFeeMinor: 1_800_000,
    });
    const seen: { url: string; method: string }[] = [];
    stub((url, method) => {
      seen.push({ url, method });
      return { status: 200, body: method === 'POST' ? leased : airport() };
    });

    render(<AirportGatesView airports={['EHAM']} />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Lease' }))[0]!);

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: 'Release' }).length).toBeGreaterThan(0);
    });
    expect(seen.some((call) => call.method === 'POST')).toBe(true);
  });

  it('puts a refusal on screen rather than throwing it away', async () => {
    stub((_url, method) =>
      method === 'POST'
        ? { status: 409, body: { message: 'Another airline holds this stand exclusively' } }
        : { status: 200, body: airport() },
    );
    render(<AirportGatesView airports={['EHAM']} />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Lease' }))[0]!);

    expect(await screen.findByRole('alert')).toHaveTextContent(/holds this stand exclusively/);
  });

  it('says nothing is scheduled rather than that no gates are needed', async () => {
    // The missing-worker reading. "You need no gates" and "nothing has been
    // scheduled yet" are different statements and this must make the second one.
    stub(() => ({
      status: 200,
      body: airport({
        requirement: {
          contactGates: 0,
          contactGatesHeld: 0,
          overnightPositions: 0,
          overnightPositionsHeld: 0,
          percentileConcurrency: 0,
          peakConcurrency: 0,
          turns: 0,
          sampledGameDate: null,
        },
      }),
    }));
    render(<AirportGatesView airports={['EHAM']} />);

    expect(await screen.findByText(/Nothing is scheduled through here/)).toBeInTheDocument();
    expect(screen.queryByText('Contact gates needed')).not.toBeInTheDocument();
  });

  it('filters the apron by stand type, because a flagship is a long list', async () => {
    const kinds: StandKind[] = ['contact_gate', 'remote_stand'];
    stub(() => ({
      status: 200,
      body: airport({
        stands: kinds.map((kind, index) =>
          stand({ position: kind === 'contact_gate' ? 'A1' : 'R1', kind, ...(index ? {} : {}) }),
        ),
      }),
    }));
    render(<AirportGatesView airports={['EHAM']} />);

    expect(await screen.findByText('A1')).toBeInTheDocument();
    expect(screen.queryByText('R1')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Stand type'), { target: { value: 'remote_stand' } });
    await waitFor(() => {
      expect(screen.getByText('R1')).toBeInTheDocument();
    });
    expect(screen.queryByText('A1')).not.toBeInTheDocument();
  });

  it('says so when the airport cannot be loaded', async () => {
    stub(() => ({ status: 500, body: {} }));
    render(<AirportGatesView airports={['EHAM']} />);
    expect(await screen.findByText(/Could not load this airport’s stands/)).toBeInTheDocument();
  });
});
