import type { PlannedFlight, PlannerAircraft, RouteEconomics, RoutePlan, Timeslot } from './types';

/**
 * Pure analysis for the planner: live economics, schedule legality, slot scoring
 * and the auto-suggest. All deterministic and side-effect free, so the workspace
 * can recompute them on every edit and the tests can pin the numbers.
 *
 * The revenue model is a believable stand-in, not the real sim (invariant 1 keeps
 * economics on the server): capacity comes from the flights on the timeline, demand
 * from the route's stable mock pool, and profit turns over as you add or cut
 * flights — up while frequency is filling unmet demand, down once it oversupplies.
 */

const SEATS_PER_FLIGHT = 160;
const KM_PER_NM = 1.852;

function daysPerWeek(plan: RoutePlan): number {
  return plan.frequency.kind === 'daily' ? 7 : plan.frequency.days.length;
}

/** Economics recomputed from the flights currently on the timeline. */
export function liveEconomics(plan: RoutePlan, flights: readonly PlannedFlight[]): RouteEconomics {
  const perWeek = daysPerWeek(plan);
  const dailyDepartures = flights.length;
  const weeklyFrequency = dailyDepartures * perWeek;
  const distanceKm = plan.route.greatCircleNm * KM_PER_NM;

  const weeklyCapacity = weeklyFrequency * SEATS_PER_FLIGHT;
  const weeklyDemand = (plan.demand.business + plan.demand.leisure + plan.demand.vfr) * 7;
  const bookedWeekly = Math.min(weeklyCapacity, weeklyDemand);
  const loadFactor = weeklyCapacity > 0 ? bookedWeekly / weeklyCapacity : 0;

  // rask/cask are the route's stable unit economics; capacity and load do the moving.
  const weeklyRevenueMinor = Math.round(bookedWeekly * distanceKm * plan.economics.raskMinor);
  const weeklyCostMinor = Math.round(weeklyCapacity * distanceKm * plan.economics.caskMinor);

  const flyers = new Set(flights.map((f) => f.aircraftId));
  const blockHours = flights.reduce((sum, f) => sum + f.blockMinutes, 0) / 60;
  const utilisationHoursPerDay = flyers.size > 0 ? blockHours / flyers.size : 0;

  return {
    weeklyFrequency,
    loadFactor,
    raskMinor: plan.economics.raskMinor,
    caskMinor: plan.economics.caskMinor,
    weeklyRevenueMinor,
    weeklyCostMinor,
    utilisationHoursPerDay,
  };
}

/** Block hours a day each aircraft is working under the current schedule. */
export function utilisationByAircraft(flights: readonly PlannedFlight[]): Map<string, number> {
  const hours = new Map<string, number>();
  for (const flight of flights) {
    hours.set(flight.aircraftId, (hours.get(flight.aircraftId) ?? 0) + flight.blockMinutes / 60);
  }
  return hours;
}

export type IssueKind = 'overlap' | 'turnaround' | 'slot';

export interface FlightIssue {
  flightId: string;
  kind: IssueKind;
  detail: string;
}

/** The minimum ground time before an aircraft can fly again, by class hint. */
function minTurnaround(aircraftClass: string): number {
  const lower = aircraftClass.toLowerCase();
  if (lower.includes('wide')) return 45;
  if (lower.includes('regional') || lower.includes('turboprop')) return 25;
  return 30;
}

/**
 * Every problem with the current schedule: two flights on one aircraft in the air
 * at once, a turnaround too short to be legal, or a departure in a slot band that
 * is already full. Returned per flight so the timeline can outline the offender.
 */
export function scheduleIssues(
  flights: readonly PlannedFlight[],
  aircraft: readonly PlannerAircraft[],
  slots: readonly Timeslot[],
): FlightIssue[] {
  const issues: FlightIssue[] = [];
  const classOf = new Map(aircraft.map((a) => [a.id, a.aircraftClass]));
  const slotByHour = new Map(slots.map((s) => [s.hour, s]));

  const byAircraft = new Map<string, PlannedFlight[]>();
  for (const flight of flights) {
    const list = byAircraft.get(flight.aircraftId) ?? [];
    list.push(flight);
    byAircraft.set(flight.aircraftId, list);
  }

  for (const [aircraftId, list] of byAircraft) {
    const sorted = [...list].sort((a, b) => a.departureMinute - b.departureMinute);
    const turn = minTurnaround(classOf.get(aircraftId) ?? '');
    for (let i = 1; i < sorted.length; i += 1) {
      const previous = sorted[i - 1]!;
      const current = sorted[i]!;
      const previousArrival = previous.departureMinute + previous.blockMinutes;
      const gap = current.departureMinute - previousArrival;
      if (gap < 0) {
        issues.push({
          flightId: current.id,
          kind: 'overlap',
          detail: 'Overlaps the previous flight',
        });
      } else if (gap < turn) {
        issues.push({
          flightId: current.id,
          kind: 'turnaround',
          detail: `Only ${String(gap)} min turnaround; needs ${String(turn)}`,
        });
      }
    }
  }

  for (const flight of flights) {
    const hour = Math.floor(flight.departureMinute / 60);
    if (slotByHour.get(hour)?.availability === 'full') {
      issues.push({ flightId: flight.id, kind: 'slot', detail: 'Departs in a full slot band' });
    }
  }

  return issues;
}

/**
 * A slot's expected contribution per departure, minor units: the demand it can
 * reasonably fill (weighted by how good the time is) at the route's fare, less what
 * the slot costs. The map's "best slot" hint and the auto-suggest both rank on it.
 */
export function slotContribution(plan: RoutePlan, slot: Timeslot): number {
  const weight = slot.quality === 'peak' ? 1 : slot.quality === 'shoulder' ? 0.6 : 0.25;
  const dailyDemand = plan.demand.business + plan.demand.leisure + plan.demand.vfr;
  const fillablePax = Math.min(SEATS_PER_FLIGHT, dailyDemand * weight * 0.4);
  const fareMinor = plan.route.fares.economy ?? 12_000;
  return Math.round(fillablePax * fareMinor - slot.costMinor);
}

/** Slots ranked best-first, excluding full bands and hours already flown. */
export function rankedSlots(
  plan: RoutePlan,
  flights: readonly PlannedFlight[],
): { slot: Timeslot; contribution: number }[] {
  const flownHours = new Set(flights.map((f) => Math.floor(f.departureMinute / 60)));
  return plan.slots
    .filter((slot) => slot.availability !== 'full' && !flownHours.has(slot.hour))
    .map((slot) => ({ slot, contribution: slotContribution(plan, slot) }))
    .sort((a, b) => b.contribution - a.contribution);
}
