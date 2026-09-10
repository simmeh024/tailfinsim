import { z } from 'zod';

import { type CabinRank, CrewRank, type FlightDeckRank } from './economy-config';
import { MinorUnits, Timestamp, Uuid } from './primitives';

/**
 * The training academy — identity and the wire contract (M9-01, §10.1).
 *
 * ## The rule the whole file is arranged around
 *
 * > **Academy level gates the ceiling. It does not grant the boost.**
 *
 * §10 says it twice and CLAUDE.md repeats it, because it is the thing that makes
 * §10 a progression system rather than a shop. Levelling the facility unlocks
 * *which tiers of boost are researchable at all*; the research is M9-05's and the
 * boost is M9-06's, and neither is reachable by paying for a building. So nothing
 * in this file returns a multiplier, a coefficient or a percentage — the only
 * things a level yields are a **rank ceiling**, a **research tier ceiling** and a
 * **slot count**, and every one of them is a permission.
 *
 * ## Why the table is here and the prices are not
 *
 * The same split the aircraft catalogue already draws: *the dates are the
 * catalogue's, the rates are the economy's*. Which rank a Flight Academy may
 * train, and that level 4 is where widebodies start, is **design** — moving
 * Captain from level 4 to level 3 is a redesign of §10.1, not a retune. What a
 * level costs to build, how many weeks it takes, what it costs a month and how
 * many crew fit through it at once are **balance**, and live in
 * `AcademyBalance` in the economy config, versioned and retunable per world.
 *
 * Keeping the two apart means a world can make training dear without inventing a
 * sixth level, and a `cash_movement` can always say which of the two explained
 * its amount.
 */

/** The five levels of §10.1's table. Level 0 is a building site, not a level. */
export const ACADEMY_MAX_LEVEL = 5;

export const AcademyLevel = z.number().int().min(1).max(ACADEMY_MAX_LEVEL);
export type AcademyLevel = z.infer<typeof AcademyLevel>;

/**
 * The commissioned level as it is *stored*, where 0 means "site established,
 * first level still under construction".
 *
 * Named apart from {@link AcademyLevel} because 0 is not a level and a reader
 * has to know which of the two a parameter means. **The compiler does not
 * enforce it** — both infer to `number`, so an assertion between them is a
 * no-op and lint removes it. The guard is the zod schema at the wire boundary
 * and the `academy_level_range` check in the database; `levelBalance` throws
 * rather than returning `undefined` if 0 reaches it anyway.
 */
export const AcademyCommissionedLevel = z.number().int().min(0).max(ACADEMY_MAX_LEVEL);
export type AcademyCommissionedLevel = z.infer<typeof AcademyCommissionedLevel>;

/** §10.1's four research tiers. The ceiling only — the tree itself is M9-05. */
export const ResearchTier = z.number().int().min(1).max(4);
export type ResearchTier = z.infer<typeof ResearchTier>;

/**
 * One row of §10.1's level table.
 *
 * Two rank ceilings rather than one, because §10.1's *"Trainable up to"* column
 * carries both ladders in the same cell — level 2 reads *"Senior Cabin Crew,
 * FO"* and level 3 *"Purser, Senior FO"*. Folding them into a single rank would
 * mean picking one ladder's progression and inventing the other's.
 */
export interface AcademyLevelDefinition {
  level: AcademyLevel;
  /** §10.1's name for the level. What the player sees on the building. */
  name: string;
  /** The ceiling in prose, from §10.1's *"Unlocks"* column. Never a percentage. */
  unlocks: string;
  /**
   * The highest flight-deck rank this level may train.
   *
   * **Null at level 1**, which is the only honest reading of *"Basic CBT,
   * induction"*: a training room is not a place a first officer is made. A
   * level-1 academy trains cabin crew and nothing on the flight deck.
   */
  flightDeckUpTo: FlightDeckRank | null;
  /** The highest cabin rank this level may train. Every level trains someone. */
  cabinUpTo: CabinRank;
  /** The highest research tier this level makes *researchable* (M9-05). */
  researchTier: ResearchTier;
}

