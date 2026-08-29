import type { FleetAirframeView } from '@tailfin/shared';

import type { RouteSummary } from '../api';
import type {
  Competitor,
  DemandBreakdown,
  Frequency,
  PlannedFlight,
  PlannerAircraft,
  RouteEconomics,
  RoutePlan,
  Timeslot,
} from './types';

/**
 * Deterministic mock data for the route planner.
 *
 * Everything the schedule, slot, competition and performance surfaces show is
 * generated here, seeded from the route id, so a route looks the same every render
 * and two routes look different. It stands in for the M2-03 schedule endpoints and
 * the competition/performance reads that do not exist yet; the shapes it returns
 * (`planner/types.ts`) mirror what those endpoints would send, so swapping this for
 * `fetch` later is a data-source change, not a component rewrite.
 */

function hash(id: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Cruise speed in knots by a coarse class hint — a stand-in for the real spec. */
function cruiseKt(aircraftClass: string): number {
  const lower = aircraftClass.toLowerCase();
  if (lower.includes('regional') || lower.includes('turboprop')) return 290;
  if (lower.includes('wide')) return 480;
  return 450;
}

/** Turnaround minutes by a coarse class hint. */
function turnaroundMinutes(aircraftClass: string): number {
  const lower = aircraftClass.toLowerCase();
  if (lower.includes('wide')) return 60;
  if (lower.includes('regional') || lower.includes('turboprop')) return 30;
  return 40;
}

/** Block time in minutes for a leg: air time from distance plus a fixed ground overhead. */
export function blockMinutes(distanceNm: number, aircraftClass: string): number {
  const airMinutes = (distanceNm / cruiseKt(aircraftClass)) * 60;
  return Math.round(airMinutes + 35);
}

/** The airline's aircraft as planner rows, plus the fleet-pool row at the end. */
export function plannerAircraft(airframes: readonly FleetAirframeView[]): PlannerAircraft[] {
  const rows: PlannerAircraft[] = airframes.map((frame) => ({
    id: frame.airframeId,
    registration: frame.registration,
    typeDesignation: frame.typeDesignation,
    aircraftClass: frame.aircraftClass,
    utilisationHoursPerDay: frame.utilisation?.blockHoursPerDay ?? 0,
    isPool: false,
  }));
  rows.push({
    id: 'pool',
    registration: 'Fleet pool',
    typeDesignation: 'unassigned',
    aircraftClass: '',
    utilisationHoursPerDay: 0,
    isPool: true,
  });
  return rows;
}

function slotsFor(seed: number): Timeslot[] {
  const rng = mulberry32(seed ^ 0x51075);
  const slots: Timeslot[] = [];
  for (let hour = 0; hour < 24; hour += 1) {
    // Peak in the morning and evening banks; cheap and empty overnight.
    const peak = (hour >= 6 && hour <= 9) || (hour >= 16 && hour <= 19);
    const shoulder = (hour >= 10 && hour <= 15) || hour === 20 || hour === 5;
    const quality = peak ? 'peak' : shoulder ? 'shoulder' : 'offpeak';
    const roll = rng();
    const availability = peak
      ? roll < 0.35
        ? 'full'
        : roll < 0.7
          ? 'limited'
          : 'available'
      : roll < 0.12
        ? 'limited'
        : 'available';
    const baseCost = peak ? 180_000 : shoulder ? 90_000 : 30_000;
    slots.push({
      hour,
      quality,
      availability,
      costMinor: baseCost + Math.round(rng() * 40_000),
    });
  }
  return slots;
}

/** One aircraft flying one or two round trips a day, laid on the 24-hour clock. */
function flightsFor(
  route: RouteSummary,
  aircraft: PlannerAircraft[],
  frequency: Frequency,
  seed: number,
): PlannedFlight[] {
  const rng = mulberry32(seed ^ 0xf11);
  const flyers = aircraft.filter((a) => !a.isPool);
  if (flyers.length === 0) return [];

  const flights: PlannedFlight[] = [];
  // Route the day's flying onto up to two aircraft, so a busy route shows more
  // than one row in use without pretending the whole fleet serves it.
  const used = flyers.slice(0, Math.min(2, flyers.length));
  used.forEach((frame, index) => {
    const block = blockMinutes(route.greatCircleNm, frame.aircraftClass);
    const turn = turnaroundMinutes(frame.aircraftClass);
    // First departure in the morning bank, staggered per aircraft.
    let depart = 6 * 60 + index * 90 + Math.floor(rng() * 40);
    let leg = 0;
    // Fill the day with out-and-back rotations until the clock runs out.
    while (depart + block * 2 + turn < 23 * 60) {
      flights.push({
        id: `${route.id}:${frame.id}:${String(leg)}:out`,
        aircraftId: frame.id,
        routeId: route.id,
        originIcao: route.originIcao,
        destinationIcao: route.destinationIcao,
        departureMinute: depart,
        blockMinutes: block,
        direction: 'out',
        frequency,
      });
      const backDepart = depart + block + turn;
      flights.push({
        id: `${route.id}:${frame.id}:${String(leg)}:back`,
        aircraftId: frame.id,
        routeId: route.id,
        originIcao: route.destinationIcao,
        destinationIcao: route.originIcao,
        departureMinute: backDepart,
        blockMinutes: block,
        direction: 'back',
        frequency,
      });
      depart = backDepart + block + turn + 45 + Math.floor(rng() * 60);
      leg += 1;
      if (leg > 2) break;
    }
  });
  return flights;
}

function competitorsFor(route: RouteSummary, seed: number): Competitor[] {
  const rng = mulberry32(seed ^ 0xc0de);
  const count = Math.floor(rng() * 4); // 0–3 rivals
  const names = ['Aurora Air', 'Meridian', 'Vega Wings', 'Cirrus Connect', 'Halcyon'];
  const products: Competitor['product'][] = ['basic', 'standard', 'premium'];
  const rivals: Competitor[] = [];
  for (let i = 0; i < count; i += 1) {
    rivals.push({
      id: `rival-${String(i)}`,
      name: names[(hash(route.id) + i) % names.length] ?? 'Rival',
      weeklyFrequency: 3 + Math.floor(rng() * 25),
      economyFareMinor: 8_000 + Math.round(rng() * 22_000),
      share: 0.1 + rng() * 0.4,
      product: products[Math.floor(rng() * products.length)] ?? 'standard',
    });
  }
  return rivals;
}

function demandFor(route: RouteSummary, seed: number): DemandBreakdown {
  const rng = mulberry32(seed ^ 0xdeed);
  // Longer routes skew business; short hops skew leisure/VFR.
  const longHaul = route.greatCircleNm > 2000;
  const business = Math.round((longHaul ? 60 : 30) + rng() * 40);
  const leisure = Math.round((longHaul ? 80 : 120) + rng() * 60);
  const vfr = Math.round(20 + rng() * 40);
  return { business, leisure, vfr };
}

function economicsFor(
  route: RouteSummary,
  flights: PlannedFlight[],
  aircraft: PlannerAircraft[],
  frequency: Frequency,
  seed: number,
): RouteEconomics {
  const rng = mulberry32(seed ^ 0xecec);
  const dailyDepartures = flights.length;
  const daysPerWeek = frequency.kind === 'daily' ? 7 : frequency.days.length;
  const weeklyFrequency = dailyDepartures * daysPerWeek;
  const loadFactor = 0.62 + rng() * 0.3;
  const raskMinor = 8 + Math.round(rng() * 6);
  const caskMinor = 6 + Math.round(rng() * 4);
  const seatKmPerWeek = route.greatCircleNm * 1.852 * 160 * weeklyFrequency;
  const flyers = aircraft.filter((a) => !a.isPool && flights.some((f) => f.aircraftId === a.id));
  const utilisation =
    flyers.length === 0
      ? 0
      : flyers.reduce((sum, a) => sum + a.utilisationHoursPerDay, 0) / flyers.length;
  return {
    weeklyFrequency,
    loadFactor,
    raskMinor,
    caskMinor,
    weeklyRevenueMinor: Math.round(seatKmPerWeek * raskMinor * loadFactor),
    weeklyCostMinor: Math.round(seatKmPerWeek * caskMinor),
    utilisationHoursPerDay: utilisation,
  };
}

function loadTrendFor(seed: number): number[] {
  const rng = mulberry32(seed ^ 0x77ab);
  const trend: number[] = [];
  let value = 0.6 + rng() * 0.2;
  for (let i = 0; i < 12; i += 1) {
    value = Math.max(0.35, Math.min(0.95, value + (rng() - 0.45) * 0.12));
    trend.push(value);
  }
  return trend;
}

/** The whole mock plan for a route, given the airline's planner aircraft. */
export function buildRoutePlan(
  route: RouteSummary,
  aircraft: PlannerAircraft[],
  frequency: Frequency = { kind: 'daily' },
): RoutePlan {
  const seed = hash(route.id);
  const flights = flightsFor(route, aircraft, frequency, seed);
  return {
    route,
    frequency,
    flights,
    slots: slotsFor(seed),
    competitors: competitorsFor(route, seed),
    demand: demandFor(route, seed),
    economics: economicsFor(route, flights, aircraft, frequency, seed),
    loadTrend: loadTrendFor(seed),
  };
}
