import { type FlightPhase } from '@tailfin/shared';

import { allocateAirborne, type FlightProfile } from './profile';

/**
 * A flight's phases laid out on the game-time line (M1-07, design doc §3.3).
 *
 * ## Why a timeline rather than a stored phase
 *
 * The M1-07 acceptance criterion is that position at any game time is derivable
 * from departure time, route, aircraft and state, **with no stored per-tick
 * history** — which is §21's "flight state is computed, not stored per-tick".
 *
 * A timeline is what makes that true. Every phase boundary is an instant
 * computed once from the plan, so asking "where is this aircraft at 14:07?" is a
 * lookup against instants rather than a replay of ticks. Nothing accumulates,
 * nothing has to be written every second, and the answer for a moment in the
 * past is the same one you would have got at the time.
 *
 * Disruptions rebuild the timeline rather than being replayed over it. A
 * diversion is a new set of instants from the moment it happened, not a log of
 * what changed.
 */

/** A phase and the game-time interval it occupies. `to` is null only for the terminal `idle`. */
export interface PhaseWindow {
  phase: FlightPhase;
  from: Date;
  to: Date | null;
}

/**
 * One airborne leg: a great-circle track and the interval flown along it.
 *
 * Normally a flight has exactly one. A diversion or an air return adds a second,
 * which begins wherever the first was cut short — `fromIcao` is null there
 * because the aircraft was over open water, not over an airport.
 *
 * `flownFraction` is what makes that reconstructible: the previous leg carries
 * how far along its own track the aircraft got before it turned. M1-08 needs
 * coordinates to draw it; every scalar it needs is here.
 */
export interface RouteLeg {
  /** Where the leg starts, or null when it starts wherever the previous leg was cut short. */
  fromIcao: string | null;
  toIcao: string;
  /** Great-circle distance of the leg as planned, in nautical miles. */
  distanceNm: number;
  /** Game time the takeoff roll began, or the replan happened. */
  startedAt: Date;
  /** Game time of touchdown, or of the replan that ended this leg early. */
  endsAt: Date;
  /** Fraction of `fromIcao → toIcao` actually flown. 1 unless a replan cut it short. */
  flownFraction: number;
}

/** Everything about one flight that does not change unless something goes wrong. */
export interface FlightPlan {
  originIcao: string;
  destinationIcao: string;
  /** Great-circle distance, nautical miles — M1-04's matrix is the source. */
  distanceNm: number;
  /** The aircraft's cruise speed in knots. M4-01's catalogue is the source. */
  cruiseSpeedKt: number;
  /** Game instant the schedule created this flight. The `scheduled` phase starts here. */
  createdAt: Date;
  /** Game instant the aircraft is due off-blocks. Boarding is sized backwards from it. */
  scheduledDeparture: Date;
  /**
   * Ground servicing after arrival, already adjusted for cabin config, ground
   * staff level and airport congestion (§3.3). Those systems resolve it; this
   * package is handed the answer.
   */
  turnaroundMinutes: number;
}

export function addMinutes(at: Date, minutes: number): Date {
  return new Date(at.getTime() + minutes * 60_000);
}

function assertUsablePlan(plan: FlightPlan): void {
  if (Number.isNaN(plan.createdAt.getTime()) || Number.isNaN(plan.scheduledDeparture.getTime())) {
    throw new Error('Flight plan has an invalid createdAt or scheduledDeparture');
  }
  if (!Number.isFinite(plan.turnaroundMinutes) || plan.turnaroundMinutes < 0) {
    throw new Error(
      `Turnaround must be zero or more minutes, got ${String(plan.turnaroundMinutes)}`,
    );
  }
  if (plan.originIcao === plan.destinationIcao) {
    throw new Error(`A flight cannot depart and arrive at ${plan.originIcao}`);
  }
}

function push(windows: PhaseWindow[], phase: FlightPhase, from: Date, minutes: number): Date {
  const to = addMinutes(from, minutes);
  windows.push({ phase, from, to });
  return to;
}