/**
 * §10.1's table, verbatim where it is explicit and reasoned where it is not.
 *
 * Two cells needed a decision:
 *
 *   - **`cabin_service_manager` at level 4.** §10.1's column stops at Purser
 *     (level 3) and never names the top cabin rank, but level 4 is where
 *     widebodies arrive and `cabinServiceManagerFromSeats` is 250 — the CSM
 *     *is* the widebody cabin rank, so the level that unlocks widebody types is
 *     the level that trains the crew they legally require. Anywhere else and a
 *     player could buy a widebody they were forbidden to crew.
 *   - **No flight deck at level 1.** See {@link AcademyLevelDefinition.flightDeckUpTo}.
 *
 * `cadet` appears nowhere as a ceiling. §10.1 puts the cadet programme at level
 * 5, which is a *source* of cadets rather than a rank you convert someone up to,
 * and it is M9-04's to build.
 */
export const ACADEMY_LEVELS: readonly AcademyLevelDefinition[] = [
  {
    level: 1,
    name: 'Training Room',
    unlocks: 'Basic CBT and induction',
    flightDeckUpTo: null,
    cabinUpTo: 'cabin_crew',
    researchTier: 1,
  },
  {
    level: 2,
    name: 'Training Centre',
    unlocks: 'Type conversion for narrowbody',
    flightDeckUpTo: 'first_officer',
    cabinUpTo: 'senior_cabin_crew',
    researchTier: 1,
  },
  {
    level: 3,
    name: 'Flight Academy',
    unlocks: 'Fixed-base sims and the purser programme',
    flightDeckUpTo: 'senior_first_officer',
    cabinUpTo: 'purser',
    researchTier: 2,
  },
  {
    level: 4,
    name: 'Full-Flight Sim Centre',
    unlocks: 'Full-motion sims and widebody types',
    flightDeckUpTo: 'captain',
    cabinUpTo: 'cabin_service_manager',
    researchTier: 3,
  },
  {
    level: 5,
    name: 'Centre of Excellence',
    unlocks: 'ULH and ETOPS, the cadet programme, and your own Training Captains',
    flightDeckUpTo: 'training_captain',
    cabinUpTo: 'cabin_service_manager',
    researchTier: 4,
  },
];

/** The §10.1 row for a commissioned level, or null for a building site. */
export function academyLevelDefinition(
  level: AcademyCommissionedLevel,
): AcademyLevelDefinition | null {
  return ACADEMY_LEVELS.find((row) => row.level === level) ?? null;
}

/**
 * §10.1's modules, built inside the academy and independently of each other.
 *
 * *"Modules determine **what** you can train; academy level determines **how
 * far**."* Two of them are read by a mechanic today — see
 * {@link ACADEMY_MODULES} for which, and for why the rest are priced and
 * buildable before anything consumes them.
 */
export const AcademyModuleKind = z.enum([
  'cbt_suite',
  'cabin_service_mockup',
  'emergency_drill',
  'fixed_base_sim',
  'full_flight_sim',
  'ground_ops_bay',
  'dispatch_lab',
]);
export type AcademyModuleKind = z.infer<typeof AcademyModuleKind>;
export const ACADEMY_MODULE_KINDS = AcademyModuleKind.options;

