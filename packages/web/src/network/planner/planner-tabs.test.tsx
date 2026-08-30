import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RouteCompetitionResponse, RoutePerformanceResponse } from '@tailfin/shared';

import { CompetitionTab } from './CompetitionTab';
import { PerformanceTab } from './PerformanceTab';

/**
 * The Performance and Competition tabs, wired to their real endpoints (M2-06,
 * M3-12). The page computes nothing — these prove it *shows* what the server
 * returned, and that a route with no flights and a market of one read as their
 * own honest states rather than as errors or zeros.
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

describe('PerformanceTab', () => {
  const flown: RoutePerformanceResponse = {
    routeId: 'route-1',
    windowDays: 84,
    flights: 40,
    seats: 7_200,
    passengers: 5_400,
    spilledPassengers: 0,
    loadFactor: 0.75,
    revenueMinor: 4_000_000,
    costMinor: 3_000_000,
    netMinor: 1_000_000,
    raskMinor: 0.62,
    caskMinor: 0.47,
    onTimePct: 0.9,
    avgArrivalDelayMinutes: 6,
    blockHours: 80,
    trend: Array.from({ length: 12 }, (_, i) => ({
      weekStart: new Date(Date.UTC(2024, 8, i + 1)).toISOString(),
      flights: 3,
      loadFactor: 0.7 + i * 0.005,
    })),
  };

  it('shows the rolled-up load factor and on-time from the server', async () => {
    stubFetch({ '/api/routes/route-1/performance': flown });
    render(<PerformanceTab routeId="route-1" />);
    await waitFor(() => expect(screen.getByText('75%')).toBeInTheDocument());
    // On-time tile.
    expect(screen.getByText('90%')).toBeInTheDocument();
    // RASK from the server, not computed here.
    expect(screen.getByText('0.62')).toBeInTheDocument();
  });

  it('reads a route that has flown nothing as idle, not broken', async () => {
    const empty: RoutePerformanceResponse = {
      ...flown,
      flights: 0,
      seats: 0,
      passengers: 0,
      loadFactor: null,
      revenueMinor: 0,
      costMinor: 0,
      netMinor: 0,
      raskMinor: null,
      caskMinor: null,
      onTimePct: null,
      avgArrivalDelayMinutes: null,
      blockHours: 0,
      trend: flown.trend.map((w) => ({ ...w, flights: 0, loadFactor: null })),
    };
    stubFetch({ '/api/routes/route-1/performance': empty });
    render(<PerformanceTab routeId="route-1" />);
    await waitFor(() => expect(screen.getByText(/hasn’t flown yet/)).toBeInTheDocument());
  });
});

describe('CompetitionTab', () => {
  const market: RouteCompetitionResponse = {
    routeId: 'route-1',
    marketDailyPassengers: 1_200,
    operators: [
      {
        airlineId: 'you',
        name: 'Your Airline',
        kind: 'player',
        isYou: true,
        weeklyFrequency: 28,
        economyFareMinor: 9_500,
        share: 0.4,
        productScore: 0.6,
      },
      {
        airlineId: 'lcc',
        name: 'Budget Air',
        kind: 'npc',
        isYou: false,
        weeklyFrequency: 35,
        economyFareMinor: 6_900,
        share: 0.35,
        productScore: 0.38,
      },
    ],
  };

  it('shows rivals and your own share from the shared model', async () => {
    stubFetch({ '/api/routes/route-1/competition': market });
    render(<CompetitionTab routeId="route-1" />);
    await waitFor(() => expect(screen.getByText('Budget Air')).toBeInTheDocument());
    // Your share segment.
    expect(screen.getByText(/You 40%/)).toBeInTheDocument();
    // The NPC rival is tagged.
    expect(screen.getByText('AI')).toBeInTheDocument();
  });

  it('reads a market of one as "you have the route to yourself"', async () => {
    stubFetch({
      '/api/routes/route-1/competition': {
        ...market,
        operators: [market.operators[0]],
      },
    });
    render(<CompetitionTab routeId="route-1" />);
    await waitFor(() => expect(screen.getByText(/have the route to yourself/)).toBeInTheDocument());
  });
});
