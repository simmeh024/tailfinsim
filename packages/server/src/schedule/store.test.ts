import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { FLAGSHIP_CONFIG, type WorldConfig } from '@tailfin/shared';
import { type Horizon, MINUTES_PER_DAY } from '@tailfin/sim';

import { createDatabase, type DatabaseHandle } from '../db/client';
import {
  airline,
  airport,
  flight,
  player,
  schedule,
  scheduleLeg,
  world,
  worldEvent,
} from '../db/schema';
import { createWorld } from '../world/lifecycle';

import {
  createSchedule,
  departureKey,
  type LegInput,
  loadSchedule,
  materialiseSchedule,
  materialiseWorld,
  orphanedFlights,
  replaceScheduleLegs,
  upcomingFlights,
} from './store';

/**
 * Schedules and their flights, against a real Postgres (M2-03).
 *
 * The rotation arithmetic is proven in `@tailfin/sim` and is not retested here.
 * What is here is the half that only a database can settle:
 *
 *   - **Rolling the horizon twice creates nothing twice**, because a unique
 *     constraint refuses it — not because this code checked first.
 *   - **An edit is one transaction that cancels before it creates.** A moved leg
 *     keeps its key, so the wrong order does not produce a wrong answer, it
 *     produces a constraint violation.
 *   - **A flight outlives the schedule that made it**, which is `on delete set
 *     null` and nothing else.
 *   - **The repeat pattern is a discriminated union in the database**, not a
 *     convention the application remembers.
 *
 * Requires `DATABASE_URL` against a migrated database; CI provides both.
 */

const url = process.env.DATABASE_URL;
if (!url)
  console.warn('\n  [schedule/store.test] DATABASE_URL not set — skipping schedule tests.\n');
const describeDb = url ? describe : describe.skip;

/** 2026-08-17 is a Monday. Game-time instants, like everything on `flight`. */
const MONDAY = new Date('2026-08-17T00:00:00.000Z');

function days(n: number): number {
  return n * MINUTES_PER_DAY * 60_000;
}

function window(from: Date, dayCount: number): Horizon {
  return { from, to: new Date(from.getTime() + days(dayCount)) };
}

function code(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let out = '';
  for (let i = 0; i < 4; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)] ?? 'A';
  }
  return out;
}