function appendAirborne(
  windows: PhaseWindow[],
  from: Date,
  distanceNm: number,
  cruiseSpeedKt: number,
  profile: FlightProfile,
  fromCruise: boolean,
): Date {
  const split = allocateAirborne(distanceNm, cruiseSpeedKt, profile, { fromCruise });
  let cursor = from;
  if (!fromCruise) {
    cursor = push(windows, 'departure', cursor, split.departureMinutes);
    cursor = push(windows, 'climb', cursor, split.climbMinutes);
  }
  cursor = push(windows, 'cruise', cursor, split.cruiseMinutes);
  cursor = push(windows, 'descent', cursor, split.descentMinutes);
  cursor = push(windows, 'approach', cursor, split.approachMinutes);
  cursor = push(windows, 'landing', cursor, split.landingMinutes);
  return cursor;
}

export interface NominalTimeline {
  windows: PhaseWindow[];
  /**
   * The single airborne leg of an undisrupted flight.
   *
   * It starts at the beginning of the takeoff roll rather than at the moment the
   * wheels leave, because track fraction 0 has to mean "at the origin airport"
   * for the map to draw the aircraft where it actually is.
   */
  leg: RouteLeg;
}

/**
 * Lays out the nominal timeline: created, boarded, flown, turned round, idle.
 *
 * `scheduledDeparture` is off-blocks, as it is on a timetable, so boarding is
 * sized *backwards* from it. A flight created later than its own boarding should
 * have begun is a scheduling bug rather than a delay, and throws — M2-03 must
 * not be able to produce one quietly.
 */
export function buildTimeline(plan: FlightPlan, profile: FlightProfile): NominalTimeline {
  assertUsablePlan(plan);

  const offBlocks = plan.scheduledDeparture;
  const boardingStart = addMinutes(offBlocks, -profile.boardingMinutes);
  if (plan.createdAt.getTime() > boardingStart.getTime()) {
    throw new Error(
      `Flight created at ${plan.createdAt.toISOString()} but boarding for a ` +
        `${offBlocks.toISOString()} departure starts at ${boardingStart.toISOString()}. ` +
        'Schedule it earlier, or move the departure.',
    );
  }

  const windows: PhaseWindow[] = [
    { phase: 'scheduled', from: plan.createdAt, to: boardingStart },
    { phase: 'boarding', from: boardingStart, to: offBlocks },
  ];

  let cursor = offBlocks;
  cursor = push(windows, 'pushback', cursor, profile.pushbackMinutes);
  cursor = push(windows, 'taxi_out', cursor, profile.taxiOutMinutes);

  const wheelsUp = cursor;
  cursor = appendAirborne(windows, cursor, plan.distanceNm, plan.cruiseSpeedKt, profile, false);
  const touchdown = cursor;

  cursor = push(windows, 'taxi_in', cursor, profile.taxiInMinutes);
  cursor = push(windows, 'turnaround', cursor, plan.turnaroundMinutes);
  windows.push({ phase: 'idle', from: cursor, to: null });

  return {
    windows,
    leg: {
      fromIcao: plan.originIcao,
      toIcao: plan.destinationIcao,
      distanceNm: plan.distanceNm,
      startedAt: wheelsUp,
      endsAt: touchdown,
      flownFraction: 1,
    },
  };
}

/**
 * The index of the window an instant falls in.
 *
 * Scans from the end so that a zero-length window — a 100 nm sector really does
 * get no cruise at all — is passed *through* rather than parked in. An instant
 * before the flight existed answers 0; after the last boundary, the terminal
 * window.
 */
export function windowIndexAt(timeline: readonly PhaseWindow[], at: Date): number {
  for (let i = timeline.length - 1; i >= 0; i -= 1) {
    const window = timeline[i];
    if (window && at.getTime() >= window.from.getTime()) return i;
  }
  return 0;
}

export function phaseAt(timeline: readonly PhaseWindow[], at: Date): FlightPhase {
  const window = timeline[windowIndexAt(timeline, at)];
  if (!window) throw new Error('A flight timeline is never empty');
  return window.phase;
}

/**
 * Everything up to `at`, with the window `at` falls in closed there.
 *
 * The first half of every disruption: what already happened is kept exactly as
 * it happened, and the future is rebuilt from the instant the disruption did.
 */
