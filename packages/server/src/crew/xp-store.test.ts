import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { ECONOMY_CONFIG_V1 } from '@tailfin/shared';
import type { Weather } from '@tailfin/sim';

import { createDatabase, type DatabaseHandle } from '../db/client';
import { airport, crewDutyPeriod, crewPool, flight, flightResult } from '../db/schema';
import { settleArrivedFlight } from '../flight/settle';
import { fixtureAirframe } from '../test-fixtures/airframe';
import { createAirportIdentities } from '../test-fixtures/airport-codes';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixture,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';

import { hireCrew, openCrewBase } from './store';
import { xpAfterDeparture } from './xp-store';


/**
 * §10.2's XP against a real database (M9-02).
 *
 * The formula has its own tests in `packages/sim`. What is worth proving here
 * is the half only Postgres can answer, and it is the half M5-01's "no crew
 * member rows" rule makes non-obvious:
 *
 *   - the XP reaches the **pools the duty period actually drew from**, at
 *     `xpPerHead × heads` each;
 *   - it is awarded **once** per flight, because it rides the settlement's own
 *     replay guard rather than a check of its own;
 *   - the airport rating and the arrival weather really do move the number, end
 *     to end, through the settlement rather than in a unit test's fixture.
 *
 * Requires `DATABASE_URL`; CI provides it.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [crew/xp-store.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

const nextAirport = createAirportIdentities('crew/xp');

const DEPARTS = new Date('2026-01-15T06:00:00.000Z');
/** Mid-afternoon UTC, so an unset timezone is not silently a night landing. */
const ARRIVES = new Date('2026-01-15T13:15:00.000Z');

const LOAD = JSON.stringify({ economy: { seats: 70, passengers: 47, revenue: 47 * 7_500 } });

/**
 * A clear, calm day, pinned.
 *
 * Every fixture world has its own seed, so two otherwise identical arrival
 * fields see two different days — and *"all else equal"* stops being something
 * a test can arrange. `resolveWeather` is the settlement's own resolver-dep
 * convention, the same one `resolveAirframe` and `resolveStation` use.
 */
const FAIR: Weather = {
  icaoCode: 'FAIR',
  date: '2026-01-15',
  temperatureC: 15,
  windKt: 4,
  visibilityM: 10_000,
  precipitation: 'none',
};

/** A winter northern day: crosswind, snow, poor visibility. */
const FOUL: Weather = {
  ...FAIR,
  temperatureC: -9,
  windKt: 34,
  visibilityM: 800,
  precipitation: 'snow',
};