describeDb('schedules and their flights', () => {
  let db: DatabaseHandle;
  const madeWorlds: string[] = [];
  const madePlayers: string[] = [];
  const madeAirports: string[] = [];

  beforeAll(() => {
    db = createDatabase();
  });

  afterEach(async () => {
    // Worlds first: the cascade takes airlines, schedules and flights with them,
    // and `airline.player_id` is `restrict`, so a player cannot go first.
    for (const id of madeWorlds.splice(0)) {
      await db.db.delete(world).where(eq(world.id, id));
    }
    for (const id of madePlayers.splice(0)) {
      await db.db.delete(player).where(eq(player.id, id));
    }
    for (const icao of madeAirports.splice(0)) {
      await db.db.delete(airport).where(eq(airport.icaoCode, icao));
    }
  });

  afterAll(async () => {
    await db.close();
  });

  async function makeAirport(): Promise<string> {
    const icao = code();
    await db.db.insert(airport).values({
      sourceId: Math.floor(Math.random() * 2_000_000_000),
      ident: `TEST-${icao}-${Math.random().toString(36).slice(2, 8)}`,
      icaoCode: icao,
      name: `Test Field ${icao}`,
      isoCountry: 'GB',
      kind: 'large_airport',
      latitude: 51.5,
      longitude: -0.1,
      scheduledService: true,
      hasRunwayData: false,
    });
    madeAirports.push(icao);
    return icao;
  }

  async function makeWorldAndAirline(): Promise<{ worldId: string; airlineId: string }> {
    const config: WorldConfig = {
      ...FLAGSHIP_CONFIG,
      name: `sched-${Math.random().toString(36).slice(2, 10)}`,
    };
    const { world: created } = await createWorld(db.db, config);
    madeWorlds.push(created.id);

    const [p] = await db.db
      .insert(player)
      .values({ displayName: `player-${Math.random().toString(36).slice(2, 8)}` })
      .returning({ id: player.id });
    if (p === undefined) throw new Error('no player');
    madePlayers.push(p.id);

    // The schema's format checks are strict, so the codes are built rather than
    // improvised: `^[A-Z0-9]{2}$`, `^[A-Z]{3}$`, `^[A-Z]{2}$`.
    const two = code().slice(0, 2);
    const [a] = await db.db
      .insert(airline)
      .values({
        worldId: created.id,
        playerId: p.id,
        name: `Test Air ${two}`,
        iataCode: two,
        icaoCode: `T${two}`,
        callsign: `TEST${two}`,
        baseCountry: 'GB',
      })
      .returning({ id: airline.id });
    if (a === undefined) throw new Error('no airline');

    return { worldId: created.id, airlineId: a.id };
  }

  /** An out-and-back that closes, twice a day, from a hub. */
  function roundTrips(hub: string, outstation: string): LegInput[] {
    return [
      {
        originIcao: hub,
        destinationIcao: outstation,
        departureMinute: 420,
        blockMinutes: 95,
        turnaroundMinutes: 40,
      },
      {
        originIcao: outstation,
        destinationIcao: hub,
        departureMinute: 555,
        blockMinutes: 95,
        turnaroundMinutes: 40,
      },
      {
        originIcao: hub,
        destinationIcao: outstation,
        departureMinute: 690,
        blockMinutes: 95,
        turnaroundMinutes: 40,
      },
      {
        originIcao: outstation,
        destinationIcao: hub,
        departureMinute: 825,
        blockMinutes: 95,
        turnaroundMinutes: 40,
      },
    ];
  }

  async function setup() {
    const hub = await makeAirport();
    const outstation = await makeAirport();
    const { worldId, airlineId } = await makeWorldAndAirline();
    const airframeId = crypto.randomUUID();
    const saved = await createSchedule(db.db, {
      worldId,
      airlineId,
      airframeId,
      legs: roundTrips(hub, outstation),
      repeat: { kind: 'daily' },
    });
    if (!saved.ok) throw new Error(`fixture rotation refused: ${saved.detail}`);
    return { hub, outstation, worldId, airlineId, airframeId, scheduleId: saved.scheduleId };
  }

  describe('saving', () => {
    it('writes the header and the legs in order', async () => {
      const { scheduleId, hub } = await setup();
      const loaded = await loadSchedule(db.db, scheduleId);

      expect(loaded?.rotation.legs).toHaveLength(4);
      expect(loaded?.rotation.legs[0]?.originIcao).toBe(hub);
      expect(loaded?.rotation.repeat).toEqual({ kind: 'daily' });
      expect(loaded?.active).toBe(true);
    });

    it('refuses an invalid rotation and writes nothing at all', async () => {
      const hub = await makeAirport();
      const outstation = await makeAirport();
      const { worldId, airlineId } = await makeWorldAndAirline();

      const result = await createSchedule(db.db, {
        worldId,
        airlineId,
        airframeId: crypto.randomUUID(),
        // One leg out and no way home: the rotation cannot repeat.
        legs: [
          {
            originIcao: hub,
            destinationIcao: outstation,
            departureMinute: 420,
            blockMinutes: 95,
            turnaroundMinutes: 40,
          },
        ],
        repeat: { kind: 'daily' },
      });

      expect(result).toMatchObject({ ok: false, problem: 'does_not_close' });
      const [row] = await db.db
        .select({ count: sql<string>`count(*)` })
        .from(schedule)
        .where(eq(schedule.worldId, worldId));
      // The point: a refused schedule leaves no row for a worker to trip over.
      expect(Number(row?.count)).toBe(0);
    });

    it('stores weekdays as an array and daily as nothing', async () => {
      const hub = await makeAirport();
      const outstation = await makeAirport();
      const { worldId, airlineId } = await makeWorldAndAirline();

      const saved = await createSchedule(db.db, {
        worldId,
        airlineId,
        airframeId: crypto.randomUUID(),
        legs: roundTrips(hub, outstation),
        repeat: { kind: 'weekdays', days: [6, 7] },
      });
      expect(saved.ok).toBe(true);

      const loaded = await loadSchedule(db.db, saved.ok ? saved.scheduleId : '');
      expect(loaded?.rotation.repeat).toEqual({ kind: 'weekdays', days: [6, 7] });
    });
  });

  describe('what the database refuses on its own', () => {
    it('will not let a daily schedule carry weekdays', async () => {
      const { worldId, airlineId } = await makeWorldAndAirline();
      await expect(
        db.db.insert(schedule).values({
          worldId,
          airlineId,
          airframeId: crypto.randomUUID(),
          repeatKind: 'daily',
          repeatDays: [1, 2],
        }),
      ).rejects.toThrow();
    });

    it('will not let a weekday schedule carry none', async () => {
      const { worldId, airlineId } = await makeWorldAndAirline();
      await expect(
        db.db.insert(schedule).values({
          worldId,
          airlineId,
          airframeId: crypto.randomUUID(),
          repeatKind: 'weekdays',
          repeatDays: [],
        }),
      ).rejects.toThrow();
    });

    it('will not let a weekday schedule carry null days either', async () => {
      // The same hole as the empty array, reached from the other side: an
      // unknown check result passes, so `cardinality(null)` had to be coalesced
      // too, not just `array_length('{}')`.
      const { worldId, airlineId } = await makeWorldAndAirline();
      await expect(
        db.db.insert(schedule).values({
          worldId,
          airlineId,
          airframeId: crypto.randomUUID(),
          repeatKind: 'weekdays',
          repeatDays: null,
        }),
      ).rejects.toThrow();
    });

    it('will not let a weekday schedule carry a day that is not one', async () => {
      const { worldId, airlineId } = await makeWorldAndAirline();
      await expect(
        db.db.insert(schedule).values({
          worldId,
          airlineId,
          airframeId: crypto.randomUUID(),
          repeatKind: 'weekdays',
          repeatDays: [0, 9],
        }),
      ).rejects.toThrow();
    });

    it('will not let two legs share a position', async () => {
      const { scheduleId, hub, outstation } = await setup();
      await expect(
        db.db.insert(scheduleLeg).values({
          scheduleId,
          legIndex: 0,
          originIcao: hub,
          destinationIcao: outstation,
          departureMinute: 100,
          blockMinutes: 95,
          turnaroundMinutes: 40,
        }),
      ).rejects.toThrow();
    });

    it('will not let a leg depart and arrive at the same airport', async () => {
      const { scheduleId, hub } = await setup();
      await expect(
        db.db.insert(scheduleLeg).values({
          scheduleId,
          legIndex: 9,
          originIcao: hub,
          destinationIcao: hub,
          departureMinute: 100,
          blockMinutes: 95,
          turnaroundMinutes: 40,
        }),
      ).rejects.toThrow();
    });
  });

  describe('materialising', () => {
    it('writes a flight and a departure event for every leg in the horizon', async () => {
      const { scheduleId, worldId } = await setup();
      const result = await materialiseSchedule(db.db, scheduleId, window(MONDAY, 3));

      expect(result).toEqual({ created: 12, alreadyPresent: 0 });

      const flights = await upcomingFlights(db.db, scheduleId, MONDAY);
      expect(flights).toHaveLength(12);
      expect(flights[0]?.scheduledDeparture.toISOString()).toBe('2026-08-17T07:00:00.000Z');

      const [events] = await db.db
        .select({ count: sql<string>`count(*)` })
        .from(worldEvent)
        .where(and(eq(worldEvent.worldId, worldId), eq(worldEvent.type, 'FLIGHT_DEPART')));
      expect(Number(events?.count)).toBe(12);

      // Every flight has its own event, keyed off its id.
      const first = flights[0];
      if (first === undefined) throw new Error('no flights');
      const [event] = await db.db
        .select()
        .from(worldEvent)
        .where(
          and(
            eq(worldEvent.worldId, worldId),
            eq(worldEvent.idempotencyKey, departureKey(first.id)),
          ),
        );
      expect(event?.fireAt.toISOString()).toBe(first.scheduledDeparture.toISOString());
    });

    it('creates nothing the second time, which is the constraint rather than a check', async () => {
      const { scheduleId } = await setup();
      const horizon = window(MONDAY, 5);

      const first = await materialiseSchedule(db.db, scheduleId, horizon);
      const second = await materialiseSchedule(db.db, scheduleId, horizon);
      const third = await materialiseSchedule(db.db, scheduleId, horizon);

      expect(first).toEqual({ created: 20, alreadyPresent: 0 });
      expect(second).toEqual({ created: 0, alreadyPresent: 20 });
      expect(third).toEqual({ created: 0, alreadyPresent: 20 });
      expect(await upcomingFlights(db.db, scheduleId, MONDAY)).toHaveLength(20);
    });

    it('adds only the new day when the horizon rolls forward', async () => {
      const { scheduleId } = await setup();
      await materialiseSchedule(db.db, scheduleId, window(MONDAY, 5));
      const rolled = await materialiseSchedule(
        db.db,
        scheduleId,
        window(new Date(MONDAY.getTime() + days(1)), 5),
      );

      expect(rolled.created).toBe(4);
      expect(await upcomingFlights(db.db, scheduleId, MONDAY)).toHaveLength(24);
    });

    it('produces nothing for a paused schedule', async () => {
      const { scheduleId } = await setup();
      await db.db.update(schedule).set({ active: false }).where(eq(schedule.id, scheduleId));
      expect(await materialiseSchedule(db.db, scheduleId, window(MONDAY, 3))).toEqual({
        created: 0,
        alreadyPresent: 0,
      });
    });

    it('rolls every active schedule in a world', async () => {
      const { worldId, airlineId, hub, outstation } = await setup();
      const second = await createSchedule(db.db, {
        worldId,
        airlineId,
        airframeId: crypto.randomUUID(),
        legs: roundTrips(outstation, hub),
        repeat: { kind: 'weekdays', days: [1] },
      });
      expect(second.ok).toBe(true);

      // Four legs a day for three days from the daily rotation, plus one Monday
      // from the weekly one.
      const result = await materialiseWorld(db.db, worldId, window(MONDAY, 3));
      expect(result.created).toBe(12 + 4);
    });
  });

  describe('editing', () => {
    /** The last leg moves fifteen minutes later; legs 1 to 3 are untouched. */
    function movedLastLeg(hub: string, outstation: string): LegInput[] {
      const legs = roundTrips(hub, outstation);
      const last = legs[3];
      if (last === undefined) throw new Error('fixture');
      return [...legs.slice(0, 3), { ...last, departureMinute: 840 }];
    }

    it('rewrites a moved leg without colliding on its key', async () => {
      // The order-of-operations test. A moved leg keeps its materialisation key,
      // so inserting before deleting violates the unique constraint — this
      // passes only if the transaction cancels first.
      const { scheduleId, hub, outstation } = await setup();
      const horizon = window(MONDAY, 7);
      await materialiseSchedule(db.db, scheduleId, horizon);

      const result = await replaceScheduleLegs(
        db.db,
        scheduleId,
        movedLastLeg(hub, outstation),
        { kind: 'daily' },
        MONDAY,
        horizon,
      );

      expect(result).toMatchObject({ ok: true, cancelled: 7, created: 7 });
      const flights = await upcomingFlights(db.db, scheduleId, MONDAY);
      expect(flights).toHaveLength(28);

      const lastLegs = flights.filter((f) => f.key?.endsWith(':3'));
      expect(lastLegs).toHaveLength(7);
      for (const leg of lastLegs) {
        expect(leg.scheduledDeparture.toISOString().slice(11, 16)).toBe('14:00');
      }
    });

    it('leaves the legs the edit did not touch exactly where they were', async () => {
      const { scheduleId, hub, outstation } = await setup();
      const horizon = window(MONDAY, 7);
      await materialiseSchedule(db.db, scheduleId, horizon);

      const before = (await upcomingFlights(db.db, scheduleId, MONDAY)).filter(
        (f) => !f.key?.endsWith(':3'),
      );
      await replaceScheduleLegs(
        db.db,
        scheduleId,
        movedLastLeg(hub, outstation),
        { kind: 'daily' },
        MONDAY,
        horizon,
      );
      const after = (await upcomingFlights(db.db, scheduleId, MONDAY)).filter(
        (f) => !f.key?.endsWith(':3'),
      );

      // Same rows, same ids — not deleted and recreated with new ones, which
      // would have thrown away anything else that referenced them.
      expect(after.map((f) => f.id)).toEqual(before.map((f) => f.id));
    });

    it('will not un-fly a flight that has already gone', async () => {
      const { scheduleId, hub, outstation } = await setup();
      const horizon = window(MONDAY, 7);
      await materialiseSchedule(db.db, scheduleId, horizon);

      const flights = await upcomingFlights(db.db, scheduleId, MONDAY);
      const gone = flights.find((f) => f.key?.endsWith(':3'));
      if (gone === undefined) throw new Error('no last-leg flight');
      await db.db
        .update(flight)
        .set({ actualDeparture: gone.scheduledDeparture, phase: 'cruise' })
        .where(eq(flight.id, gone.id));

      const result = await replaceScheduleLegs(
        db.db,
        scheduleId,
        movedLastLeg(hub, outstation),
        { kind: 'daily' },
        MONDAY,
        horizon,
      );

      // Six rewritten rather than seven, and the departed one is untouched.
      expect(result).toMatchObject({ ok: true, cancelled: 6, created: 6 });
      const [still] = await db.db.select().from(flight).where(eq(flight.id, gone.id));
      expect(still?.actualDeparture).not.toBeNull();
      expect(still?.scheduledDeparture.toISOString()).toBe(gone.scheduledDeparture.toISOString());
    });

    it('takes the pending departure events with the flights it cancels', async () => {
      const { scheduleId, worldId, hub, outstation } = await setup();
      const horizon = window(MONDAY, 7);
      await materialiseSchedule(db.db, scheduleId, horizon);

      const doomed = (await upcomingFlights(db.db, scheduleId, MONDAY)).filter((f) =>
        f.key?.endsWith(':3'),
      );
      await replaceScheduleLegs(
        db.db,
        scheduleId,
        movedLastLeg(hub, outstation),
        { kind: 'daily' },
        MONDAY,
        horizon,
      );

      for (const f of doomed) {
        const [orphan] = await db.db
          .select()
          .from(worldEvent)
          .where(
            and(eq(worldEvent.worldId, worldId), eq(worldEvent.idempotencyKey, departureKey(f.id))),
          );
        expect(orphan).toBeUndefined();
      }

      // And the replacements have events of their own.
      const [events] = await db.db
        .select({ count: sql<string>`count(*)` })
        .from(worldEvent)
        .where(and(eq(worldEvent.worldId, worldId), eq(worldEvent.type, 'FLIGHT_DEPART')));
      expect(Number(events?.count)).toBe(28);
    });

    it('refuses an edit that would break the rotation, and changes nothing', async () => {
      const { scheduleId, hub, outstation } = await setup();
      const horizon = window(MONDAY, 3);
      await materialiseSchedule(db.db, scheduleId, horizon);

      const result = await replaceScheduleLegs(
        db.db,
        scheduleId,
        // Drop the last leg: the aircraft now ends the day away from the hub.
        roundTrips(hub, outstation).slice(0, 3),
        { kind: 'daily' },
        MONDAY,
        horizon,
      );

      expect(result).toMatchObject({ ok: false, problem: 'does_not_close' });
      expect(await upcomingFlights(db.db, scheduleId, MONDAY)).toHaveLength(12);
      expect((await loadSchedule(db.db, scheduleId))?.rotation.legs).toHaveLength(4);
    });

    it('leaves flights before the effective instant alone', async () => {
      const { scheduleId, hub, outstation } = await setup();
      const horizon = window(MONDAY, 7);
      await materialiseSchedule(db.db, scheduleId, horizon);

      const thursday = new Date('2026-08-20T00:00:00.000Z');
      const result = await replaceScheduleLegs(
        db.db,
        scheduleId,
        movedLastLeg(hub, outstation),
        { kind: 'daily' },
        thursday,
        horizon,
      );

      // Monday, Tuesday and Wednesday keep their 13:45; the remaining four days
      // move to 14:00.
      expect(result).toMatchObject({ ok: true, cancelled: 4, created: 4 });
      const lastLegs = (await upcomingFlights(db.db, scheduleId, MONDAY)).filter((f) =>
        f.key?.endsWith(':3'),
      );
      const times = lastLegs.map((f) => f.scheduledDeparture.toISOString().slice(11, 16));
      expect(times).toEqual(['13:45', '13:45', '13:45', '14:00', '14:00', '14:00', '14:00']);
    });
  });

  describe('a flight outlives its schedule', () => {
    it('keeps the flights when the schedule is deleted', async () => {
      const { scheduleId, worldId } = await setup();
      await materialiseSchedule(db.db, scheduleId, window(MONDAY, 2));
      expect(await orphanedFlights(db.db, worldId)).toBe(0);

      await db.db.delete(schedule).where(eq(schedule.id, scheduleId));

      // `on delete set null`, not cascade: one of these may have flown and
      // earned money, and §22.10 wants the operational record to survive.
      expect(await orphanedFlights(db.db, worldId)).toBe(8);
      const [row] = await db.db
        .select({ count: sql<string>`count(*)` })
        .from(flight)
        .where(eq(flight.worldId, worldId));
      expect(Number(row?.count)).toBe(8);
    });

    it('takes them when the world goes, because nothing survives that', async () => {
      const { scheduleId, worldId } = await setup();
      await materialiseSchedule(db.db, scheduleId, window(MONDAY, 2));

      await db.db.delete(world).where(eq(world.id, worldId));
      madeWorlds.splice(madeWorlds.indexOf(worldId), 1);

      const [row] = await db.db
        .select({ count: sql<string>`count(*)` })
        .from(flight)
        .where(eq(flight.worldId, worldId));
      expect(Number(row?.count)).toBe(0);
    });
  });
});
