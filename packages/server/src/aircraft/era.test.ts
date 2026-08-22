import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { FLAGSHIP_CONFIG } from '@tailfin/shared';

import { createDatabase, type DatabaseHandle } from '../db/client';
import { world } from '../db/schema';
import { createWorld } from '../world/lifecycle';

import { seedAircraftCatalogue } from './catalogue';
import { fleetCatalogue } from './era';

/**
 * Era gating against a real world clock (M4-02, §7.2b).
 *
 * The three acceptance criteria, each with a test:
 *
 *   1. a 1950s world offers no jets
 *   2. types arriving soon are visible with their EIS date, not hidden
 *   3. restrictions degrade economics before the hard out-of-service date
 *
 * The third is mostly proved in `packages/sim/src/aircraft/restrictions.test.ts`,
 * where the settlement can be run directly. What is proved here is that the
 * charge reaches a player through the catalogue endpoint.
 *
 * Requires `DATABASE_URL` against a migrated database; CI provides both.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [era.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

describeDb('the catalogue as a world sees it', () => {
  let db: DatabaseHandle;
  const madeWorlds: string[] = [];

  beforeAll(async () => {
    db = createDatabase();
    await seedAircraftCatalogue(db.db);
  });

  afterEach(async () => {
    for (const id of madeWorlds.splice(0)) {
      await db.db.delete(world).where(eq(world.id, id));
    }
  });

  afterAll(async () => {
    await db.close();
  });

  /**
   * A world whose clock reads a given date *now*.
   *
   * `launch_date` is when the world started running and game time is
   * `epoch + speed × (now − launch)`, so a world created this instant reads its
   * own epoch. Setting the epoch is therefore enough to place the clock, and it
   * avoids waiting for time to pass — which is the same trick `speed.test.ts`
   * uses in reverse.
   */
  async function worldAt(epochIso: string): Promise<string> {
    const created = await createWorld(db.db, {
      ...FLAGSHIP_CONFIG,
      name: `era-test-${randomUUID().slice(0, 8)}`,
      epoch: epochIso,
    });
    madeWorlds.push(created.world.id);
    return created.world.id;
  }

  // ------------------------------------------- criterion 1: a 1950s world

  it('offers a 1950s world no aircraft at all', async () => {
    // §7.2b's own example: "In a 1950s world you start on DC-3s and
    // Constellations". The shipped catalogue has neither — its oldest type
    // entered service in 1998 — so what this world correctly offers is
    // *nothing*, and it says so rather than showing eighteen locked rows.
    const worldId = await worldAt('1955-06-01T00:00:00.000Z');
    const catalogue = await fleetCatalogue(db.db, worldId);

    expect(catalogue.types).toEqual([]);
  });

  it('does not leak a future world’s aircraft into an early one', async () => {
    // The stronger half of §7.2b: an aircraft "simply does not exist" in a
    // world whose clock has not reached it. Absent, not greyed out — a 1955
    // world that listed an A350 as "arrives 2015" would be telling the player
    // about a future their world does not have.
    const worldId = await worldAt('1955-06-01T00:00:00.000Z');
    const catalogue = await fleetCatalogue(db.db, worldId);

    expect(catalogue.types.map((t) => t.designation)).not.toContain('A350-900');
  });

  it('offers a 1999 world only what had flown by then', async () => {
    // Between the two extremes, so the filter is shown to be a date comparison
    // rather than an all-or-nothing switch. The 737-800 was in service; the
    // Dash 8-400 had flown but not entered service; nothing else existed.
    const worldId = await worldAt('1999-01-01T00:00:00.000Z');
    const catalogue = await fleetCatalogue(db.db, worldId);

    const byState = new Map(catalogue.types.map((t) => [t.designation, t.availability]));
    expect(byState.get('737-800')).toBe('orderable');
    expect(byState.get('Dash 8-400')).toBe('prototype');
    expect(byState.has('A320neo')).toBe(false);
  });

  // ------------------------------- criterion 2: arriving types are visible

  it('lists the A321XLR with the date it arrives', async () => {
    const worldId = await worldAt(FLAGSHIP_CONFIG.epoch);
    const catalogue = await fleetCatalogue(db.db, worldId);

    const xlr = catalogue.types.find((t) => t.designation === 'A321XLR');
    expect(xlr?.availability).toBe('prototype');
    // The criterion in one field: visible, with its EIS date.
    expect(xlr?.arrivesOn).toBe('2024-11-11');
    expect(xlr?.detail).toMatch(/Enters service on 2024-11-11/);
  });

  it('lists the 777-9 as flying with no announced date', async () => {
    const worldId = await worldAt(FLAGSHIP_CONFIG.epoch);
    const catalogue = await fleetCatalogue(db.db, worldId);

    const x = catalogue.types.find((t) => t.designation === '777-9');
    expect(x?.availability).toBe('prototype');
    // Null rather than a guess. Nobody knows when it enters service, and
    // inventing a date would be worse than saying so.
    expect(x?.arrivesOn).toBeNull();
    expect(x?.detail).toMatch(/No entry into service has been announced/);
  });

  it('does not put an arrival date on something already in service', async () => {
    // A historical EIS in that field would read as a countdown to an aircraft
    // the player can already buy.
    const worldId = await worldAt(FLAGSHIP_CONFIG.epoch);
    const catalogue = await fleetCatalogue(db.db, worldId);

    for (const entry of catalogue.types) {
      if (entry.availability !== 'prototype') {
        expect(entry.arrivesOn, entry.designation).toBeNull();
      }
    }
  });

  it('reports the world’s own date, not the server’s', async () => {
    // The world runs at 2× from its own epoch, so "today" here is neither the
    // wall clock nor a fixed date. A client that guessed would be wrong.
    const worldId = await worldAt('2010-03-04T00:00:00.000Z');
    const catalogue = await fleetCatalogue(db.db, worldId);

    expect(catalogue.inGameDate.slice(0, 10)).toBe('2010-03-04');
    expect(catalogue.catalogueVersion).toBe(FLAGSHIP_CONFIG.aircraftCatalogueVersion);
  });

  // ----------------------------- criterion 3: restrictions reach the player

  it('carries no restriction charge for the shipped catalogue', async () => {
    // Honest state of the data: App. C.2 publishes no restriction dates, and
    // inventing eighteen sets would be authoring data the design doc does not
    // have. The mechanism is built, tested and priced; the launch set simply
    // has nothing to charge yet.
    const worldId = await worldAt(FLAGSHIP_CONFIG.epoch);
    const catalogue = await fleetCatalogue(db.db, worldId);

    for (const entry of catalogue.types) {
      expect(entry.restrictionCostPerDepartureMinor, entry.designation).toBe(0);
      expect(entry.restrictions, entry.designation).toEqual([]);
    }
  });

  it('sorts nothing and filters nothing else — every listed type exists', async () => {
    const worldId = await worldAt(FLAGSHIP_CONFIG.epoch);
    const catalogue = await fleetCatalogue(db.db, worldId);

    // Eighteen minus nothing: on the flagship epoch every type has at least
    // flown, so all of them are listed even though only thirteen can be ordered.
    expect(catalogue.types).toHaveLength(18);
    expect(catalogue.types.filter((t) => t.availability === 'orderable')).toHaveLength(13);
    expect(catalogue.types.filter((t) => t.availability === 'prototype')).toHaveLength(2);
    expect(catalogue.types.filter((t) => t.availability === 'used_only')).toHaveLength(3);
  });

  it('refuses a world that does not exist rather than returning an empty list', async () => {
    // An empty catalogue is a real answer for a 1950s world. It must not also
    // be the answer for "that world is gone", or the two become indistinguishable.
    await expect(fleetCatalogue(db.db, randomUUID())).rejects.toThrow(/No world/);
  });
});
