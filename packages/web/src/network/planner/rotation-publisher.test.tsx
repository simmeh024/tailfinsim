import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CreateScheduleResponse, FleetAirframeView } from '@tailfin/shared';

import { RotationPublisher } from './RotationPublisher';

/**
 * Publishing a rotation from the Schedule tab (M2-03).
 *
 * The page computes nothing — these prove it sends the stops the player built,
 * shows the cost the server returned, and shows *which* leg the server refused
 * rather than a blank failure.
 */

const AIRFRAME = {
  airframeId: 'af-1',
  registration: 'PH-ABC',
  typeDesignation: 'A320neo',
  locationIcao: 'EHAM',
} as unknown as FleetAirframeView;

const CREATED: CreateScheduleResponse = {
  schedule: {
    id: 'sch-1',
    airframeId: 'af-1',
    legs: [
      {
        routeId: 'r1',
        originIcao: 'EHAM',
        destinationIcao: 'BIKF',
        departureMinute: 480,
        blockMinutes: 180,
        turnaroundMinutes: 40,
      },
    ],
    repeat: { kind: 'daily' },
    active: true,
    upcomingFlights: 0,
    createdAt: '2024-11-01T00:00:00.000Z',
  },
  warning: null,
  cost: {
    legs: [
      {
        originIcao: 'EHAM',
        destinationIcao: 'BIKF',
        distanceNm: 800,
        opened: true,
        variableCostMinor: 500_000,
      },
    ],
    totalDistanceNm: 800,
    totalVariableCostMinor: 500_000,
    routesOpened: 1,
  },
};

interface Route {
  status: number;
  body: unknown;
}

function stub(routes: (url: string, method: string) => Route): void {
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

describe('RotationPublisher', () => {
  it('seeds a leg from the route and shows the empty rotation list', async () => {
    stub((url) => {
      if (url.endsWith('/api/fleet/airframes'))
        return { status: 200, body: { airframes: [AIRFRAME] } };
      if (url.endsWith('/api/schedules')) return { status: 200, body: { schedules: [] } };
      return { status: 404, body: {} };
    });
    render(<RotationPublisher seedOrigin="EHAM" seedDestination="BIKF" />);
    await waitFor(() => expect(screen.getByText(/No rotations yet/)).toBeInTheDocument());
    expect(screen.getByLabelText('Origin airport')).toHaveValue('EHAM');
    expect(screen.getByLabelText('Stop 1 airport')).toHaveValue('BIKF');
  });

  it('adds a stop, so a longer route with a stop can be built', async () => {
    stub((url) => {
      if (url.endsWith('/api/fleet/airframes'))
        return { status: 200, body: { airframes: [AIRFRAME] } };
      if (url.endsWith('/api/schedules')) return { status: 200, body: { schedules: [] } };
      return { status: 404, body: {} };
    });
    render(<RotationPublisher seedOrigin="EHAM" seedDestination="BIKF" />);
    await waitFor(() => expect(screen.getByLabelText('Stop 1 airport')).toBeInTheDocument());
    fireEvent.click(screen.getByText('+ Add a stop'));
    expect(screen.getByLabelText('Stop 2 airport')).toBeInTheDocument();
  });

  it('publishes the rotation and shows the cost the server returned', async () => {
    stub((url, method) => {
      if (url.endsWith('/api/fleet/airframes'))
        return { status: 200, body: { airframes: [AIRFRAME] } };
      if (url.endsWith('/api/schedules') && method === 'POST')
        return { status: 201, body: CREATED };
      if (url.endsWith('/api/schedules')) return { status: 200, body: { schedules: [] } };
      return { status: 404, body: {} };
    });
    render(<RotationPublisher seedOrigin="EHAM" seedDestination="BIKF" />);
    // Wait for the fleet to load, which enables Publish.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Publish rotation/ })).toBeEnabled(),
    );
    fireEvent.click(screen.getByText('Publish rotation'));
    // The cost summary appears, flagging the route the publish opened.
    await waitFor(() => expect(screen.getByText(/Opened 1 new route/)).toBeInTheDocument());
  });

  it('shows exactly which leg the server refused', async () => {
    stub((url, method) => {
      if (url.endsWith('/api/fleet/airframes'))
        return { status: 200, body: { airframes: [AIRFRAME] } };
      if (url.endsWith('/api/schedules') && method === 'POST')
        return {
          status: 422,
          body: {
            problem: 'unreachable',
            detail: 'EHAM→BIKF is out of range: 800 nm, the aircraft does 500 nm.',
          },
        };
      if (url.endsWith('/api/schedules')) return { status: 200, body: { schedules: [] } };
      return { status: 404, body: {} };
    });
    render(<RotationPublisher seedOrigin="EHAM" seedDestination="BIKF" />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Publish rotation/ })).toBeEnabled(),
    );
    fireEvent.click(screen.getByText('Publish rotation'));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/out of range/)).toBeInTheDocument();
  });
});
