import { randomUUID } from 'node:crypto';

import { and, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm';

import {
  ACADEMY_MODULES,
  academyLevelDefinition,
  academyModuleDefinition,
  type AcademiesResponse,
  type AcademyBalance,
  type AcademyBuildQuote,
  type AcademyLevel,
  type AcademyModuleKind,
  type AcademyModuleOffer,
  type AcademyModuleView,
  type AcademyRefusal,
  type AcademySiteView,
  type AcademyView,
  type BuildAcademyModuleInput,
} from '@tailfin/shared';
import {
  academyMonthlyUpkeep,
  academyTrainingSlots,
  buildCompletesAt,
  levelBalance,
  moduleBalance,
  nextAcademyLevel,
} from '@tailfin/sim';

import { moveAirlineCash } from '../airline/cash';
import { monthAfter, previousMonth } from '../crew/payroll';
import {
  academy,
  academyModule,
  aircraftType,
  cashMovement,
  crewBase,
  crewConversion,
  world,
} from '../db/schema';
import { loadWorldEconomyConfig } from '../economy/loader';
import { worldGameNow } from '../world/game-now';

import type { Database } from '../db/client';

/**
 * The training academy's rows and its money (M9-01, §10.1).
 *
 * `packages/sim` owns what a level permits and what a course costs; this file
 * owns the rows, the cash and the two sweeps the worker runs.
 *
 * ## Three rules this file exists to hold
 *
 *  1. **Level gates the ceiling and grants no boost.** Nothing here returns or
 *     stores a multiplier. Commissioning a level changes one integer, and every
 *     capability that integer unlocks is a permission — a rank ceiling, a
 *     research tier, a slot count.
 *  2. **Money cannot shorten a build.** There is no endpoint, field or balance
 *     lever that moves `construction_ready_at` closer — the rule holds by the
 *     absence of a lever rather than by a check. The span itself is **game**
 *     weeks (ADR-0026), like every other span inside a world; §10.1's *"real
 *     weeks"* is one of the sentences that ADR settles.
 *  3. **One academy per crew base**, by a unique constraint rather than by a
 *     check the writer performs.
 *
 * ## Owner-scoped by resolution, never by a check afterwards
 *
 * Every query is scoped by the session-resolved airline (ADR-0020). An academy
 * belonging to somebody else is not in the result set, so operating on one is
 * not a state a request can express, and a foreign id receives the endpoint's
 * identical 404.
 */

export type AcademyResult<T> = { ok: true; value: T } | { ok: false; refusal: AcademyRefusal };

class InsufficientFunds extends Error {}

interface AcademyOwner {
  worldId: string;
  airlineId: string;
}

async function academyBalanceOf(db: Database, worldId: string): Promise<AcademyBalance> {
  return (await loadWorldEconomyConfig(db, worldId)).academy;
}

function levelQuote(level: AcademyLevel, balance: AcademyBalance): AcademyBuildQuote {
  const row = levelBalance(level, balance);
  return {
    capitalCostMinor: row.capitalCostMinor,
    buildWeeks: row.buildWeeks,
    monthlyUpkeepMinor: row.monthlyUpkeepMinor,
  };
}

function moduleQuote(kind: AcademyModuleKind, balance: AcademyBalance): AcademyBuildQuote {
  const row = moduleBalance(kind, balance);
  return {
    capitalCostMinor: row.capitalCostMinor,
    buildWeeks: row.buildWeeks,
    monthlyUpkeepMinor: row.monthlyUpkeepMinor,
  };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** The aircraft families this world flies, for the full-flight sim picker. */
async function worldFamilies(db: Database, worldId: string): Promise<string[]> {
  const versions = await db
    .select({ version: world.aircraftCatalogueVersion })
    .from(world)
    .where(eq(world.id, worldId))
    .limit(1);
  const version = versions[0]?.version;
  if (version === undefined) return [];
  const rows = await db
    .selectDistinct({ family: aircraftType.family })
    .from(aircraftType)
    .where(eq(aircraftType.catalogueVersion, version));
  return rows
    .map((row) => row.family)
    .filter((family): family is string => family !== null)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Everything the academies page needs, in one response.
 *
 * The whole state rather than an id, for the reason the crew endpoints return
 * the whole state: founding an academy or starting a build changes cash, the
 * ceiling and what may be built next all at once, and a client that had to
 * refetch would show a stale purse for a frame.
 */
export async function readAcademies(db: Database, own: AcademyOwner): Promise<AcademiesResponse> {
  const economy = await loadWorldEconomyConfig(db, own.worldId);
  const balance = economy.academy;

  const bases = await db
    .select({ id: crewBase.id, airportIcao: crewBase.airportIcao, status: crewBase.status })
    .from(crewBase)
    .where(and(eq(crewBase.worldId, own.worldId), eq(crewBase.airlineId, own.airlineId)));

  const rows = await db
    .select({
      id: academy.id,
      crewBaseId: academy.crewBaseId,
      level: academy.level,
      pendingLevel: academy.pendingLevel,
      constructionReadyAt: academy.constructionReadyAt,
    })
    .from(academy)
    .where(and(eq(academy.worldId, own.worldId), eq(academy.airlineId, own.airlineId)));

  const ids = rows.map((row) => row.id);
  const modules =
    ids.length === 0
      ? []
      : await db
          .select({
            id: academyModule.id,
            academyId: academyModule.academyId,
            kind: academyModule.kind,
            family: academyModule.family,
            status: academyModule.status,
            readyAt: academyModule.readyAt,
            installedAt: academyModule.installedAt,
          })
          .from(academyModule)
          .where(inArray(academyModule.academyId, ids));

  /*
   * Slots in use, as `sum(heads)` and not a row count: §10.1's slots hold crew,
   * and a course of ten heads occupies ten of them. Grouped and looked up rather
   * than correlated in the select list — a correlated subquery in a drizzle
   * select came back empty against real Postgres once, and CLAUDE.md records it.
   */
  const slotRows =
    ids.length === 0
      ? []
      : await db
          .select({
            academyId: crewConversion.academyId,
            heads: sql<number>`coalesce(sum(${crewConversion.heads}), 0)::int`,
          })
          .from(crewConversion)
          .where(
            and(inArray(crewConversion.academyId, ids), eq(crewConversion.status, 'in_training')),
          )
          .groupBy(crewConversion.academyId);
  const slotsByAcademy = new Map(
    slotRows.map((row) => [row.academyId, Number(row.heads)] as const),
  );

  const families = await worldFamilies(db, own.worldId);
  const icaoOf = new Map(bases.map((base) => [base.id, base.airportIcao] as const));

  const academies: AcademyView[] = rows.map((row) => {
    const own_modules = modules.filter((module) => module.academyId === row.id);
    const operational = own_modules.filter((module) => module.status === 'operational');
    const level = row.level;
    const definition = academyLevelDefinition(level);
    const slotsInUse = slotsByAcademy.get(row.id) ?? 0;
    const next = nextAcademyLevel(level);

    return {
      id: row.id,
      crewBaseId: row.crewBaseId,
      airportIcao: icaoOf.get(row.crewBaseId) ?? '????',
      level,
      levelName: definition?.name ?? null,
      pendingLevel: row.pendingLevel,
      constructionReadyAt: row.constructionReadyAt?.toISOString() ?? null,
      ceiling:
        definition === null
          ? null
          : {
              flightDeckUpTo: definition.flightDeckUpTo,
              cabinUpTo: definition.cabinUpTo,
              researchTier: definition.researchTier,
              trainingSlots: academyTrainingSlots(level, balance),
              slotsInUse,
            },
      modules: own_modules.map((module): AcademyModuleView => ({
        id: module.id,
        kind: module.kind,
        family: module.family,
        status: module.status,
        readyAt: module.readyAt.toISOString(),
        installedAt: module.installedAt?.toISOString() ?? null,
      })),
      // Null while a build is running as well as at level 5: §10.1 builds one
      // level at a time, so there is no next level to quote until this one is up.
      nextLevel: next === null || row.pendingLevel !== null ? null : levelQuote(next, balance),
      moduleOffers: ACADEMY_MODULES.map((definitionRow): AcademyModuleOffer => {
        const held = own_modules.filter((module) => module.kind === definitionRow.kind);
        const availableFamilies = definitionRow.perFamily
          ? families.filter((family) => !held.some((module) => module.family === family))
          : [];
        const blockedBy =
          level < definitionRow.fromLevel
            ? ('level' as const)
            : definitionRow.perFamily
              ? availableFamilies.length === 0
                ? ('already_built' as const)
                : null
              : held.length === 0
                ? null
                : held.some((module) => module.status === 'under_construction')
                  ? ('under_construction' as const)
                  : ('already_built' as const);
        return {
          kind: definitionRow.kind,
          name: definitionRow.name,
          purpose: definitionRow.purpose,
          perFamily: definitionRow.perFamily,
          fromLevel: definitionRow.fromLevel,
          readToday: definitionRow.readToday,
          quote: moduleQuote(definitionRow.kind, balance),
          availableFamilies,
          blockedBy,
        };
      }),
      monthlyUpkeepMinor: academyMonthlyUpkeep(
        level,
        operational.map((module) => module.kind),
        balance,
      ),
    };
  });

  const founded = new Set(rows.map((row) => row.crewBaseId));
  const sites: AcademySiteView[] = bases
    .filter((base) => base.status === 'open' && !founded.has(base.id))
    .map((base) => ({
      crewBaseId: base.id,
      airportIcao: base.airportIcao,
      quote: levelQuote(1, balance),
    }));

  return {
    academies: academies.sort((a, b) => a.airportIcao.localeCompare(b.airportIcao)),
    sites: sites.sort((a, b) => a.airportIcao.localeCompare(b.airportIcao)),
    families,
    outsourcedConversionPerHeadMinor: economy.crew.conversion.costPerHeadMinor,
  };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Found an academy at a crew base and start building level 1.
 *
 * The capital is charged now and the building arrives in game weeks. There is
 * deliberately no way to pay for it to arrive sooner: the third acceptance
 * criterion is that build time cannot be shortened with money, and the surest
 * form of that rule is that no code path exists to try.
 */
export async function foundAcademy(
  db: Database,
  own: AcademyOwner,
  crewBaseId: string,
): Promise<AcademyResult<{ academyId: string; readyAt: Date }>> {
  const balance = await academyBalanceOf(db, own.worldId);
  const quote = levelQuote(1, balance);
  /*
   * The world's instant, read once: the two dates written and the cash movement
   * dated beside them must agree, and re-reading the clock between them would
   * let a tick fall in the gap. Game time throughout — the span by ADR-0026, and
   * the movement's `occurred_at` by TIME-02, which made the AIR-06 ledger one
   * calendar so a date-ranged P&L cannot depend on which kind of row it caught.
   */
  const startedAt = await worldGameNow(db, own.worldId);
  const readyAt = buildCompletesAt(startedAt, quote.buildWeeks);

  try {
    return await db.transaction(async (tx) => {
      const bases = await tx
        .select({ id: crewBase.id, status: crewBase.status })
        .from(crewBase)
        .where(
          and(
            eq(crewBase.id, crewBaseId),
            eq(crewBase.airlineId, own.airlineId),
            eq(crewBase.worldId, own.worldId),
          ),
        )
        .limit(1);
      const base = bases[0];
      if (!base) return { ok: false, refusal: 'base_absent' as const };
      if (base.status !== 'open') return { ok: false, refusal: 'base_closed' as const };

      const existing = await tx
        .select({ id: academy.id })
        .from(academy)
        .where(eq(academy.crewBaseId, crewBaseId))
        .limit(1);
      if (existing[0]) return { ok: false, refusal: 'academy_exists' as const };

      const academyId = randomUUID();
      const movement = await moveAirlineCash(tx, {
        airlineId: own.airlineId,
        amountMinor: -quote.capitalCostMinor,
        cause: 'academy_construction',
        reference: `${academyId}:level:1`,
        occurredAt: startedAt,
      });
      if (movement.movement.balanceAfterMinor < 0) throw new InsufficientFunds();

      await tx.insert(academy).values({
        id: academyId,
        worldId: own.worldId,
        airlineId: own.airlineId,
        crewBaseId,
        level: 0,
        pendingLevel: 1,
        constructionStartedAt: startedAt,
        constructionReadyAt: readyAt,
      });

      return { ok: true, value: { academyId, readyAt } };
    });
  } catch (error) {
    if (error instanceof InsufficientFunds) return { ok: false, refusal: 'insufficient_funds' };
    throw error;
  }
}

/** Start building the next level. One at a time, and always the next one. */
export async function upgradeAcademy(
  db: Database,
  own: AcademyOwner,
  academyId: string,
): Promise<AcademyResult<{ pendingLevel: AcademyLevel; readyAt: Date }>> {
  const balance = await academyBalanceOf(db, own.worldId);
  const startedAt = await worldGameNow(db, own.worldId);

  try {
    return await db.transaction(async (tx) => {
      /*
       * `FOR UPDATE`, and the level re-read inside it. Two upgrade requests
       * arriving together would each pass a check made against the same stale
       * level and together charge twice for one level — which the
       * `pending_level = level + 1` constraint would then refuse at write time
       * with an error nobody can act on.
       */
      const rows = await tx
        .select({ id: academy.id, level: academy.level, pendingLevel: academy.pendingLevel })
        .from(academy)
        .where(
          and(
            eq(academy.id, academyId),
            eq(academy.airlineId, own.airlineId),
            eq(academy.worldId, own.worldId),
          ),
        )
        .limit(1)
        .for('update');
      const row = rows[0];
      if (!row) return { ok: false, refusal: 'academy_absent' as const };
      if (row.pendingLevel !== null) return { ok: false, refusal: 'already_building' as const };

      const next = nextAcademyLevel(row.level);
      if (next === null) return { ok: false, refusal: 'max_level' as const };

      const quote = levelQuote(next, balance);
      const readyAt = buildCompletesAt(startedAt, quote.buildWeeks);

      const movement = await moveAirlineCash(tx, {
        airlineId: own.airlineId,
        amountMinor: -quote.capitalCostMinor,
        cause: 'academy_construction',
        reference: `${academyId}:level:${String(next)}`,
        occurredAt: startedAt,
      });
      if (movement.movement.balanceAfterMinor < 0) throw new InsufficientFunds();

      await tx
        .update(academy)
        .set({
          pendingLevel: next,
          constructionStartedAt: startedAt,
          constructionReadyAt: readyAt,
        })
        .where(eq(academy.id, academyId));

      return { ok: true, value: { pendingLevel: next, readyAt } };
    });
  } catch (error) {
    if (error instanceof InsufficientFunds) return { ok: false, refusal: 'insufficient_funds' };
    throw error;
  }
}

/** Build a module inside a commissioned academy. */
export async function buildAcademyModule(
  db: Database,
  own: AcademyOwner,
  academyId: string,
  input: BuildAcademyModuleInput,
): Promise<AcademyResult<{ moduleId: string; readyAt: Date }>> {
  const balance = await academyBalanceOf(db, own.worldId);
  const definition = academyModuleDefinition(input.kind);
  const quote = moduleQuote(input.kind, balance);
  const startedAt = await worldGameNow(db, own.worldId);
  const readyAt = buildCompletesAt(startedAt, quote.buildWeeks);

  const family = input.family ?? null;
  if (family !== null && !(await worldFamilies(db, own.worldId)).includes(family)) {
    /*
     * A family the world does not fly is refused rather than stored. M5-01
     * learned this the expensive way with a free-text family box: a crew pool
     * rated on a family literally called `test` is still in the dev database,
     * unusable and unspendable. A simulator is a great deal dearer than a pool.
     */
    return { ok: false, refusal: 'unknown_family' };
  }

  try {
    return await db.transaction(async (tx) => {
      const rows = await tx
        .select({ id: academy.id, level: academy.level })
        .from(academy)
        .where(
          and(
            eq(academy.id, academyId),
            eq(academy.airlineId, own.airlineId),
            eq(academy.worldId, own.worldId),
          ),
        )
        .limit(1)
        .for('update');
      const row = rows[0];
      if (!row) return { ok: false, refusal: 'academy_absent' as const };
      if (row.level < definition.fromLevel) return { ok: false, refusal: 'module_level' as const };

      const held = await tx
        .select({ id: academyModule.id })
        .from(academyModule)
        .where(
          and(
            eq(academyModule.academyId, academyId),
            eq(academyModule.kind, input.kind),
            family === null
              ? sql`${academyModule.family} IS NULL`
              : eq(academyModule.family, family),
          ),
        )
        .limit(1);
      if (held[0]) return { ok: false, refusal: 'module_exists' as const };

      const moduleId = randomUUID();
      const movement = await moveAirlineCash(tx, {
        airlineId: own.airlineId,
        amountMinor: -quote.capitalCostMinor,
        cause: 'academy_construction',
        reference: `${moduleId}:module`,
        occurredAt: startedAt,
      });
      if (movement.movement.balanceAfterMinor < 0) throw new InsufficientFunds();

      await tx.insert(academyModule).values({
        id: moduleId,
        academyId,
        kind: input.kind,
        family,
        status: 'under_construction',
        startedAt,
        readyAt,
      });

      return { ok: true, value: { moduleId, readyAt } };
    });
  } catch (error) {
    if (error instanceof InsufficientFunds) return { ok: false, refusal: 'insufficient_funds' };
    throw error;
  }
}

// ---------------------------------------------------------------------------
// The worker's sweeps
// ---------------------------------------------------------------------------

export interface AcademyBuildSweepResult {
  levelsCommissioned: number;
  modulesInstalled: number;
}

/**
 * Commission every level and module whose build time has run out.
 *
 * `gameNow` is the world's clock (ADR-0026), like the maintenance, conversion
 * and aircraft-delivery sweeps beside it. Required rather than defaulted to
 * `new Date()`, for the reason `deliverDueAircraftOrders` had its default
 * *removed* in TIME-01: a default that read the wall clock would be a silent
 * cross-domain comparison that no type could catch, and the failure — academies
 * opening early on a world whose calendar is ahead of reality — would look like
 * a balance bug.
 *
 * Idempotent by the claim: each update carries the predicate it was selected on,
 * so a re-run or a second worker commissions nothing twice.
 */
export async function completeDueAcademyBuilds(
  db: Database,
  worldId: string,
  gameNow: Date,
): Promise<AcademyBuildSweepResult> {
  const dueLevels = await db
    .select({ id: academy.id, pendingLevel: academy.pendingLevel })
    .from(academy)
    .where(
      and(
        eq(academy.worldId, worldId),
        isNotNull(academy.pendingLevel),
        lte(academy.constructionReadyAt, gameNow),
      ),
    );

  let levelsCommissioned = 0;
  for (const row of dueLevels) {
    if (row.pendingLevel === null) continue;
    const claimed = await db
      .update(academy)
      .set({
        level: row.pendingLevel,
        pendingLevel: null,
        constructionStartedAt: null,
        constructionReadyAt: null,
      })
      .where(and(eq(academy.id, row.id), eq(academy.pendingLevel, row.pendingLevel)))
      .returning({ id: academy.id });
    if (claimed.length > 0) levelsCommissioned += 1;
  }

  /*
   * Modules are claimed in one statement rather than row by row: unlike a level
   * there is nothing to compute per row, so the `status` predicate in the
   * `WHERE` is the whole claim and two workers cannot both win it.
   */
  const installed = await db
    .update(academyModule)
    .set({ status: 'operational', installedAt: gameNow })
    .where(
      and(
        eq(academyModule.status, 'under_construction'),
        lte(academyModule.readyAt, gameNow),
        inArray(
          academyModule.academyId,
          db.select({ id: academy.id }).from(academy).where(eq(academy.worldId, worldId)),
        ),
      ),
    )
    .returning({ id: academyModule.id });

  return { levelsCommissioned, modulesInstalled: installed.length };
}

export interface AcademyUpkeepResult {
  airlinesBilled: number;
  totalMinor: number;
}

/**
 * Bill every airline in this world for a month of academy upkeep.
 *
 * Monthly on the world's game clock, on the world's own calendar month — the
 * same shape as crew payroll and the hub fee, and for the same reason: an
 * academy costs a fixed sum to hold whether or not anybody was trained in it,
 * and that fixed cost is what makes §10.1's *"is a level 5 at this base a money
 * pit?"* a question worth asking.
 *
 * Idempotent by `academy_upkeep:<airline>:<YYYY-MM>`, the pattern
 * `runCrewPayroll` established: AIR-06 refuses a second movement with the same
 * cause and reference, so this is attempted every tick and bills once, needs no
 * "last billed" column for ADR-0005's reset to forget to clear, and self-heals
 * across a month boundary the worker was down for.
 *
 * The already-billed references are read first for the reason payroll reads
 * them: AIR-06's guard asserts a replay carries the **same facts**, and an
 * academy commissioned mid-month would change the amount between two ticks.
 */
export async function runAcademyUpkeep(
  db: Database,
  worldId: string,
  gameNow: Date,
): Promise<AcademyUpkeepResult> {
  const period = previousMonth(gameNow);
  const occurredAt = new Date(`${monthAfter(period)}-01T00:00:00.000Z`);
  const balance = (await loadWorldEconomyConfig(db, worldId)).academy;

  const bills = foldAcademyUpkeep(await academyUpkeepLines(db, worldId), balance);
  if (bills.size === 0) return { airlinesBilled: 0, totalMinor: 0 };

  const already = new Set(
    (
      await db
        .select({ reference: cashMovement.reference })
        .from(cashMovement)
        .where(
          inArray(
            cashMovement.reference,
            [...bills.keys()].map((airlineId) => `academy_upkeep:${airlineId}:${period}`),
          ),
        )
    ).map((row) => row.reference),
  );

  let airlinesBilled = 0;
  let totalMinor = 0;
  for (const [airlineId, amount] of bills) {
    if (amount <= 0) continue;
    const reference = `academy_upkeep:${airlineId}:${period}`;
    if (already.has(reference)) continue;
    /*
     * Inside a transaction, and that is not optional. `moveAirlineCash` inserts
     * the movement and *then* updates the balance, and the reconciliation
     * trigger is `DEFERRABLE` — so outside one the insert commits alone and the
     * trigger refuses a balance that has not moved yet, naming the airline
     * rather than the mistake. Every payroll in the game wraps it; this one did
     * not at first, and a real Postgres run is what said so.
     */
    const result = await db.transaction((tx) =>
      moveAirlineCash(tx, {
        airlineId,
        amountMinor: -amount,
        cause: 'academy_upkeep',
        reference,
        occurredAt,
      }),
    );
    if (result.status !== 'already-applied') {
      airlinesBilled += 1;
      totalMinor += amount;
    }
  }

  return { airlinesBilled, totalMinor };
}

/** One `academy` × operational `academy_module` line, as the upkeep fold reads it. */
export interface AcademyUpkeepLine {
  airlineId: string;
  academyId: string;
  level: number;
  moduleKind: AcademyModuleKind | null;
}

/**
 * Fold academies and their modules into what each airline owes for a month.
 *
 * Exported so M8-08's cash runway projects the **same** bill the sweep will
 * charge. A projection with its own copy of this arithmetic would be a second
 * answer to *"what does my academy cost me next month?"*, and the two would
 * drift the first time a level was commissioned — the failure §14.1 exists to
 * prevent, one screen away from the number it is warning about.
 */
export function foldAcademyUpkeep(
  rows: readonly AcademyUpkeepLine[],
  balance: AcademyBalance,
): Map<string, number> {
  const byAcademy = new Map<
    string,
    { airlineId: string; level: number; modules: AcademyModuleKind[] }
  >();
  for (const row of rows) {
    let entry = byAcademy.get(row.academyId);
    if (!entry) {
      entry = { airlineId: row.airlineId, level: row.level, modules: [] };
      byAcademy.set(row.academyId, entry);
    }
    if (row.moduleKind !== null) entry.modules.push(row.moduleKind);
  }

  const bills = new Map<string, number>();
  for (const entry of byAcademy.values()) {
    const owed = academyMonthlyUpkeep(entry.level, entry.modules, balance);
    bills.set(entry.airlineId, (bills.get(entry.airlineId) ?? 0) + owed);
  }
  return bills;
}

/** The academies and modules a month of upkeep is folded from. */
export function academyUpkeepLines(
  db: Database,
  worldId: string,
  airlineId?: string,
): Promise<AcademyUpkeepLine[]> {
  return db
    .select({
      airlineId: academy.airlineId,
      academyId: academy.id,
      level: academy.level,
      moduleKind: academyModule.kind,
    })
    .from(academy)
    .leftJoin(
      academyModule,
      and(eq(academyModule.academyId, academy.id), eq(academyModule.status, 'operational')),
    )
    .where(
      and(
        eq(academy.worldId, worldId),
        airlineId === undefined ? undefined : eq(academy.airlineId, airlineId),
      ),
    );
}
