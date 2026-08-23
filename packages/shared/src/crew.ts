import { z } from 'zod';

import { CrewRank } from './economy-config';
import { MinorUnits, Timestamp, Uuid } from './primitives';

/**
 * The crew wire contract (M5-01, §9.2).
 *
 * ## Counts all the way out
 *
 * Nothing here names a person, and that is the acceptance criterion rather than
 * a simplification: *"the player interacts with pool sizes and policies, never
 * with individual rosters"*. A response that carried crew members would make a
 * roster interface the obvious next thing to build, which is the failure mode the
 * issue is written to prevent.
 *
 * ## Availability is reported, never inferred by the client
 *
 * `available` is sent alongside `headcount` rather than left as a subtraction the
 * browser does. The rule for what counts as available is the server's — today it
 * is "not in a classroom", and duty and rest will make it more than that — and a
 * client that had learned to subtract would silently disagree the moment it did.
 */

export const CrewPoolView = z.object({
  id: Uuid,
  /** The aircraft family the rating is for — never a single type (§9.2). */
  family: z.string().min(1),
  rank: CrewRank,
  headcount: z.number().int().nonnegative(),
  /** In conversion training, and therefore not rosterable. */
  unavailable: z.number().int().nonnegative(),
  /** `headcount - unavailable`, decided by the server. */
  available: z.number().int().nonnegative(),
});
export type CrewPoolView = z.infer<typeof CrewPoolView>;

export const CrewConversionView = z.object({
  id: Uuid,
  fromFamily: z.string().min(1),
  toFamily: z.string().min(1),
  rank: CrewRank,
  heads: z.number().int().positive(),
  /** Game time, like everything else a world schedules. */
  startedAt: Timestamp,
  completesAt: Timestamp,
});
export type CrewConversionView = z.infer<typeof CrewConversionView>;

export const CrewBaseView = z.object({
  id: Uuid,
  airportIcao: z.string().length(4),
  status: z.enum(['open', 'closed']),
  openedAt: Timestamp,
  pools: z.array(CrewPoolView),
  conversions: z.array(CrewConversionView),
});
export type CrewBaseView = z.infer<typeof CrewBaseView>;

/**
 * What a mixed fleet is costing, stated rather than implied.
 *
 * §9.2's complaint about fleet commonality is that it *"quietly wrecks your
 * utilisation"*, so the quiet part is the bug. There is no penalty coefficient
 * behind these numbers — crew rated on one family are simply not in another's
 * pool — and the figures exist to make that arithmetic visible.
 */
export const CrewFragmentation = z.object({
  families: z.array(z.string().min(1)),
  totalAvailable: z.number().int().nonnegative(),
  largestFamilyAvailable: z.number().int().nonnegative(),
  /** Available crew outside the largest family: real, but not poolable with it. */
  strandedHeads: z.number().int().nonnegative(),
});
export type CrewFragmentation = z.infer<typeof CrewFragmentation>;

/**
 * What the fleet needs, against what the airline holds.
 *
 * ## "Required" means one departure per aeroplane, and nothing more
 *
 * The honest demand signal available in M5-01 is: for every airframe the
 * airline owns, the legal complement for its seat count on a short sector,
 * summed by family and rank. It is a **floor** — a single aeroplane flying a
 * day of rotations needs several crews, and working out how many is duty and
 * rest, which §9.2 defers and this milestone does not build.
 *
 * Named and labelled as a floor everywhere it is shown, so it cannot be
 * mistaken for a rostering answer. A number that quietly pretended to be one
 * would be worse than no number.
 *
 * ## Airline-wide, because crew are not positioned yet
 *
 * There is no positioning model, so demand cannot be attributed to a base. The
 * figures are for the whole airline; an interface that split them per base would
 * be inventing §9.2's hotelling and deadheading.
 */
export const CrewDemandRow = z.object({
  family: z.string().min(1),
  rank: CrewRank,
  /** Heads needed to launch every airframe of this family once. */
  required: z.number().int().nonnegative(),
  /** Heads the airline can actually roster, across every open base. */
  available: z.number().int().nonnegative(),
  /** `available - required`. Negative is a shortage. */
  delta: z.number().int(),
});
export type CrewDemandRow = z.infer<typeof CrewDemandRow>;

export const CrewDemand = z.object({
  rows: z.array(CrewDemandRow),
  totalRequired: z.number().int().nonnegative(),
  /**
   * Of `totalRequired`, how much is actually fieldable.
   *
   * `sum(min(available, required))` per row, **not** total available against
   * total required. Crew are not fungible: a surplus of A320neo cabin crew does
   * nothing for a shortage of 737 MAX captains, and dividing one total by the
   * other let the readiness ring read *100% covered* directly above the words
   * "not enough crew to launch your whole fleet". Seen in a sandbox, not caught
   * by a test.
   */
  metRequired: z.number().int().nonnegative(),
  /** True when no rank is short. The page says so in words as well. */
  covered: z.boolean(),
  /** Families the airline owns aircraft in but holds no crew for at all. */
  uncoveredFamilies: z.array(z.string().min(1)),
});
export type CrewDemand = z.infer<typeof CrewDemand>;

export const CrewResponse = z.object({
  bases: z.array(CrewBaseView),
  fragmentation: CrewFragmentation,
  demand: CrewDemand,
  /**
   * The aircraft families this world flies, for the hire and conversion pickers.
   *
   * Sent with the crew rather than left to the client to fetch from the
   * catalogue, and it is not a convenience: the first version of the page had a
   * free-text family box, and a stray pool rated on a family literally called
   * `test` is still sitting in the dev database because of it. A rating that
   * matches no aeroplane can never be used and cannot be spent away.
   */
  families: z.array(z.string().min(1)),
  /** What the next base, hire and conversion would cost, so the UI need not guess. */
  costs: z.object({
    baseOpeningMinor: MinorUnits,
    hireFlightDeckMinor: MinorUnits,
    hireCabinMinor: MinorUnits,
    conversionPerHeadMinor: MinorUnits,
    conversionDurationDays: z.number().int().positive(),
    weeklyHiringCapacity: z.number().int().positive(),
  }),
});
export type CrewResponse = z.infer<typeof CrewResponse>;

export const OpenCrewBaseInput = z.object({ airportIcao: z.string().length(4) }).strict();
export type OpenCrewBaseInput = z.infer<typeof OpenCrewBaseInput>;

export const HireCrewInput = z
  .object({
    crewBaseId: Uuid,
    family: z.string().min(1).max(64),
    rank: CrewRank,
    heads: z.number().int().positive().max(1000),
  })
  .strict();
export type HireCrewInput = z.infer<typeof HireCrewInput>;

export const StartCrewConversionInput = z
  .object({
    crewBaseId: Uuid,
    fromFamily: z.string().min(1).max(64),
    toFamily: z.string().min(1).max(64),
    rank: CrewRank,
    heads: z.number().int().positive().max(1000),
  })
  .strict();
export type StartCrewConversionInput = z.infer<typeof StartCrewConversionInput>;

/**
 * Why a crew operation was refused.
 *
 * A closed set rather than a message, for the reason `RotationProblem` is one:
 * the interface has to be able to offer the fix. "Not enough heads" points at a
 * pool; "hiring capacity" points at next week.
 */
export const CrewRefusal = z.enum([
  'base_exists',
  'base_absent',
  'base_closed',
  'insufficient_funds',
  'hiring_capacity',
  'not_enough_heads',
  'same_family',
]);
export type CrewRefusal = z.infer<typeof CrewRefusal>;
