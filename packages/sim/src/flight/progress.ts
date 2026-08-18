import { type FlightPhase } from '@tailfin/shared';

import { type AirborneSpeedFactors, type FlightProfile } from './profile';
import { type FlightPlan, legIndexAt, type PhaseWindow, type RouteLeg } from './timeline';

/**
 * How far along its track a flight is, and how fast (M1-08, design doc §21).
 *
 * ## Distance, not time
 *
 * M1-07's timeline says which phase a flight is in at any instant. Turning that
 * into a *position* needs one more thing: how much of the track has actually
 * been covered, which is not the fraction of the time that has passed. An
 * aircraft in its climb is going considerably slower than one in cruise, so a
 * flight halfway through its airborne minutes is not halfway to its destination.
 *
 * Using time as a proxy would show every aircraft moving at a constant speed and
 * would make `groundSpeedKt` a number that contradicts the progress bar beside
 * it — a dead-end number, which CONTRIBUTING invariant 4 exists to prevent.
 *
 * ## The scale is solved for, not configured
 *
 * `speedFactors` gives the phases' speeds *relative to one another*. The
 * absolute scale is solved per leg so the speeds integrate to exactly the leg's
 * distance. Configuring absolute speeds instead would let a retuned climb rate
 * quietly land the aircraft somewhere other than the airport it was aimed at.
 */

const AIRBORNE_PHASES = new Set<FlightPhase>([
  'departure',
  'climb',
  'cruise',
  'descent',
  'approach',
  'landing',
]);

function factorFor(phase: FlightPhase, factors: AirborneSpeedFactors): number {
  switch (phase) {
    case 'departure':
      return factors.departure;
    case 'climb':
      return factors.climb;
    case 'cruise':
      return factors.cruise;
    case 'descent':
      return factors.descent;
    case 'approach':
      return factors.approach;
    case 'landing':
      return factors.landing;
    default:
      return 0;
  }
}

/** The parts of a flight this module reads. `FlightState` satisfies it structurally. */
export interface FlightShape {
  plan: FlightPlan;
  timeline: readonly PhaseWindow[];
  legs: readonly RouteLeg[];
}

export interface LegProgress {
  leg: RouteLeg;
  legIndex: number;
  /** Distance covered along this leg's planned track, nautical miles. */
  coveredNm: number;
  /** `coveredNm / leg.distanceNm`, 0–1. Reaches `leg.flownFraction` when the leg ends. */
  fraction: number;
  /** Ground speed right now, knots. */
  groundSpeedKt: number;
  phase: FlightPhase;
  /** How far through the current phase, 0–1. */
  phaseFraction: number;
  /**
   * The altitude this leg actually tops out at, feet above sea level.
   *
   * `plan.cruiseAltitudeFt` capped by what the climb has time to achieve, so a
   * sector too short for a full climb never claims to have reached cruise level.
   */
  ceilingFt: number;
}

interface Segment {
  phase: FlightPhase;
  fromMs: number;
  toMs: number;
  factor: number;
}

/**
 * The airborne windows of one leg, clipped to it.
 *
 * Clipped rather than filtered: a diversion cuts a window in the middle, and the
 * half that belongs to the old leg must not be counted against the new one.
 */
function segmentsOf(
  timeline: readonly PhaseWindow[],
  leg: RouteLeg,
  factors: AirborneSpeedFactors,
): Segment[] {
  const startMs = leg.startedAt.getTime();
  const endMs = leg.endsAt.getTime();
  const segments: Segment[] = [];

  for (const window of timeline) {
    if (!AIRBORNE_PHASES.has(window.phase)) continue;
    const fromMs = Math.max(window.from.getTime(), startMs);
    const toMs = Math.min(window.to?.getTime() ?? endMs, endMs);
    if (toMs <= fromMs) continue;
    segments.push({ phase: window.phase, fromMs, toMs, factor: factorFor(window.phase, factors) });
  }

  return segments;
}

