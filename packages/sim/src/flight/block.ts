/**
 * Block time — off-blocks to on-blocks (M2-05, §3.3, §10.4).
 *
 * The industry's measure, and the one that costs money: the clock starts when
 * the aircraft is pushed back and stops when it is parked. It is what crew are
 * paid for, what maintenance is allocated against, and what a schedule has to
 * fit between two slots.
 *
 * ## It is not the flying time
 *
 * `airborneMinutes` in `profile.ts` already answers *"how long is it in the
 * air"*, including the manoeuvre allowance that stops a 100 nm hop claiming to
 * take 13 minutes. Block time is that plus taxi at both ends, and the gap is
 * large: an ATR 72 from Amsterdam to London is about **55 airborne minutes and
 * about 75 block minutes**. Twenty minutes of taxi on a 199 nm sector is a fifth
 * of the cost of operating it, which is exactly why short-haul economics are
 * unforgiving.
 *
 * That distinction is worth stating because M2-05's acceptance criterion asks
 * for *"AMS–LHR in an ATR 72 yields ~55 min block time"*, and 55 minutes is the
 * **airborne** figure under this model, not the block figure. Both are returned,
 * so a reader can check either — see the test, which asserts both.
 */

import {
  EFFICIENCY_CEILINGS,
  type EfficiencyBoost,
  stackEfficiencyBoosts,
} from '../economy/boosts';

import {
  type AirborneAllocation,
  airborneMinutes,
  allocateAirborne,
  type FlightProfile,
} from './profile';

export interface BlockTimeResult {
  /** Off-blocks to on-blocks. What the schedule and the crew clock care about. */
  blockMinutes: number;
  /**
   * The sector this was computed for, echoed back.
   *
   * Carried rather than left to the caller so that `computeFuelBurn` can take a
   * `BlockTimeResult` alone and be unable to disagree with it about how far the
   * aircraft flew or how fast — the two figures have to come from one sector or
   * the block time and the fuel bill stop reconciling (invariant 4).
   */
  distanceNm: number;
  cruiseSpeedKt: number;
  /** Stand to holding point. */
  taxiOutMinutes: number;
  /** Wheels-up to wheels-down, including the manoeuvre allowance. */
  airborneMinutes: number;
  /** Runway to stand. */
  taxiInMinutes: number;
  /** How the airborne time splits across the phases, from `allocateAirborne`. */
  allocation: AirborneAllocation;
  /** Minutes removed by §10.4 boosts. Zero or negative-of-nothing when none apply. */
  boostSavingMinutes: number;
  /** The reduction actually applied, 0–1, after diminishing returns and the ceiling. */
  boostFraction: number;
  /** Whether §10.4's −4% ceiling clipped it. */
  boostCapReached: boolean;
}

/**
 * Block minutes for one sector.
 *
 * ## Where the §10.4 boost applies
 *
 * The table calls the row *"Block time reduction (taxi/routing efficiency)"* and
 * caps it at **−4%**. The parenthetical names the **mechanism** — you earn it by
 * taxiing and routing better — not the base the percentage applies to: a boost
 * of 2% is 2% of block time, the same way a turnaround boost of 2% is 2% of the
 * turn.
 *
 * The ceiling being 4% rather than 20% is the design doc's own acknowledgement
 * that most of block time is cruise, and no amount of research makes the
 * aircraft fly faster.
 */
export function computeBlockTime(
  distanceNm: number,
  cruiseSpeedKt: number,
  profile: FlightProfile,
  boosts: readonly EfficiencyBoost[] = [],
  options: { fromCruise?: boolean } = {},
): BlockTimeResult {
  // `airborneMinutes` validates distance and speed, and throws with a message
  // naming which was wrong — no reason to check them twice.
  const airborne = airborneMinutes(distanceNm, cruiseSpeedKt, profile);
  const allocation = allocateAirborne(distanceNm, cruiseSpeedKt, profile, options);

  if (!Number.isFinite(profile.taxiOutMinutes) || profile.taxiOutMinutes < 0) {
    throw new Error(`Taxi out must be zero or more minutes, got ${String(profile.taxiOutMinutes)}`);
  }
  if (!Number.isFinite(profile.taxiInMinutes) || profile.taxiInMinutes < 0) {
    throw new Error(`Taxi in must be zero or more minutes, got ${String(profile.taxiInMinutes)}`);
  }

  const nominal = profile.taxiOutMinutes + airborne + profile.taxiInMinutes;
  const { fraction, capped } = stackEfficiencyBoosts(boosts, EFFICIENCY_CEILINGS.blockTime);
  const saving = nominal * fraction;

  return {
    blockMinutes: nominal - saving,
    distanceNm,
    cruiseSpeedKt,
    taxiOutMinutes: profile.taxiOutMinutes,
    airborneMinutes: airborne,
    taxiInMinutes: profile.taxiInMinutes,
    allocation,
    boostSavingMinutes: saving,
    boostFraction: fraction,
    boostCapReached: capped,
  };
}

/** Block time in hours, which is the unit crew and maintenance are costed in. */
export function blockHours(result: BlockTimeResult): number {
  return result.blockMinutes / 60;
}

/** Minutes with an engine running on the ground, which is what taxi fuel is burnt over. */
export function taxiMinutes(result: BlockTimeResult): number {
  return result.taxiOutMinutes + result.taxiInMinutes;
}
