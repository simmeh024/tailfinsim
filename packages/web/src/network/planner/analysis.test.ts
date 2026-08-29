import { describe, expect, it } from 'vitest';

import { liveEconomics, rankedSlots, scheduleIssues, utilisationByAircraft } from './analysis';

import type { PlannedFlight, PlannerAircraft, RoutePlan, Timeslot } from './types';
import type { RouteSummary } from '../api';

const route: RouteSummary = {
  id: 'r1',
  originIcao: 'EHAM',
  destinationIcao: 'LEBL',
  greatCircleNm: 700,
  fares: { economy: 12_000 },
  active: true,
};

const slots: Timeslot[] = [
  { hour: 7, quality: 'peak', availability: 'available', costMinor: 180_000 },
  { hour: 8, quality: 'peak', availability: 'full', costMinor: 200_000 },
  { hour: 13, quality: 'shoulder', availability: 'available', costMinor: 90_000 },
  { hour: 22, quality: 'offpeak', availability: 'available', costMinor: 30_000 },
];

function plan(flights: PlannedFlight[]): RoutePlan {
  return {
    route,
    frequency: { kind: 'daily' },
    flights,
    slots,
    competitors: [],
    demand: { business: 40, leisure: 120, vfr: 30 },
    economics: {
      weeklyFrequency: 0,
      loadFactor: 0,
      raskMinor: 10,
      caskMinor: 7,
      weeklyRevenueMinor: 0,
      weeklyCostMinor: 0,
      utilisationHoursPerDay: 0,
    },
    loadTrend: [0.6, 0.7],
  };
}

const aircraft: PlannerAircraft[] = [
  {
    id: 'ac1',
    registration: 'TF-1',
    typeDesignation: 'AT76',
    aircraftClass: 'regional',
    utilisationHoursPerDay: 0,
    isPool: false,
  },
  {
    id: 'pool',
    registration: 'Fleet pool',
    typeDesignation: 'unassigned',
    aircraftClass: '',
    utilisationHoursPerDay: 0,
    isPool: true,
  },
];

function flight(
  over: Partial<PlannedFlight> & { id: string; departureMinute: number },
): PlannedFlight {
  return {
    aircraftId: 'ac1',
    routeId: 'r1',
    originIcao: 'EHAM',
    destinationIcao: 'LEBL',
    blockMinutes: 180,
    direction: 'out',
    frequency: { kind: 'daily' },
    ...over,
  };
}

describe('liveEconomics', () => {
  it('is a load factor in [0,1] that falls as capacity outstrips demand', () => {
    const light = liveEconomics(plan([]), [flight({ id: 'a', departureMinute: 420 })]);
    const heavy = liveEconomics(
      plan([]),
      Array.from({ length: 10 }, (_, i) =>
        flight({ id: `f${String(i)}`, departureMinute: 300 + i * 60 }),
      ),
    );
    expect(light.loadFactor).toBeGreaterThanOrEqual(0);
    expect(light.loadFactor).toBeLessThanOrEqual(1);
    // Ten daily departures oversupply a 190-pax/day market, so load drops.
    expect(heavy.loadFactor).toBeLessThan(light.loadFactor);
    expect(heavy.weeklyCostMinor).toBeGreaterThan(light.weeklyCostMinor);
  });

  it('reports no flying with no flights', () => {
    const e = liveEconomics(plan([]), []);
    expect(e.weeklyFrequency).toBe(0);
    expect(e.loadFactor).toBe(0);
  });
});

describe('scheduleIssues', () => {
  it('flags an overlap and a short turnaround on one aircraft', () => {
    const flights = [
      flight({ id: 'a', departureMinute: 420, blockMinutes: 120 }), // 07:00–09:00
      flight({ id: 'b', departureMinute: 500, blockMinutes: 120 }), // 08:20 — overlaps a, ends 10:20
      flight({ id: 'c', departureMinute: 640 }), // 10:40 — 20 min after b arrives, short turn (<25)
    ];
    const issues = scheduleIssues(flights, aircraft, slots);
    expect(issues.some((i) => i.flightId === 'b' && i.kind === 'overlap')).toBe(true);
    expect(issues.some((i) => i.flightId === 'c' && i.kind === 'turnaround')).toBe(true);
  });

  it('flags a departure in a full slot band', () => {
    const issues = scheduleIssues([flight({ id: 'a', departureMinute: 8 * 60 })], aircraft, slots);
    expect(issues.some((i) => i.kind === 'slot')).toBe(true);
  });
});

describe('rankedSlots', () => {
  it('excludes full and already-flown hours, best contribution first', () => {
    const ranked = rankedSlots(plan([]), [flight({ id: 'a', departureMinute: 13 * 60 })]);
    const hours = ranked.map((r) => r.slot.hour);
    expect(hours).not.toContain(8); // full
    expect(hours).not.toContain(13); // already flown
    // Sorted descending by contribution.
    for (let i = 1; i < ranked.length; i += 1) {
      expect(ranked[i - 1]!.contribution).toBeGreaterThanOrEqual(ranked[i]!.contribution);
    }
  });
});

describe('utilisationByAircraft', () => {
  it('sums block hours per aircraft', () => {
    const map = utilisationByAircraft([
      flight({ id: 'a', departureMinute: 420, blockMinutes: 120 }),
      flight({ id: 'b', departureMinute: 700, blockMinutes: 60 }),
    ]);
    expect(map.get('ac1')).toBeCloseTo(3, 5);
  });
});
