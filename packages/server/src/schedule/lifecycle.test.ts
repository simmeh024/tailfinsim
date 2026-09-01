import crypto from 'node:crypto';

import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { gameTime, horizonFrom, type WorldClock } from '@tailfin/sim';

import { createDatabase, type DatabaseHandle } from '../db/client';
import { airport, flight } from '../db/schema';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixture,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';

import { pauseSchedule, removeSchedule } from './authoring';
import { listSchedules } from './read';
import { createSchedule, materialiseSchedule } from './store';

import type { ResolvedPlayerAirline } from '../airline/context';

/**
 * The schedule lifecycle: pause and delete (M2-03 lifecycle).
 *
 * Owner-scoped throughout — another airline's schedule is never touched. The
 * leg-resolution and edit logic is proved in `prepare-legs.test.ts` (it turns on
 * a capability, not a whole airframe). Requires `DATABASE_URL`; CI provides it.
 */
const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [schedule/lifecycle.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

function own(fixture: FoundedAirlineFixture): ResolvedPlayerAirline {
  return { id: fixture.airline.id, worldId: fixture.world.id, status: 'active' };
}

describeDb('schedule lifecycle', () => {
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

  async function makeAirport(): Promise<string> {
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
    });
    madeAirports.push(icao);
    return icao;
  }

  async function roundTrip(a: FoundedAirlineFixture, hub: string, out: string): Promise<string> {
    const saved = await createSchedule(db.db, {
      worldId: a.world.id,
      airlineId: a.airline.id,
      airframeId: crypto.randomUUID(),
      legs: [
        {
          originIcao: hub,
          destinationIcao: out,
          departureMinute: 420,
          blockMinutes: 95,
          turnaroundMinutes: 40,
        },
        {
          originIcao: out,
          destinationIcao: hub,
          departureMinute: 555,
          blockMinutes: 95,
          turnaroundMinutes: 40,
        },
      ],
      repeat: { kind: 'daily' },
    });
    if (!saved.ok) throw new Error(`fixture rotation refused: ${saved.detail}`);
    return saved.scheduleId;
  }

  it('pauses and resumes a schedule, and refuses another airline’s', async () => {
    const a = await fixtures.create({ baseCountry: 'GB' });
    const b = await fixtures.create({ worldId: a.world.id, baseCountry: 'GB' });
    const hub = await makeAirport();
    const out = await makeAirport();
    const id = await roundTrip(a, hub, out);

    const paused = await pauseSchedule(db.db, own(a), id, false);
    expect(paused?.active).toBe(false);
    const resumed = await pauseSchedule(db.db, own(a), id, true);
    expect(resumed?.active).toBe(true);

    // Not b's schedule — untouched, and reported as absent.
    expect(await pauseSchedule(db.db, own(b), id, false)).toBeNull();
  });

  it('deletes a schedule and cancels its future flights, owner-scoped', async () => {
    const a = await fixtures.create({ baseCountry: 'GB' });
    const b = await fixtures.create({ worldId: a.world.id, baseCountry: 'GB' });
    const hub = await makeAirport();
    const out = await makeAirport();
    const id = await roundTrip(a, hub, out);

    // Materialise a horizon of flights so there is something to cancel.
    const clock: WorldClock = {
      epoch: a.world.epoch,
      launchDate: a.world.launchDate,
      speedMultiplier: Number(a.world.speedMultiplier),
    };
    const gameNow = gameTime(clock, new Date());
    await materialiseSchedule(db.db, id, horizonFrom(gameNow));

    const before = await db.db
      .select({ id: flight.id })
      .from(flight)
      .where(and(eq(flight.scheduleId, id), isNull(flight.actualDeparture)));
    expect(before.length).toBeGreaterThan(0);

    // Another airline cannot delete it.
    expect(await removeSchedule(db.db, own(b), id)).toBe(false);

    expect(await removeSchedule(db.db, own(a), id)).toBe(true);
    expect(await listSchedules(db.db, own(a))).toHaveLength(0);
    const after = await db.db
      .select({ id: flight.id })
      .from(flight)
      .where(eq(flight.scheduleId, id));
    expect(after).toHaveLength(0);
  });
});