export interface AcademyModuleDefinition {
  kind: AcademyModuleKind;
  name: string;
  /** What it is for, in the words §10.1 uses. */
  purpose: string;
  /**
   * True for the one module that is built **per aircraft family** (§10.1 names
   * it that way and no other). A full-flight sim is a specific aeroplane's
   * cockpit; the rest are rooms.
   */
  perFamily: boolean;
  /**
   * The academy level this module may first be installed at.
   *
   * Drawn from §10.1's own *"Unlocks"* column rather than invented: fixed-base
   * sims arrive at level 3 and full-motion sims at level 4, so a module cannot
   * be bought ahead of the building that houses it.
   */
  fromLevel: AcademyLevel;
  /**
   * Whether a mechanic reads this module **today**.
   *
   * Recorded rather than left to be discovered. Three modules are priced,
   * buildable and inert: `emergency_drill` is recurrent safety training,
   * `ground_ops_bay` is §9.3's self-handling school and `dispatch_lab` is
   * §14's performance work, and each belongs to a milestone that is not this
   * one. Building one costs real money for a capability that does not exist
   * yet, so the interface must be able to say so — which it cannot do if the
   * fact only lives in a comment.
   */
  readToday: boolean;
}

/**
 * The seven modules, with what each one actually does today.
 *
 * ## Which modules have teeth, and why only these
 *
 * §10.1 states one module effect outright: *"A Full-Flight Sim for a family you
 * own converts crew in-house at a fraction of the cost of outsourcing."* That
 * sentence is the whole in-house training path, and it is what M9-01 wires:
 *
 *   - `cbt_suite` — induction, and so the **prerequisite for training anybody
 *     in-house**. §10.1 puts CBT at level 1 as the first thing an academy is
 *     for; an academy without it is a building with no curriculum.
 *   - `fixed_base_sim` / `full_flight_sim` — the flight-deck ladder. An FBS
 *     converts pilots in-house; an FFS for the *target* family does it at the
 *     better rate, which is the sentence above made into a number.
 *   - `cabin_service_mockup` — the cabin equivalent.
 *
 * The other three are deliberately inert (see
 * {@link AcademyModuleDefinition.readToday}). Inventing effects for them would
 * be guessing at §9.3's and §14's mechanics from inside §10.
 */
export const ACADEMY_MODULES: readonly AcademyModuleDefinition[] = [
  {
    kind: 'cbt_suite',
    name: 'CBT Suite',
    purpose: 'Computer-based training and induction. Nothing is taught in-house without it.',
    perFamily: false,
    fromLevel: 1,
    readToday: true,
  },
  {
    kind: 'cabin_service_mockup',
    name: 'Cabin Service Mock-up',
    purpose: 'Cabin crew service and door training, in-house.',
    perFamily: false,
    fromLevel: 1,
    readToday: true,
  },
  {
    kind: 'emergency_drill',
    name: 'Emergency & Wet Drill',
    purpose: 'Recurrent safety, evacuation and ditching drills.',
    perFamily: false,
    fromLevel: 2,
    readToday: false,
  },
  {
    kind: 'fixed_base_sim',
    name: 'Fixed-Base Sim',
    purpose: 'Procedures training for the flight deck. Converts pilots in-house.',
    perFamily: false,
    fromLevel: 3,
    readToday: true,
  },
  {
    kind: 'full_flight_sim',
    name: 'Full-Flight Sim',
    purpose: 'Full-motion simulator for one aircraft family. The cheapest way to convert onto it.',
    perFamily: true,
    fromLevel: 4,
    readToday: true,
  },
  {
    kind: 'ground_ops_bay',
    name: 'Ground Ops Bay',
    purpose: 'Ramp, loading and pushback training for a self-handling station (§9.3).',
    perFamily: false,
    fromLevel: 2,
    readToday: false,
  },
  {
    kind: 'dispatch_lab',
    name: 'Dispatch & Performance Lab',
    purpose: 'Flight planning, performance and load control (§14).',
    perFamily: false,
    fromLevel: 3,
    readToday: false,
  },
];

export function academyModuleDefinition(kind: AcademyModuleKind): AcademyModuleDefinition {
  const found = ACADEMY_MODULES.find((row) => row.kind === kind);
  /* istanbul ignore next -- the enum and the table are held in step by a test. */
  if (!found) throw new Error(`No academy module definition for ${kind}`);
  return found;
}

