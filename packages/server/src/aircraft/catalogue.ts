import { and, eq } from 'drizzle-orm';

import {
  AIRCRAFT_CATALOGUE_V1,
  AircraftEraDates,
  AircraftSpec,
  type AircraftType,
  AircraftType as AircraftTypeSchema,
} from '@tailfin/shared';

import { readBuildInfo } from '../build-info';
import { type Database } from '../db/client';
import { aircraftType, world } from '../db/schema';

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

const cache = new Map<string, PinnedCatalogue>();

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
export async function loadCatalogue(db: Database, version: string): Promise<PinnedCatalogue> {
  const cached = cache.get(version);
  if (cached) return cached;

  const rows = await db
    .select()
    .from(aircraftType)
    .where(eq(aircraftType.catalogueVersion, version));

  if (rows.length === 0) throw new UnknownCatalogueError(version);

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
          availableOptionIds: [],
        }),
      ),
    );
  }

  cache.set(version, types);
  return types;
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
  const rows = await db
    .select({ version: world.aircraftCatalogueVersion })
    .from(world)
    .where(eq(world.id, worldId))
    .limit(1);

  const row = rows[0];
  if (!row) throw new Error(`No world ${worldId}`);
  return loadCatalogue(db, row.version);
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

  return {
    version: AIRCRAFT_CATALOGUE_V1.version,
    inserted: inserted.length,
    existing: AIRCRAFT_CATALOGUE_V1.types.length - inserted.length,
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
