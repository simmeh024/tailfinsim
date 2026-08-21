/**
 * What a disruption costs (M2-08, §8.4, §11).
 *
 * §8.4: *"Each has a cost and a reputation consequence."* This is the cost half.
 * The reputation half is §15's, and this deliberately stops at handing it a
 * magnitude — see {@link DisruptionCost.reputationImpact}.
 *
 * ## Why it is not part of `settleFlight`
 *
 * A cancelled flight never flies. It has no block time, burns no fuel, pays no
 * landing fee — every input `settleFlight` needs is absent, and calling it with
 * zeroes would produce a `flight_result` claiming the aircraft operated. But the
 * cancellation still costs real money: passengers have to be put on something
 * else, and in Europe they have to be compensated for the privilege.
 *
 * So disruption cost is its own calculation, added to an operating result when
 * the flight flew and standing alone when it did not.
 *
 * ## Calibrated against EU261, which is the only hard number available
 *
 * §8.4 gives no figures. Regulation 261/2004 does, and it is the rule that
 * actually governs the short-haul European operation §13.4 costs out: **€250 for
 * a cancellation or a 3-hour delay under 1,500 km**, plus a duty of care —
 * meals, and a hotel if it runs overnight — that is separate and open-ended.
 *
 * That is deliberately punishing relative to the fare. §13.4's airline sells
 * seats at €75, so one compensated passenger costs more than three paid for. It
 * should: the entire point of on-time performance as a mechanic is that the
 * player who ignores it loses money faster than they can explain, and a
 * compensation regime softer than the real one would make reliability a
 * cosmetic choice.
 */

import { ECONOMY_CONFIG_V1, type FlightLoad } from '@tailfin/shared';

import { roundMinor, sumMinor } from './money';

import type { DisruptionOutcome } from '../flight/disruption';

/** Where the money went when a flight went wrong. */
export type DisruptionCostSource = 'rebooking' | 'compensation' | 'care' | 'recovery';

export interface DisruptionCostLine {
  source: DisruptionCostSource;
  amountMinor: number;
  detail: string;
}

export interface DisruptionCost {
  /** Sum of {@link lines}. */
  totalMinor: number;
  lines: DisruptionCostLine[];
  /** Passengers who were on the flight, or would have been. */
  passengers: number;
  /**
   * How bad this was for the airline's standing, 0–1.
   *
   * **An input to §15, not a reputation change.** What a cancellation does to an
   * airline's compound reputation depends on how often it happens, what the
   * world median is, and how long the memory is — none of which is decided, and
   * all of which is §15's. M2-08's job is to say *how bad it was*, at the moment
   * that is knowable, and leave the consequence to the system that owns it.
   *
   * The same discipline M2-06 used for arrival delay, for the same reason.
   */
  reputationImpact: number;
}

/**
 * Balance numbers (invariant 3), retunable under §22.3.
 *
 * Money is in minor units throughout, like everything financial — see
 * `money.ts` for why that is not negotiable.
 */
export interface DisruptionCostConfig {
  /**
   * Putting one passenger on somebody else's aeroplane.
   *
   * Above the fare taken, because a seat bought at the last minute on a rival is
   * not bought at your price. §13.4's €75 average against €120 here is the
   * standard shape of the trade.
   */
  rebookingPerPassengerMinor: number;
  /** EU261's short-haul figure: €250 a head. */
  compensationPerPassengerMinor: number;
  /**
   * The delay at which compensation becomes payable.
   *
   * EU261 says three hours, and the cliff is the point — 179 minutes costs
   * nothing and 181 costs €250 a passenger, which is exactly the kind of edge a
   * player should learn to plan against.
   */
  compensationDelayThresholdMinutes: number;
  /** Meals and a hotel while they wait, per passenger per hour. */
  carePerPassengerPerHourMinor: number;
  /** Getting an aircraft and its passengers onward from where it actually landed. */
  recoveryPerPassengerMinor: number;
  /** The delay at which duty of care starts — EU261's two hours for short haul. */
  careDelayThresholdMinutes: number;
}

/**
 * What a delay, cancellation or diversion costs, as currently tuned.
 *
 * The numbers live in `ECONOMY_CONFIG_V1` in `@tailfin/shared` — the same
 * payload that is seeded into `economy_config` and retuned live (M3-11, §22.3).
 * This constant is the default parameter for the pure functions below; the
 * server reads the world's pinned config instead, and lint stops it reaching
 * for this one.
 */
export const DEFAULT_DISRUPTION_COST: DisruptionCostConfig = ECONOMY_CONFIG_V1.costs.disruption;