export function truncateAt(timeline: readonly PhaseWindow[], at: Date): PhaseWindow[] {
  const index = windowIndexAt(timeline, at);
  const kept = timeline.slice(0, index + 1).map((window) => ({ ...window }));
  const last = kept[kept.length - 1];
  if (last) last.to = at;
  return kept;
}

/**
 * Appends windows, merging into the previous one when the phase is unchanged.
 *
 * A diversion during cruise would otherwise produce cruise-then-cruise, and an
 * advance event that fires the instant it is scheduled and changes nothing
 * visible. The aircraft did not enter a new phase; its cruise simply got longer.
 */
function appendMerging(into: PhaseWindow[], windows: readonly PhaseWindow[]): void {
  for (const window of windows) {
    const last = into[into.length - 1];
    if (last?.phase === window.phase) {
      last.to = window.to;
      continue;
    }
    into.push({ ...window });
  }
}

/** Taxi-in, turnaround, idle — the tail every flight ends with, however it ended. */
export function appendArrivalGround(
  into: PhaseWindow[],
  from: Date,
  turnaroundMinutes: number,
  profile: FlightProfile,
): void {
  const tail: PhaseWindow[] = [];
  let cursor = push(tail, 'taxi_in', from, profile.taxiInMinutes);
  cursor = push(tail, 'turnaround', cursor, turnaroundMinutes);
  tail.push({ phase: 'idle', from: cursor, to: null });
  appendMerging(into, tail);
}

/**
 * A replanned airborne leg: cruise, down, and the ground tail after it.
 *
 * Used by both a diversion and an air return, because they are the same event
 * with a different destination. There is no takeoff and no initial climb — the
 * aircraft is already up — so the new leg starts in cruise and the allocator is
 * told so.
 */
export function appendReplannedLeg(
  into: PhaseWindow[],
  from: Date,
  distanceNm: number,
  cruiseSpeedKt: number,
  turnaroundMinutes: number,
  profile: FlightProfile,
): Date {
  const leg: PhaseWindow[] = [];
  const touchdown = appendAirborne(leg, from, distanceNm, cruiseSpeedKt, profile, true);
  appendMerging(into, leg);
  appendArrivalGround(into, touchdown, turnaroundMinutes, profile);
  return touchdown;
}

/**
 * Moves everything from `at` onwards later by `minutes`.
 *
 * The window `at` falls in keeps its start — the aircraft is already in that
 * phase — and gains the delay at its end. A delay is the only disruption that
 * changes durations rather than the route.
 */
export function shiftFrom(
  timeline: readonly PhaseWindow[],
  at: Date,
  minutes: number,
): PhaseWindow[] {
  const index = windowIndexAt(timeline, at);
  return timeline.map((window, i) => {
    if (i < index) return { ...window };
    const to = window.to === null ? null : addMinutes(window.to, minutes);
    if (i === index) return { ...window, to };
    return { ...window, from: addMinutes(window.from, minutes), to };
  });
}

/** On-blocks: the start of the turnaround, or null if the flight never arrives. */
export function estimatedArrival(timeline: readonly PhaseWindow[]): Date | null {
  for (let i = timeline.length - 1; i >= 0; i -= 1) {
    const window = timeline[i];
    if (window?.phase === 'turnaround') return window.from;
  }
  return null;
}

/** Where the aircraft is along the leg it is flying, 0–1 of that leg's track, or null on the ground. */
export function trackFraction(
  legs: readonly RouteLeg[],
  at: Date,
): { leg: RouteLeg; fraction: number } | null {
  for (let i = legs.length - 1; i >= 0; i -= 1) {
    const leg = legs[i];
    if (!leg) continue;
    if (at.getTime() < leg.startedAt.getTime()) continue;

    const span = leg.endsAt.getTime() - leg.startedAt.getTime();
    const elapsed = at.getTime() - leg.startedAt.getTime();
    const along = span <= 0 ? 1 : Math.min(1, elapsed / span);
    return { leg, fraction: along * leg.flownFraction };
  }
  return null;
}
