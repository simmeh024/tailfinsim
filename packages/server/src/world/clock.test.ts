import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { FLAGSHIP_CONFIG } from '@tailfin/shared';

import { createDatabase, type DatabaseHandle } from '../db/client';
import { world } from '../db/schema';

import { readWorldClock } from './clock';
import { createWorld } from './lifecycle';

/**
 * The clock a player reads (§22.2, ADR-0005).
 *
 * The point of the endpoint is that the *server* decides what time it is, so
 * what is worth proving is that the answer moves at the world's speed and not at
 * wall-clock speed — and that `serverTime` is sent alongside, because the client
 * cannot correct for its own skew without it.
 *
 * Requires `DATABASE_URL` against a migrated database; CI provides both.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [world/clock.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

describeDb('the world clock a player reads', () => {
  let db: DatabaseHandle;
  const madeWorlds: string[] = [];

  beforeAll(() => {
    db = createDatabase();
  });

  afterEach(async () => {
    for (const id of madeWorlds.splice(0)) {
      await db.db.delete(world).where(eq(world.id, id));
    }
  });

  afterAll(async () => {
    await db.close();
  });

  /** A world launched `at`, so its clock reads its own epoch at that instant. */
  async function worldAt(epochIso: string, speedMultiplier: number, at: Date): Promise<string> {
    const created = await createWorld(
      db.db,
      {
        ...FLAGSHIP_CONFIG,
        name: `clock-test-${randomUUID().slice(0, 8)}`,
        epoch: epochIso,
        speedMultiplier,
      },
      at,
    );
    madeWorlds.push(created.world.id);
    return created.world.id;
  }

  it('reads the epoch at launch, and carries the server s own time', async () => {
    const launch = new Date('2026-08-23T12:00:00.000Z');
    const worldId = await worldAt('2024-10-20T00:00:00.000Z', 2, launch);

    const result = await readWorldClock(db.db, worldId, launch);
    expect(result.kind).toBe('read');
    if (result.kind !== 'read') return;

    expect(result.clock.inGameTime).toBe('2024-10-20T00:00:00.000Z');
    expect(result.clock.speedMultiplier).toBe(2);
    // Without this the browser cannot tell its own clock skew from elapsed time.
    expect(result.clock.serverTime).toBe(launch.toISOString());
    expect(result.clock.worldId).toBe(worldId);
  });

  it('advances at the world s speed, not at wall-clock speed', async () => {
    const launch = new Date('2026-08-23T12:00:00.000Z');
    const worldId = await worldAt('2024-10-20T00:00:00.000Z', 2, launch);

    // One real hour later.
    const later = new Date(launch.getTime() + 3_600_000);
    const result = await readWorldClock(db.db, worldId, later);
    if (result.kind !== 'read') throw new Error('expected a clock');

    // Two in-game hours. A wall-clock reading would say 01:00, and that is the
    // whole distinction the endpoint exists to make.
    expect(result.clock.inGameTime).toBe('2024-10-20T02:00:00.000Z');
  });

  it('honours a speed that is not the flagship s', async () => {
    const launch = new Date('2026-08-23T12:00:00.000Z');
    const worldId = await worldAt('2024-10-20T00:00:00.000Z', 1, launch);

    const later = new Date(launch.getTime() + 3_600_000);
    const result = await readWorldClock(db.db, worldId, later);
    if (result.kind !== 'read') throw new Error('expected a clock');

    expect(result.clock.inGameTime).toBe('2024-10-20T01:00:00.000Z');
    // `numeric` comes back from the driver as a string; a client doing
    // arithmetic on "1" would concatenate rather than add.
    expect(result.clock.speedMultiplier).toBe(1);
    expect(typeof result.clock.speedMultiplier).toBe('number');
  });

  it('reports absence rather than inventing a clock', async () => {
    const result = await readWorldClock(db.db, randomUUID(), new Date());
    expect(result.kind).toBe('not-found');
  });
});
