/**
 * Fuel burnt over a sector, by phase (M2-05, §10.4, §11, App. C.6).
 *
 * §11 lists fuel first among the costs, and §13.4's worked example makes it the
 * single largest line in a one-aircraft airline's P&L — *"fuel 168k"* against a
 * total of $808k. It is therefore the number that has to be right, and the one a
 * player will interrogate hardest.
 *
 * ## Burnt, not uplifted
 *
 * This computes what the sector **burns**. It is not what the tanks take at the
 * pump: an aircraft departs with trip fuel plus contingency, alternate and final
 * reserve, and the reserves come back still in the tanks. Across a rotation the
 * reserve is a carried balance rather than a recurring purchase, so charging for
 * it every sector would bill the player over and over for fuel never used.
 *
 * That distinction is what {@link FuelBurnConfig.tripFuelFraction} exists for,
 * and it is easy to get wrong in the other direction too — see its note.
 *
 * ## Why per phase rather than per mile
 *
 * A mile of climb costs about half again what a mile of cruise costs, and a mile
 * of descent costs a third, because the engines are near idle all the way down.
 * On a 4,000 nm sector that averages out and per-mile is fine. On the 200 nm
 * sectors §13.4's example airline actually flies, cruise is **under 8 minutes of
 * a 56-minute airborne leg** — the sector is essentially a climb followed by a
 * descent, and a per-mile model would get it wrong by a quarter.
 *
 * So the burn is integrated over the phase allocation `computeBlockTime` has
 * already produced, which also means the fuel bill and the block time cannot
 * disagree about how long the aircraft spent in each phase (invariant 4).
 */

import {
  EFFICIENCY_CEILINGS,
  type EfficiencyBoost,
  stackEfficiencyBoosts,
} from '../economy/boosts';

import { type BlockTimeResult, taxiMinutes } from './block';

/** The phases fuel is burnt in. `taxi` covers both ends; the rest are airborne. */
export type FuelPhase =
  'taxi' | 'departure' | 'climb' | 'cruise' | 'descent' | 'approach' | 'landing';

/**
 * Burn rate of each phase relative to cruise, which is the reference at 1.
 *
 * Ratios rather than absolute flows, for the same reason `AirborneSpeedFactors`
 * are ratios: the absolute scale is a property of the airframe and arrives from
 * `effective_spec`, while the shape of the curve is a property of *flying* and is
 * much the same for everything with wings.
 */
export interface FuelPhaseFactors {
  /** Idle on the ground, frequently on one engine. */
  taxi: number;
  /** The takeoff roll — the thirstiest minutes of the whole sector. */
  departure: number;
  /** Climb thrust, and the aircraft is at its heaviest. */
  climb: number;
  cruise: number;
  /** Near idle for most of it. Gravity does the work. */
  descent: number;
  /** Configured, dirty, and back on the thrust. */
  approach: number;
  /** Touchdown, reverse and the rollout. */
  landing: number;
}

/**
 * What the airframe brings to the calculation.
 *
 * `cruiseBurnTPerNm` comes straight from `effective_spec` (App. C.6: everything
 * downstream *"reads only `effective_spec`"*), which is what makes a factory
 * option matter here without this module knowing options exist — sharklets are a
 * `burnFactor` of 0.965 inside `effectiveSpec`, and this reads the folded figure.
 */
export interface FuelBurnAircraft {
  /** Tonnes per nautical mile, range-calibrated. See {@link FuelBurnConfig.tripFuelFraction}. */
  cruiseBurnTPerNm: number;
}

/**
 * Balance numbers (CONTRIBUTING invariant 3), retunable against a snapshot under
 * §22.3 rather than compiled in.
 */
export interface FuelBurnConfig {
  /**
   * The share of the range-calibrated per-mile figure that is actually burnt.
   *
   * `cruiseBurnTPerNm` is solved by `calibrateCruiseBurn` as *fuel loaded ÷
   * published range*, and a published range already respects reserves — so the
   * fuel in that numerator includes fuel the mission never burns. Used raw as a
   * burn rate it therefore runs high, by roughly the reserve fraction.
   *
   * 0.85 is the usual short-haul build-up read backwards: 5% contingency, an
   * alternate, and 30 minutes of final reserve come to about 15% of the uplift on
   * a European sector.
   *
   * Deliberately **not** folded into `calibrateCruiseBurn` instead. That function
   * has to keep returning the figure that reproduces the brochure range, because
   * that is what App. B.4's reachability check reads; the haircut belongs to
   * whoever is asking about burn, which is here.
   */
  tripFuelFraction: number;
  phaseFactors: FuelPhaseFactors;
}

/**
 * A conventional turbine burn curve, in the absence of a real fuel-flow deck.
 *
 * The two that carry the result on a short sector are `climb` and `descent`, and
 * they are the two to retune first if type-level data ever lands: every other
 * phase is either brief or close to cruise.
 */
export const DEFAULT_FUEL_BURN: FuelBurnConfig = {
  tripFuelFraction: 0.85,
  phaseFactors: {
    taxi: 0.15,
    departure: 2.5,
    climb: 1.5,
    cruise: 1,
    descent: 0.35,
    approach: 0.5,
    landing: 0.6,
  },
};

/**
 * Version tag, mirroring `FLIGHT_PROFILE_VERSION` and `TURNAROUND_CONFIG_VERSION`.
 *
 * A world records which numbers it ran under, so a fuel bill from October can
 * still be explained after they are retuned (invariant 4).
 */
export const FUEL_BURN_CONFIG_VERSION = 'v1' as const;