describeDb('crew XP on settlement', () => {
  let db: DatabaseHandle;
  let fixtures: FoundedAirlineFixtureHarness;
  const madeAirports: string[] = [];

  beforeAll(() => {
    db = createDatabase();
    fixtures = createFoundedAirlineFixtureHarness(db.db);
  });

  afterEach(async () => {
    await fixtures.cleanup();
    for (const icao of madeAirports.splice(0)) {
      await db.db.delete(airport).where(eq(airport.icaoCode, icao));
    }
  });

  afterAll(async () => {
    await db.close();
  });

  async function makeAirport(options: {
    latitude: number;
    longitude: number;
    difficulty?: number | null;
    utcOffsetMinutes?: number | null;
    continent?: string | null;
  }): Promise<string> {
    const identity = nextAirport();
    await db.db.insert(airport).values({
      sourceId: identity.sourceId,
      ident: identity.ident,
      icaoCode: identity.icaoCode,
      name: `XP Test Field ${identity.icaoCode}`,
      isoCountry: 'NL',
      kind: 'large_airport',
      latitude: options.latitude,
      longitude: options.longitude,
      scheduledService: true,
      hasRunwayData: false,
      difficulty: options.difficulty ?? null,
      utcOffsetMinutes: options.utcOffsetMinutes ?? null,
      continent: options.continent ?? 'EU',
    });
    madeAirports.push(identity.icaoCode);
    return identity.icaoCode;
  }

  /** A crew base with pools, and an open duty period holding a complement. */
  async function crewedFlight(options: {
    fixture: FoundedAirlineFixture;
    origin: string;
    dest: string;
    captains: number;
    firstOfficers: number;
  }): Promise<{ flightId: string; crewBaseId: string; dutyPeriodId: string }> {
    const { fixture } = options;
    const opened = await openCrewBase(db.db, {
      worldId: fixture.world.id,
      airlineId: fixture.airline.id,
      airportIcao: options.origin,
    });
    if (!opened.ok) throw new Error(`could not open a base: ${opened.refusal}`);
    const crewBaseId = opened.value.crewBaseId;

    for (const [rank, heads] of [
      ['captain', options.captains],
      ['first_officer', options.firstOfficers],
    ] as const) {
      const hired = await hireCrew(db.db, {
        worldId: fixture.world.id,
        airlineId: fixture.airline.id,
        crewBaseId,
        family: 'A320neo',
        rank,
        heads,
      });
      if (!hired.ok) throw new Error(`could not hire ${rank}: ${hired.refusal}`);
    }

    const airframeId = randomUUID();
    const [period] = await db.db
      .insert(crewDutyPeriod)
      .values({
        worldId: fixture.world.id,
        airlineId: fixture.airline.id,
        airframeId,
        crewBaseId,
        family: 'A320neo',
        heads: options.captains + options.firstOfficers,
        complement: JSON.stringify([
          { rank: 'captain', count: options.captains },
          { rank: 'first_officer', count: options.firstOfficers },
        ]),
        reportAt: DEPARTS,
        locationIcao: options.origin,
      })
      .returning({ id: crewDutyPeriod.id });
    if (!period) throw new Error('no duty period');

    const [f] = await db.db
      .insert(flight)
      .values({
        worldId: fixture.world.id,
        airlineId: fixture.airline.id,
        airframeId,
        originIcao: options.origin,
        destinationIcao: options.dest,
        crewDutyPeriodId: period.id,
        scheduledDeparture: DEPARTS,
        estimatedArrival: ARRIVES,
        load: LOAD,
        cargoKg: 0,
      })
      .returning({ id: flight.id });
    if (!f) throw new Error('no flight');

    return { flightId: f.id, crewBaseId, dutyPeriodId: period.id };
  }

  async function poolXp(crewBaseId: string): Promise<Map<string, number>> {
    const rows = await db.db
      .select({ rank: crewPool.rank, xp: crewPool.xp, headcount: crewPool.headcount })
      .from(crewPool)
      .where(eq(crewPool.crewBaseId, crewBaseId));
    return new Map(rows.map((row) => [row.rank, row.xp] as const));
  }

  async function settle(flightId: string, weather: Weather | null = FAIR): Promise<void> {
    await db.db.transaction(async (tx) => {
      const outcome = await settleArrivedFlight(tx, flightId, ARRIVES, {
        resolveAirframe: () => fixtureAirframe(),
        resolveWeather: () => weather,
      });
      if (outcome.status === 'not-found') throw new Error('flight vanished');
    });
  }

  // -------------------------------------------------------------------------

  it('awards every head aboard, to the pools the duty period drew from', async () => {
    const fixture = await fixtures.create();
    const origin = await makeAirport({ latitude: 52.3086, longitude: 4.76389 });
    const dest = await makeAirport({ latitude: 51.4706, longitude: -0.461941 });
    const { flightId, crewBaseId } = await crewedFlight({
      fixture,
      origin,
      dest,
      captains: 2,
      firstOfficers: 3,
    });

    expect([...(await poolXp(crewBaseId)).values()]).toEqual([0, 0]);
    await settle(flightId);

    const after = await poolXp(crewBaseId);
    const captainXp = after.get('captain') ?? 0;
    const foXp = after.get('first_officer') ?? 0;
    expect(captainXp).toBeGreaterThan(0);

    // §10.2's "every crew member aboard": the same per head, so three first
    // officers earn exactly 1.5× what two captains do.
    expect(foXp / captainXp).toBeCloseTo(3 / 2, 6);
    expect(captainXp % 2).toBe(0);
  });

  it('records why, on the flight result, so the figure can be argued with', async () => {
    const fixture = await fixtures.create();
    const origin = await makeAirport({ latitude: 52.3086, longitude: 4.76389 });
    const dest = await makeAirport({ latitude: 51.4706, longitude: -0.461941, difficulty: 0.7 });
    const { flightId } = await crewedFlight({
      fixture,
      origin,
      dest,
      captains: 2,
      firstOfficers: 2,
    });
    await settle(flightId);

    const [result] = await db.db
      .select({ breakdown: flightResult.breakdown })
      .from(flightResult)
      .where(eq(flightResult.flightId, flightId));
    const breakdown = JSON.parse(result?.breakdown ?? '{}') as {
      crewXp?: {
        xpPerHead: number;
        heads: number;
        totalXp: number;
        factors: { factor: string }[];
        pools: { rank: string; xp: number }[];
      };
    };

    expect(breakdown.crewXp).toBeDefined();
    expect(breakdown.crewXp?.heads).toBe(4);
    expect(breakdown.crewXp?.totalXp).toBe((breakdown.crewXp?.xpPerHead ?? 0) * 4);
    // The hard arrival field is named as a reason rather than folded silently in.
    expect(breakdown.crewXp?.factors.map((f) => f.factor)).toContain('arrivalAirport');
    expect(breakdown.crewXp?.pools.map((p) => p.rank).sort()).toEqual(['captain', 'first_officer']);
  });

  /** AC1, end to end: the same sector into a hard field earns measurably more. */
  it('pays more into a hard field than an easy one, all else equal', async () => {
    const easy = await fixtures.create();
    const easyOrigin = await makeAirport({ latitude: 52.3086, longitude: 4.76389 });
    const easyDest = await makeAirport({
      latitude: 51.4706,
      longitude: -0.461941,
      difficulty: 0,
    });
    const easyFlight = await crewedFlight({
      fixture: easy,
      origin: easyOrigin,
      dest: easyDest,
      captains: 2,
      firstOfficers: 0,
    });
    await settle(easyFlight.flightId);

    const hard = await fixtures.create();
    const hardOrigin = await makeAirport({ latitude: 52.3086, longitude: 4.76389 });
    // Same coordinates, so the same distance and the same base XP — the only
    // difference between the two settlements is the rating on the arrival row.
    const hardDest = await makeAirport({
      latitude: 51.4706,
      longitude: -0.461941,
      difficulty: 0.8,
    });
    const hardFlight = await crewedFlight({
      fixture: hard,
      origin: hardOrigin,
      dest: hardDest,
      captains: 2,
      firstOfficers: 0,
    });
    await settle(hardFlight.flightId);

    const easyXp = (await poolXp(easyFlight.crewBaseId)).get('captain') ?? 0;
    const hardXp = (await poolXp(hardFlight.crewBaseId)).get('captain') ?? 0;
    expect(hardXp).toBeGreaterThan(easyXp);
  });

  it('treats an unrated field as unrated, not as easy', async () => {
    // Both settlements must produce the *same* XP: null contributes nothing,
    // and a rating of 0 contributes nothing. The difference is what the
    // interface can say, not what the crew earn.
    const a = await fixtures.create();
    const aOrigin = await makeAirport({ latitude: 52.3086, longitude: 4.76389 });
    const aDest = await makeAirport({ latitude: 51.4706, longitude: -0.461941, difficulty: null });
    const aFlight = await crewedFlight({
      fixture: a,
      origin: aOrigin,
      dest: aDest,
      captains: 1,
      firstOfficers: 0,
    });
    await settle(aFlight.flightId);

    const b = await fixtures.create();
    const bOrigin = await makeAirport({ latitude: 52.3086, longitude: 4.76389 });
    const bDest = await makeAirport({ latitude: 51.4706, longitude: -0.461941, difficulty: 0 });
    const bFlight = await crewedFlight({
      fixture: b,
      origin: bOrigin,
      dest: bDest,
      captains: 1,
      firstOfficers: 0,
    });
    await settle(bFlight.flightId);

    expect((await poolXp(aFlight.crewBaseId)).get('captain')).toBe(
      (await poolXp(bFlight.crewBaseId)).get('captain'),
    );
  });

  /** AC3, where it actually matters: a replayed arrival must not pay twice. */
  it('awards XP exactly once, however many times the arrival is replayed', async () => {
    const fixture = await fixtures.create();
    const origin = await makeAirport({ latitude: 52.3086, longitude: 4.76389 });
    const dest = await makeAirport({ latitude: 51.4706, longitude: -0.461941 });
    const { flightId, crewBaseId } = await crewedFlight({
      fixture,
      origin,
      dest,
      captains: 2,
      firstOfficers: 0,
    });

    await settle(flightId);
    const once = (await poolXp(crewBaseId)).get('captain') ?? 0;
    expect(once).toBeGreaterThan(0);

    // The settlement's own unique constraint refuses the second result, and the
    // XP rides that guard rather than carrying one of its own.
    await settle(flightId);
    await settle(flightId);
    expect((await poolXp(crewBaseId)).get('captain')).toBe(once);
  });

  it('awards nothing to a flight that carried no crew', async () => {
    const fixture = await fixtures.create();
    const origin = await makeAirport({ latitude: 52.3086, longitude: 4.76389 });
    const dest = await makeAirport({ latitude: 51.4706, longitude: -0.461941 });
    const opened = await openCrewBase(db.db, {
      worldId: fixture.world.id,
      airlineId: fixture.airline.id,
      airportIcao: origin,
    });
    if (!opened.ok) throw new Error('no base');
    const hired = await hireCrew(db.db, {
      worldId: fixture.world.id,
      airlineId: fixture.airline.id,
      crewBaseId: opened.value.crewBaseId,
      family: 'A320neo',
      rank: 'captain',
      heads: 2,
    });
    if (!hired.ok) throw new Error('no hire');

    // No `crewDutyPeriodId` — a ferry positioned before the crew model, or a
    // world with no base. A real state rather than an error.
    const [f] = await db.db
      .insert(flight)
      .values({
        worldId: fixture.world.id,
        airlineId: fixture.airline.id,
        airframeId: randomUUID(),
        originIcao: origin,
        destinationIcao: dest,
        scheduledDeparture: DEPARTS,
        estimatedArrival: ARRIVES,
        load: LOAD,
        cargoKg: 0,
      })
      .returning({ id: flight.id });
    if (!f) throw new Error('no flight');

    await settle(f.id);
    expect((await poolXp(opened.value.crewBaseId)).get('captain')).toBe(0);
  });

  it('pays more for landing in winter weather than in fair weather', async () => {
    const fair = await fixtures.create();
    const fairOrigin = await makeAirport({ latitude: 52.3086, longitude: 4.76389 });
    const fairDest = await makeAirport({ latitude: 51.4706, longitude: -0.461941 });
    const fairFlight = await crewedFlight({
      fixture: fair,
      origin: fairOrigin,
      dest: fairDest,
      captains: 1,
      firstOfficers: 0,
    });
    await settle(fairFlight.flightId, FAIR);

    const foul = await fixtures.create();
    const foulOrigin = await makeAirport({ latitude: 52.3086, longitude: 4.76389 });
    const foulDest = await makeAirport({ latitude: 51.4706, longitude: -0.461941 });
    const foulFlight = await crewedFlight({
      fixture: foul,
      origin: foulOrigin,
      dest: foulDest,
      captains: 1,
      firstOfficers: 0,
    });
    await settle(foulFlight.flightId, FOUL);

    expect((await poolXp(foulFlight.crewBaseId)).get('captain') ?? 0).toBeGreaterThan(
      (await poolXp(fairFlight.crewBaseId)).get('captain') ?? 0,
    );
  });

  it('pays a night landing more than a daytime one, on the field’s local clock', async () => {
    // Same UTC arrival; the two arrival fields differ only in their offset, so
    // one lands at 13:15 local and the other at 01:15.
    const day = await fixtures.create();
    const dayOrigin = await makeAirport({ latitude: 52.3086, longitude: 4.76389 });
    const dayDest = await makeAirport({
      latitude: 51.4706,
      longitude: -0.461941,
      utcOffsetMinutes: 0,
    });
    const dayFlight = await crewedFlight({
      fixture: day,
      origin: dayOrigin,
      dest: dayDest,
      captains: 1,
      firstOfficers: 0,
    });
    await settle(dayFlight.flightId);

    const night = await fixtures.create();
    const nightOrigin = await makeAirport({ latitude: 52.3086, longitude: 4.76389 });
    const nightDest = await makeAirport({
      latitude: 51.4706,
      longitude: -0.461941,
      utcOffsetMinutes: 12 * 60,
    });
    const nightFlight = await crewedFlight({
      fixture: night,
      origin: nightOrigin,
      dest: nightDest,
      captains: 1,
      firstOfficers: 0,
    });
    await settle(nightFlight.flightId);

    expect((await poolXp(nightFlight.crewBaseId)).get('captain') ?? 0).toBeGreaterThan(
      (await poolXp(dayFlight.crewBaseId)).get('captain') ?? 0,
    );
  });
});

