import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type DatabaseHandle } from '../db/client';
import { world } from '../db/schema';

import { listTickableWorlds } from './simulation';

/**
 * Which worlds the engine will drive, against a real Postgres.
 *
 * Worth a database test rather than a mocked one, because the thing being
 * asserted *is* the query: `ne(world.status, 'archived')` is one token away from
 * `eq`, and either spelling typechecks. Getting it the wrong way round would mean
 * the engine drives only the worlds it must never touch.
 *
 * Requires `DATABASE_URL` against a migrated database; CI provides both, and
 * `test-setup.ts` refuses any database whose name is not disposable.
 */

const url = process.env.DATABASE_URL;
if (!url) {
  console.warn('\n  [simulation-worlds.test] DATABASE_URL not set — skipping world selection.\n');
}
const describeDb = url ? describe : describe.skip;

const EPOCH = new Date('2024-10-20T00:00:00.000Z');
const LAUNCH = new Date('2026-08-18T00:00:00.000Z');

describeDb('the worlds the engine drives', () => {
  let db: DatabaseHandle;
  const created: string[] = [];
  const suffix = Math.random().toString(36).slice(2, 10);

  async function makeWorld(status: 'staging' | 'open' | 'locked' | 'archived'): Promise<string> {
    const [row] = await db.db
      .insert(world)
      .values({
        name: `engine-${status}-${suffix}`,
        epoch: EPOCH,
        launchDate: LAUNCH,
        seed: `engine-seed-${status}-${suffix}`,
        speedMultiplier: '2',
        aircraftCatalogueVersion: 'test',
        economyConfigVersion: 'test',
        status,
      })
      .returning({ id: world.id });

    if (!row) throw new Error(`could not create a ${status} world`);
    created.push(row.id);
    return row.id;
  }

  beforeAll(() => {
    db = createDatabase();
  });

  afterAll(async () => {
    if (created.length > 0) {
      await db.db.delete(world).where(inArray(world.id, created));
    }
    await db.close();
  });

  it('drives staging, open and locked worlds, and never an archived one', async () => {
    const staging = await makeWorld('staging');
    const open = await makeWorld('open');
    const locked = await makeWorld('locked');
    const archived = await makeWorld('archived');

    const driven = new Set((await listTickableWorlds(db.db)).map((entry) => entry.id));

    // Locked is the one that surprises people: locking stops play and
    // deliberately does not stop the clock, so an aircraft in the air when a
    // world locks is still in the air when it reopens — which is only true if
    // its arrival event still fires.
    expect(driven.has(staging)).toBe(true);
    expect(driven.has(open)).toBe(true);
    expect(driven.has(locked)).toBe(true);

    // Archived means "a record of what happened". Draining one would keep
    // changing the record.
    expect(driven.has(archived)).toBe(false);
  });

  it('carries each world its own clock, with the speed as a number', async () => {
    const id = await makeWorld('open');
    await db.db.update(world).set({ speedMultiplier: '4.50' }).where(eq(world.id, id));

    const driven = await listTickableWorlds(db.db);
    const entry = driven.find((candidate) => candidate.id === id);

    expect(entry).toBeDefined();
    // `numeric` arrives from the driver as a string. Left as one, every game-time
    // conversion downstream becomes string arithmetic and silently wrong.
    expect(entry?.clock.speedMultiplier).toBe(4.5);
    expect(entry?.clock.epoch).toBeInstanceOf(Date);
    expect(entry?.clock.launchDate).toBeInstanceOf(Date);
  });
});
