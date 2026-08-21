import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  canonicalEconomyJson,
  ECONOMY_CONFIG_V1_VERSION,
  type EconomyConfig,
  FLAGSHIP_CONFIG,
} from '@tailfin/shared';

import { BOOTSTRAP_ACTOR } from '../admin/grants';
import { createDatabase, type DatabaseHandle } from '../db/client';
import { economyConfig, world, type WorldRow } from '../db/schema';
import { createWorld } from '../world/lifecycle';

import { ECONOMY_CONFIG_V1 } from './config';
import {
  clearEconomyConfigCache,
  economyCacheStats,
  economyConfigVersionExists,
  loadEconomyConfig,
  loadWorldEconomyConfig,
} from './loader';
import { ensureEconomyConfigSeeded, resetEconomySeedMemo, seedEconomyConfig } from './seed';
import {
  createEconomyConfigVersion,
  listEconomyConfigVersions,
  pinWorldEconomyConfig,
  readEconomyConfigVersion,
  validateCreateRequest,
  validatePinRequest,
} from './versions';

/**
 * The economy as versioned, live-editable data (M3-11, §22.3).
 *
 * The three acceptance criteria, each with a test that fails if it stops being
 * true. The first — no balance literal in `packages/sim` — is a property of the
 * source and is asserted in `balance-source.test.ts`; this file covers the other
 * two, which are properties of the running system:
 *
 *   - a config change takes effect without a deploy
 *   - every version is diffable against the previous
 *
 * Plus the thing that makes both safe: a version cannot be edited once written.
 *
 * Requires `DATABASE_URL` against a migrated database; CI provides both. Note
 * that the versions these tests create **cannot be cleaned up** — the table's
 * triggers refuse DELETE, which is the property under test. Every name is
 * therefore unique per run.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [economy-config.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

/** Unique per call. A version can never be deleted, so a name is used once. */
function versionName(label: string): string {
  return `t-${label}-${randomUUID().slice(0, 8)}`;
}

/** A retune of the shipped payload, as an admin would submit one. */
function retunedPayload(mutate: (draft: EconomyConfig) => void): string {
  const draft = JSON.parse(canonicalEconomyJson(ECONOMY_CONFIG_V1)) as EconomyConfig;
  mutate(draft);
  return JSON.stringify(draft);
}

