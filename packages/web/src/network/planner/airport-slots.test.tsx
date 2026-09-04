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
      held: 0,
      heldByYou: false,
      available: 5,
    })),
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
          body: { icao: 'EGSS', name: 'Stansted', coordinated: false, slotLevel: 1, bands: [] },
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
});
