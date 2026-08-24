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
  /**
   * Flying, or serving the rest that follows a duty (M5-02).
   *
   * Kept apart from `unavailable` because the two are different answers to the
   * same question. A crew member in a classroom is gone for a fortnight and the
   * fix is to wait; one who is resting is back tonight and the fix is to hire,
   * or to keep a reserve.
   */
  onDuty: z.number().int().nonnegative(),
  /**
   * Held back from the roster as standby (M5-02, section 9.2).
   *
   * A subset of `headcount`, not an addition to it: a reserve is an ordinary
   * crew member who is not rostered, draws the same salary, and can cover
   * anything the rest of the pool could.
   */
  reserve: z.number().int().nonnegative(),
  /**
   * Off sick (M5-03).
   *
   * A fourth bucket rather than a flavour of any other, because the fixes
   * differ: a classroom is a fortnight and you wait, a duty is a night, and
   * sickness is a *symptom* -- the fix is upstream of the roster entirely.
   */
  sick: z.number().int().nonnegative().default(0),
  /** `headcount - unavailable - onDuty`, decided by the server. */
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

/**
 * A crew set currently working or resting (M5-02).
 *
 * There is still no person here. A duty period is a span of time with a report
 * and an off-duty, which is what the regulation actually constrains, and the
 * heads on it are a count drawn from the pools.
 */
export const CrewDutyView = z.object({
  id: Uuid,
  family: z.string().min(1),
  heads: z.number().int().positive(),
  status: z.enum(['open', 'resting']),
  /** True when this set was called out from the standby designation. */
  fromReserve: z.boolean(),
  /** Game time, like everything else a world schedules. */
  reportAt: Timestamp,
  /** Null while the set is still working. */
  offDutyAt: Timestamp.nullable(),
  /** Game time the heads return to the pool. Null while still working. */
  restUntil: Timestamp.nullable(),
  sectors: z.number().int().nonnegative(),
  /** Where the crew are, which is the positioning question answered. */
  locationIcao: z.string().length(4),
  /** True when they are not at their own base, and so in a hotel. */
  awayFromBase: z.boolean(),
});
export type CrewDutyView = z.infer<typeof CrewDutyView>;

export const PayBandValue = z.enum(['lean', 'market', 'generous']);
export type PayBandValue = z.infer<typeof PayBandValue>;

export const HotelTierValue = z.enum(['budget', 'standard', 'premium']);
export type HotelTierValue = z.infer<typeof HotelTierValue>;

/** One of the four things section 9.2 says morale is made of. */
export const MoraleFactor = z.object({
  factor: z.enum(['pay', 'rosterStability', 'hotel', 'rest']),
  /** A sentence naming what the player chose, or what happened to the crew. */
  detail: z.string().min(1),
  /** This input's own score, 0-1, before weighting. */
  value: z.number().min(0).max(1),
  /** Its share of the total, 0-1. */
  weight: z.number().min(0).max(1),
  /** `value x weight`. These sum to `target`. */
  weighted: z.number().min(0).max(1),
});
export type MoraleFactor = z.infer<typeof MoraleFactor>;

/**
 * How a base feels, and why (M5-03, section 9.2).
 *
 * `score` is where morale **is**; `target` is where it is heading. They differ
 * on purpose and the gap is the mechanic: section 9.2 asks for a *delayed* bill,
 * and without a lag between choosing badly and suffering for it there is no
 * decision to make.
 *
 * `factors` is not commentary beside the number. The weighted values sum to
 * `target` exactly, which is what makes the second acceptance criterion -
 * *"morale is shown per base with its contributing factors itemised"* - mean
 * something more than a tooltip.
 */
export const CrewBaseMorale = z.object({
  score: z.number().min(0).max(1),
  target: z.number().min(0).max(1),
  payBand: PayBandValue,
  hotelTier: HotelTierValue,
  factors: z.array(MoraleFactor),
  /** Game time of the last review. Null before the worker has ever run one. */
  reviewedAt: Timestamp.nullable(),
});
export type CrewBaseMorale = z.infer<typeof CrewBaseMorale>;

export const CrewBaseView = z.object({
  id: Uuid,
  airportIcao: z.string().length(4),
  status: z.enum(['open', 'closed']),
  openedAt: Timestamp,
  pools: z.array(CrewPoolView),
  conversions: z.array(CrewConversionView),
  /**
   * Sets currently on duty or resting, newest first (M5-02).
   *
   * Bounded by the server rather than paginated: a base has as many open duty
   * periods as it has aeroplanes flying, which is a small number, and the
   * closed ones are history the page has no question for.
   */
  duty: z.array(CrewDutyView).default([]),
  /**
   * Null for a closed base, which has no crew to have a mood (M5-03).
   *
   * Defaulted, so a client built against an older payload keeps parsing.
   */
  morale: CrewBaseMorale.nullable().default(null),
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
    /**
     * What the crew already hired cost each game month (M5-02).
     *
     * Salaries plus base overhead, at today's headcount. The number section 9.2
     * wants a player to feel before they hire: *"cost money and do nothing most
     * days"* is not a trade anybody can weigh without seeing the money.
     */
    monthlyPayrollMinor: MinorUnits.default(0),
    /** Per head per night, when a rotation ends away from base. */
    hotelPerHeadPerNightMinor: MinorUnits.default(0),
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
export const SetCrewReserveInput = z
  .object({
    crewBaseId: Uuid,
    family: z.string().min(1).max(64),
    rank: CrewRank,
    /** Absolute, not a delta. The player sets a level, not a change. */
    reserve: z.number().int().nonnegative().max(1000),
  })
  .strict();
export type SetCrewReserveInput = z.infer<typeof SetCrewReserveInput>;

/**
 * The two policies that buy morale (M5-03).
 *
 * Both optional, so a player changing one need not restate the other - and
 * absent means *leave it alone* rather than *reset it*, which a required field
 * would have made impossible to express.
 */
export const SetCrewPoliciesInput = z
  .object({
    crewBaseId: Uuid,
    payBand: PayBandValue.optional(),
    hotelTier: HotelTierValue.optional(),
  })
  .strict();
export type SetCrewPoliciesInput = z.infer<typeof SetCrewPoliciesInput>;

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
