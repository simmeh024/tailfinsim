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

/**
 * The airborne part of one window, clipped to a leg — or null if none of it is.
 *
 * Clipped rather than filtered: a diversion cuts a window in the middle, and the
 * half that belongs to the old leg must not be counted against the new one.
 *
 * Returned as two numbers written into the caller's scratch pair rather than an
 * object, because this runs 65,000 times a sweep at world scale and the objects
 * were the sweep's largest cost — see `position.test.ts`.
 */
function clipTo(
  window: PhaseWindow,
  startMs: number,
  endMs: number,
  out: { fromMs: number; toMs: number },
): boolean {
  const from = window.from.getTime();
  const to = window.to === null ? endMs : window.to.getTime();
  out.fromMs = from > startMs ? from : startMs;
  out.toMs = to < endMs ? to : endMs;
  return out.toMs > out.fromMs;
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

  const startMs = leg.startedAt.getTime();
  const endMs = leg.endsAt.getTime();
  const rawAt = at.getTime();
  const atMs = rawAt < endMs ? rawAt : endMs;
  const factors = profile.speedFactors;
  const targetNm = leg.distanceNm * leg.flownFraction;

  // Two passes over the timeline with no allocation at all, rather than building
  // an array of segments and walking that. The array was the largest single cost
  // of a world-scale sweep — 5,000 flights each allocating six objects is 30,000
  // short-lived objects per sweep, and the garbage collector noticed.
  const span = { fromMs: 0, toMs: 0 };

  // Total factor-weighted minutes, and the climb the leg has had. The scale that
  // turns weighted minutes into nautical miles is whatever makes the leg come out
  // at exactly the right distance.
  let weighted = 0;
  let airborneWindows = 0;
  let climbMinutes = 0;

  for (const window of flight.timeline) {
    if (window.phase === 'climb') {
      // Every climb minute up to the end of this leg, not only the ones inside
      // it. A replanned leg has no climb window of its own — the aircraft is
      // already up — so it inherits the climb that got it there, and a diversion
      // *during* the climb inherits only the part that had actually happened.
      const from = window.from.getTime();
      const to = Math.min(window.to === null ? endMs : window.to.getTime(), endMs);
      if (to > from) climbMinutes += (to - from) / 60_000;
    }
    if (!AIRBORNE_PHASES.has(window.phase)) continue;
    if (!clipTo(window, startMs, endMs, span)) continue;
    airborneWindows += 1;
    weighted += ((span.toMs - span.fromMs) / 60_000) * factorFor(window.phase, factors);
  }

  const ceilingFt =
    climbMinutes <= 0
      ? flight.plan.cruiseAltitudeFt
      : Math.min(
          flight.plan.cruiseAltitudeFt,
          profile.departureAltitudeFt + climbMinutes * profile.climbRateFtPerMin,
        );

  if (airborneWindows === 0 || weighted <= 0) {
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
  let phaseFraction = 0;
  let currentPhase: FlightPhase = 'cruise';
  let currentFactor = 0;

  for (const window of flight.timeline) {
    if (!AIRBORNE_PHASES.has(window.phase)) continue;
    if (!clipTo(window, startMs, endMs, span)) continue;

    const factor = factorFor(window.phase, factors);
    const spanMinutes = (span.toMs - span.fromMs) / 60_000;
    currentPhase = window.phase;
    currentFactor = factor;

    if (atMs >= span.toMs) {
      coveredNm += spanMinutes * factor * nmPerWeightedMinute;
      phaseFraction = 1;
      continue;
    }

    const elapsedMinutes = atMs > span.fromMs ? (atMs - span.fromMs) / 60_000 : 0;
    coveredNm += elapsedMinutes * factor * nmPerWeightedMinute;
    phaseFraction = spanMinutes <= 0 ? 1 : elapsedMinutes / spanMinutes;
    break;
  }

  return {
    leg,
    legIndex,
    coveredNm,
    fraction: leg.distanceNm <= 0 ? leg.flownFraction : coveredNm / leg.distanceNm,
    groundSpeedKt: currentFactor * nmPerWeightedMinute * 60,
    phase: currentPhase,
    phaseFraction,
    ceilingFt,
  };
}
