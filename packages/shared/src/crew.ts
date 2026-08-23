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

export const CrewResponse = z.object({
  bases: z.array(CrewBaseView),
  fragmentation: CrewFragmentation,
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