describeDb('the economy in the database', () => {
  let db: DatabaseHandle;
  const madeWorlds: string[] = [];

  beforeAll(async () => {
    db = createDatabase();
    // Every test below assumes v1 is there, exactly as the web node's startup
    // arranges. Idempotent, so running it here costs nothing after the first.
    await seedEconomyConfig(db.db);
  });

  afterEach(async () => {
    for (const id of madeWorlds.splice(0)) {
      await db.db.delete(world).where(eq(world.id, id));
    }
    clearEconomyConfigCache();
  });

  afterAll(async () => {
    await db.close();
  });

  async function makeWorld(
    economyConfigVersion: string = ECONOMY_CONFIG_V1_VERSION,
  ): Promise<WorldRow> {
    const created = await createWorld(db.db, {
      ...FLAGSHIP_CONFIG,
      name: `economy-test-${randomUUID().slice(0, 8)}`,
      economyConfigVersion,
    });
    madeWorlds.push(created.world.id);
    return created.world;
  }

  // ------------------------------------------------------------------- seed

  describe('seeding the shipped payload', () => {
    it('is what makes a freshly migrated database able to hold a world', async () => {
      // The bug this exists for: the seed originally ran only in `main.ts`, so
      // every process that creates a world without booting the web server —
      // the test suite, `pnpm world:seed`, the admin CLI — met an empty table
      // and could not create one at all.
      resetEconomySeedMemo();
      const result = await ensureEconomyConfigSeeded(db.db);
      expect(result.version).toBe(ECONOMY_CONFIG_V1_VERSION);

      const created = await makeWorld();
      expect(created.economyConfigVersion).toBe(ECONOMY_CONFIG_V1_VERSION);
    });

    it('costs one round trip per process, however often it is asked', async () => {
      resetEconomySeedMemo();
      const [first, second] = await Promise.all([
        ensureEconomyConfigSeeded(db.db),
        ensureEconomyConfigSeeded(db.db),
      ]);
      // The same promise, so two callers racing cannot both insert.
      expect(first).toBe(second);
    });

    it('is idempotent, and says which run created it', async () => {
      const again = await seedEconomyConfig(db.db);
      expect(again.inserted).toBe(false);
      expect(again.matchesShipped).toBe(true);
      expect(again.storedChecksum).toBe(again.shippedChecksum);
    });

    it('stores the payload in canonical form, so the checksum describes the row', async () => {
      const rows = await db.db
        .select()
        .from(economyConfig)
        .where(eq(economyConfig.version, ECONOMY_CONFIG_V1_VERSION));

      expect(rows[0]?.payload).toBe(canonicalEconomyJson(ECONOMY_CONFIG_V1));
      expect(rows[0]?.parentVersion).toBeNull();
    });
  });

  // ----------------------------------------------------------- immutability

  describe('a version, once written', () => {
    it('cannot be updated, however the update is phrased', async () => {
      // The guarantee the cache rests on, and the reason an old flight_result
      // stays explicable. Enforced by the database rather than by convention,
      // so it holds against a psql session too.
      await expect(
        db.db
          .update(economyConfig)
          .set({ notes: 'tampered' })
          .where(eq(economyConfig.version, ECONOMY_CONFIG_V1_VERSION)),
      ).rejects.toThrow();
    });

    it('cannot be deleted', async () => {
      await expect(
        db.db.delete(economyConfig).where(eq(economyConfig.version, ECONOMY_CONFIG_V1_VERSION)),
      ).rejects.toThrow();
    });

    it('still holds the shipped payload after both attempts', async () => {
      const rows = await db.db
        .select()
        .from(economyConfig)
        .where(eq(economyConfig.version, ECONOMY_CONFIG_V1_VERSION));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.notes).not.toBe('tampered');
    });
  });

  // ----------------------------------------------------------------- loader

  describe('loading what a world runs', () => {
    it('resolves a world through its pin', async () => {
      const created = await makeWorld();
      const config = await loadWorldEconomyConfig(db.db, created.id);
      expect(config.version).toBe(ECONOMY_CONFIG_V1_VERSION);
      expect(config.demand.logit.beta.leisure.price).toBe(3.0);
    });

    it('caches by version, so a second read costs no query', async () => {
      clearEconomyConfigCache();
      await loadEconomyConfig(db.db, ECONOMY_CONFIG_V1_VERSION);
      const afterFirst = economyCacheStats();
      expect(afterFirst.misses).toBe(1);

      await loadEconomyConfig(db.db, ECONOMY_CONFIG_V1_VERSION);
      const afterSecond = economyCacheStats();
      expect(afterSecond.hits).toBe(1);
      expect(afterSecond.misses).toBe(1);
      expect(afterSecond.size).toBe(1);
    });

    it('refuses a version that is not there rather than falling back', async () => {
      // The failure this prevents is the quiet one: a world running the shipped
      // numbers while claiming to run a retune.
      await expect(loadEconomyConfig(db.db, 'not-a-version')).rejects.toThrow(
        /No economy config version "not-a-version"/,
      );
    });

    it('answers whether a version could be pinned, without loading it', async () => {
      expect(await economyConfigVersionExists(db.db, ECONOMY_CONFIG_V1_VERSION)).toBe(true);
      expect(await economyConfigVersionExists(db.db, 'not-a-version')).toBe(false);
    });
  });

  // -------------------------------------------------- creating a new version

  describe('creating a version', () => {
    it('writes it, diffs it against its parent, and pins nothing', async () => {
      const version = versionName('create');
      const validated = validateCreateRequest({
        version,
        parentVersion: ECONOMY_CONFIG_V1_VERSION,
        notes: 'Leisure price sensitivity down, for the autumn test.',
        payloadJson: retunedPayload((draft) => {
          draft.demand.logit.beta.leisure.price = 2.6;
        }),
      });
      if (!validated.ok) throw new Error(`expected valid: ${JSON.stringify(validated.fields)}`);

      const outcome = await createEconomyConfigVersion(db.db, validated, BOOTSTRAP_ACTOR);
      if (!outcome.ok) throw new Error(`expected success: ${outcome.message}`);

      // Exactly the change that was made, and nothing else. `version` differs
      // too, which is honest — it is a field of the payload.
      expect(outcome.diff).toEqual([
        { path: 'version', before: ECONOMY_CONFIG_V1_VERSION, after: version },
        { path: 'demand.logit.beta.leisure.price', before: 3.0, after: 2.6 },
      ]);

      // Created is not applied. Nothing moves until a world is pinned.
      expect(outcome.summary.worldsPinned).toBe(0);
    });

    it('refuses a payload that is not a valid economy, naming the field', () => {
      const validated = validateCreateRequest({
        version: versionName('bad'),
        parentVersion: ECONOMY_CONFIG_V1_VERSION,
        notes: 'Should not survive validation.',
        payloadJson: retunedPayload((draft) => {
          (draft.demand.logit.beta.leisure as { price: unknown }).price = 'cheap';
        }),
      });

      if (validated.ok) throw new Error('expected a refusal');
      expect(validated.code).toBe('invalid_payload');
      expect(validated.fields.payloadJson?.[0]).toMatch(/demand\.logit\.beta\.leisure\.price/);
    });

    it('refuses a name that is already taken, because a version is never edited', () => {
      const validated = validateCreateRequest({
        version: ECONOMY_CONFIG_V1_VERSION,
        parentVersion: ECONOMY_CONFIG_V1_VERSION,
        notes: 'An attempt to edit v1 in place.',
        payloadJson: retunedPayload((draft) => {
          draft.pricing.fareFloorRatio = 0.5;
        }),
      });
      // Caught before the database: deriving a version from itself is nonsense
      // whatever the table holds.
      if (validated.ok) throw new Error('expected a refusal');
      expect(validated.code).toBe('invalid_request');
      expect(validated.fields.parentVersion?.[0]).toMatch(/cannot be derived from itself/);
    });

    it('refuses a parent that does not exist', async () => {
      const validated = validateCreateRequest({
        version: versionName('orphan'),
        parentVersion: 'not-a-version',
        notes: 'No such ancestor.',
        payloadJson: canonicalEconomyJson(ECONOMY_CONFIG_V1),
      });
      if (!validated.ok) throw new Error('expected the request itself to be well formed');

      const outcome = await createEconomyConfigVersion(db.db, validated, BOOTSTRAP_ACTOR);
      if (outcome.ok) throw new Error('expected a refusal');
      expect(outcome.code).toBe('unknown_parent');
    });
  });

  // ------------------------------------------------------ pinning it, or not

  describe('pinning a world to a version', () => {
    async function makeVersion(mutate: (draft: EconomyConfig) => void): Promise<string> {
      const version = versionName('pin');
      const validated = validateCreateRequest({
        version,
        parentVersion: ECONOMY_CONFIG_V1_VERSION,
        notes: 'A retune to pin.',
        payloadJson: retunedPayload(mutate),
      });
      if (!validated.ok) throw new Error('expected valid');
      const outcome = await createEconomyConfigVersion(db.db, validated, BOOTSTRAP_ACTOR);
      if (!outcome.ok) throw new Error(`expected success: ${outcome.message}`);
      return version;
    }

    it('takes effect on the next read, with no restart and no deploy', async () => {
      const created = await makeWorld();
      const before = await loadWorldEconomyConfig(db.db, created.id);
      expect(before.airlineStartingPosition.openingCashMinor).toBe(50_000_000);

      const version = await makeVersion((draft) => {
        draft.airlineStartingPosition.openingCashMinor = 75_000_000;
      });

      const outcome = await pinWorldEconomyConfig(
        db.db,
        created.id,
        { version, expectedVersion: ECONOMY_CONFIG_V1_VERSION },
        BOOTSTRAP_ACTOR,
      );
      if (!outcome.ok) throw new Error(`expected success: ${outcome.message}`);

      // The whole criterion, in one assertion: nothing was restarted, no cache
      // was flushed, and the world is running different numbers. The pin is read
      // fresh every time; only the immutable payload is cached.
      const after = await loadWorldEconomyConfig(db.db, created.id);
      expect(after.version).toBe(version);
      expect(after.airlineStartingPosition.openingCashMinor).toBe(75_000_000);
    });

    it('reports what moved, so the change is reviewable', async () => {
      const created = await makeWorld();
      const version = await makeVersion((draft) => {
        draft.costs.settlement.crewCostPerBlockHourMinor = 21_000;
      });

      const outcome = await pinWorldEconomyConfig(
        db.db,
        created.id,
        { version, expectedVersion: ECONOMY_CONFIG_V1_VERSION },
        BOOTSTRAP_ACTOR,
      );
      if (!outcome.ok) throw new Error('expected success');

      expect(outcome.diff).toContainEqual({
        path: 'costs.settlement.crewCostPerBlockHourMinor',
        before: 19_500,
        after: 21_000,
      });
    });

    it('refuses when the world has moved on since the admin was shown it', async () => {
      const created = await makeWorld();
      const version = await makeVersion((draft) => {
        draft.pricing.fareFloorRatio = 0.55;
      });

      const outcome = await pinWorldEconomyConfig(
        db.db,
        created.id,
        { version, expectedVersion: 'something-else' },
        BOOTSTRAP_ACTOR,
      );
      if (outcome.ok) throw new Error('expected a refusal');
      expect(outcome.code).toBe('version_stale');
    });

    it('refuses a version that does not exist', async () => {
      const created = await makeWorld();
      const outcome = await pinWorldEconomyConfig(
        db.db,
        created.id,
        { version: 'not-a-version', expectedVersion: ECONOMY_CONFIG_V1_VERSION },
        BOOTSTRAP_ACTOR,
      );
      if (outcome.ok) throw new Error('expected a refusal');
      expect(outcome.code).toBe('unknown_version');
    });

    it('refuses a repin to the version already in force, rather than logging a non-change', async () => {
      const created = await makeWorld();
      const outcome = await pinWorldEconomyConfig(
        db.db,
        created.id,
        {
          version: ECONOMY_CONFIG_V1_VERSION,
          expectedVersion: ECONOMY_CONFIG_V1_VERSION,
        },
        BOOTSTRAP_ACTOR,
      );
      if (outcome.ok) throw new Error('expected a refusal');
      expect(outcome.code).toBe('version_unchanged');
    });

    it('rolls back by pinning the old version again', async () => {
      // §22.3's "one-click rollback". It works because versions are never
      // deleted, so the thing to go back to is always still there.
      const created = await makeWorld();
      const version = await makeVersion((draft) => {
        draft.pricing.fareFloorRatio = 0.5;
      });

      await pinWorldEconomyConfig(
        db.db,
        created.id,
        { version, expectedVersion: ECONOMY_CONFIG_V1_VERSION },
        BOOTSTRAP_ACTOR,
      );
      const back = await pinWorldEconomyConfig(
        db.db,
        created.id,
        { version: ECONOMY_CONFIG_V1_VERSION, expectedVersion: version },
        BOOTSTRAP_ACTOR,
      );
      if (!back.ok) throw new Error(`expected success: ${back.message}`);

      const after = await loadWorldEconomyConfig(db.db, created.id);
      expect(after.pricing.fareFloorRatio).toBe(0.6);
    });

    it('rejects a malformed pin request without touching the world', () => {
      expect(validatePinRequest({ version: 'v1' }).ok).toBe(false);
      expect(validatePinRequest(null).ok).toBe(false);
      expect(validatePinRequest({ version: 'V 1', expectedVersion: 'v1' }).ok).toBe(false);
    });
  });

  // -------------------------------------------------------------- listing it

  describe('listing and reading versions', () => {
    it('counts the worlds pinned to each version', async () => {
      const created = await makeWorld();
      const versions = await listEconomyConfigVersions(db.db);
      const v1 = versions.find((v) => v.version === ECONOMY_CONFIG_V1_VERSION);

      expect(v1).toBeDefined();
      // At least the one just made. Other suites in the same run may hold more,
      // which is why this is a lower bound rather than an equality.
      expect(v1?.worldsPinned ?? 0).toBeGreaterThanOrEqual(1);
      expect(created.economyConfigVersion).toBe(ECONOMY_CONFIG_V1_VERSION);
    });

    it('returns the payload as the exact bytes the checksum covers', async () => {
      const detail = await readEconomyConfigVersion(db.db, ECONOMY_CONFIG_V1_VERSION);
      expect(detail?.payloadJson).toBe(canonicalEconomyJson(ECONOMY_CONFIG_V1));
      // The seed has no parent, so there is nothing to compare it against — null
      // rather than an empty diff, which would claim they were identical.
      expect(detail?.comparedWith).toBeNull();
      expect(detail?.diff).toBeNull();
    });

    it('diffs a version against the one it came from', async () => {
      const version = versionName('read');
      const validated = validateCreateRequest({
        version,
        parentVersion: ECONOMY_CONFIG_V1_VERSION,
        notes: 'Cheaper connections.',
        payloadJson: retunedPayload((draft) => {
          draft.demand.itinerary.basePenalty.business = 0.75;
        }),
      });
      if (!validated.ok) throw new Error('expected valid');
      await createEconomyConfigVersion(db.db, validated, BOOTSTRAP_ACTOR);

      const detail = await readEconomyConfigVersion(db.db, version);
      expect(detail?.comparedWith).toBe(ECONOMY_CONFIG_V1_VERSION);
      expect(detail?.diff).toContainEqual({
        path: 'demand.itinerary.basePenalty.business',
        before: 0.9,
        after: 0.75,
      });
    });

    it('is null for a version nobody created', async () => {
      expect(await readEconomyConfigVersion(db.db, 'not-a-version')).toBeNull();
    });
  });

  // ------------------------------------------------------ creating a world on it

  describe('a world created on a retune', () => {
    it('runs the version it was created with, not the shipped one', async () => {
      const version = versionName('world');
      const validated = validateCreateRequest({
        version,
        parentVersion: ECONOMY_CONFIG_V1_VERSION,
        notes: 'A richer opening position, for a test world.',
        payloadJson: retunedPayload((draft) => {
          draft.airlineStartingPosition.openingCashMinor = 12_345_600;
        }),
      });
      if (!validated.ok) throw new Error('expected valid');
      await createEconomyConfigVersion(db.db, validated, BOOTSTRAP_ACTOR);

      const created = await makeWorld(version);
      const config = await loadWorldEconomyConfig(db.db, created.id);
      expect(config.airlineStartingPosition.openingCashMinor).toBe(12_345_600);
    });

    it('cannot be created on a version that does not exist', async () => {
      await expect(
        createWorld(db.db, {
          ...FLAGSHIP_CONFIG,
          name: `economy-test-${randomUUID().slice(0, 8)}`,
          economyConfigVersion: 'not-a-version',
        }),
      ).rejects.toThrow(/not in economy_config/);
    });
  });
});
