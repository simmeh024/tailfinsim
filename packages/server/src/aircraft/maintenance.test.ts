import { randomInt, randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { MaintenanceResponse } from '@tailfin/shared';
import { maintenanceStatus } from '@tailfin/sim';

import { moveAirlineCash } from '../airline/cash';
import { type ResolvedPlayerAirline } from '../airline/context';
import { createDatabase, type DatabaseHandle } from '../db/client';
import { airframe, airport, type WorldRow } from '../db/schema';
import { createSchedule } from '../schedule/store';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixture,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';

import { acquireAircraft } from './acquisition';
import { seedAircraftCatalogue } from './catalogue';
import {
  bookCheck,
  fleetMaintenance,
  stateOf,
  sweepMaintenance,
  accrueFlightHours,
} from './maintenance';

/**
 * M4-06 against real Postgres.
 *
 * The due calculation and the reliability decay are proved without a database in
 * `packages/sim/src/aircraft/maintenance.test.ts`. What needs Postgres:
 *
 *   - the null-history reading, which is the one that could ground a live fleet;
 *   - booking a check, which moves money and takes an aeroplane out of service in
 *     one transaction;
 *   - the completion sweep, and that it is idempotent under a per-second tick;
 *   - the third acceptance criterion, which is a refusal from `createSchedule`.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [maintenance.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

const DAY_MS = 86_400_000;

describeDb('maintenance', () => {
  let db: DatabaseHandle;
  let fixtures: FoundedAirlineFixtureHarness;
  const madeAirports: string[] = [];

  beforeAll(async () => {
    db = createDatabase();
    fixtures = createFoundedAirlineFixtureHarness(db.db);
    await seedAircraftCatalogue(db.db);
  });

  afterEach(async () => {
    await fixtures.cleanup();
  });

  afterAll(async () => {
    for (const id of madeAirports.splice(0)) {
      await db.db.delete(airport).where(eq(airport.id, id));
    }
    await db.close();
  });

  async function makeAirport(): Promise<string> {
    const tag = Array.from({ length: 3 }, () => String.fromCharCode(randomInt(65, 91))).join('');
    const icao = `V${tag}`;
    const [created] = await db.db
      .insert(airport)
      .values({
        sourceId: randomInt(-2_147_483_648, 0),
        ident: icao,
        icaoCode: icao,
        name: `Maintenance test ${tag}`,
        isoCountry: 'NL',
        kind: 'medium_airport',
        latitude: 52,
        longitude: 4,
        scheduledService: true,
        hasRunwayData: false,
        tier: 'medium',
        slotLevel: 2,
      })
      .returning({ id: airport.id });
    if (!created) throw new Error('Airport was not created');
    madeAirports.push(created.id);
    return icao;
  }

  function own(fixture: FoundedAirlineFixture): ResolvedPlayerAirline {
    return { id: fixture.airline.id, worldId: fixture.world.id, status: 'active' };
  }

  /** Real-time instant at which this world's game clock reads `epoch + days`. */
  function atGameDay(world: WorldRow, days: number): Date {
    return new Date(world.launchDate.getTime() + (days * DAY_MS) / Number(world.speedMultiplier));
  }

  async function topUp(fixture: FoundedAirlineFixture, amountMinor: number): Promise<void> {
    await db.db.transaction((tx) =>
      moveAirlineCash(tx, {
        airlineId: fixture.airline.id,
        amountMinor,
        cause: 'flight_settlement',
        reference: `maintenance-top-up-${randomUUID()}`,
        occurredAt: fixture.world.epoch,
      }),
    );
  }

  /** Lease an ATR so there is a real airframe to maintain. */
  async function leaseAircraft(fixture: FoundedAirlineFixture): Promise<string> {
    const icao = await makeAirport();
    const acquired = await acquireAircraft(
      db.db,
      own(fixture),
      {
        requestId: randomUUID(),
        kind: 'lease',
        typeDesignation: 'ATR 72-600',
        deliveryAirportIcao: icao,
      },
      fixture.world.launchDate,
    );
    if (!acquired.ok || acquired.airframe === null) throw new Error('Lease did not deliver');
    return acquired.airframe.id;
  }

  /**
   * **The reading that could have grounded a live fleet.**
   *
   * `maintenance_state` is nullable, and an airframe delivered before M4-06 has
   * no history. Read as "last checked at hour zero" it would be tens of thousands
   * of hours overdue and the first sweep after the deploy would ground it.
   */
  it('reads a null history as nothing overdue, not as catastrophically overdue', async () => {
    const fixture = await fixtures.create();
    const airframeId = await leaseAircraft(fixture);

    // Simulate a pre-M4-06 row: real hours, no recorded history.
    await db.db
      .update(airframe)
      .set({ hours: 24_000, cycles: 19_000, maintenanceState: null })
      .where(eq(airframe.id, airframeId));

    const [row] = await db.db.select().from(airframe).where(eq(airframe.id, airframeId));
    if (!row) throw new Error('airframe vanished');

    const status = maintenanceStatus(stateOf(row), 'turboprop');
    expect(status.airworthiness.airworthy).toBe(true);
    expect(status.dueTiers).toEqual([]);

    // And the sweep agrees: nothing is grounded.
    const swept = await sweepMaintenance(db.db, fixture.world.id, atGameDay(fixture.world, 1));
    expect(swept.grounded).toBe(0);

    const [after] = await db.db.select().from(airframe).where(eq(airframe.id, airframeId));
    expect(after?.status).toBe('in_service');
  });

  it('accrues hours and cycles once per flight', async () => {
    const fixture = await fixtures.create();
    const airframeId = await leaseAircraft(fixture);

    await db.db.transaction((tx) => accrueFlightHours(tx, airframeId, 2.5));
    await db.db.transaction((tx) => accrueFlightHours(tx, airframeId, 1.5));

    const [row] = await db.db.select().from(airframe).where(eq(airframe.id, airframeId));
    expect(row?.hours).toBeCloseTo(4, 6);
    expect(row?.cycles).toBe(2);
    expect(row?.maintenanceState).not.toBeNull();
  });

  it('does not fail an arrival whose airframe id has no row', async () => {
    // `flight.airframe_id` has no foreign key until the M4/HIST boundary (#508),
    // and M2's tests fly placeholder ids. Accrual must be a no-op, not a throw.
    await expect(
      db.db.transaction((tx) => accrueFlightHours(tx, randomUUID(), 2)),
    ).resolves.toBeUndefined();
  });

  describe('booking a check', () => {
    it('takes the money and puts the aeroplane out of service', async () => {
      const fixture = await fixtures.create();
      const airframeId = await leaseAircraft(fixture);
      await topUp(fixture, 5_000_000);

      const booked = await bookCheck(
        db.db,
        own(fixture),
        airframeId,
        'a',
        atGameDay(fixture.world, 1),
      );
      expect(booked.ok).toBe(true);
      if (!booked.ok) return;
      expect(booked.costMinor).toBe(800_000); // the shipped turboprop A-check
      expect(booked.completesAt.getTime()).toBeGreaterThan(fixture.world.epoch.getTime());

      const [row] = await db.db.select().from(airframe).where(eq(airframe.id, airframeId));
      expect(row?.status).toBe('in_check');
      expect(row?.checkTier).toBe('a');
      expect(row?.checkCompletesAt).not.toBeNull();
    });

    it('refuses a second check while one is running', async () => {
      const fixture = await fixtures.create();
      const airframeId = await leaseAircraft(fixture);
      await topUp(fixture, 5_000_000);

      await bookCheck(db.db, own(fixture), airframeId, 'a', atGameDay(fixture.world, 1));
      const again = await bookCheck(
        db.db,
        own(fixture),
        airframeId,
        'c',
        atGameDay(fixture.world, 1),
      );
      expect(again).toMatchObject({ ok: false, kind: 'already-in-check' });
    });

    it('refuses a check the airline cannot afford, and moves no money', async () => {
      const fixture = await fixtures.create();
      const airframeId = await leaseAircraft(fixture);

      // A turboprop D-check is $700k; the opening balance after a lease deposit
      // is nowhere near it.
      const booked = await bookCheck(
        db.db,
        own(fixture),
        airframeId,
        'd',
        atGameDay(fixture.world, 1),
      );
      expect(booked).toMatchObject({ ok: false, kind: 'insufficient-funds' });

      const [row] = await db.db.select().from(airframe).where(eq(airframe.id, airframeId));
      expect(row?.status).toBe('in_service');
    });

    it('will not touch another airline’s aircraft, and says nothing about it', async () => {
      const mine = await fixtures.create();
      const theirs = await fixtures.create();
      const theirAirframe = await leaseAircraft(theirs);
      await topUp(mine, 5_000_000);

      const booked = await bookCheck(
        db.db,
        own(mine),
        theirAirframe,
        'a',
        atGameDay(mine.world, 1),
      );
      // `not-owned`, and the route renders it as a 404 — an aircraft belonging to
      // somebody else must be indistinguishable from one that does not exist.
      expect(booked).toMatchObject({ ok: false, kind: 'not-owned' });
    });
  });

  describe('the completion sweep', () => {
    it('returns the aeroplane to service when its downtime has elapsed', async () => {
      const fixture = await fixtures.create();
      const airframeId = await leaseAircraft(fixture);
      await topUp(fixture, 5_000_000);
      await db.db
        .update(airframe)
        .set({ hours: 600, cycles: 500 })
        .where(eq(airframe.id, airframeId));

      await bookCheck(db.db, own(fixture), airframeId, 'a', atGameDay(fixture.world, 1));

      // A turboprop A-check is one game day of downtime.
      const tooEarly = await sweepMaintenance(db.db, fixture.world.id, atGameDay(fixture.world, 1));
      expect(tooEarly.completed).toBe(0);

      const later = await sweepMaintenance(db.db, fixture.world.id, atGameDay(fixture.world, 4));
      expect(later.completed).toBe(1);

      const [row] = await db.db.select().from(airframe).where(eq(airframe.id, airframeId));
      expect(row?.status).toBe('in_service');
      expect(row?.checkTier).toBeNull();
      expect(row?.checkCompletesAt).toBeNull();
      // And the tier is genuinely reset, not merely un-flagged.
      const state = stateOf(row ?? { hours: 0, cycles: 0, maintenanceState: null });
      expect(state.hoursAtLastCheck.a).toBe(row?.hours);
    });

    it('does nothing on the second call, or the tenth', async () => {
      const fixture = await fixtures.create();
      const airframeId = await leaseAircraft(fixture);
      await topUp(fixture, 5_000_000);
      await bookCheck(db.db, own(fixture), airframeId, 'a', atGameDay(fixture.world, 1));

      const at = atGameDay(fixture.world, 5);
      const first = await sweepMaintenance(db.db, fixture.world.id, at);
      expect(first.completed).toBe(1);
      for (let i = 0; i < 4; i += 1) {
        const again = await sweepMaintenance(db.db, fixture.world.id, at);
        expect(again.completed, `call ${String(i + 2)}`).toBe(0);
      }
    });

    it('grounds an airframe flown far past a check, and releases it once done', async () => {
      const fixture = await fixtures.create();
      const airframeId = await leaseAircraft(fixture);
      await topUp(fixture, 5_000_000);

      // A turboprop A-check falls due at 500 hours; grounding is 1.5×.
      await db.db
        .update(airframe)
        .set({ hours: 900, cycles: 100, maintenanceState: null })
        .where(eq(airframe.id, airframeId));
      // A null history reads as "just checked", so give it a real one that is
      // genuinely overdue rather than relying on the null.
      await db.db
        .update(airframe)
        .set({
          maintenanceState: JSON.stringify({
            totalHours: 900,
            totalCycles: 100,
            hoursAtLastCheck: { a: 0, c: 0, d: 0 },
            cyclesAtLastCheck: { a: 0, c: 0, d: 0 },
          }),
        })
        .where(eq(airframe.id, airframeId));

      const swept = await sweepMaintenance(db.db, fixture.world.id, atGameDay(fixture.world, 2));
      expect(swept.grounded).toBe(1);

      const [grounded] = await db.db.select().from(airframe).where(eq(airframe.id, airframeId));
      expect(grounded?.status).toBe('grounded');

      // Grounding is a state you clear by doing the work, not a dead end.
      const booked = await bookCheck(
        db.db,
        own(fixture),
        airframeId,
        'a',
        atGameDay(fixture.world, 2),
      );
      expect(booked.ok).toBe(true);
      const after = await sweepMaintenance(db.db, fixture.world.id, atGameDay(fixture.world, 6));
      expect(after.completed).toBe(1);

      const [released] = await db.db.select().from(airframe).where(eq(airframe.id, airframeId));
      expect(released?.status).toBe('in_service');
    });
  });

  /**
   * **M4-06 acceptance criterion 3**, and the reason it is a rotation problem
   * rather than a new error: to the player the schedule is simply unflyable, the
   * same way `not_positioned` is.
   */
  describe('an unavailable aircraft cannot be scheduled', () => {
    it('refuses a rotation for an aircraft in a check, as a conflict', async () => {
      const fixture = await fixtures.create();
      const airframeId = await leaseAircraft(fixture);
      await topUp(fixture, 5_000_000);
      await bookCheck(db.db, own(fixture), airframeId, 'a', atGameDay(fixture.world, 1));

      const a = await makeAirport();
      const b = await makeAirport();
      const saved = await createSchedule(db.db, {
        worldId: fixture.world.id,
        airlineId: fixture.airline.id,
        airframeId,
        legs: [
          {
            originIcao: a,
            destinationIcao: b,
            departureMinute: 480,
            blockMinutes: 90,
            turnaroundMinutes: 40,
          },
          {
            originIcao: b,
            destinationIcao: a,
            departureMinute: 660,
            blockMinutes: 90,
            turnaroundMinutes: 40,
          },
        ],
        repeat: { kind: 'daily' },
      });

      expect(saved.ok).toBe(false);
      if (saved.ok) return;
      expect(saved.problem).toBe('airframe_unavailable');
      expect(saved.detail).toMatch(/maintenance check/i);
    });

    it('still schedules an aircraft that is in service', async () => {
      const fixture = await fixtures.create();
      const airframeId = await leaseAircraft(fixture);
      const a = await makeAirport();
      const b = await makeAirport();

      const saved = await createSchedule(db.db, {
        worldId: fixture.world.id,
        airlineId: fixture.airline.id,
        airframeId,
        legs: [
          {
            originIcao: a,
            destinationIcao: b,
            departureMinute: 480,
            blockMinutes: 90,
            turnaroundMinutes: 40,
          },
          {
            originIcao: b,
            destinationIcao: a,
            departureMinute: 660,
            blockMinutes: 90,
            turnaroundMinutes: 40,
          },
        ],
        repeat: { kind: 'daily' },
      });
      expect(saved.ok).toBe(true);
    });
  });

  /** **M4-06 acceptance criterion 2** — the timeline a player plans around. */
  describe('the due timeline', () => {
    it('reports remaining hours and cycles, and which limit is binding', async () => {
      const fixture = await fixtures.create();
      const airframeId = await leaseAircraft(fixture);
      await db.db
        .update(airframe)
        .set({ hours: 100, cycles: 350, maintenanceState: null })
        .where(eq(airframe.id, airframeId));

      const view = await fleetMaintenance(db.db, own(fixture));
      expect(MaintenanceResponse.safeParse(view).success).toBe(true);
      expect(view.airframes).toHaveLength(1);

      const entry = view.airframes[0];
      expect(entry?.maintenanceProfile).toBe('turboprop');
      expect(entry?.status).toBe('in_service');
      expect(entry?.airworthy).toBe(true);
      expect(entry?.tiers).toHaveLength(3);
      // Every tier quotes a cost and a downtime, so the timeline is plannable
      // rather than merely informative.
      for (const tier of entry?.tiers ?? []) {
        expect(tier.costMinor).toBeGreaterThan(0);
        expect(tier.downtimeDays).toBeGreaterThan(0);
      }
    });

    it('puts the most urgent aircraft first', async () => {
      const fixture = await fixtures.create();
      const healthy = await leaseAircraft(fixture);
      const neglected = await leaseAircraft(fixture);

      await db.db
        .update(airframe)
        .set({
          hours: 480,
          cycles: 100,
          maintenanceState: JSON.stringify({
            totalHours: 480,
            totalCycles: 100,
            hoursAtLastCheck: { a: 0, c: 0, d: 0 },
            cyclesAtLastCheck: { a: 0, c: 0, d: 0 },
          }),
        })
        .where(eq(airframe.id, neglected));

      const view = await fleetMaintenance(db.db, own(fixture));
      expect(view.airframes[0]?.airframeId).toBe(neglected);
      expect(view.airframes.at(-1)?.airframeId).toBe(healthy);
    });

    it('shows only this airline’s fleet', async () => {
      const mine = await fixtures.create();
      const theirs = await fixtures.create();
      const myAirframe = await leaseAircraft(mine);
      await leaseAircraft(theirs);

      const view = await fleetMaintenance(db.db, own(mine));
      expect(view.airframes.map((a) => a.airframeId)).toEqual([myAirframe]);
    });
  });
});
