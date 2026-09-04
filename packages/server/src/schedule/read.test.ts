import crypto from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type DatabaseHandle } from '../db/client';
import { airport, route } from '../db/schema';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixture,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';

import { listSchedules } from './read';
import { createSchedule } from './store';

import type { ResolvedPlayerAirline } from '../airline/context';

/**
 * Reading schedules back (M2-03, §8.2).
 *
 * Proves the mapping this file owns: legs come back in order, each mapped to the
 * route it flies by its endpoints, and a leg whose route does not exist maps to
 * null rather than inventing one. The store's own writes are proved in
 * `store.test.ts`. Requires `DATABASE_URL`; CI provides it.
 */
const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [schedule/read.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

function own(fixture: FoundedAirlineFixture): ResolvedPlayerAirline {
  return { id: fixture.airline.id, worldId: fixture.world.id, status: 'active' };
}

describeDb('listSchedules', () => {
  let db: DatabaseHandle;
  let fixtures: FoundedAirlineFixtureHarness;
  const madeAirports: string[] = [];

  beforeAll(() => {
    db = createDatabase();
    fixtures = createFoundedAirlineFixtureHarness(db.db);
  });

  afterEach(async () => {
    await fixtures.cleanup();
  });

  afterAll(async () => {
    for (const icao of madeAirports.splice(0)) {
      await db.db.delete(airport).where(eq(airport.icaoCode, icao));
    }
    await db.close();
  });

  function code(): string {
    return `Z${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
  }

  async function makeAirport(utcOffsetMinutes: number | null = null): Promise<string> {
    const icao = code();
    await db.db.insert(airport).values({
      sourceId: Math.floor(Math.random() * 2_000_000_000),
      ident: `TEST-${icao}`,
      icaoCode: icao,
      name: `Test Field ${icao}`,
      isoCountry: 'GB',
      kind: 'large_airport',
      latitude: 51.5,
      longitude: -0.1,
      scheduledService: true,
      hasRunwayData: false,
      utcOffsetMinutes,
    });
    madeAirports.push(icao);
    return icao;
  }

  async function makeRoute(
    fixture: FoundedAirlineFixture,
    from: string,
    to: string,
  ): Promise<string> {
    const [row] = await db.db
      .insert(route)
      .values({
        worldId: fixture.world.id,
        airlineId: fixture.airline.id,
        originIcao: from,
        destinationIcao: to,
        greatCircleNm: 620,
      })
      .returning({ id: route.id });
    if (!row) throw new Error('no route');
    return row.id;
  }

  it('returns a schedule with its legs, mapped to the routes they fly', async () => {
    const a = await fixtures.create({ baseCountry: 'GB' });
    const hub = await makeAirport();
    const outstation = await makeAirport();
    const outboundRouteId = await makeRoute(a, hub, outstation);
    const inboundRouteId = await makeRoute(a, outstation, hub);

    const saved = await createSchedule(db.db, {
      worldId: a.world.id,
      airlineId: a.airline.id,
      airframeId: crypto.randomUUID(),
      legs: [
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
      ],
      repeat: { kind: 'daily' },
    });
    expect(saved.ok).toBe(true);

    const schedules = await listSchedules(db.db, own(a));
    expect(schedules).toHaveLength(1);
    const view = schedules[0];
    expect(view?.active).toBe(true);
    expect(view?.repeat).toEqual({ kind: 'daily' });
    expect(view?.upcomingFlights).toBe(0);
    expect(view?.legs.map((l) => l.routeId)).toEqual([outboundRouteId, inboundRouteId]);
    expect(view?.legs.map((l) => l.departureMinute)).toEqual([420, 555]);
  });

  it('maps a leg with no matching route to a null routeId', async () => {
    const a = await fixtures.create({ baseCountry: 'GB' });
    const hub = await makeAirport();
    const outstation = await makeAirport();
    // Only the outbound direction has a route; the return leg has none.
    const outboundRouteId = await makeRoute(a, hub, outstation);

    const saved = await createSchedule(db.db, {
      worldId: a.world.id,
      airlineId: a.airline.id,
      airframeId: crypto.randomUUID(),
      legs: [
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
      ],
      repeat: { kind: 'daily' },
    });
    expect(saved.ok).toBe(true);

    const [view] = await listSchedules(db.db, own(a));
    expect(view?.legs.map((l) => l.routeId)).toEqual([outboundRouteId, null]);
  });

  it('does not return another airline’s schedules', async () => {
    const a = await fixtures.create({ baseCountry: 'GB' });
    const b = await fixtures.create({ worldId: a.world.id, baseCountry: 'GB' });
    const hub = await makeAirport();
    const outstation = await makeAirport();

    await createSchedule(db.db, {
      worldId: a.world.id,
      airlineId: a.airline.id,
      airframeId: crypto.randomUUID(),
      legs: [
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
      ],
      repeat: { kind: 'daily' },
    });

    expect(await listSchedules(db.db, own(b))).toHaveLength(0);
  });

  it('reads a stored absolute departure back in the origin’s local time', async () => {
    // Both airports sit at UTC−5; a leg stored at absolute 13:00 UTC is a 08:00
    // local departure, which is what the player must see (M3-04a). Two legs, so the
    // rotation closes back at the hub and validates.
    const a = await fixtures.create({ baseCountry: 'GB' });
    const hub = await makeAirport(-300);
    const outstation = await makeAirport(-300);
    await makeRoute(a, hub, outstation);
    await makeRoute(a, outstation, hub);

    await createSchedule(db.db, {
      worldId: a.world.id,
      airlineId: a.airline.id,
      airframeId: crypto.randomUUID(),
      legs: [
        {
          originIcao: hub,
          destinationIcao: outstation,
          departureMinute: 13 * 60, // absolute (UTC-anchor) → 08:00 local
          blockMinutes: 95,
          turnaroundMinutes: 40,
        },
        {
          originIcao: outstation,
          destinationIcao: hub,
          departureMinute: 13 * 60 + 95 + 40, // earliest it can follow → 10:15 local
          blockMinutes: 95,
          turnaroundMinutes: 40,
        },
      ],
      repeat: { kind: 'daily' },
    });

    const [view] = await listSchedules(db.db, own(a));
    expect(view?.legs.map((l) => l.departureMinute)).toEqual([8 * 60, 8 * 60 + 95 + 40]);
  });
});
