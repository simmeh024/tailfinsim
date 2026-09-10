import {
  ACADEMY_LEVELS,
  ACADEMY_MAX_LEVEL,
  academyLevelDefinition,
  CabinRank,
  FlightDeckRank,
  type AcademyBalance,
  type AcademyCommissionedLevel,
  type AcademyLevel,
  type AcademyLevelBalance,
  type AcademyModuleBalance,
  type AcademyModuleKind,
  type CrewRank,
  type ResearchTier,
} from '@tailfin/shared';

/**
 * What an academy level permits, and what it costs (M9-01, §10.1).
 *
 * Pure, like everything in `@tailfin/sim`: the §10.1 table arrives as
 * `@tailfin/shared`'s `ACADEMY_LEVELS` and the money arrives as an
 * `AcademyBalance`, so this file holds **no balance literal** — CONTRIBUTING's
 * invariant 3, and the reason a world can reprice training without a deploy.
 *
 * ## Everything here answers "may I?", never "how well?"
 *
 * The rule §10 is built on is that *academy level gates the ceiling and does not
 * grant the boost*. So no function below returns a multiplier applied to
 * anything a flight does, and none should ever be added: a level yields a rank
 * ceiling, a research-tier ceiling and a slot count, and all three are
 * permissions. The performance side of §10 is M9-05's research and M9-06's
 * boosts, and it has to stay reachable only by earning it.
 */

/** The two crew ladders, in promotion order, as §10.1's ceiling is read against. */
const FLIGHT_DECK_ORDER: readonly CrewRank[] = FlightDeckRank.options;
const CABIN_ORDER: readonly CrewRank[] = CabinRank.options;

/** Which ladder a rank is on. Every `CrewRank` is on exactly one. */
export function crewLadderOf(rank: CrewRank): 'flight_deck' | 'cabin' {
  return FLIGHT_DECK_ORDER.includes(rank) ? 'flight_deck' : 'cabin';
}

/**
 * May an academy at this level train up to this rank?
 *
 * False at level 0 for every rank, which is the whole of the third acceptance
 * criterion in one line: a building site permits nothing, and there is no
 * argument — a payment, a world speed, a retune — that turns it into a level 1.
 */
export function academyPermitsRank(level: AcademyCommissionedLevel, rank: CrewRank): boolean {
  const definition = academyLevelDefinition(level);
  if (definition === null) return false;
  if (crewLadderOf(rank) === 'flight_deck') {
    const ceiling = definition.flightDeckUpTo;
    if (ceiling === null) return false;
    return FLIGHT_DECK_ORDER.indexOf(rank) <= FLIGHT_DECK_ORDER.indexOf(ceiling);
  }
  return CABIN_ORDER.indexOf(rank) <= CABIN_ORDER.indexOf(definition.cabinUpTo);
}

/**
 * The highest research tier this level makes **researchable** (M9-05).
 *
 * Null at level 0, and null is not zero: an academy under construction has no
 * tier rather than a tier of none, the same distinction `crew_base.morale` draws
 * between *never reviewed* and *nothing*.
 *
 * Nothing in M9-01 reads the returned number. It is the ceiling M9-05's tree
 * will be gated on, and the first acceptance criterion — *"levelling the academy
 * unlocks researchable tiers but grants no boost by itself"* — is proved by that
 * being all it is.
 */
export function academyResearchTier(level: AcademyCommissionedLevel): ResearchTier | null {
  return academyLevelDefinition(level)?.researchTier ?? null;
}

/** Crew who may be in training at once. Zero while the first level is going up. */
export function academyTrainingSlots(
  level: AcademyCommissionedLevel,
  balance: AcademyBalance,
): number {
  if (level < 1) return 0;
  return levelBalance(level, balance).trainingSlots;
}

/**
 * The balance row for a commissioned level.
 *
 * Throws on 0, which is a building site and has no row. `AcademyLevel` and
 * `AcademyCommissionedLevel` both infer to `number`, so the type system will not
 * catch that — without this the caller would get
 * `Cannot read properties of undefined`, naming neither the level nor the
 * function that was handed it.
 */
export function levelBalance(level: AcademyLevel, balance: AcademyBalance): AcademyLevelBalance {
  const row = balance.levels[String(level) as '1' | '2' | '3' | '4' | '5'] as
    AcademyLevelBalance | undefined;
  if (row === undefined) {
    throw new Error(`No academy balance for level ${String(level)}; levels run 1-5`);
  }
  return row;
}

export function moduleBalance(
  kind: AcademyModuleKind,
  balance: AcademyBalance,
): AcademyModuleBalance {
  return balance.modules[kind];
}

/** The next level this academy could build, or null once level 5 is commissioned. */
export function nextAcademyLevel(level: AcademyCommissionedLevel): AcademyLevel | null {
  return level >= ACADEMY_MAX_LEVEL ? null : level + 1;
}

/**
 * When a build started at `gameStartedAt` finishes.
 *
 * **Game** instant in, game instant out (ADR-0026). Both parameters are already
 * on the world's clock, which is why there is no `WorldClock` here to convert
 * with — the conversion happens once, at the caller's boundary, and a function
 * that took both a clock and an instant would invite converting twice.
 *
 * §10.1's *"cannot be shortened with money"* is held by there being no third
 * parameter: nothing a player can buy reaches this arithmetic.
 */
export function buildCompletesAt(gameStartedAt: Date, weeks: number): Date {
  return new Date(gameStartedAt.getTime() + weeks * 7 * 24 * 60 * 60 * 1000);
}

/**
 * What the academy costs its owner every month.
 *
 * The commissioned level's upkeep plus every **operational** module's. A module
 * still under construction is not charged upkeep — the capital was taken when
 * the build started, and charging rent on a building site would be a second bill
 * for the same thing.
 */
export function academyMonthlyUpkeep(
  level: AcademyCommissionedLevel,
  operationalModules: readonly AcademyModuleKind[],
  balance: AcademyBalance,
): number {
  const base = level < 1 ? 0 : levelBalance(level, balance).monthlyUpkeepMinor;
  return operationalModules.reduce(
    (total, kind) => total + moduleBalance(kind, balance).monthlyUpkeepMinor,
    base,
  );
}

/** Every level's definition, for an interface that wants to show the ladder. */
export const ACADEMY_LEVEL_LADDER = ACADEMY_LEVELS;
