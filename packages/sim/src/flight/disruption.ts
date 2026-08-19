/**
 * Whether a flight goes wrong, why, and what that costs (M2-08, §8.4, §24).
 *
 * §8.4 is two sentences — *"weather, ATC flow, technical faults, crew timeout.
 * Player choices: delay, cancel, swap aircraft, rebook. Each has a cost and a
 * reputation consequence"* — and §24 flags this as the largest unspecified
 * system after the demand model. So most of what follows is M2-08 deciding it,
 * and the decisions are marked where they are load-bearing.
 *
 * ## What this owns, and what it does not
 *
 * `machine.ts` already knows how a disrupted flight moves: `DELAY`, `CANCEL`,
 * `RETURN_TO_STAND`, `AIR_RETURN` and `DIVERT` are M1-07's, along with the rules
 * about which phases each is legal from. This module decides **whether one
 * happens and which**, and hands back something a caller turns into that command.
 *
 * The split matters because the two have different reasons to change. The
 * lifecycle is a rulebook about physical possibility and barely moves; the risk
 * model is balance, and will be retuned for as long as the game exists.
 *
 * ## Every cause is an input, not a guess
 *
 * Six causes, and this module models the *consequence* of each rather than the
 * phenomenon:
 *
 *   - **weather** at either end — M2-09 owns the weather system itself
 *   - **ATC flow** — congestion at a station, which M7's slots will supply
 *   - **technical** — airframe reliability, which M4-06's maintenance state drives
 *   - **crew timeout** — M5's duty and rest model says when a crew runs out
 *   - **ground vendor** — the handler's reliability, from §9.3's contracts
 *   - **airport closure** — §18's events, and a runway that is simply shut
 *
 * None of those systems exist. Each therefore arrives as a number on
 * {@link DisruptionRisk} rather than as a stub, which is the same boundary M2-04
 * drew around congestion and M2-05 around cruise speed. When they land, they
 * fill in a field and nothing here changes.
 *
 * ## One roll, not six
 *
 * The causes are evaluated together and **at most one wins**. Rolling each
 * independently would let a flight be cancelled for crew timeout *and* diverted
 * for weather, which is not a thing that can happen to one aeroplane — and worse,
 * it would make the total disruption rate rise with the number of causes
 * modelled, so adding a cause later would silently make the whole world worse.
 *
 * Instead: the hazards are summed into one probability that anything goes wrong,
 * and a second draw picks which. Adding a seventh cause changes the mix without
 * changing the scale.
 */

import type { FlightDisruption } from '@tailfin/shared';

import {
  EFFICIENCY_CEILINGS,
  type EfficiencyBoost,
  stackEfficiencyBoosts,
} from '../economy/boosts';
import { type Rng, chance, intBetween, weightedPick } from '../random';

/**
 * Why a flight went wrong.
 *
 * Recorded on every disruption, because M2-08's acceptance criteria ask for it
 * and because §14.1 forbids a number a player cannot interrogate. "Your flight
 * was delayed 40 minutes" is not information; "delayed 40 minutes by ATC flow
 * control at Schiphol" is something a player can plan around.
 */
export type DisruptionCause =
  | 'weather_origin'
  | 'weather_destination'
  | 'atc_flow'
  | 'technical'
  | 'crew_timeout'
  | 'ground_vendor'
  | 'airport_closure';

/** Every cause, in the order a readout should list them. */
export const DISRUPTION_CAUSES: readonly DisruptionCause[] = [
  'weather_origin',
  'weather_destination',
  'atc_flow',
  'technical',
  'crew_timeout',
  'ground_vendor',
  'airport_closure',
];

/**
 * The conditions this flight is exposed to, each 0–1.
 *
 * Zero means the cause cannot fire. That is the honest default while the systems
 * that supply these do not exist: a world with no weather model has no weather
 * disruption, rather than a made-up amount of it.
 */