// ---------------------------------------------------------------------------
// The wire contract
// ---------------------------------------------------------------------------

export const AcademyBuildStatus = z.enum(['under_construction', 'operational']);
export type AcademyBuildStatus = z.infer<typeof AcademyBuildStatus>;

export const AcademyModuleView = z
  .object({
    id: Uuid,
    kind: AcademyModuleKind,
    /** The aircraft family, for `full_flight_sim` only. Null for every other kind. */
    family: z.string().min(1).nullable(),
    status: AcademyBuildStatus,
    /**
     * **Game** time, like every other span inside a world (ADR-0026).
     *
     * §10.1 says construction takes *real* weeks, and that sentence is one of
     * the four ADR-0026 names as belonging to a system that did not exist when
     * it was written: *"unless a span is genuinely a real-world quantity in the
     * way an exchange rate is, it is measured on the world's clock, and the
     * burden is on the exception to argue for itself."* A building put up at a
     * crew base, staffed and teaching the world's crew cannot make that
     * argument, and a wall clock here would mean a world at 4× was specifically
     * and only worse at building academies — TIME-01's finding about factory
     * orders, in a second place.
     *
     * The acceptance criterion the *"real weeks"* sentence exists to serve —
     * **build time cannot be shortened with money** — is kept in full, and kept
     * structurally: no field, endpoint or balance lever moves this instant
     * closer. See `docs/training-academy.md`.
     */
    readyAt: Timestamp,
    /** Null while still under construction. */
    installedAt: Timestamp.nullable(),
  })
  .strict();
export type AcademyModuleView = z.infer<typeof AcademyModuleView>;

/** What a level or module would cost, and how long it would take. */
export const AcademyBuildQuote = z
  .object({
    capitalCostMinor: MinorUnits.nonnegative(),
    /** Weeks of the **world's** calendar (ADR-0026). Never shortened by money. */
    buildWeeks: z.number().int().positive(),
    monthlyUpkeepMinor: MinorUnits.nonnegative(),
  })
  .strict();
export type AcademyBuildQuote = z.infer<typeof AcademyBuildQuote>;

/** A module the academy could build next, priced, with any reason it cannot. */
export const AcademyModuleOffer = z
  .object({
    kind: AcademyModuleKind,
    name: z.string().min(1),
    purpose: z.string().min(1),
    perFamily: z.boolean(),
    fromLevel: AcademyLevel,
    /** False for a module that is priced and buildable but that nothing reads yet. */
    readToday: z.boolean(),
    quote: AcademyBuildQuote,
    /** Families this academy could still build a full-flight sim for. Empty unless `perFamily`. */
    availableFamilies: z.array(z.string().min(1)).default([]),
    /** Null when it can be built now; otherwise why not, for the interface to place. */
    blockedBy: z.enum(['level', 'already_built', 'under_construction']).nullable().default(null),
  })
  .strict();
export type AcademyModuleOffer = z.infer<typeof AcademyModuleOffer>;

/**
 * What one academy permits — the ceiling, and nothing but the ceiling.
 *
 * There is deliberately no multiplier on this object. If a future field here
 * would change how well anything performs rather than what is *allowed*, it
 * belongs to M9-05's research or M9-06's boosts and not to the building.
 */
export const AcademyCeiling = z
  .object({
    flightDeckUpTo: CrewRank.nullable(),
    cabinUpTo: CrewRank,
    /** The highest research tier this level makes researchable (M9-05 owns the tree). */
    researchTier: ResearchTier,
    /** Crew who may be in training here at once. Finite, and the throughput limit. */
    trainingSlots: z.number().int().nonnegative(),
    /** Slots taken by conversions running here right now. */
    slotsInUse: z.number().int().nonnegative(),
  })
  .strict();
export type AcademyCeiling = z.infer<typeof AcademyCeiling>;

