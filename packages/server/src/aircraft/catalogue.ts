import { and, eq } from 'drizzle-orm';

import {
  AIRCRAFT_CATALOGUE_V1,
  AircraftEraDates,
  type AircraftOption,
  AircraftOption as AircraftOptionSchema,
  AircraftSpec,
  AircraftSpecDelta,
  type AircraftType,
  AircraftType as AircraftTypeSchema,
} from '@tailfin/shared';

import { readBuildInfo } from '../build-info';
import { type Database } from '../db/client';
import { aircraftOption, aircraftType, aircraftTypeOption, world } from '../db/schema';

/**
 * Reading and seeding the aircraft catalogue (M4-01, App. C.1–C.2, §22.5).
 *
 * The same shape as `economy/seed.ts` and `economy/loader.ts`, and deliberately
 * so — a reader who has understood one has understood both:
 *
 *   - the shipped catalogue is a **seed**, inserted if absent and never updated,
 *     so a deploy cannot revert a published version;
 *   - rows are **immutable**, enforced by trigger, so a world's aircraft cannot
 *     change specification underneath the flights it has already settled;
 *   - the cache is keyed by version and needs no invalidation, because a
 *     version cannot come to mean something else;
 *   - the world's **pin** is read fresh every time, so re-pinning a world takes
 *     effect on the next read in every process.
 *
 * The one difference is storage: an economy is one object read whole, so it is
 * one JSON payload; a catalogue is eighteen things looked up by name, so it is
 * rows with the version in the key.
 */

/** Parsed, frozen, and keyed by designation — the shape callers actually want. */
export type PinnedCatalogue = ReadonlyMap<string, Readonly<AircraftType>>;

/** The version's factory options, keyed by id (M4-03). */
export type PinnedOptions = ReadonlyMap<string, Readonly<AircraftOption>>;

/**
 * One catalogue version, whole.
 *
 * The types and the options are cached together because they are one version and
 * a caller almost always wants both: a configurator needs the type's
 * `availableOptionIds` *and* the rows those ids name, and resolving them from two
 * separately-cached reads would let a half-warmed cache hand back a type whose
 * options are missing.
 */
export interface PinnedCatalogueVersion {
  version: string;
  types: PinnedCatalogue;
  options: PinnedOptions;
}

const cache = new Map<string, PinnedCatalogueVersion>();

export class UnknownCatalogueError extends Error {
  constructor(readonly version: string) {
    super(
      `No aircraft catalogue version "${version}". A world pins a version that has no rows in ` +
        'aircraft_type; nothing falls back to the shipped catalogue, because a world flying ' +
        'different aircraft from the ones it was pinned to is worse than a refusal.',
    );
    this.name = 'UnknownCatalogueError';
  }
}

/** Drop cached versions. For tests; not needed in normal operation. */
export function clearCatalogueCache(version?: string): void {
  if (version === undefined) cache.clear();
  else cache.delete(version);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}

/**
 * Every type in one catalogue version.
 *
 * Parsed on the way **out**, not merely on the way in. A row is text, it can be
 * written by a psql session, and a catalogue that validated against last year's
 * schema is not proof that it validates against this one — the same discipline
 * `economy/loader.ts` uses, and for the same reason.
 */