/** Version tag, mirroring the rest. A disruption bill has to stay explicable. */
export const DISRUPTION_COST_VERSION = 'v1' as const;

/**
 * How much each outcome hurts a reputation, before §15 decides what that means.
 *
 * A cancellation is worse than any delay, and a diversion is worse than most —
 * being taken to the wrong city is a different kind of failure from arriving
 * late in the right one. Delay severity scales with its length rather than
 * being flat, because a ten-minute delay is not a reputational event and a
 * four-hour one is.
 */
function impactOf(outcome: DisruptionOutcome, delayMinutes: number): number {
  switch (outcome) {
    case 'cancel':
      return 1;
    case 'divert':
      return 0.8;
    case 'air_return':
      return 0.9;
    case 'delay':
      // Reaches 1 at six hours, which is where a delay stops being distinguishable
      // from a cancellation in the mind of the person sitting in the terminal.
      return Math.min(1, delayMinutes / 360);
  }
}

function passengersOn(load: FlightLoad): number {
  let total = 0;
  for (const entry of Object.values(load)) {
    if (entry) total += entry.passengers;
  }
  return total;
}

function money(minor: number): string {
  return (minor / 100).toLocaleString('en-GB', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

function hours(minutes: number): string {
  return (minutes / 60).toLocaleString('en-GB', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

/**
 * What a disruption costs the airline.
 *
 * Takes the load it was carrying — or would have carried — because every line
 * here is charged per passenger. A flight nobody had booked costs nothing to
 * cancel, which is correct and is a real strategic fact: the cheapest flight to
 * cancel is the empty one, and a player who works that out has learned something
 * true about airlines.
 */
export function disruptionCost(
  outcome: DisruptionOutcome,
  delayMinutes: number,
  load: FlightLoad,
  config: DisruptionCostConfig = DEFAULT_DISRUPTION_COST,
): DisruptionCost {
  if (!Number.isFinite(delayMinutes) || delayMinutes < 0) {
    throw new Error(`Delay must be zero or more minutes, got ${String(delayMinutes)}`);
  }

  const passengers = passengersOn(load);
  const lines: DisruptionCostLine[] = [];

  // The flight is not going. Everybody aboard needs to be somewhere else.
  if (outcome === 'cancel') {
    const rebooking = roundMinor(passengers * config.rebookingPerPassengerMinor);
    if (rebooking > 0) {
      lines.push({
        source: 'rebooking',
        amountMinor: rebooking,
        detail: `${String(passengers)} passengers rebooked at ${money(config.rebookingPerPassengerMinor)} each.`,
      });
    }
  }

  // Landed somewhere nobody meant to be. Getting them onward is the airline's
  // problem, and it is a coach, not a connecting flight.
  if (outcome === 'divert' || outcome === 'air_return') {
    const recovery = roundMinor(passengers * config.recoveryPerPassengerMinor);
    if (recovery > 0) {
      lines.push({
        source: 'recovery',
        amountMinor: recovery,
        detail:
          `${String(passengers)} passengers moved onward from where the aircraft actually ` +
          `landed, at ${money(config.recoveryPerPassengerMinor)} each.`,
      });
    }
  }

  // EU261. A cancellation always pays; a delay pays once it crosses the cliff.
  const compensable =
    outcome === 'cancel' || delayMinutes >= config.compensationDelayThresholdMinutes;
  if (compensable) {
    const compensation = roundMinor(passengers * config.compensationPerPassengerMinor);
    if (compensation > 0) {
      lines.push({
        source: 'compensation',
        amountMinor: compensation,
        detail:
          outcome === 'cancel'
            ? `Regulation 261 compensation for a cancellation, ${money(config.compensationPerPassengerMinor)} a passenger.`
            : `Regulation 261 compensation — ${hours(delayMinutes)} hours late, past the ` +
              `${hours(config.compensationDelayThresholdMinutes)}-hour threshold.`,
      });
    }
  }

  // Duty of care runs from the moment they are stuck, and keeps running.
  if (delayMinutes >= config.careDelayThresholdMinutes) {
    const care = roundMinor(passengers * config.carePerPassengerPerHourMinor * (delayMinutes / 60));
    if (care > 0) {
      lines.push({
        source: 'care',
        amountMinor: care,
        detail:
          `Meals and accommodation for ${String(passengers)} passengers over ` +
          `${hours(delayMinutes)} hours.`,
      });
    }
  }

  return {
    totalMinor: sumMinor(lines.map((l) => l.amountMinor)),
    lines,
    passengers,
    reputationImpact: impactOf(outcome, delayMinutes),
  };
}