export interface DisruptionRisk {
  /** Weather severity at the departure airport (M2-09). */
  weatherOrigin: number;
  /** Weather severity at the arrival airport (M2-09). */
  weatherDestination: number;
  /** How congested the airspace and slots are (M7). */
  atcFlow: number;
  /**
   * How likely this airframe is to break, 0–1.
   *
   * The inverse of condition: a new aircraft fresh from a C-check is near 0, one
   * overdue for maintenance approaches 1. M4-06 owns what moves it.
   */
  technical: number;
  /**
   * How close the assigned crew is to running out of duty hours (M5).
   *
   * A distinct cause rather than a flavour of delay, which M2-08 asks for
   * explicitly — because it is the one cause whose fix is a rostering decision
   * rather than an operational one, and a player needs to see it as such.
   */
  crewTimeout: number;
  /** How unreliable the ground handler is (§9.3). */
  groundVendor: number;
  /**
   * The airport is shut — a closure, a curfew breach, an §18 event.
   *
   * Modelled as a probability like the rest, but in practice it will be 0 or 1:
   * a runway is not slightly closed. Kept uniform so the caller does not need a
   * special case, and so a partial closure has somewhere to go if one is ever
   * modelled.
   */
  airportClosure: number;
  /**
   * §10.4's incident-rate reductions, capped at −30%.
   *
   * The largest ceiling in the table after nothing, and §10.4 is firm about why
   * it is a ceiling at all: *"a year-one player must never face an unbeatable
   * wall of stacked veteran bonuses."*
   */
  boosts: readonly EfficiencyBoost[];
}

/** A flight exposed to nothing. The baseline a test or a quiet world starts from. */
export const NO_RISK: DisruptionRisk = {
  weatherOrigin: 0,
  weatherDestination: 0,
  atcFlow: 0,
  technical: 0,
  crewTimeout: 0,
  groundVendor: 0,
  airportClosure: 0,
  boosts: [],
};

/** What actually happens to the aeroplane. Maps onto `machine.ts`'s commands. */
export type DisruptionOutcome = 'delay' | 'cancel' | 'divert' | 'air_return';

export interface DisruptionRoll {
  cause: DisruptionCause;
  outcome: DisruptionOutcome;
  /** Minutes lost. Zero for an outcome that ends the flight rather than moving it. */
  delayMinutes: number;
  /** The `flight.disruption` value this becomes, so a caller does not re-map it. */
  disruption: FlightDisruption;
  /** The chance anything went wrong at all, for the attribution readout (§14.1). */
  probability: number;
}

/**
 * How each cause behaves. Balance numbers (invariant 3), retunable under §22.3.
 *
 * `hazard` is the probability that cause fires when its risk input is 1 — the
 * worst weather, the most congested airspace, an airframe about to break. Real
 * severities are fractions of that, so the numbers below are the *ceiling* of
 * each cause rather than its everyday rate.
 *
 * `outcomes` are relative weights, not probabilities: they say a technical fault
 * is four times likelier to delay than to cancel, and normalising is
 * `weightedPick`'s job. Written as weights precisely so a retune cannot leave
 * them not summing to one.
 */
export interface CauseProfile {
  hazard: number;
  outcomes: { delay: number; cancel: number; divert: number; airReturn: number };
  /** Minutes of delay, when the outcome is a delay. Inclusive. */
  delayRange: readonly [number, number];
}

export interface DisruptionConfig {
  causes: Record<DisruptionCause, CauseProfile>;
  /**
   * The most likely any single flight can be to go wrong, however bad the day.
   *
   * A world where every flight is disrupted is not a hard world, it is a broken
   * one — the player stops being able to tell a good decision from a bad one,
   * which is the only thing that makes a simulation worth playing. 0.6 leaves
   * even a catastrophic day with flights that operate.
   */
  maxProbability: number;
}

/**
 * Calibrated to plausible short-haul on-time performance rather than to a
 * published figure, because there is not one to calibrate against — §8.4 gives
 * causes and consequences and no rates at all.
 *
 * The shape to notice is that **weather at the destination diverts and weather
 * at the origin delays**. An aeroplane that has not left yet waits on the stand;
 * one already airborne with nowhere to land goes somewhere else. That asymmetry
 * is most of what makes the two ends different causes rather than one.
 */
