import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_TURNAROUND_MINUTES } from '@tailfin/sim';

import { createDatabase, type DatabaseHandle } from '../db/client';
import { airlineHub, airport } from '../db/schema';
import { openSelfHandling, signContract } from '../ground/contracts';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixture,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';

import { turnaroundResolver } from './authoring';

import type { ResolvedPlayerAirline } from '../airline/context';

/**
 * How long a turn takes, from the handler working it (BUG-06, M5-06, §9.3).
 *
 * `authoring.test.ts` drives `placeLegs` with a resolver of its own, which
 * proves the arithmetic and the placement. This is the half only a database can
 * answer: that the resolver reads the **destination's** arrangement, for the
 * airline that owns the schedule, and that a grade actually moves the number.
 *
 * Requires `DATABASE_URL`; CI provides it.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [schedule/turnaround-db.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

function own(fixture: FoundedAirlineFixture): ResolvedPlayerAirline {
  return { id: fixture.airline.id, worldId: fixture.world.id, status: 'active' };
}

/** One leg, in the shape `turnaroundResolver` reads. */
function leg(originIcao: string, destinationIcao: string) {
  return {
    routeId: randomUUID(),
    originIcao,
    destinationIcao,
    greatCircleNm: 400,
    departureMinuteLocal: 480,
    opened: false,
  };
}

describeDb('the turnaround a schedule plans', () => {
  let db: DatabaseHandle;
  let fixtures: FoundedAirlineFixtureHarness;
  const madeAirports: string[] = [];
  let seq = 0;

  beforeAll(() => {
    db = createDatabase();
    fixtures = createFoundedAirlineFixtureHarness(db.db);
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

  async function makeAirport(icao: string): Promise<string> {
    const n = seq++;
    const [created] = await db.db
      .insert(airport)
      .values({
        sourceId: -(9_980_000 + n),
        ident: `TURN-${icao}`,
        icaoCode: icao,
        name: `Turnaround Test ${icao}`,
        isoCountry: 'NL',
        continent: 'EU',
        kind: 'large_airport',
        latitude: 52 + n * 0.01,
        longitude: 4 + n * 0.01,
        scheduledService: true,
        hasRunwayData: false,
        tier: 'large',
        elevationFt: 0,
      })
      .returning({ id: airport.id });
    if (!created) throw new Error(`no airport ${icao}`);
    madeAirports.push(created.id);
    return icao;
  }

  async function giveHub(fixture: FoundedAirlineFixture, icao: string): Promise<void> {
    const [row] = await db.db
      .select({ id: airport.id })
      .from(airport)
      .where(eq(airport.icaoCode, icao))
      .limit(1);
    if (!row) throw new Error(`no airport ${icao}`);
    await db.db
      .insert(airlineHub)
      .values({ airlineId: fixture.airline.id, airportId: row.id })
      .onConflictDoNothing();
  }

  it('is the baseline when nothing is arranged at the station', async () => {
    const a = await fixtures.create();
    const origin = await makeAirport('TRA1');
    const dest = await makeAirport('TRA2');
    const resolve = await turnaroundResolver(db.db, own(a), [leg(origin, dest)]);
    // Walk-up reads as budget-grade for *reliability*, but its speed is the
    // budget handler's too — the airline is scrambling the bags itself.
    expect(resolve(dest)).toBeGreaterThan(DEFAULT_TURNAROUND_MINUTES);
  });

  it('shortens with a premium handler and lengthens with a budget one', async () => {
    // §9.3's "cheap ramp handlers = slower turns", finally true of the plan.
    const a = await fixtures.create();
    const origin = await makeAirport('TRB1');
    const dest = await makeAirport('TRB2');

    await signContract(db.db, own(a), dest, { serviceLine: 'ramp_baggage', grade: 'premium' });
    const premium = (await turnaroundResolver(db.db, own(a), [leg(origin, dest)]))(dest);

    await signContract(db.db, own(a), dest, { serviceLine: 'ramp_baggage', grade: 'standard' });
    const standard = (await turnaroundResolver(db.db, own(a), [leg(origin, dest)]))(dest);

    await signContract(db.db, own(a), dest, { serviceLine: 'ramp_baggage', grade: 'budget' });
    const budget = (await turnaroundResolver(db.db, own(a), [leg(origin, dest)]))(dest);

    expect(premium).toBeLessThan(standard);
    expect(standard).toBe(DEFAULT_TURNAROUND_MINUTES);
    expect(budget).toBeGreaterThan(standard);
  });

  it('reads the destination, not the origin — the turn happens where it lands', async () => {
    const a = await fixtures.create();
    const origin = await makeAirport('TRC1');
    const dest = await makeAirport('TRC2');

    // A premium handler at the *origin* works the previous turn, not this one.
    await signContract(db.db, own(a), origin, { serviceLine: 'ramp_baggage', grade: 'premium' });
    const resolve = await turnaroundResolver(db.db, own(a), [leg(origin, dest)]);
    expect(resolve(dest)).toBeGreaterThan(DEFAULT_TURNAROUND_MINUTES);
  });

  it('reads an understaffed operation of the airline’s own as the slow thing it is', async () => {
    const a = await fixtures.create();
    const origin = await makeAirport('TRD1');
    const dest = await makeAirport('TRD2');
    await giveHub(a, dest);

    await openSelfHandling(db.db, own(a), dest, { serviceLine: 'ramp_baggage', headcount: 28 });
    const staffed = (await turnaroundResolver(db.db, own(a), [leg(origin, dest)]))(dest);

    await openSelfHandling(db.db, own(a), dest, { serviceLine: 'ramp_baggage', headcount: 1 });
    const thin = (await turnaroundResolver(db.db, own(a), [leg(origin, dest)]))(dest);

    // Fully staffed beats the standard contractor; a station run by one person
    // is worse than the cheapest vendor.
    expect(staffed).toBeLessThan(DEFAULT_TURNAROUND_MINUTES);
    expect(thin).toBeGreaterThan(DEFAULT_TURNAROUND_MINUTES);
  });

  it('is scoped to the airline that owns the schedule', async () => {
    const a = await fixtures.create();
    const b = await fixtures.create({ worldId: a.world.id });
    const origin = await makeAirport('TRE1');
    const dest = await makeAirport('TRE2');

    // B's premium handler must not shorten A's turns.
    await signContract(db.db, own(b), dest, { serviceLine: 'ramp_baggage', grade: 'premium' });
    const forA = (await turnaroundResolver(db.db, own(a), [leg(origin, dest)]))(dest);
    const forB = (await turnaroundResolver(db.db, own(b), [leg(origin, dest)]))(dest);

    expect(forA).toBeGreaterThan(DEFAULT_TURNAROUND_MINUTES);
    expect(forB).toBeLessThan(DEFAULT_TURNAROUND_MINUTES);
  });

  it('resolves each station once, however many legs land there', async () => {
    const a = await fixtures.create();
    const origin = await makeAirport('TRF1');
    const dest = await makeAirport('TRF2');
    const resolve = await turnaroundResolver(db.db, own(a), [
      leg(origin, dest),
      leg(dest, origin),
      leg(origin, dest),
    ]);
    expect(resolve(dest)).toBe(resolve(dest));
    expect(resolve(origin)).toBeGreaterThan(0);
  });
});