export const AcademyView = z
  .object({
    id: Uuid,
    crewBaseId: Uuid,
    airportIcao: z.string().length(4),
    /** 0 while the first level is still being built. */
    level: AcademyCommissionedLevel,
    /** §10.1's name for the commissioned level. Null at level 0. */
    levelName: z.string().min(1).nullable(),
    /** The level being built toward, or null when nothing is under construction. */
    pendingLevel: AcademyLevel.nullable(),
    /** Game time (see {@link AcademyModuleView.readyAt}). Null when nothing is building. */
    constructionReadyAt: Timestamp.nullable(),
    /**
     * Null at level 0: a building site permits nothing.
     *
     * The interface must not fall back to level 1's ceiling while the level-1
     * building is still going up — that is exactly the *"pay to skip the wait"*
     * the third acceptance criterion forbids, arrived at by accident.
     */
    ceiling: AcademyCeiling.nullable(),
    modules: z.array(AcademyModuleView),
    /** What the next level would cost. Null once level 5 is commissioned. */
    nextLevel: AcademyBuildQuote.nullable(),
    /** Every module kind, priced, with what currently blocks it. */
    moduleOffers: z.array(AcademyModuleOffer),
    /** Level upkeep plus every operational module's, per game month. */
    monthlyUpkeepMinor: MinorUnits.nonnegative(),
  })
  .strict();
export type AcademyView = z.infer<typeof AcademyView>;

/** A base with no academy yet, and what founding one there would cost. */
export const AcademySiteView = z
  .object({
    crewBaseId: Uuid,
    airportIcao: z.string().length(4),
    quote: AcademyBuildQuote,
  })
  .strict();
export type AcademySiteView = z.infer<typeof AcademySiteView>;

export const AcademiesResponse = z
  .object({
    academies: z.array(AcademyView),
    /** Open crew bases without one. §10.1: one academy per base, or none. */
    sites: z.array(AcademySiteView),
    /** The families this world flies, for the full-flight sim picker. */
    families: z.array(z.string().min(1)),
    /**
     * What a conversion costs when it is **not** trained in-house.
     *
     * Sent so the saving an academy buys is legible next to its price. §10.1's
     * *"a fraction of the cost of outsourcing"* is only a decision if the
     * player can see both halves of the fraction.
     */
    outsourcedConversionPerHeadMinor: MinorUnits.nonnegative(),
  })
  .strict();
export type AcademiesResponse = z.infer<typeof AcademiesResponse>;

export const FoundAcademyInput = z.object({ crewBaseId: Uuid }).strict();
export type FoundAcademyInput = z.infer<typeof FoundAcademyInput>;

/**
 * Building a module.
 *
 * `family` is required for `full_flight_sim` and refused for everything else,
 * checked here rather than in the handler so a malformed pair is a 400 from the
 * schema and never reaches a query.
 */
export const BuildAcademyModuleInput = z
  .object({
    kind: AcademyModuleKind,
    family: z.string().min(1).max(64).optional(),
  })
  .strict()
  .refine((input) => (input.kind === 'full_flight_sim') === (input.family !== undefined), {
    message: 'A full-flight sim names one aircraft family; no other module takes one',
    path: ['family'],
  });
export type BuildAcademyModuleInput = z.infer<typeof BuildAcademyModuleInput>;

/**
 * The closed set of reasons an academy request is refused.
 *
 * Codes rather than prose, for the reason `CrewRefusal` is: these have to be
 * placed next to a specific control, and a sentence cannot be placed.
 */
export const AcademyRefusal = z.enum([
  'base_absent',
  'base_closed',
  'academy_exists',
  'academy_absent',
  'already_building',
  'max_level',
  'module_exists',
  'module_level',
  'unknown_family',
  'insufficient_funds',
]);
export type AcademyRefusal = z.infer<typeof AcademyRefusal>;
