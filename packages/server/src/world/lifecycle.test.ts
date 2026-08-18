import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { FLAGSHIP_CONFIG, type WorldConfig } from '@tailfin/shared';

import { createDatabase, type DatabaseHandle } from '../db/client';
import { player, world, worldEvent } from '../db/schema';

import {
  createWorld,
  currentGameDate,
  exportWorldConfig,
  openWorld,
  resetWorld,
} from './lifecycle';

/**
 * World creation, export and reset, against a real Postgres.
 *
 * The reset is the destructive one, so it gets the most attention: the clock
 * really does return to the epoch, and the things a rewound clock invalidates
 * really are gone.
 *
 * Requires `DATABASE_URL`; CI provides it.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [lifecycle.test] DATABASE_URL not set — skipping world tests.\n');
const describeDb = url ? describe : describe.skip;

function config(overrides: Partial<WorldConfig> = {}): WorldConfig {
  return {
    ...FLAGSHIP_CONFIG,
    name: `test-${Math.random().toString(36).slice(2, 10)}`,
    ...overrides,
  };
}

describeDb('world lifecycle', () => {
  let db: DatabaseHandle;
  const made: string[] = [];

  beforeAll(() => {
    db = createDatabase();
  });

  afterEach(async () => {
    for (const id of made.splice(0)) {
      await db.db.delete(world).where(eq(world.id, id));
    }
  });

  afterAll(async () => {
    await db.close();
  });

  async function make(c: WorldConfig = config()) {
    const result = await createWorld(db.db, c);
    made.push(result.world.id);
    return result;
  }

  describe('createWorld', () => {
    it('creates a world from config', async () => {
      const { world: created, created: isNew } = await make();
      expect(isNew).toBe(true);
      expect(created.epoch.toISOString()).toBe(FLAGSHIP_CONFIG.epoch);
      expect(Number(created.speedMultiplier)).toBe(2);
      expect(created.status).toBe('staging');
    });

    it('is idempotent by name, so the seed can be re-run', async () => {
      // The seed command is what a fresh environment runs, and a fresh
      // environment happens more than once.
      const c = config();
      const first = await make(c);
      const second = await createWorld(db.db, c);
      expect(second.created).toBe(false);
      expect(second.world.id).toBe(first.world.id);
    });

    it('starts a world in staging, never open', async () => {
      const { world: created } = await make();
      expect(created.status).toBe('staging');
    });

    it('refuses an epoch that is not in the past', async () => {
      // An epoch of "now" makes a reset a no-op — the failure ADR-0005 exists to
      // prevent, and one that would only surface weeks later.
      await expect(
        make(config({ epoch: new Date(Date.now() + 60_000).toISOString() })),
      ).rejects.toThrow(/not in the past/);
    });

    it('puts the in-game clock at the epoch on creation', async () => {
      const { world: created } = await make();
      const at = await currentGameDate(db.db, created.id, created.launchDate);
      expect(at.toISOString()).toBe(FLAGSHIP_CONFIG.epoch);
    });

    it('runs the flagship world at 2x from 2024-10-20', () => {
      // The configuration asked for, asserted rather than assumed.
      expect(FLAGSHIP_CONFIG.epoch).toBe('2024-10-20T00:00:00.000Z');
      expect(FLAGSHIP_CONFIG.speedMultiplier).toBe(2);
    });
  });

  describe('export', () => {
    it('round-trips: create, export, recreate identically', async () => {
      // The acceptance criterion, stated as a property.
      const original = config();
      const { world: created } = await make(original);
      const exported = await exportWorldConfig(db.db, created.id);
      expect(exported).toEqual(original);
    });

    it('leaves launch_date out of the config', async () => {
      // It is not part of what the world *is*. Including it would make a
      // recreated world claim to have started running when it did not.
      const { world: created } = await make();
      const exported = await exportWorldConfig(db.db, created.id);
      expect(Object.keys(exported)).not.toContain('launchDate');
    });
  });

  describe('resetWorld', () => {
    it('returns the in-game calendar to the epoch', async () => {
      const { world: created } = await make();
      const result = await resetWorld(db.db, created.id);
      expect(result.gameDate.toISOString()).toBe(FLAGSHIP_CONFIG.epoch);
    });

    it('leaves the epoch alone and moves launch_date', async () => {
      // ADR-0005's mechanism, checked directly on the row.
      const { world: created } = await make();
      const before = created.launchDate.getTime();
      await resetWorld(db.db, created.id);

      const after = (await db.db.select().from(world).where(eq(world.id, created.id)))[0]!;
      expect(after.epoch.toISOString()).toBe(FLAGSHIP_CONFIG.epoch);
      expect(after.launchDate.getTime()).toBeGreaterThanOrEqual(before);
    });

    it('clears pending events, which are on a timeline that no longer exists', async () => {
      const { world: created } = await make();
      await db.db.insert(worldEvent).values({
        worldId: created.id,
        type: 'FLIGHT_DEPART',
        fireAt: new Date('2024-11-01T00:00:00.000Z'),
        payload: '{}',
        idempotencyKey: 'reset-test',
      });

      const result = await resetWorld(db.db, created.id);
      expect(result.eventsCleared).toBe(1);

      const left = await db.db
        .select({ n: sql<number>`count(*)::int` })
        .from(worldEvent)
        .where(eq(worldEvent.worldId, created.id));
      expect(left[0]?.n).toBe(0);
    });

    it('clears airlines but not the player accounts behind them', async () => {
      // Accounts are global, not per world. Signing in again must still work and
      // simply find no airline.
      const { world: created } = await make();
      const people = await db.db
        .insert(player)
        .values({ displayName: 'Reset Test Pilot' })
        .returning({ id: player.id });
      const playerId = people[0]!.id;

      await db.db.execute(sql`
        insert into airline (world_id, player_id, name, iata_code, icao_code, callsign, base_country)
        values (${created.id}, ${playerId}, 'Reset Air', 'RA', 'RST', 'RESET', 'NL')
      `);

      const result = await resetWorld(db.db, created.id);
      expect(result.airlinesCleared).toBe(1);

      const stillThere = await db.db.select().from(player).where(eq(player.id, playerId));
      expect(stillThere).toHaveLength(1);

      await db.db.delete(player).where(eq(player.id, playerId));
    });

    it('puts the world back to staging', async () => {
      const { world: created } = await make();
      await openWorld(db.db, created.id);
      await resetWorld(db.db, created.id);

      const after = (await db.db.select().from(world).where(eq(world.id, created.id)))[0]!;
      expect(after.status).toBe('staging');
    });

    it('can be run repeatedly', async () => {
      // Stated because it is the thing that will happen most during testing.
      const { world: created } = await make();
      for (let i = 0; i < 3; i += 1) {
        const result = await resetWorld(db.db, created.id);
        expect(result.gameDate.toISOString()).toBe(FLAGSHIP_CONFIG.epoch);
      }
    });
  });
});
