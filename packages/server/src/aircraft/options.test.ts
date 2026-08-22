import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AIRCRAFT_CATALOGUE_V1,
  AIRCRAFT_CATALOGUE_V1_VERSION,
  AIRCRAFT_OPTIONS_V1,
} from '@tailfin/shared';
import { computeEffectiveSpec, resolveOptions, validateBuild } from '@tailfin/sim';

import { createDatabase, type DatabaseHandle } from '../db/client';
import { aircraftOption, aircraftTypeOption } from '../db/schema';

import {
  clearCatalogueCache,
  loadCatalogue,
  loadCatalogueVersion,
  loadOptions,
  seedAircraftCatalogue,
} from './catalogue';

/**
 * Factory options in the database (M4-03, App. C.3, C.6, §22.5).
 *
 * `aircraft-options.test.ts` in `packages/shared` checks the option set against
 * C.3's own rules, and `effective-spec.test.ts` in `packages/sim` reproduces
 * C.4. This checks the half that needs storage:
 *
 *   - the options and their availability arrive intact and are versioned;
 *   - a version, once written, cannot be edited;
 *   - a build resolved from the **stored** rows folds to the same spec as one
 *     resolved from the shipped constant, which is what makes the round trip
 *     worth anything.
 *
 * Requires `DATABASE_URL` against a migrated database; CI provides both.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [options.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

describeDb('factory options in the catalogue', () => {
  let db: DatabaseHandle;

  beforeAll(async () => {
    db = createDatabase();
    await seedAircraftCatalogue(db.db);
  });

  afterAll(async () => {
    clearCatalogueCache();
    await db.close();
  });

  describe('seeding', () => {
    it('is idempotent', async () => {
      const again = await seedAircraftCatalogue(db.db);
      expect(again.optionsInserted).toBe(0);
      expect(again.availabilityInserted).toBe(0);
    });

    it('lands every option App. C.3 tabulates', async () => {
      const rows = await db.db
        .select({ optionId: aircraftOption.optionId })
        .from(aircraftOption)
        .where(eq(aircraftOption.catalogueVersion, AIRCRAFT_CATALOGUE_V1_VERSION));

      expect(rows.map((r) => r.optionId).sort()).toEqual(
        AIRCRAFT_OPTIONS_V1.map((o) => o.id).sort(),
      );
    });

    it('lands the availability every type was authored with', async () => {
      const expected = AIRCRAFT_CATALOGUE_V1.types.reduce(
        (total, type) => total + type.availableOptionIds.length,
        0,
      );
      const rows = await db.db
        .select({ optionId: aircraftTypeOption.optionId })
        .from(aircraftTypeOption)
        .where(eq(aircraftTypeOption.catalogueVersion, AIRCRAFT_CATALOGUE_V1_VERSION));

      expect(rows).toHaveLength(expected);
    });

    it('offers the folding wingtips to the 777-9 and to nothing else', async () => {
      // C.3 names the aircraft, and the storage layer must not widen it.
      const rows = await db.db
        .select({ designation: aircraftTypeOption.designation })
        .from(aircraftTypeOption)
        .where(
          and(
            eq(aircraftTypeOption.catalogueVersion, AIRCRAFT_CATALOGUE_V1_VERSION),
            eq(aircraftTypeOption.optionId, 'folding-wingtips'),
          ),
        );

      expect(rows.map((r) => r.designation)).toEqual(['777-9']);
    });
  });

  describe('a version, once written', () => {
    it('cannot have an option updated', async () => {
      // The same guarantee `aircraft_type` has, for the same reason: an airframe
      // built with three tanks has that build folded into every flight_result it
      // ever settled.
      await expect(
        db.db
          .update(aircraftOption)
          .set({ priceMinor: 1 })
          .where(
            and(
              eq(aircraftOption.catalogueVersion, AIRCRAFT_CATALOGUE_V1_VERSION),
              eq(aircraftOption.optionId, 'sharklets'),
            ),
          ),
      ).rejects.toThrow();
    });

    it('cannot have an option deleted', async () => {
      await expect(
        db.db
          .delete(aircraftOption)
          .where(
            and(
              eq(aircraftOption.catalogueVersion, AIRCRAFT_CATALOGUE_V1_VERSION),
              eq(aircraftOption.optionId, 'sharklets'),
            ),
          ),
      ).rejects.toThrow();
    });

    it('cannot have its availability rewritten', async () => {
      // Which options a type *could* be ordered with is as much a fact about a
      // settled flight as the deltas themselves.
      await expect(
        db.db
          .delete(aircraftTypeOption)
          .where(
            and(
              eq(aircraftTypeOption.catalogueVersion, AIRCRAFT_CATALOGUE_V1_VERSION),
              eq(aircraftTypeOption.optionId, 'sharklets'),
            ),
          ),
      ).rejects.toThrow();
    });
  });

  describe('loading', () => {
    it('round-trips every option through the database unchanged', async () => {
      const stored = await loadOptions(db.db, AIRCRAFT_CATALOGUE_V1_VERSION);
      for (const shipped of AIRCRAFT_OPTIONS_V1) {
        expect(stored.get(shipped.id), shipped.id).toEqual(shipped);
      }
    });

    it('gives each type the availability it was authored with', async () => {
      const types = await loadCatalogue(db.db, AIRCRAFT_CATALOGUE_V1_VERSION);
      for (const shipped of AIRCRAFT_CATALOGUE_V1.types) {
        expect(
          types.get(shipped.designation)?.availableOptionIds.slice().sort(),
          shipped.designation,
        ).toEqual(shipped.availableOptionIds.slice().sort());
      }
    });

    it('freezes what it hands out', async () => {
      const options = await loadOptions(db.db, AIRCRAFT_CATALOGUE_V1_VERSION);
      const sharklets = options.get('sharklets');
      expect(sharklets).toBeDefined();
      // A caller that mutated a cached option would change it for every other
      // caller in the process.
      expect(Object.isFrozen(sharklets)).toBe(true);
      expect(Object.isFrozen(sharklets?.specDeltas)).toBe(true);
    });

    it('names an option a type offers against a real row', async () => {
      // Every availability row resolves. The loader refuses a version where one
      // does not, so this passing is the claim.
      const { types, options } = await loadCatalogueVersion(db.db, AIRCRAFT_CATALOGUE_V1_VERSION);
      for (const type of types.values()) {
        for (const id of type.availableOptionIds) {
          expect(options.get(id), `${type.designation} offers ${id}`).toBeDefined();
        }
      }
    });
  });

  describe('a build resolved from stored rows', () => {
    it('folds to the same spec as one resolved from the shipped constant', async () => {
      // The point of the round trip. If storage lost a delta, C.4 would still
      // pass in `packages/sim` and the game would be wrong.
      const { types, options } = await loadCatalogueVersion(db.db, AIRCRAFT_CATALOGUE_V1_VERSION);
      const stored = types.get('A321neo');
      const shipped = AIRCRAFT_CATALOGUE_V1.types.find((t) => t.designation === 'A321neo');
      expect(stored).toBeDefined();
      expect(shipped).toBeDefined();
      if (stored === undefined || shipped === undefined) return;

      const build = ['act-3', 'mtow-increase', 'etops-180'];

      const fromStorage = resolveOptions({
        type: stored,
        catalogue: options,
        optionIds: build,
        research: ['etops-180'],
      });
      expect(fromStorage.ok).toBe(true);
      if (!fromStorage.ok) return;

      const spec = computeEffectiveSpec({
        baseSpec: stored.baseSpec,
        options: fromStorage.options,
      });

      // App. C.4's long-range column, out of the database.
      expect(spec.rangeNm).toBe(4_700);
      expect(spec.mtowTonnes).toBe(101);
    });

    it('refuses an option the stored type does not offer', async () => {
      const { types, options } = await loadCatalogueVersion(db.db, AIRCRAFT_CATALOGUE_V1_VERSION);
      const atr = types.get('ATR 72-600');
      expect(atr).toBeDefined();
      if (atr === undefined) return;

      // An 825 nm turboprop has nowhere useful to put three centre tanks.
      const refusals = validateBuild({
        type: atr,
        catalogue: options,
        optionIds: ['act-3'],
      });
      expect(refusals.map((r) => r.code)).toContain('not_available_for_type');
      expect(refusals[0]?.detail).toContain('ATR 72-600');
    });
  });
});
