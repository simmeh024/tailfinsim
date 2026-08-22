import { and, asc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';

import {
  type AircraftAcquisitionKind,
  type AirframeAssignment,
  type AirframeDetailResponse,
  AirframeOwnerHistoryEntry,
  type BuildStepView,
  type CatalogueOption,
  type EffectiveSpecView,
  type FleetAirframeView,
  type FleetAirframesResponse,
  type FleetUtilisation,
  type MaintenanceAirframeView,
  type MaintenanceBalance,
  type RepeatPattern,
} from '@tailfin/shared';
import {
  airframeLocation,
  CHECK_TIERS,
  checkTerms,
  decomposeBuild,
  gameTime,
  maintenanceStatus,
  type Movement,
  resolveOptions,
  type WorldClock,
} from '@tailfin/sim';

import { type Database } from '../db/client';
import {
  aircraftOrder,
  airframe,
  flight,
  schedule,
  scheduleLeg,
  world,
  type AirframeRow,
} from '../db/schema';
import { loadEconomyConfig } from '../economy/loader';

import { loadCatalogueVersion, type PinnedCatalogueVersion } from './catalogue';
import { stateOf } from './maintenance';

/**
 * The fleet an airline owns (M4-07, App. C.6).
 *
 * `era.ts` answers *"what can this world fly?"*; this answers *"what have I
 * got, and which one needs me?"* Two projections of the same rows, and the
 * split is the one §11's fleet panel implies: a table you scan, and a record you
 * open.
 *
 * ## Every number arrives with its working
 *
 * The reason M4-07 is more than a table renderer is CONTRIBUTING's fourth
 * invariant. Three figures here would be dead ends if sent alone:
 *
 *   - **the effective spec.** Sent as a decomposition — base, then one step per
 *     option — because a 79.4 t MTOW nobody can attribute is a number a player
 *     will assume is a bug. `spec-decomposition.ts` owns the arithmetic and
 *     guarantees the steps sum to the total.
 *   - **utilisation.** Sent with the window and the hours, not just the rate, so
 *     *"6.2 block hours a day"* can be traced to the flights that produced it.
 *   - **the next check.** Sent with both limits and which one binds, because
 *     M4-06 already established that *"210 cycles from an A-check"* is a plan
 *     and *"soonish"* is not.
 *
 * ## Where things are is folded, not stored
 *
 * `positioning.ts` is emphatic that an aircraft's position is derived from its
 * flights and that a `location` column would be a second source of truth that
 * drifts the first time a flight diverts. So the fleet list folds movements, in
 * one grouped query for the whole fleet rather than one per airframe.
 *
 * ## Reading, only
 *
 * Nothing in this file mutates. `POST /api/fleet/maintenance/checks` is M4-06's
 * and remains the only fleet write besides an acquisition — which matters for
 * what M4-07 could *not* build, recorded in `docs/fleet-management.md`: the
 * issue's bulk actions are *"apply livery"* and *"assign to base"*, and Tailfin
 * has neither a livery (M6-01) nor an aircraft base (§9.2's base is a crew
 * facility). A bulk action over a field that does not exist would be a button
 * that changes nothing.
 */

const MS_PER_DAY = 86_400_000;

/**
 * The trailing window utilisation is measured over, in **game** days.
 *
 * A week, because that is the cadence everything else operational runs on — the
 * NPC review, the used-market refresh — and because a rotation repeats weekly, so
 * a shorter window would make a Tuesday-only schedule look idle on a Wednesday.
 *
 * Game days rather than real ones: a world at 4× flies four times as much per
 * real day, and a rate that changed with the world's speed multiplier would not
 * be comparable between worlds or across a speed change (ADR-0005).
 */
const UTILISATION_WINDOW_DAYS = 7;

function clockOf(row: { epoch: Date; launchDate: Date; speedMultiplier: string }): WorldClock {
  return {
    epoch: row.epoch,
    launchDate: row.launchDate,
    speedMultiplier: Number(row.speedMultiplier),
  };
}

function jsonArray(value: string): unknown[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error('Expected a stored JSON array');
  return parsed;
}

function optionIdsOf(row: Pick<AirframeRow, 'buildOptionIds'>): string[] {
  return jsonArray(row.buildOptionIds).filter((id): id is string => typeof id === 'string');
}

/**
 * App. C.6's `owner_history[]`, parsed on the way **out**.
 *
 * The column is text and the wire schema is `.strict()`, so a row written by an
 * older build — or by a psql session — has to be checked here rather than
 * assumed. An entry that does not parse is dropped rather than coerced: a
 * half-read owner with a blank date would put a wrong provenance on screen, and a
 * provenance nobody can trust is worse than a shorter one. The same discipline
 * `loadCatalogueVersion` uses on the catalogue rows.
 */
function ownerHistoryOf(row: Pick<AirframeRow, 'ownerHistory'>): AirframeOwnerHistoryEntry[] {
  const entries: AirframeOwnerHistoryEntry[] = [];
  for (const entry of jsonArray(row.ownerHistory)) {
    const parsed = AirframeOwnerHistoryEntry.safeParse(entry);
    if (parsed.success) entries.push(parsed.data);
  }
  return entries;
}

// ---------------------------------------------------------------------------
// The effective spec, taken apart
// ---------------------------------------------------------------------------

/**
 * Decompose an airframe's build for the detail view.
 *
 * The options come from `build_option_ids` on the airframe rather than from the
 * type, because the airframe is the record of what was actually ordered — and
 * they go through `resolveOptions`, so an id that is no longer valid in its
 * pinned catalogue version surfaces as an absent option rather than as a spec
 * that silently omits it.
 *
 * The `effective` spec here is **recomputed**, not read from
 * `airframe.effective_spec`. That is deliberate and it is the one place this file
 * could produce two numbers for one fact, so: the stored column is what the
 * simulation bills, and `fleet.test.ts` asserts the recomputation equals it. If
 * they ever diverge the test says so, rather than the build screen quietly
 * explaining a different aeroplane from the one that is flying.
 */
function decomposeAirframe(
  row: AirframeRow,
  catalogue: PinnedCatalogueVersion,
): { spec: EffectiveSpecView; options: CatalogueOption[] } | null {
  const type = catalogue.types.get(row.typeDesignation);
  if (!type) return null;

  const askedFor = optionIdsOf(row);
  const resolved = resolveOptions({
    type,
    catalogue: catalogue.options,
    optionIds: askedFor,
    // Not a retrofit and no research gate: these options were validated when the
    // order was placed, and re-refusing them now would make an airframe's own
    // record unreadable after a research reset.
  });
  const options = resolved.ok ? resolved.options : [];

  const { base, steps, build } = decomposeBuild({
    baseSpec: type.baseSpec,
    options,
    listPriceMinor: type.listPrice ?? 0,
  });

  const byId = new Map(options.map((option) => [option.id, option]));
  const stepViews: BuildStepView[] = steps.map((step) => {
    const option = step.optionId === null ? undefined : byId.get(step.optionId);
    return {
      optionId: step.optionId,
      // The cabin has no C.3 row, so it is labelled rather than named.
      label: option?.name ?? 'Cabin fitted',
      category: option?.category ?? null,
      summary: option?.summary ?? null,
      spec: step.spec,
      movements: [...step.movements],
      wingspan: step.wingspan,
      capabilityMovements: [...step.capabilityMovements],
      capabilitiesGained: [...step.capabilitiesGained],
      priceMinor: step.priceMinor,
      leadTimeWeeks: step.leadTimeWeeks,
    };
  });

  return {
    spec: {
      base,
      steps: stepViews,
      effective: build.spec,
      capabilities: {
        cargoVolumeFactor: build.cargoVolumeFactor,
        comfortDelta: build.comfortDelta,
        maintenanceCostFactor: build.maintenanceCostFactor,
        lowVisibilityCancellationFactor: build.lowVisibilityCancellationFactor,
        etopsMinutes: build.etopsMinutes,
        ulhCapable: build.ulhCapable,
        unpavedCapable: build.unpavedCapable,
      },
      priceMinor: build.priceMinor,
      leadTimeWeeks: build.leadTimeWeeks,
    },
    options: [...options],
  };
}

// ---------------------------------------------------------------------------
// The three things the list needs from other tables
// ---------------------------------------------------------------------------

/**
 * Where every airframe in the fleet is, from one query.
 *
 * Ordered by arrival so the fold sees movements in the order they happened, which
 * `airframeLocation` requires of its caller. Only flights that actually moved the
 * aeroplane count — a `scheduled` flight has taken it nowhere, and counting one
 * would report an aircraft at an airport it has not reached, which is exactly the
 * teleportation `positioning.ts` exists to catch.
 */
async function locationsFor(
  db: Database,
  rows: readonly AirframeRow[],
): Promise<Map<string, string>> {
  const located = new Map<string, string>();
  if (rows.length === 0) return located;

  const movements = await db
    .select({
      airframeId: flight.airframeId,
      originIcao: flight.originIcao,
      destinationIcao: flight.destinationIcao,
      diversionIcao: flight.diversionIcao,
    })
    .from(flight)
    .where(
      and(
        inArray(
          flight.airframeId,
          rows.map((row) => row.id),
        ),
        isNotNull(flight.actualArrival),
      ),
    )
    .orderBy(asc(flight.actualArrival));

  const byAirframe = new Map<string, Movement[]>();
  for (const movement of movements) {
    const list = byAirframe.get(movement.airframeId);
    if (list === undefined) byAirframe.set(movement.airframeId, [movement]);
    else list.push(movement);
  }

  for (const row of rows) {
    located.set(row.id, airframeLocation(row.deliveredToIcao, byAirframe.get(row.id) ?? []));
  }
  return located;
}

/**
 * Block hours flown per airframe inside the window.
 *
 * Summed in Postgres, from `actual_arrival − actual_departure`, because that is
 * the block time the aeroplane really spent rather than what the schedule planned.
 * Grouped rather than correlated: CLAUDE.md records a correlated subquery in a
 * drizzle select list returning empty against real Postgres, and `loadCatalogue`
 * takes the same shape for the same reason.
 */
async function blockHoursSince(
  db: Database,
  rows: readonly AirframeRow[],
  since: Date,
): Promise<Map<string, number>> {
  const flown = new Map<string, number>();
  if (rows.length === 0) return flown;

  const totals = await db
    .select({
      airframeId: flight.airframeId,
      // Cast to text and parsed below: an aggregate has no column type parser, so
      // the driver would hand back whatever it liked. CLAUDE.md's `sql<Date>` trap
      // is the same mistake in a different type.
      seconds: sql<string>`sum(extract(epoch from (${flight.actualArrival} - ${flight.actualDeparture})))::text`,
    })
    .from(flight)
    .where(
      and(
        inArray(
          flight.airframeId,
          rows.map((row) => row.id),
        ),
        isNotNull(flight.actualArrival),
        isNotNull(flight.actualDeparture),
        gte(flight.actualArrival, since),
      ),
    )
    .groupBy(flight.airframeId);

  for (const total of totals) {
    const seconds = Number(total.seconds);
    if (Number.isFinite(seconds)) flown.set(total.airframeId, seconds / 3_600);
  }
  return flown;
}

/** Every active-or-paused rotation these airframes are assigned to, with its legs. */
async function assignmentsFor(
  db: Database,
  own: { id: string; worldId: string },
  airframeIds: readonly string[],
): Promise<Map<string, AirframeAssignment[]>> {
  const byAirframe = new Map<string, AirframeAssignment[]>();
  if (airframeIds.length === 0) return byAirframe;

  const schedules = await db
    .select()
    .from(schedule)
    .where(
      and(
        eq(schedule.worldId, own.worldId),
        eq(schedule.airlineId, own.id),
        inArray(schedule.airframeId, [...airframeIds]),
      ),
    );
  if (schedules.length === 0) return byAirframe;

  const legs = await db
    .select()
    .from(scheduleLeg)
    .where(
      inArray(
        scheduleLeg.scheduleId,
        schedules.map((row) => row.id),
      ),
    )
    .orderBy(asc(scheduleLeg.scheduleId), asc(scheduleLeg.legIndex));

  const legsBySchedule = new Map<string, typeof legs>();
  for (const leg of legs) {
    const list = legsBySchedule.get(leg.scheduleId);
    if (list === undefined) legsBySchedule.set(leg.scheduleId, [leg]);
    else list.push(leg);
  }

  for (const row of schedules) {
    const ordered = legsBySchedule.get(row.id) ?? [];
    // The discriminated union `network.ts` insists on, rebuilt from the two
    // columns the schema splits it across. `daily` carries no days at all — an
    // empty array meaning "every day" is the trap that file records.
    const repeat: RepeatPattern =
      row.repeatKind === 'daily'
        ? { kind: 'daily' }
        : { kind: 'weekdays', days: row.repeatDays ?? [] };

    const assignment: AirframeAssignment = {
      scheduleId: row.id,
      active: row.active,
      repeat,
      legs: ordered.map((leg) => ({
        legIndex: leg.legIndex,
        originIcao: leg.originIcao,
        destinationIcao: leg.destinationIcao,
        departureMinute: leg.departureMinute,
        blockMinutes: leg.blockMinutes,
        turnaroundMinutes: leg.turnaroundMinutes,
      })),
      dailyBlockMinutes: ordered.reduce((total, leg) => total + leg.blockMinutes, 0),
    };

    const list = byAirframe.get(row.airframeId);
    if (list === undefined) byAirframe.set(row.airframeId, [assignment]);
    else list.push(assignment);
  }

  return byAirframe;
}

// ---------------------------------------------------------------------------
// Assembling a row
// ---------------------------------------------------------------------------

interface RowContext {
  clock: WorldClock;
  gameNow: Date;
  economyMaintenance: MaintenanceBalance;
  catalogue: PinnedCatalogueVersion;
  locationIcao: string | null;
  blockHours: number;
  assignments: readonly AirframeAssignment[];
}

/**
 * The maintenance position, in the shape `/api/fleet/maintenance` already sends.
 *
 * Built here rather than imported from `fleetMaintenance` because that function
 * loads its own world and catalogue per call, and the fleet list has already
 * loaded both. One shape, two assemblers, and `fleet.test.ts` asserts the two
 * agree for the same airframe — which is the property that matters, rather than
 * which function built it.
 */
function maintenanceView(row: AirframeRow, context: RowContext): MaintenanceAirframeView | null {
  const type = context.catalogue.types.get(row.typeDesignation);
  if (!type) return null;

  const profile = type.maintenanceProfile;
  const status = maintenanceStatus(stateOf(row), profile, context.economyMaintenance);

  return {
    airframeId: row.id,
    registration: row.registration,
    typeDesignation: row.typeDesignation,
    maintenanceProfile: profile,
    status: row.status,
    checkTier:
      row.checkTier === 'a' || row.checkTier === 'c' || row.checkTier === 'd'
        ? row.checkTier
        : null,
    checkCompletesAt: row.checkCompletesAt?.toISOString() ?? null,
    totalHours: row.hours,
    totalCycles: row.cycles,
    technicalRisk: status.technicalRisk,
    airworthy: status.airworthiness.airworthy,
    dueTiers: [...status.dueTiers],
    tiers: CHECK_TIERS.map((tier) => {
      const t = status.tiers[tier];
      const terms = checkTerms(tier, profile, context.economyMaintenance);
      return {
        tier,
        hoursRemaining: t.hoursRemaining,
        cyclesRemaining: t.cyclesRemaining,
        binding: t.binding,
        usedFraction: t.usedFraction,
        due: t.due,
        costMinor: terms.costMinor,
        downtimeDays: terms.downtimeDays,
      };
    }),
  };
}

/**
 * How much of the window this airframe has actually existed for, in game days.
 *
 * An aeroplane delivered two game days ago is not idle because it flew nothing in
 * the five days before it existed. Dividing by a fixed seven would say it was, and
 * §2488's onboarding warning fires on exactly this number — so it would tell a
 * player to stop buying aircraft on the day their first one arrived.
 *
 * `deliveredAt` is real time (factory lead times are wall-clock weeks, §7.2), so
 * it is converted to the world's clock before being compared with a game instant.
 */
function utilisationOf(row: AirframeRow, context: RowContext): FleetUtilisation | null {
  const deliveredInGame = gameTime(context.clock, row.deliveredAt);
  const gameDaysOwned = (context.gameNow.getTime() - deliveredInGame.getTime()) / MS_PER_DAY;
  const windowDays = Math.min(UTILISATION_WINDOW_DAYS, gameDaysOwned);

  // Less than a game day of ownership: there is no rate yet, and inventing one
  // from a fraction of a day would swing wildly for no reason a player could see.
  if (!(windowDays >= 1)) return null;

  return {
    windowDays,
    blockHours: context.blockHours,
    blockHoursPerDay: context.blockHours / windowDays,
  };
}

function ageYearsOf(row: AirframeRow, gameNow: Date): number | null {
  if (row.builtAt === null) return null;
  const years = (gameNow.getTime() - row.builtAt.getTime()) / (365.25 * MS_PER_DAY);
  return Math.max(0, years);
}

function viewOf(row: AirframeRow, context: RowContext): FleetAirframeView | null {
  const type = context.catalogue.types.get(row.typeDesignation);
  const maintenance = maintenanceView(row, context);
  if (!type || maintenance === null) return null;

  // The tier closest to due, overdue included — the one decision this row is
  // about. Sorted by how much of the interval is used rather than by tier, so a
  // C-check at 98% outranks an A-check at 30%.
  const nextCheck =
    [...maintenance.tiers].sort((a, b) => b.usedFraction - a.usedFraction)[0] ?? null;

  return {
    airframeId: row.id,
    registration: row.registration,

    typeDesignation: type.designation,
    family: type.family,
    manufacturer: type.manufacturer,
    aircraftClass: type.class,

    liveryId: row.liveryId,
    // Null until M6-06 renders one. See the note on the contract: the client
    // renders a URL the server chose, so it never composes a livery itself.
    liveryThumbnailUrl: null,

    locationIcao: context.locationIcao,

    status: row.status,
    checkTier: maintenance.checkTier,
    checkCompletesAt: maintenance.checkCompletesAt,
    airworthy: maintenance.airworthy,
    technicalRisk: maintenance.technicalRisk,

    ownership: row.ownership,
    hours: row.hours,
    cycles: row.cycles,
    ageYears: ageYearsOf(row, context.gameNow),

    utilisation: utilisationOf(row, context),
    nextCheck,
    activeScheduleCount: context.assignments.filter((assignment) => assignment.active).length,
  };
}

// ---------------------------------------------------------------------------
// The two reads
// ---------------------------------------------------------------------------

interface FleetContext {
  clock: WorldClock;
  gameNow: Date;
  economyMaintenance: MaintenanceBalance;
  catalogues: Map<string, PinnedCatalogueVersion>;
}

async function fleetContext(
  db: Database,
  worldId: string,
  rows: readonly AirframeRow[],
  now: Date,
): Promise<FleetContext> {
  const worlds = await db
    .select({
      epoch: world.epoch,
      launchDate: world.launchDate,
      speedMultiplier: world.speedMultiplier,
      economyConfigVersion: world.economyConfigVersion,
    })
    .from(world)
    .where(eq(world.id, worldId))
    .limit(1);
  const worldRow = worlds[0];
  if (!worldRow) throw new Error(`No world ${worldId}`);

  const economy = await loadEconomyConfig(db, worldRow.economyConfigVersion);
  const catalogues = new Map<string, PinnedCatalogueVersion>();
  for (const version of new Set(rows.map((row) => row.catalogueVersion))) {
    catalogues.set(version, await loadCatalogueVersion(db, version));
  }

  const clock = clockOf(worldRow);
  return {
    clock,
    gameNow: gameTime(clock, now),
    economyMaintenance: economy.maintenance,
    catalogues,
  };
}

/**
 * The fleet table (M4-07).
 *
 * Sorted so the first row is the decision: an aeroplane that cannot fly, then the
 * one closest to a check. The same ordering `fleetMaintenance` uses, and for the
 * same reason — *"plan around"* means the urgent thing is at the top and the rest
 * is inventory.
 */
export async function listFleet(
  db: Database,
  own: { id: string; worldId: string },
  now: Date = new Date(),
): Promise<FleetAirframesResponse> {
  const rows = await db
    .select()
    .from(airframe)
    .where(and(eq(airframe.worldId, own.worldId), eq(airframe.airlineId, own.id)))
    .orderBy(asc(airframe.registration));

  if (rows.length === 0) return { airframes: [] };

  const context = await fleetContext(db, own.worldId, rows, now);
  const windowStart = new Date(context.gameNow.getTime() - UTILISATION_WINDOW_DAYS * MS_PER_DAY);

  const [locations, flown, assignments] = await Promise.all([
    locationsFor(db, rows),
    blockHoursSince(db, rows, windowStart),
    assignmentsFor(
      db,
      own,
      rows.map((row) => row.id),
    ),
  ]);

  const airframes: FleetAirframeView[] = [];
  for (const row of rows) {
    const catalogue = context.catalogues.get(row.catalogueVersion);
    if (catalogue === undefined) continue;
    const view = viewOf(row, {
      clock: context.clock,
      gameNow: context.gameNow,
      economyMaintenance: context.economyMaintenance,
      catalogue,
      locationIcao: locations.get(row.id) ?? null,
      blockHours: flown.get(row.id) ?? 0,
      assignments: assignments.get(row.id) ?? [],
    });
    if (view !== null) airframes.push(view);
  }

  airframes.sort((a, b) => urgency(b) - urgency(a) || a.registration.localeCompare(b.registration));
  return { airframes };
}

/** Higher is more urgent. Cannot fly first, then closest to a check. */
function urgency(view: FleetAirframeView): number {
  if (!view.airworthy) return 1_000;
  return view.nextCheck?.usedFraction ?? 0;
}

/**
 * One aircraft, in full (M4-07).
 *
 * `null` for an airframe that is not this airline's, which the route turns into
 * the same 404 a missing id gets. ADR-0020: a private id belonging to somebody
 * else must be indistinguishable from one that does not exist, and the query is
 * scoped by the session-resolved owner rather than checked after the fact.
 */
export async function airframeDetail(
  db: Database,
  own: { id: string; worldId: string },
  airframeId: string,
  now: Date = new Date(),
): Promise<AirframeDetailResponse | null> {
  const rows = await db
    .select()
    .from(airframe)
    .where(
      and(
        eq(airframe.id, airframeId),
        eq(airframe.worldId, own.worldId),
        eq(airframe.airlineId, own.id),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const context = await fleetContext(db, own.worldId, [row], now);
  const catalogue = context.catalogues.get(row.catalogueVersion);
  if (catalogue === undefined) return null;

  const windowStart = new Date(context.gameNow.getTime() - UTILISATION_WINDOW_DAYS * MS_PER_DAY);
  const [locations, flown, assignments, orders] = await Promise.all([
    locationsFor(db, [row]),
    blockHoursSince(db, [row], windowStart),
    assignmentsFor(db, own, [row.id]),
    db
      .select({ kind: aircraftOrder.kind })
      .from(aircraftOrder)
      .where(eq(aircraftOrder.id, row.sourceOrderId))
      .limit(1),
  ]);

  const rowContext: RowContext = {
    clock: context.clock,
    gameNow: context.gameNow,
    economyMaintenance: context.economyMaintenance,
    catalogue,
    locationIcao: locations.get(row.id) ?? null,
    blockHours: flown.get(row.id) ?? 0,
    assignments: assignments.get(row.id) ?? [],
  };

  const view = viewOf(row, rowContext);
  const maintenance = maintenanceView(row, rowContext);
  const decomposed = decomposeAirframe(row, catalogue);
  if (view === null || maintenance === null || decomposed === null) return null;

  // `source_order_id` is `notNull` with a `restrict` foreign key, so the order is
  // always there; the fallback keeps the types honest rather than because a
  // delivered airframe can have no order.
  const acquisitionKind: AircraftAcquisitionKind = orders[0]?.kind ?? 'new';

  return {
    airframe: view,
    spec: decomposed.spec,
    options: decomposed.options,
    cabinConfigId: row.cabinConfigId,
    assignments: [...rowContext.assignments],
    maintenance,
    provenance: {
      builtAt: row.builtAt?.toISOString() ?? null,
      deliveredAt: row.deliveredAt.toISOString(),
      deliveredToIcao: row.deliveredToIcao,
      acquisitionKind,
      ownerHistory: ownerHistoryOf(row),
    },
  };
}

/** Exported for the tests that assert the window is the one documented above. */
export const FLEET_UTILISATION_WINDOW_DAYS = UTILISATION_WINDOW_DAYS;
