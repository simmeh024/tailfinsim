import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AirportSlotsResponse } from '@tailfin/shared';

import { AirportSlotsView } from './AirportSlotsView';

/**
 * The Slots view, wired to `/api/airports/:icao/slots` (M7-05).
 *
 * The page computes nothing — these prove it shows the server's bands, claims a
 * band and reflects the fresh picture the server returns, and reads an
 * uncoordinated airport (and no routes) as their own honest states.
 */

function coordinated(overrides: Partial<AirportSlotsResponse> = {}): AirportSlotsResponse {
  return {
    icao: 'EHAM',
    name: 'Schiphol',
    coordinated: true,
    slotLevel: 3,
    bands: Array.from({ length: 24 }, (_, band) => ({
      band,
      capacity: 5,
      released: 5,
      shape: 'shoulder' as const,
      held: 0,
      heldByYou: false,
      available: 5,
      holders: [],
    })),
    releases: {
      worldAgeGameDays: 120,
      releasedFraction: 1,
      nextWaveAtGameDay: null,
      nextWaveFraction: null,
      nextWaveInGameDays: null,
    },
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

describe('AirportSlotsView', () => {
  it('asks for a route first when the airline flies nowhere', () => {
    stub(() => ({ status: 404, body: {} }));
    render(<AirportSlotsView airports={[]} />);
    expect(screen.getByText(/Open a route first/)).toBeInTheDocument();
  });

  it('reads an uncoordinated airport as free', async () => {
    stub((url) => {
      if (url.endsWith('/api/airports/EGSS/slots')) {
        return {
          status: 200,
          body: {
            icao: 'EGSS',
            name: 'Stansted',
            coordinated: false,
            slotLevel: 1,
            bands: [],
            releases: null,
          },
        };
      }
      return { status: 404, body: {} };
    });
    render(<AirportSlotsView airports={['EGSS']} />);
    await waitFor(() => expect(screen.getByText(/not slot-coordinated/)).toBeInTheDocument());
  });

  it('shows the bands and claims one, reflecting the server’s fresh picture', async () => {
    // After a claim, band 0 comes back held by you.
    const afterClaim = coordinated({
      bands: coordinated().bands.map((b) =>
        b.band === 0 ? { ...b, held: 1, heldByYou: true, available: 4 } : b,
      ),
    });
    stub((url, method) => {
      if (url.endsWith('/api/airports/EHAM/slots/0') && method === 'POST') {
        return { status: 200, body: afterClaim };
      }
      if (url.endsWith('/api/airports/EHAM/slots')) return { status: 200, body: coordinated() };
      return { status: 404, body: {} };
    });
    render(<AirportSlotsView airports={['EHAM']} />);

    await waitFor(() => expect(screen.getByText('00:00')).toBeInTheDocument());
    // 24 bands, none held yet.
    expect(screen.getAllByText('Claim').length).toBe(24);

    fireEvent.click(screen.getAllByText('Claim')[0]!);

    // The 00:00 band now reads as held and offers Release.
    await waitFor(() => expect(screen.getByText('Release')).toBeInTheDocument());
    expect(screen.getByText('Held')).toBeInTheDocument();
  });

  it('surfaces a refusal (a full band) without throwing', async () => {
    stub((url, method) => {
      if (url.endsWith('/api/airports/EHAM/slots/0') && method === 'POST') {
        return {
          status: 409,
          body: { code: 'band_full', message: 'Every slot in this band is taken' },
        };
      }
      if (url.endsWith('/api/airports/EHAM/slots')) return { status: 200, body: coordinated() };
      return { status: 404, body: {} };
    });
    render(<AirportSlotsView airports={['EHAM']} />);

    await waitFor(() => expect(screen.getByText('00:00')).toBeInTheDocument());
    fireEvent.click(screen.getAllByText('Claim')[0]!);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Every slot in this band is taken/);
  });

  it('tells a newcomer the board is not carved up, and when the next wave lands', async () => {
    // §21's land grab is only answered if waiting is visibly not futile. A wave
    // nobody can see is indistinguishable from a permanently full airport.
    stub((url) => {
      if (url.endsWith('/api/airports/EHAM/slots')) {
        return {
          status: 200,
          body: coordinated({
            releases: {
              worldAgeGameDays: 18,
              releasedFraction: 0.5,
              nextWaveAtGameDay: 30,
              nextWaveFraction: 0.75,
              nextWaveInGameDays: 12,
            },
          }),
        };
      }
      return { status: 404, body: {} };
    });
    render(<AirportSlotsView airports={['EHAM']} />);

    await waitFor(() => expect(screen.getByText('00:00')).toBeInTheDocument());
    expect(screen.getByText(/50% of this airport’s slots are released/)).toBeInTheDocument();
    expect(screen.getByText(/game day 30/)).toBeInTheDocument();
    expect(screen.getByText(/12 game days away/)).toBeInTheDocument();
  });

  it('distinguishes a band that is taken from one the wave has not opened', async () => {
    // Two different refusals that must not read the same: somebody else's slot,
    // versus capacity that does not exist yet.
    stub((url) => {
      if (url.endsWith('/api/airports/EHAM/slots')) {
        const base = coordinated();
        const bands = base.bands.map((band) =>
          band.band === 0
            ? // Fully released and fully taken — gone.
              { ...band, capacity: 5, released: 5, held: 5, available: 0 }
            : band.band === 1
              ? // Only part released, and that part is taken — not yet.
                { ...band, capacity: 5, released: 2, held: 2, available: 0 }
              : band,
        );
        return { status: 200, body: { ...base, bands } };
      }
      return { status: 404, body: {} };
    });
    render(<AirportSlotsView airports={['EHAM']} />);

    await waitFor(() => expect(screen.getByText('00:00')).toBeInTheDocument());
    expect(screen.getByText('Full')).toBeInTheDocument();
    expect(screen.getByText('Not yet')).toBeInTheDocument();
  });

  it('names the airlines holding a band, and marks which one is you', async () => {
    // M7-05's third acceptance criterion: holdings visible per airport for all
    // airlines, not a bare count.
    stub((url) => {
      if (url.endsWith('/api/airports/EHAM/slots')) {
        const base = coordinated();
        const bands = base.bands.map((band) =>
          band.band === 0
            ? {
                ...band,
                held: 2,
                heldByYou: true,
                available: 3,
                holders: [
                  {
                    airlineId: '00000000-0000-4000-8000-000000000001',
                    name: 'Your Airline',
                    iataCode: 'YA',
                    isYou: true,
                  },
                  {
                    airlineId: '00000000-0000-4000-8000-000000000002',
                    name: 'Rival Air',
                    iataCode: 'RV',
                    isYou: false,
                  },
                ],
              }
            : band,
        );
        return { status: 200, body: { ...base, bands } };
      }
      return { status: 404, body: {} };
    });
    render(<AirportSlotsView airports={['EHAM']} />);

    await waitFor(() => expect(screen.getByText('00:00')).toBeInTheDocument());
    // The rival is named by its code; you are named as "You" rather than by yours.
    expect(screen.getByText(/You, RV/)).toBeInTheDocument();
  });

  it('labels how contested each hour is, so an empty band is explicable', async () => {
    stub((url) => {
      if (url.endsWith('/api/airports/EHAM/slots')) {
        const base = coordinated();
        const bands = base.bands.map((band) => ({
          ...band,
          shape:
            band.band === 8
              ? ('peak' as const)
              : band.band === 3
                ? ('off_peak' as const)
                : ('shoulder' as const),
        }));
        return { status: 200, body: { ...base, bands } };
      }
      return { status: 404, body: {} };
    });
    render(<AirportSlotsView airports={['EHAM']} />);

    await waitFor(() => expect(screen.getByText('00:00')).toBeInTheDocument());
    expect(screen.getByText('Peak')).toBeInTheDocument();
    expect(screen.getByText('Off-peak')).toBeInTheDocument();
  });
});
