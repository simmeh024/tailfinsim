/**
 * How long each phase of a flight takes (M1-07, design doc §3.3).
 *
 * §3.3: "Each phase has a duration and can host events." These are those
 * durations, and they are **balance numbers**, so per CONTRIBUTING invariant 3
 * they live in a config object rather than scattered through the state machine.
 * §22.3 wants an admin able to retune this against a snapshot without a deploy;
 * a hardcoded `TAXI_MINUTES` is a number that cannot be fixed while the world is
 * running.
 *
 * ## What is here and what is not
 *
 * Durations that belong to *the airline's operation* are here. Durations that
 * belong to *a specific flight* — cruise speed, sector distance, and the
 * turnaround time after cabin config, ground staff level and airport congestion
 * have had their say (§3.3) — belong on the `FlightPlan`, because the systems
 * that compute them (M4-01, M6, M8) resolve them per flight.
 */

export interface FlightProfile {
  /**
   * Doors open to doors closed.
   *
   * Modelled as its own phase ahead of pushback, so the industry's "turn time"
   * — the aircraft on stand between two flights — is `turnaroundMinutes +
   * boardingMinutes` here, not `turnaroundMinutes` alone. §14's research ladder
   * targets a sub-25-minute narrowbody turn, and that target is against the
   * combined figure.
   */
  boardingMinutes: number;
  /** Off-blocks until the tug is clear and the aircraft is under its own power. */
  pushbackMinutes: number;
  /** Stand to holding point. The number congestion (§8) will push around most. */
  taxiOutMinutes: number;
  /** Line-up and roll. Short by design: it is a distinct phase because the map shows it. */
  departureMinutes: number;
  /** Wheels-up to top of climb, for a sector long enough to reach cruise at all. */
  climbMinutes: number;
  /** Top of descent to the final approach fix. */
  descentMinutes: number;
  /** Final approach fix to threshold. */
  approachMinutes: number;
  /** Threshold to runway vacated. */
  landingMinutes: number;
  /** Runway to stand. Shorter than taxi-out: no queue at the far end. */
  taxiInMinutes: number;
  /**
   * Airborne minutes beyond great-circle distance ÷ cruise speed.
   *
   * A flight never covers its sector at cruise speed for the whole sector: it
   * climbs, it is vectored, it flies a SID and a STAR. This is the gap between
   * block time and the arithmetic, and it is why a 100 nm hop takes 25 minutes
   * in the air rather than 13.
   */
  manoeuvreMinutes: number;
}

/**
 * Version tag, mirroring `world.economy_config_version`.
 *
 * A world records which profile it ran under, so a flight that took 47 minutes
 * in October can still be explained after the numbers change (invariant 4).
 */
export const FLIGHT_PROFILE_VERSION = 'v1' as const;

/**
 * Baseline narrowbody short-haul operation.
 *
 * Deliberately unremarkable numbers: a 25-minute board, a 12-minute taxi-out
 * and a 40-minute turn are what an unimproved airline gets, so every research
 * branch in §14 and every ground-staff decision in §6 has somewhere to move
 * them from.
 */
export const DEFAULT_FLIGHT_PROFILE: FlightProfile = {
  boardingMinutes: 25,
  pushbackMinutes: 5,
  taxiOutMinutes: 12,
  departureMinutes: 2,
  climbMinutes: 18,
  descentMinutes: 20,
  approachMinutes: 6,
  landingMinutes: 2,
  taxiInMinutes: 8,
  manoeuvreMinutes: 12,
};

/** Ground servicing after the passengers are off, before the next boarding starts. */
export const DEFAULT_TURNAROUND_MINUTES = 40;

/**
 * How the airborne time splits across the airborne phases.
 *
 * The interesting case is the short sector. A 100 nm hop at 450 kt is 25 airborne
 * minutes, and the nominal climb and descent alone want 38 — so they are scaled
 * down together and cruise gets nothing. That is correct: on a sector that short
 * the aircraft levels off briefly, or not at all.
 *
 * `fromCruise` is the replan case — a diversion or an air return. The aircraft is
 * already flying, so there is no takeoff roll and no initial climb; the new leg
 * is cruise, then down.
 */
export interface AirborneAllocation {
  departureMinutes: number;
  climbMinutes: number;
  cruiseMinutes: number;
  descentMinutes: number;
  approachMinutes: number;
  landingMinutes: number;
  /** Always equals the sum of the six above, and always equals the airborne time asked for. */
  totalMinutes: number;
}

export function airborneMinutes(
  distanceNm: number,
  cruiseSpeedKt: number,
  profile: FlightProfile,
): number {
  if (!Number.isFinite(cruiseSpeedKt) || cruiseSpeedKt <= 0) {
    throw new Error(`Cruise speed must be positive, got ${String(cruiseSpeedKt)}`);
  }
  if (!Number.isFinite(distanceNm) || distanceNm < 0) {
    throw new Error(`Sector distance must be zero or more, got ${String(distanceNm)}`);
  }
  return (60 * distanceNm) / cruiseSpeedKt + profile.manoeuvreMinutes;
}

export function allocateAirborne(
  distanceNm: number,
  cruiseSpeedKt: number,
  profile: FlightProfile,
  options: { fromCruise?: boolean } = {},
): AirborneAllocation {
  const total = airborneMinutes(distanceNm, cruiseSpeedKt, profile);
  const fromCruise = options.fromCruise ?? false;

  const departure = fromCruise ? 0 : profile.departureMinutes;
  const nominalClimb = fromCruise ? 0 : profile.climbMinutes;

  // The phases whose length does not depend on the sector: you land the same way
  // after 100 nm as after 5,000.
  const fixed = departure + profile.approachMinutes + profile.landingMinutes;

  if (total <= fixed) {
    // Pathological rather than expected — it needs a sector short enough that
    // even the manoeuvre allowance does not cover lining up and landing. Scaled
    // rather than clamped, so the phases stay in proportion and the total is
    // still exactly the airborne time.
    const scale = fixed === 0 ? 0 : total / fixed;
    return {
      departureMinutes: departure * scale,
      climbMinutes: 0,
      cruiseMinutes: 0,
      descentMinutes: 0,
      approachMinutes: profile.approachMinutes * scale,
      landingMinutes: profile.landingMinutes * scale,
      totalMinutes: total,
    };
  }

  const flexible = total - fixed;
  const nominalFlexible = nominalClimb + profile.descentMinutes;

  if (flexible >= nominalFlexible) {
    return {
      departureMinutes: departure,
      climbMinutes: nominalClimb,
      cruiseMinutes: flexible - nominalFlexible,
      descentMinutes: profile.descentMinutes,
      approachMinutes: profile.approachMinutes,
      landingMinutes: profile.landingMinutes,
      totalMinutes: total,
    };
  }

  const scale = nominalFlexible === 0 ? 0 : flexible / nominalFlexible;
  return {
    departureMinutes: departure,
    climbMinutes: nominalClimb * scale,
    cruiseMinutes: 0,
    descentMinutes: profile.descentMinutes * scale,
    approachMinutes: profile.approachMinutes,
    landingMinutes: profile.landingMinutes,
    totalMinutes: total,
  };
}