export const DEFAULT_DISRUPTION: DisruptionConfig = {
  causes: {
    weather_origin: {
      hazard: 0.35,
      outcomes: { delay: 8, cancel: 2, divert: 0, airReturn: 0 },
      delayRange: [15, 180],
    },
    weather_destination: {
      // Airborne with the destination below minima: the aeroplane has to go
      // somewhere, and holding only buys so much time.
      hazard: 0.3,
      outcomes: { delay: 5, cancel: 1, divert: 4, airReturn: 0 },
      delayRange: [20, 120],
    },
    atc_flow: {
      // The most common real cause and the least severe: a flow restriction is
      // a slot an hour later, not a cancelled day.
      hazard: 0.4,
      outcomes: { delay: 20, cancel: 1, divert: 0, airReturn: 0 },
      delayRange: [10, 90],
    },
    technical: {
      // The one that turns into an air return, because a fault that appears
      // after takeoff is the textbook reason to come straight back.
      hazard: 0.12,
      outcomes: { delay: 6, cancel: 3, divert: 0, airReturn: 1 },
      delayRange: [30, 240],
    },
    crew_timeout: {
      // Out of hours is out of hours. It rarely delays, because the crew that
      // has run out does not become legal by waiting a little longer.
      hazard: 0.25,
      outcomes: { delay: 2, cancel: 5, divert: 0, airReturn: 0 },
      delayRange: [45, 180],
    },
    ground_vendor: {
      // A slow handler costs the turn, not the flight.
      hazard: 0.3,
      outcomes: { delay: 15, cancel: 1, divert: 0, airReturn: 0 },
      delayRange: [10, 60],
    },
    airport_closure: {
      // Nothing is landing and nothing is leaving. The only question is whether
      // the aeroplane is already in the air.
      hazard: 0.95,
      outcomes: { delay: 2, cancel: 6, divert: 3, airReturn: 0 },
      delayRange: [60, 360],
    },
  },
  maxProbability: 0.6,
};

/**
 * Version tag, mirroring `SETTLEMENT_CONFIG_VERSION` and the rest.
 *
 * More than decoration here: a disruption is a permanent, arguable fact about a
 * player's day, and after these rates are retuned the only way to explain an old
 * one is to know which rates it ran under (invariant 4).
 */
export const DISRUPTION_CONFIG_VERSION = 'v1' as const;

const OUTCOME_TO_DISRUPTION: Record<DisruptionOutcome, FlightDisruption> = {
  delay: 'delayed',
  cancel: 'cancelled',
  divert: 'diverted',
  air_return: 'air_return',
};

function riskOf(risk: DisruptionRisk, cause: DisruptionCause): number {
  switch (cause) {
    case 'weather_origin':
      return risk.weatherOrigin;
    case 'weather_destination':
      return risk.weatherDestination;
    case 'atc_flow':
      return risk.atcFlow;
    case 'technical':
      return risk.technical;
    case 'crew_timeout':
      return risk.crewTimeout;
    case 'ground_vendor':
      return risk.groundVendor;
    case 'airport_closure':
      return risk.airportClosure;
  }
}