/** One phase's share of the sector's fuel, and the rate that produced it. */
export interface FuelBurnContribution {
  phase: FuelPhase;
  minutes: number;
  tonnes: number;
  /** Burn rate in this phase, tonnes per hour — the figure a pilot would recognise. */
  tonnesPerHour: number;
}

export interface FuelBurnResult {
  /** Total burnt over the sector, after boosts. */
  tonnes: number;
  /** Ground burn, both ends. Small per sector, and not small across a year. */
  taxiTonnes: number;
  /** Wheels-up to wheels-down. */
  airborneTonnes: number;
  /** Every phase, in flight order. Sums to the burn before boosts. */
  contributions: FuelBurnContribution[];
  /**
   * Tonnes per nautical mile actually burnt.
   *
   * The number that shows why short sectors are dear: on a 200 nm hop it lands
   * above `cruiseBurnTPerNm` even after the trip-fuel haircut, and it converges
   * down as the sector lengthens and cruise starts to dominate.
   */
  tonnesPerNm: number;
  /** Tonnes per block hour — the unit a fleet report compares types in (§14.3). */
  tonnesPerBlockHour: number;
  /** Tonnes removed by §10.4 boosts. */
  boostSavingTonnes: number;
  /** The reduction actually applied, 0–1, after diminishing returns and the ceiling. */
  boostFraction: number;
  /** Whether §10.4's −8% ceiling clipped it. */
  boostCapReached: boolean;
}

/** Flight order, so a readout lists the phases the way the sector happened. */
export const FUEL_PHASES: readonly FuelPhase[] = [
  'taxi',
  'departure',
  'climb',
  'cruise',
  'descent',
  'approach',
  'landing',
];

function assertPositive(value: number, what: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${what} must be positive, got ${String(value)}`);
  }
}

function assertNonNegative(value: number, what: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${what} must be zero or more, got ${String(value)}`);
  }
}

/**
 * Fuel burnt over one sector.
 *
 * Takes the `BlockTimeResult` rather than the raw sector, because the phase
 * allocation is the expensive part and `computeBlockTime` has already done it —
 * and because a caller cannot then hand the two models different distances.
 *
 * ## Where the §10.4 boost applies
 *
 * To the total, at **−8%**, the largest ceiling in the table after turnaround and
 * incidents. The section's own justification is worth keeping in view: *"−8% fuel
 * is a real edge that a smarter network plan can beat."* It lands after the
 * phases are summed rather than inside them, because the doctrines that earn it —
 * cost-index discipline, continuous descent, tankering judgement (§10.3) — are
 * whole-flight habits rather than one phase's trick.
 */
export function computeFuelBurn(
  block: BlockTimeResult,
  aircraft: FuelBurnAircraft,
  boosts: readonly EfficiencyBoost[] = [],
  config: FuelBurnConfig = DEFAULT_FUEL_BURN,
): FuelBurnResult {
  assertPositive(aircraft.cruiseBurnTPerNm, 'Cruise burn');
  assertPositive(block.cruiseSpeedKt, 'Cruise speed');
  assertNonNegative(block.distanceNm, 'Sector distance');
  assertPositive(config.tripFuelFraction, 'Trip fuel fraction');
  for (const phase of FUEL_PHASES) {
    assertNonNegative(config.phaseFactors[phase], `Burn factor for ${phase}`);
  }

  // Tonnes per minute at cruise. A per-mile figure becomes a per-minute figure by
  // way of the speed those miles are covered at — and the trip-fuel haircut comes
  // off here, once, rather than in every phase.
  const cruiseTPerMin =
    ((aircraft.cruiseBurnTPerNm * config.tripFuelFraction) / 60) * block.cruiseSpeedKt;

  const minutes: Record<FuelPhase, number> = {
    taxi: taxiMinutes(block),
    departure: block.allocation.departureMinutes,
    climb: block.allocation.climbMinutes,
    cruise: block.allocation.cruiseMinutes,
    descent: block.allocation.descentMinutes,
    approach: block.allocation.approachMinutes,
    landing: block.allocation.landingMinutes,
  };

  const contributions: FuelBurnContribution[] = FUEL_PHASES.map((phase) => {
    const rate = cruiseTPerMin * config.phaseFactors[phase];
    return {
      phase,
      minutes: minutes[phase],
      tonnes: minutes[phase] * rate,
      tonnesPerHour: rate * 60,
    };
  });

  const nominal = contributions.reduce((sum, c) => sum + c.tonnes, 0);
  const { fraction, capped } = stackEfficiencyBoosts(boosts, EFFICIENCY_CEILINGS.fuelBurn);
  const saving = nominal * fraction;
  const tonnes = nominal - saving;

  // Split the total after the boost so the two halves still add up to it. Scaling
  // both by the same fraction is right rather than convenient: single-engine taxi
  // is one of the doctrines §10.3 lists, so the ground burn earns the boost too.
  const keep = 1 - fraction;
  const taxiTonnes = minutes.taxi * cruiseTPerMin * config.phaseFactors.taxi * keep;

  return {
    tonnes,
    taxiTonnes,
    airborneTonnes: tonnes - taxiTonnes,
    contributions,
    tonnesPerNm: block.distanceNm === 0 ? 0 : tonnes / block.distanceNm,
    tonnesPerBlockHour: block.blockMinutes === 0 ? 0 : tonnes / (block.blockMinutes / 60),
    boostSavingTonnes: saving,
    boostFraction: fraction,
    boostCapReached: capped,
  };
}