/**
 * The pro-rata removal, as pure arithmetic.
 *
 * Its database half is exercised by the morale suite; what matters here is that
 * the rule itself cannot produce a rise, which is the failure it exists to
 * prevent.
 */
describe('XP leaves with the heads that carried it', () => {
  it('keeps XP per head unchanged when crew resign', () => {
    const before = { xp: 1_000, heads: 10 };
    const after = xpAfterDeparture(before.xp, before.heads, 3);
    // 700 over 7 heads is the same 100 per head it was over 10.
    expect(after).toBe(700);
    expect(after / 7).toBeCloseTo(before.xp / before.heads, 6);
  });

  it('never lets a resignation make the survivors look better', () => {
    for (const heads of [1, 2, 5, 12, 40]) {
      for (const leaving of [1, 2, 3]) {
        if (leaving >= heads) continue;
        const xp = 997 * heads;
        const after = xpAfterDeparture(xp, heads, leaving);
        expect(after / (heads - leaving)).toBeLessThanOrEqual(xp / heads + 1e-9);
      }
    }
  });

  it('empties the pool when everybody leaves', () => {
    expect(xpAfterDeparture(5_000, 4, 4)).toBe(0);
    expect(xpAfterDeparture(5_000, 4, 9)).toBe(0);
  });

  it('changes nothing when nobody leaves', () => {
    expect(xpAfterDeparture(5_000, 4, 0)).toBe(5_000);
    expect(xpAfterDeparture(5_000, 0, 2)).toBe(5_000);
  });

  it('never returns a negative, which the check constraint would refuse', () => {
    for (const heads of [1, 3, 9]) {
      for (const leaving of [0, 1, heads]) {
        expect(xpAfterDeparture(17, heads, leaving)).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('the shipped balance is reachable from the crew config', () => {
  it('carries an XP section', () => {
    expect(ECONOMY_CONFIG_V1.crew.xp.baseSectorXp).toBeGreaterThan(0);
  });
});