export async function loadCatalogueVersion(
  db: Database,
  version: string,
): Promise<PinnedCatalogueVersion> {
  const cached = cache.get(version);
  if (cached) return cached;

  const [rows, optionRows, availabilityRows] = await Promise.all([
    db.select().from(aircraftType).where(eq(aircraftType.catalogueVersion, version)),
    db.select().from(aircraftOption).where(eq(aircraftOption.catalogueVersion, version)),
    db.select().from(aircraftTypeOption).where(eq(aircraftTypeOption.catalogueVersion, version)),
  ]);

  if (rows.length === 0) throw new UnknownCatalogueError(version);

  const options = new Map<string, Readonly<AircraftOption>>();
  for (const row of optionRows) {
    options.set(
      row.optionId,
      deepFreeze(
        AircraftOptionSchema.parse({
          id: row.optionId,
          name: row.name,
          summary: row.summary,
          category: row.category,
          specDeltas: AircraftSpecDelta.parse(JSON.parse(row.specDeltas)),
          priceMinor: row.priceMinor,
          leadTimeWeeks: row.leadTimeWeeks,
          retrofittable: row.retrofittable,
          // `as unknown` rather than trusting `JSON.parse`'s `any`: the schema
          // below is what validates these, exactly as it does the deltas.
          requiresResearch: JSON.parse(row.requiresResearch) as unknown,
          conflictsWith: JSON.parse(row.conflictsWith) as unknown,
        }),
      ),
    );
  }

  // Grouped in the application rather than joined, and grouped from a second
  // query rather than a correlated subquery: `CLAUDE.md` records that a
  // correlated subquery in a drizzle select list came back empty against real
  // Postgres, and `countWorldContents` and `listPlayers` both use this shape for
  // the same reason.
  const availability = new Map<string, string[]>();
  for (const row of availabilityRows) {
    // A row naming an option this version does not have is a corrupt version,
    // not a type with a shorter list. Refusing is the same choice
    // `UnknownCatalogueError` makes: a world flying something other than what it
    // was pinned to is worse than a refusal.
    if (!options.has(row.optionId)) {
      throw new Error(
        `Catalogue version "${version}" offers option "${row.optionId}" on ` +
          `${row.designation}, and has no such option row.`,
      );
    }
    const list = availability.get(row.designation);
    if (list === undefined) availability.set(row.designation, [row.optionId]);
    else list.push(row.optionId);
  }

  const types = new Map<string, Readonly<AircraftType>>();
  for (const row of rows) {
    types.set(
      row.designation,
      deepFreeze(
        AircraftTypeSchema.parse({
          designation: row.designation,
          family: row.family,
          manufacturer: row.manufacturer,
          class: row.class,
          maintenanceProfile: row.maintenanceProfile,
          baseSpec: AircraftSpec.parse(JSON.parse(row.baseSpec)),
          eraDates: AircraftEraDates.parse(JSON.parse(row.eraDates)),
          listPrice: row.listPriceMinor,
          monthlyLeaseRate: row.monthlyLeaseRateMinor,
          // Sorted into the same canonical order `availableOptionsFor` uses, so a
          // type read back out of the database equals the type written into it.
          // Postgres returns these rows in no guaranteed order (invariant 2).
          availableOptionIds: (availability.get(row.designation) ?? []).sort((a, b) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        }),
      ),
    );
  }

  const loaded: PinnedCatalogueVersion = { version, types, options };
  cache.set(version, loaded);
  return loaded;
}

/** Just the types. The shape M4-01 and M4-02 already read. */
export async function loadCatalogue(db: Database, version: string): Promise<PinnedCatalogue> {
  return (await loadCatalogueVersion(db, version)).types;
}

/** Just the options — what a configurator resolves a build against. */
export async function loadOptions(db: Database, version: string): Promise<PinnedOptions> {
  return (await loadCatalogueVersion(db, version)).options;
}

/** One type, or `null` — a designation that is not in this version does not exist. */
export async function loadType(
  db: Database,
  version: string,
  designation: string,
): Promise<Readonly<AircraftType> | null> {
  return (await loadCatalogue(db, version)).get(designation) ?? null;
}

/**
 * The catalogue one world is flying, resolved through its current pin.
 *
 * The pin is read here rather than passed in, so a caller cannot hold a stale
 * one across a re-pin.
 */
export async function loadWorldCatalogue(db: Database, worldId: string): Promise<PinnedCatalogue> {
  return (await loadWorldCatalogueVersion(db, worldId)).types;
}

/** The whole pinned version — types and options — for one world. */
export async function loadWorldCatalogueVersion(
  db: Database,
  worldId: string,
): Promise<PinnedCatalogueVersion> {
  const rows = await db
    .select({ version: world.aircraftCatalogueVersion })
    .from(world)
    .where(eq(world.id, worldId))
    .limit(1);

  const row = rows[0];
  if (!row) throw new Error(`No world ${worldId}`);
  return loadCatalogueVersion(db, row.version);
}

/** Whether a version has any rows — the check a world-creation validator wants. */
export async function catalogueVersionExists(db: Database, version: string): Promise<boolean> {
  if (cache.has(version)) return true;
  const rows = await db
    .select({ designation: aircraftType.designation })
    .from(aircraftType)
    .where(eq(aircraftType.catalogueVersion, version))
    .limit(1);
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

export interface CatalogueSeedResult {
  version: string;
  /** Types created by this run. Zero on a database that already has them. */
  inserted: number;
  /** Types already present. */
  existing: number;
  /** Options created by this run (M4-03). */
  optionsInserted: number;
  /** Type/option availability rows created by this run. */
  availabilityInserted: number;
}

const asDate = (iso: string | null): Date | null =>
  iso === null ? null : new Date(`${iso}T00:00:00.000Z`);

/**
 * Put the shipped catalogue into a database that has never seen it.
 *
 * `onConflictDoNothing`, deliberately, exactly as the economy seed does: once a
 * version exists in a database it belongs to that database, and a deploy must
 * not be able to change what a world is flying.
 *
 * A partially-present version is completed rather than refused. That is the
 * shape of the only realistic failure — a seed interrupted halfway — and
 * finishing it is both harmless and what an operator would want.
 */
export async function seedAircraftCatalogue(db: Database): Promise<CatalogueSeedResult> {
  const build = readBuildInfo();
  const label = `build ${String(build.build)} (${build.commit})`;

  const inserted = await db
    .insert(aircraftType)
    .values(
      AIRCRAFT_CATALOGUE_V1.types.map((type) => ({
        catalogueVersion: AIRCRAFT_CATALOGUE_V1.version,
        designation: type.designation,
        family: type.family,
        manufacturer: type.manufacturer,
        class: type.class,
        maintenanceProfile: type.maintenanceProfile,
        baseSpec: JSON.stringify(type.baseSpec),
        eraDates: JSON.stringify(type.eraDates),
        // The same four dates as columns, so era gating is an indexed query
        // rather than eighteen JSON parses. The JSON stays the source of truth.
        firstFlight: asDate(type.eraDates.firstFlight),
        entryIntoService: asDate(type.eraDates.entryIntoService),
        productionEnd: asDate(type.eraDates.productionEnd),
        outOfService: asDate(type.eraDates.outOfService),
        listPriceMinor: type.listPrice,
        monthlyLeaseRateMinor: type.monthlyLeaseRate,
        createdByLabel: label,
      })),
    )
    .onConflictDoNothing()
    .returning({ designation: aircraftType.designation });

  // Options and their availability, same version, same insert-if-absent rule.
  //
  // Deliberately *not* conditional on `inserted.length` — a database seeded
  // before M4-03 already holds v1's eighteen types and none of its options, and
  // completing that version is exactly the case `seedAircraftCatalogue`'s
  // partially-present note describes.
  const optionsInserted = await db
    .insert(aircraftOption)
    .values(
      AIRCRAFT_CATALOGUE_V1.options.map((option) => ({
        catalogueVersion: AIRCRAFT_CATALOGUE_V1.version,
        optionId: option.id,
        name: option.name,
        summary: option.summary,
        category: option.category,
        specDeltas: JSON.stringify(option.specDeltas),
        priceMinor: option.priceMinor,
        leadTimeWeeks: option.leadTimeWeeks,
        retrofittable: option.retrofittable,
        requiresResearch: JSON.stringify(option.requiresResearch),
        conflictsWith: JSON.stringify(option.conflictsWith),
        createdByLabel: label,
      })),
    )
    .onConflictDoNothing()
    .returning({ optionId: aircraftOption.optionId });

  const availability = AIRCRAFT_CATALOGUE_V1.types.flatMap((type) =>
    type.availableOptionIds.map((optionId) => ({
      catalogueVersion: AIRCRAFT_CATALOGUE_V1.version,
      designation: type.designation,
      optionId,
    })),
  );

  const availabilityInserted =
    availability.length === 0
      ? []
      : await db
          .insert(aircraftTypeOption)
          .values(availability)
          .onConflictDoNothing()
          .returning({ optionId: aircraftTypeOption.optionId });

  return {
    version: AIRCRAFT_CATALOGUE_V1.version,
    inserted: inserted.length,
    existing: AIRCRAFT_CATALOGUE_V1.types.length - inserted.length,
    optionsInserted: optionsInserted.length,
    availabilityInserted: availabilityInserted.length,
  };
}

/**
 * The shipped catalogue, guaranteed present — once per process.
 *
 * Same memoised ensure as the economy config, and it exists for the same reason
 * that one does: a world cannot be created without a catalogue to pin, and the
 * places that create worlds include the test suite and `pnpm world:seed`,
 * neither of which boots the web server.
 */
let pending: Promise<CatalogueSeedResult> | null = null;

export function ensureCatalogueSeeded(db: Database): Promise<CatalogueSeedResult> {
  pending ??= seedAircraftCatalogue(db).catch((error: unknown) => {
    pending = null;
    throw error;
  });
  return pending;
}

/** Forget that this process has seeded. For tests that want a cold start. */
export function resetCatalogueSeedMemo(): void {
  pending = null;
}

/** Types in a version, filtered by what a world's clock permits. Used by M4-02. */
export async function typesInWorld(
  db: Database,
  worldId: string,
): Promise<readonly Readonly<AircraftType>[]> {
  return [...(await loadWorldCatalogue(db, worldId)).values()];
}

/** Whether this version has this designation, without loading the whole catalogue. */
export async function typeExists(
  db: Database,
  version: string,
  designation: string,
): Promise<boolean> {
  const rows = await db
    .select({ designation: aircraftType.designation })
    .from(aircraftType)
    .where(
      and(eq(aircraftType.catalogueVersion, version), eq(aircraftType.designation, designation)),
    )
    .limit(1);
  return rows.length > 0;
}