/**
 * Where along its current leg the flight is at `at`, or null while on the ground.
 *
 * A pure function of the flight and the instant — nothing is stored per tick and
 * nothing is read from a clock, which is the M1-08 acceptance criterion and
 * CONTRIBUTING invariant 2 in the same breath.
 */
export function legProgressAt(
  flight: FlightShape,
  at: Date,
  profile: FlightProfile,
): LegProgress | null {
  const legIndex = legIndexAt(flight.legs, at);
  const leg = flight.legs[legIndex];
  if (!leg) return null;

  const atMs = Math.min(at.getTime(), leg.endsAt.getTime());
  const segments = segmentsOf(flight.timeline, leg, profile.speedFactors);
  const targetNm = leg.distanceNm * leg.flownFraction;

  // Total factor-weighted minutes. The scale that turns those into nautical
  // miles is whatever makes the leg come out at exactly the right distance.
  let weighted = 0;
  for (const segment of segments)
    weighted += ((segment.toMs - segment.fromMs) / 60_000) * segment.factor;

  if (segments.length === 0 || weighted <= 0) {
    // A leg with no airborne minutes at all — possible only for a zero-length
    // leg. Treat it as flown out rather than dividing by zero.
    return {
      leg,
      legIndex,
      coveredNm: targetNm,
      fraction: leg.flownFraction,
      groundSpeedKt: 0,
      phase: 'cruise',
      phaseFraction: 1,
      ceilingFt: flight.plan.cruiseAltitudeFt,
    };
  }

  const nmPerWeightedMinute = targetNm / weighted;

  let coveredNm = 0;
  let current: Segment | undefined;
  let phaseFraction = 0;

  for (const segment of segments) {
    const spanMinutes = (segment.toMs - segment.fromMs) / 60_000;
    current = segment;

    if (atMs >= segment.toMs) {
      coveredNm += spanMinutes * segment.factor * nmPerWeightedMinute;
      phaseFraction = 1;
      continue;
    }

    const elapsedMinutes = Math.max(0, (atMs - segment.fromMs) / 60_000);
    coveredNm += elapsedMinutes * segment.factor * nmPerWeightedMinute;
    phaseFraction = spanMinutes <= 0 ? 1 : elapsedMinutes / spanMinutes;
    break;
  }

  return {
    leg,
    legIndex,
    coveredNm,
    fraction: leg.distanceNm <= 0 ? leg.flownFraction : coveredNm / leg.distanceNm,
    groundSpeedKt: (current?.factor ?? 0) * nmPerWeightedMinute * 60,
    phase: current?.phase ?? 'cruise',
    phaseFraction,
    ceilingFt: ceilingOf(flight, leg, profile),
  };
}

/**
 * The altitude a leg tops out at.
 *
 * The aircraft climbs at a rate, so the climb's length decides how high it gets.
 * A 100 nm hop whose climb was scaled to seven minutes reaches about FL140, not
 * the FL350 its catalogue entry claims — and the map should show that, because a
 * player looking at a short hop cruising at FL350 would rightly not believe it.
 */
function ceilingOf(flight: FlightShape, leg: RouteLeg, profile: FlightProfile): number {
  // Every climb minute flown up to the end of this leg, not only the ones inside
  // it. A replanned leg has no climb window of its own — the aircraft is already
  // up — so it has to inherit the climb that got it there, and a diversion
  // *during* the climb inherits only the part that had actually happened.
  let climbMinutes = 0;
  for (const window of flight.timeline) {
    if (window.phase !== 'climb') continue;
    const fromMs = window.from.getTime();
    const toMs = Math.min(window.to?.getTime() ?? leg.endsAt.getTime(), leg.endsAt.getTime());
    if (toMs > fromMs) climbMinutes += (toMs - fromMs) / 60_000;
  }

  if (climbMinutes <= 0) return flight.plan.cruiseAltitudeFt;

  const reachableFt = profile.departureAltitudeFt + climbMinutes * profile.climbRateFtPerMin;
  return Math.min(flight.plan.cruiseAltitudeFt, reachableFt);
}
