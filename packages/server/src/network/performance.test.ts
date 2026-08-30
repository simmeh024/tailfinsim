import { describe, expect, it } from 'vitest';

import { summarisePerformance, type SettledFlight } from './performance';

/**
 * Rolling settled flights up into a route's performance (M2-06, §14.4).
 *
 * The arithmetic half of the endpoint, proved without a database: load factor,
 * RASK/CASK, on-time share and the weekly trend, from a fixed set of flights.
 */
describe('summarisePerformance', () => {
  const DAY = 86_400_000;
  const gameNow = new Date('2024-11-01T00:00:00.000Z');
  const nm = 500; // 500 nm → 926 km stage.

  function flight(overrides: Partial<SettledFlight> = {}): SettledFlight {
    return {
      revenueMinor: 100_000,
      costMinor: 70_000,
      netMinor: 30_000,
      seats: 180,
      passengers: 150,
      spilledPassengers: 0,
      blockSeconds: 3_600,
      arrivalDelayMinutes: 0,
      settledAt: new Date(gameNow.getTime() - DAY),
      ...overrides,
    };
  }

  it('reports zeros and an empty-but-full trend for a route that has flown nothing', () => {
    const p = summarisePerformance('r1', [], nm, gameNow);
    expect(p.flights).toBe(0);
    expect(p.loadFactor).toBeNull();
    expect(p.raskMinor).toBeNull();
    expect(p.caskMinor).toBeNull();
    expect(p.onTimePct).toBeNull();
    expect(p.avgArrivalDelayMinutes).toBeNull();
    expect(p.trend).toHaveLength(12);
    expect(p.trend.every((w) => w.flights === 0 && w.loadFactor === null)).toBe(true);
  });

  it('sums money and traffic, and derives load factor from the totals', () => {
    const p = summarisePerformance('r1', [flight(), flight()], nm, gameNow);
    expect(p.flights).toBe(2);
    expect(p.seats).toBe(360);
    expect(p.passengers).toBe(300);
    expect(p.revenueMinor).toBe(200_000);
    expect(p.costMinor).toBe(140_000);
    expect(p.netMinor).toBe(60_000);
    expect(p.loadFactor).toBeCloseTo(300 / 360, 10);
    expect(p.blockHours).toBeCloseTo(2, 10);
  });

  it('computes RASK and CASK per available seat-kilometre', () => {
    const p = summarisePerformance('r1', [flight()], nm, gameNow);
    const askKm = 180 * 500 * 1.852; // seats × stage km
    expect(p.raskMinor).toBeCloseTo(100_000 / askKm, 8);
    expect(p.caskMinor).toBeCloseTo(70_000 / askKm, 8);
  });

  it('counts an arrival within 15 minutes as on time, and averages the delay', () => {
    const rows = [
      flight({ arrivalDelayMinutes: 0 }),
      flight({ arrivalDelayMinutes: 15 }), // exactly on the bar — still on time
      flight({ arrivalDelayMinutes: 40 }), // late
      flight({ arrivalDelayMinutes: -5 }), // early — on time
    ];
    const p = summarisePerformance('r1', rows, nm, gameNow);
    expect(p.onTimePct).toBeCloseTo(3 / 4, 10);
    expect(p.avgArrivalDelayMinutes).toBeCloseTo((0 + 15 + 40 - 5) / 4, 10);
  });

  it('buckets the trend into whole weeks back from now, oldest first', () => {
    const rows = [
      flight({ settledAt: new Date(gameNow.getTime() - DAY), passengers: 90, seats: 180 }), // this week
      flight({ settledAt: new Date(gameNow.getTime() - 8 * DAY), passengers: 180, seats: 180 }), // last week
    ];
    const p = summarisePerformance('r1', rows, nm, gameNow);
    // Oldest-first: the last bucket is the current week.
    expect(p.trend[11]?.flights).toBe(1);
    expect(p.trend[11]?.loadFactor).toBeCloseTo(0.5, 10);
    expect(p.trend[10]?.flights).toBe(1);
    expect(p.trend[10]?.loadFactor).toBeCloseTo(1, 10);
    // Weeks before those flew nothing.
    expect(p.trend[9]?.flights).toBe(0);
    expect(p.trend[9]?.loadFactor).toBeNull();
  });

  it('ignores a flight older than the twelve-week window', () => {
    const p = summarisePerformance(
      'r1',
      [flight({ settledAt: new Date(gameNow.getTime() - 90 * DAY) })],
      nm,
      gameNow,
    );
    // It is in `rows`, so the totals see it, but no trend bucket holds it.
    expect(p.trend.every((w) => w.flights === 0)).toBe(true);
  });
});
