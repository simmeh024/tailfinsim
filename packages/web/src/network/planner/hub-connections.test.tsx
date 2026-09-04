import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HubConnectionsResponse } from '@tailfin/shared';

import { HubConnectionsView } from './HubConnectionsView';

/**
 * The Connections view, wired to `GET /api/network/connections` (§7.4).
 *
 * The page computes nothing — these prove it shows the server's counts and banks,
 * flags a dead-end arrival, and reads an unscheduled hub as its own honest state
 * rather than an error.
 */

function stubFetch(body: unknown, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      const url = String(input);
      if (url.endsWith('/api/network/connections')) {
        return Promise.resolve({ status, json: () => Promise.resolve(body) });
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const POPULATED: HubConnectionsResponse = {
  hubIcao: 'EHAM',
  minConnectMinutes: 30,
  maxConnectMinutes: 120,
  horizonDays: 3,
  inboundFlights: 2,
  outboundFlights: 3,
  feasibleConnections: 3,
  connectingInbound: 2,
  connectingOutbound: 2,
  deadEndArrivalCount: 1,
  unfedDepartureCount: 1,
  deadEndArrivals: [{ flightId: 'f-dead', spokeIcao: 'BIKF', atUtc: '2024-10-21T08:00:00.000Z' }],
  unfedDepartures: [{ flightId: 'f-unfed', spokeIcao: 'LEBL', atUtc: '2024-10-21T18:00:00.000Z' }],
  banks: [
    {
      startUtc: '2024-10-21T08:00:00.000Z',
      endUtc: '2024-10-21T09:00:00.000Z',
      arrivals: 2,
      departures: 2,
      connections: 3,
    },
  ],
};

describe('HubConnectionsView', () => {
  it('shows the hub, the connect window and the server’s counts', async () => {
    stubFetch(POPULATED);
    render(<HubConnectionsView />);

    await waitFor(() => expect(screen.getByText(/Connections at EHAM/)).toBeInTheDocument());
    expect(screen.getByText(/30–120 min connect window/)).toBeInTheDocument();
    // The feasible-connection headline and its bank appear.
    expect(screen.getByText('Feasible connections')).toBeInTheDocument();
    expect(screen.getByText(/Arrivals that connect to nothing/)).toBeInTheDocument();
    expect(screen.getByText(/from BIKF/)).toBeInTheDocument();
    expect(screen.getByText(/to LEBL/)).toBeInTheDocument();
  });

  it('reads an unscheduled hub as empty, not broken', async () => {
    stubFetch({
      ...POPULATED,
      inboundFlights: 0,
      outboundFlights: 0,
      feasibleConnections: 0,
      connectingInbound: 0,
      connectingOutbound: 0,
      deadEndArrivalCount: 0,
      unfedDepartureCount: 0,
      deadEndArrivals: [],
      unfedDepartures: [],
      banks: [],
      horizonDays: 0,
    });
    render(<HubConnectionsView />);

    await waitFor(() =>
      expect(screen.getByText(/Nothing is scheduled through your hub yet/)).toBeInTheDocument(),
    );
  });

  it('surfaces a load failure as an alert', async () => {
    stubFetch({}, 500);
    render(<HubConnectionsView />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Could not load your hub connections/);
  });
});
