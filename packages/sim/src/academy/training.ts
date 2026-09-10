import {
  type AcademyBalance,
  type AcademyCommissionedLevel,
  type AcademyModuleKind,
  type CrewRank,
} from '@tailfin/shared';

import { academyPermitsRank, academyTrainingSlots, crewLadderOf } from './levels';

/**
 * Where a type conversion is trained, and what it therefore costs (M9-01, §10.1).
 *
 * ## The one sentence this file implements
 *
 * > *"A Full-Flight Sim for a family you own converts crew in-house at a
 * > fraction of the cost of outsourcing."* — §10.1
 *
 * Read carefully, that sentence says the academy makes conversion **cheaper**,
 * not **possible**. §10.1's other half — *"a base without one can only hire
 * pre-qualified crew at market rates"* — says the same thing from the other
 * side: without an academy you pay the market rate, which is a price and not a
 * refusal. So a base with no academy keeps converting crew exactly as M5-01
 * shipped it, at the outsourced price, and an academy buys a discount and a
 * ceiling.
 *
 * That reading is deliberate and it is the conservative one. Making the academy
 * a *gate* on conversion would silently strip a capability from every airline in
 * every existing world on the deploy that shipped it — the release before it
 * would keep working against the schema and stop working against the game, which
 * is exactly the failure the expand rule exists to prevent, arrived at through
 * behaviour instead of DDL.
 *
 * ## What the slot actually costs you
 *
 * The finite thing is the **cheap** path. In-house training occupies one of
 * §10.1's training slots per head, and when they are gone the airline is back to
 * paying the market rate. That is the throughput limit with teeth: an academy at
 * capacity does not stop you training crew, it stops you training them cheaply,
 * and the crew are unavailable to fly either way.
 */

/** Which module carried a course, and so which rate it was charged at. */
export type TrainingProvider = 'full_flight_sim' | 'fixed_base_sim' | 'cabin_mockup';

export interface TrainingRoute {
  mode: 'in_house' | 'outsourced';
  /** Null when outsourced. */
  provider: TrainingProvider | null;
  /**
   * Why the course was not trained in-house. Null when it was.
   *
   * A closed set rather than prose, because the interface has to put this
   * beside the control that would fix it — *build a CBT suite* and *wait for a
   * slot* are different buttons.
   */
  outsourcedBecause:
    | 'no_academy'
    | 'not_commissioned'
    | 'rank_above_ceiling'
    | 'no_cbt_suite'
    | 'no_module'
    | 'slots_full'
    | null;
  /** Per head, in minor units. */
  costPerHeadMinor: number;
}

export interface TrainingAcademyState {
  /** 0 while the first level is still being built. */
  level: AcademyCommissionedLevel;
  /** Operational modules only. A module under construction teaches nobody. */
  modules: readonly { kind: AcademyModuleKind; family: string | null }[];
  /** Heads already occupying a slot here. */
  slotsInUse: number;
}

/**
 * Decide how a conversion of `heads` crew of `rank` onto `toFamily` is trained.
 *
 * `academy` is null for a base without one. `outsourcedPerHeadMinor` is
 * `crew.conversion.costPerHeadMinor` — the market rate, and the denominator of
 * §10.1's fraction.
 *
 * The whole course goes one way or the other. Splitting a course of ten heads
 * across four in-house slots and six bought-in places would be a second price on
 * one `crew_conversion` row and a number the player could not check against
 * either rate.
 */
export function trainingRoute(input: {
  academy: TrainingAcademyState | null;
  rank: CrewRank;
  toFamily: string;
  heads: number;
  outsourcedPerHeadMinor: number;
  balance: AcademyBalance;
}): TrainingRoute {
  const { academy, rank, toFamily, heads, outsourcedPerHeadMinor, balance } = input;

  const outsourced = (reason: NonNullable<TrainingRoute['outsourcedBecause']>): TrainingRoute => ({
    mode: 'outsourced',
    provider: null,
    outsourcedBecause: reason,
    costPerHeadMinor: outsourcedPerHeadMinor,
  });

  if (academy === null) return outsourced('no_academy');
  if (academy.level < 1) return outsourced('not_commissioned');
  if (!academyPermitsRank(academy.level, rank)) return outsourced('rank_above_ceiling');

  // §10.1 puts CBT at level 1 as the first thing an academy is for. Without the
  // suite the building has no curriculum, whatever else is inside it.
  const has = (kind: AcademyModuleKind, family?: string): boolean =>
    academy.modules.some(
      (module) => module.kind === kind && (family === undefined || module.family === family),
    );
  if (!has('cbt_suite')) return outsourced('no_cbt_suite');

  const provider: TrainingProvider | null =
    crewLadderOf(rank) === 'flight_deck'
      ? // The ladder §10.1 lists: the target family's own simulator is the best
        // rate, procedures training the fallback. A full-flight sim for some
        // *other* family teaches nothing about this one, which is why the family
        // is matched rather than the kind alone — and why fleet commonality pays
        // a second time here.
        has('full_flight_sim', toFamily)
        ? 'full_flight_sim'
        : has('fixed_base_sim')
          ? 'fixed_base_sim'
          : null
      : has('cabin_service_mockup')
        ? 'cabin_mockup'
        : null;
  if (provider === null) return outsourced('no_module');

  // The slot check is last, so the interface can distinguish "you cannot train
  // this here" from "you cannot train it here *yet*". Whole-course, for the
  // reason in the doc comment above.
  const free = academyTrainingSlots(academy.level, balance) - academy.slotsInUse;
  if (free < heads) return outsourced('slots_full');

  const rate =
    provider === 'full_flight_sim'
      ? balance.inHouseConversionRate.fullFlightSim
      : provider === 'fixed_base_sim'
        ? balance.inHouseConversionRate.fixedBaseSim
        : balance.inHouseConversionRate.cabinMockup;

  return {
    mode: 'in_house',
    provider,
    outsourcedBecause: null,
    // Rounded per head rather than on the total, so the movement equals the sum
    // of the rows a player would add up themselves — the same rule the crew
    // payroll fold follows.
    costPerHeadMinor: Math.round(outsourcedPerHeadMinor * rate),
  };
}