function assertFraction(value: number, what: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${what} must be between 0 and 1, got ${String(value)}`);
  }
}

/**
 * Each cause's contribution to the chance of something going wrong.
 *
 * Exported because it is the attribution readout §14.1 asks for: a player
 * looking at a delayed flight should be able to see that it was 70% likely to be
 * ATC and 20% weather, not merely that ATC is what happened. That is also the
 * difference between a system a player can plan against and one that feels
 * arbitrary.
 */
export function causeHazards(
  risk: DisruptionRisk,
  config: DisruptionConfig = DEFAULT_DISRUPTION,
): { cause: DisruptionCause; hazard: number }[] {
  return DISRUPTION_CAUSES.map((cause) => {
    const exposure = riskOf(risk, cause);
    assertFraction(exposure, `Risk for ${cause}`);
    return { cause, hazard: exposure * config.causes[cause].hazard };
  });
}

/**
 * The chance this flight goes wrong at all, before anything is drawn.
 *
 * Split out from {@link rollDisruption} rather than buried inside it, for two
 * reasons that turned out to be the same reason. §14.1 wants a player able to
 * see *"this flight is 22% likely to be disrupted, mostly ATC"* without waiting
 * to find out — and a probability that can only be observed by rolling is one
 * that cannot be tested independently of the draw either.
 */
export function disruptionProbability(
  risk: DisruptionRisk,
  config: DisruptionConfig = DEFAULT_DISRUPTION,
): number {
  const total = causeHazards(risk, config).reduce((sum, h) => sum + h.hazard, 0);
  if (total <= 0) return 0;

  // §10.4, capped at −30%. Applied to the chance of anything happening rather
  // than to the severity of what does: research and training stop incidents,
  // they do not make a closed airport reopen sooner.
  const { fraction } = stackEfficiencyBoosts(risk.boosts, EFFICIENCY_CEILINGS.incidentRate);

  // Summed, then clamped. Summing overstates slightly when several causes are
  // live at once — two independent 30% hazards are 51%, not 60% — and the
  // overstatement is deliberate: a day with bad weather *and* a broken handler
  // *should* feel worse than the arithmetic of independence suggests, and the
  // clamp stops it running away.
  return Math.min(total * (1 - fraction), config.maxProbability);
}

/**
 * Roll for disruption on one flight.
 *
 * `rng` should be the flight's **own** stream — `deriveRng(worldSeed, 'flight',
 * flightId)` — so the answer depends on which flight it is rather than on how
 * many were rolled before it. That is what makes M2-08's first acceptance
 * criterion true across restarts, batches and two workers racing.
 *
 * Returns null when nothing went wrong, which is the common case and is not an
 * absence of information: the probability that produced it is on every roll that
 * does happen, and `causeHazards` is callable without rolling at all.
 */
export function rollDisruption(
  rng: Rng,
  risk: DisruptionRisk,
  config: DisruptionConfig = DEFAULT_DISRUPTION,
): DisruptionRoll | null {
  const hazards = causeHazards(risk, config);
  const probability = disruptionProbability(risk, config);
  if (probability <= 0) return null;

  if (!chance(rng, probability)) return null;

  // Which cause. Weighted by hazard, so the likeliest explanation is the likeliest
  // to be the one that fired — the property that makes attribution honest rather
  // than merely present.
  const cause = weightedPick(
    rng,
    hazards.map((h) => [h.cause, h.hazard] as const),
  );

  const profile = config.causes[cause];
  const outcome = weightedPick(rng, [
    ['delay', profile.outcomes.delay] as const,
    ['cancel', profile.outcomes.cancel] as const,
    ['divert', profile.outcomes.divert] as const,
    ['air_return', profile.outcomes.airReturn] as const,
  ]);

  const [low, high] = profile.delayRange;
  const delayMinutes = outcome === 'delay' ? intBetween(rng, low, high) : 0;

  return {
    cause,
    outcome,
    delayMinutes,
    disruption: OUTCOME_TO_DISRUPTION[outcome],
    probability,
  };
}

/**
 * Whether an outcome is still possible from the phase the flight is actually in.
 *
 * `machine.ts` owns the rule and refuses the command; this asks the question
 * *before* the roll is turned into one, so a caller can pick a legal outcome
 * rather than discovering an illegal one and dropping the disruption on the
 * floor. The two must agree, and the test asserts they do.
 *
 * The case that makes it necessary: a technical fault rolled while the aircraft
 * is at the gate can cancel, but the same fault rolled in the cruise cannot —
 * the aeroplane is airborne and has to land somewhere.
 */
export function outcomeIsPossible(outcome: DisruptionOutcome, airborne: boolean): boolean {
  switch (outcome) {
    case 'cancel':
      return !airborne;
    case 'divert':
    case 'air_return':
      return airborne;
    case 'delay':
      return true;
  }
}

/**
 * The same roll, made legal for where the flight actually is.
 *
 * A cancellation rolled in the cruise becomes an air return; a diversion rolled
 * on the stand becomes a delay. The **cause is never rewritten** — what went
 * wrong is a fact, and only what it does about it depends on the phase.
 */
export function applicableOutcome(roll: DisruptionRoll, airborne: boolean): DisruptionRoll {
  if (outcomeIsPossible(roll.outcome, airborne)) return roll;

  const outcome: DisruptionOutcome = airborne ? 'air_return' : 'delay';
  return { ...roll, outcome, disruption: OUTCOME_TO_DISRUPTION[outcome] };
}
