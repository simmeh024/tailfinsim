import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AIRCRAFT_CATALOGUE_V1, AIRCRAFT_CATALOGUE_V1_VERSION } from '@tailfin/shared';
import { availabilityOf, isOrderableNew } from '@tailfin/sim';

import { createDatabase, type DatabaseHandle } from '../db/client';
import { aircraftType } from '../db/schema';

import {
  catalogueVersionExists,
  clearCatalogueCache,
  loadCatalogue,
  loadType,
  seedAircraftCatalogue,
  UnknownCatalogueError,
} from './catalogue';

/**
 * The catalogue in the database (M4-01, §22.5).
 *
 * `aircraft-catalogue.test.ts` in `packages/shared` checks the eighteen types
 * against App. C.2. This checks the half that needs storage: that they arrive
 * intact, that a version cannot be edited once written, and that a world
 * resolves the version it pins rather than whatever happens to be shipped.
 *
 * Requires `DATABASE_URL` against a migrated database; CI provides both.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [catalogue.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

describeDb('the aircraft catalogue', () => {
  let db: DatabaseHandle;

  beforeAll(async () => {
    db = createDatabase();
    // What the web node's startup arranges. Idempotent, so running it here
    // costs nothing after the first.
    await seedAircraftCatalogue(db.db);
  });

  afterAll(async () => {
    clearCatalogueCache();
    await db.close();
  });

  describe('seeding', () => {
    it('is idempotent', async () => {
      const again = await seedAircraftCatalogue(db.db);
      expect(again.inserted).toBe(0);
      expect(again.existing).toBe(18);
    });

    it('lands all eighteen types', async () => {
      const rows = await db.db
        .select({ designation: aircraftType.designation })
        .from(aircraftType)
        .where(eq(aircraftType.catalogueVersion, AIRCRAFT_CATALOGUE_V1_VERSION));
      expect(rows).toHaveLength(18);
    });

    it('denormalises the era dates into columns that match the JSON', async () => {
      // The columns are an index over the JSON, which stays the source of truth.
      // Two copies of a fact is a bug waiting to happen unless something checks.
      const rows = await db.db
        .select()
        .from(aircraftType)
        .where(eq(aircraftType.catalogueVersion, AIRCRAFT_CATALOGUE_V1_VERSION));

      for (const row of rows) {
        const era = JSON.parse(row.eraDates) as { entryIntoService: string | null };
        const column = row.entryIntoService?.toISOString().slice(0, 10) ?? null;
        expect(column, row.designation).toBe(era.entryIntoService);
      }
    });
  });

  describe('a version, once written', () => {
    it('cannot be updated', async () => {
      // A world flying a type has its performance baked into every flight_result
      // it has settled. A spec that could change underneath those would make an
      // old flight inexplicable (invariant 4).
      await expect(
        db.db
          .update(aircraftType)
          .set({ family: 'tampered' })
          .where(eq(aircraftType.designation, 'A320neo')),
      ).rejects.toThrow();
    });

    it('cannot be deleted', async () => {
      await expect(
        db.db.delete(aircraftType).where(eq(aircraftType.designation, 'A320neo')),
      ).rejects.toThrow();
    });
  });

  describe('loading', () => {
    it('returns every type, keyed by designation', async () => {
      const catalogue = await loadCatalogue(db.db, AIRCRAFT_CATALOGUE_V1_VERSION);
      expect(catalogue.size).toBe(18);
      expect(catalogue.get('A321XLR')?.baseSpec.rangeNm).toBe(4_700);
    });

    it('round-trips a type through the database unchanged', async () => {
      // The thing storage can quietly break: a number that went in as 23.0 and
      // came back as a string, or a nested array that lost its order.
      const shipped = AIRCRAFT_CATALOGUE_V1.types.find((t) => t.designation === 'ATR 72-600')!;
      const stored = await loadType(db.db, AIRCRAFT_CATALOGUE_V1_VERSION, 'ATR 72-600');
      expect(stored).toEqual(shipped);
    });

    it('refuses a version nobody published, rather than falling back', async () => {
      await expect(loadCatalogue(db.db, 'not-a-version')).rejects.toThrow(UnknownCatalogueError);
    });

    it('answers whether a version could be pinned', async () => {
      expect(await catalogueVersionExists(db.db, AIRCRAFT_CATALOGUE_V1_VERSION)).toBe(true);
      expect(await catalogueVersionExists(db.db, 'not-a-version')).toBe(false);
    });

    it('has no type for a designation that is not in the catalogue', async () => {
      expect(await loadType(db.db, AIRCRAFT_CATALOGUE_V1_VERSION, 'Concorde')).toBeNull();
    });

    it('freezes what it hands out', async () => {
      const type = await loadType(db.db, AIRCRAFT_CATALOGUE_V1_VERSION, 'A320neo');
      expect(Object.isFrozen(type)).toBe(true);
      expect(Object.isFrozen(type?.baseSpec)).toBe(true);
    });
  });

  describe('era gating over the stored catalogue', () => {
    it('agrees with the sim about what a 2024 world can order', async () => {
      // The stored catalogue and the pure rule have to reach the same answer,
      // or the list a player sees and the order they can place disagree.
      const catalogue = await loadCatalogue(db.db, AIRCRAFT_CATALOGUE_V1_VERSION);
      const epoch = new Date('2024-10-20T00:00:00.000Z');

      expect(availabilityOf(catalogue.get('777-9')!.eraDates, epoch)).toBe('prototype');
      expect(isOrderableNew(catalogue.get('A321XLR')!.eraDates, epoch)).toBe(false);
      expect(isOrderableNew(catalogue.get('A320neo')!.eraDates, epoch)).toBe(true);
      expect(availabilityOf(catalogue.get('737-800')!.eraDates, epoch)).toBe('used_only');
    });

    it('can answer the same question from the indexed columns', async () => {
      // The reason the dates are columns as well as JSON: this query is what a
      // fleet list runs, and parsing eighteen blobs to answer it would make era
      // gating cost a scan every time somebody opened a page.
      const orderable = await db.db
        .select({ designation: aircraftType.designation })
        .from(aircraftType)
        .where(eq(aircraftType.catalogueVersion, AIRCRAFT_CATALOGUE_V1_VERSION));

      const epoch = new Date('2024-10-20T00:00:00.000Z');
      const catalogue = await loadCatalogue(db.db, AIRCRAFT_CATALOGUE_V1_VERSION);
      const fromJson = orderable
        .filter((row) => isOrderableNew(catalogue.get(row.designation)!.eraDates, epoch))
        .map((row) => row.designation)
        .sort();

      const fromColumns = await db.db
        .select({
          designation: aircraftType.designation,
          eis: aircraftType.entryIntoService,
          end: aircraftType.productionEnd,
        })
        .from(aircraftType)
        .where(eq(aircraftType.catalogueVersion, AIRCRAFT_CATALOGUE_V1_VERSION));

      const viaColumns = fromColumns
        .filter(
          (row) => row.eis !== null && row.eis <= epoch && (row.end === null || row.end > epoch),
        )
        .map((row) => row.designation)
        .sort();

      expect(viaColumns).toEqual(fromJson);
    });
  });
});
