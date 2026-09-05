import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type DatabaseHandle } from '../db/client';
import { airlineHub, airport } from '../db/schema';
import { openSelfHandling, signContract } from '../ground/contracts';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixture,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';

import { createEconomicsProvider, primeEconomicsScope } from './economics';
import { floorFor } from './fares';

import type { RouteRow } from './fares';
import type { ResolvedPlayerAirline } from '../airline/context';

/**
 * What the fare-floor provider actually resolves, against a real database
 * (BUG-01).
 *
 * `fares.test.ts` and `waterfall.test.ts` hand `RouteEconomics` in as a literal,
 * so nothing exercised the half that reads the world — and that is precisely how
 * the floor came to be drawn against standard-grade handling for every airline
 * while the settlement billed 0.15x to 1.5x. A provider whose inputs no test
 * resolves is a provider that can quietly stop matching the bill.
 *
 * Requires `DATABASE_URL`; CI provides it.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [network/economics-db.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

function own(fixture: FoundedAirlineFixture): ResolvedPlayerAirline {
  return { id: fixture.airline.id, worldId: fixture.world.id, status: 'active' };
}

describeDb('the economics provider', () => {
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
        sourceId: -(9_900_000 + n),
        ident: icao,
        icaoCode: icao,
        name: `Economics Test ${icao}`,
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

  function routeRow(fixture: FoundedAirlineFixture, origin: string, dest: string): RouteRow {
    return {
      id: randomUUID(),
      worldId: fixture.world.id,
      airlineId: fixture.airline.id,
      originIcao: origin,
      destinationIcao: dest,
      greatCircleNm: 400,
      fares: { economy: 12_000 },
    };
  }

  it('resolves the handling factor from the route owner’s own arrangement', async () => {
    const a = await fixtures.create();
    const origin = await makeAirport('EQA1');
    const dest = await makeAirport('EQA2');
    await giveHub(a, origin);
    const row = routeRow(a, origin, dest);
    const economicsFor = createEconomicsProvider(db.db);

    // Nothing arranged: the walk-up premium, which is what the flight will pay.
    const walkUp = await economicsFor(row);
    expect(walkUp.handlingPriceFactor).toBeGreaterThan(1);

    await signContract(db.db, own(a), origin, { serviceLine: 'ramp_baggage', grade: 'standard' });
    const standard = await economicsFor(row);
    expect(standard.handlingPriceFactor).toBe(1);

    await signContract(db.db, own(a), origin, { serviceLine: 'ramp_baggage', grade: 'premium' });
    const premium = await economicsFor(row);
    expect(premium.handlingPriceFactor).toBeGreaterThan(walkUp.handlingPriceFactor);

    await openSelfHandling(db.db, own(a), origin, { serviceLine: 'ramp_baggage', headcount: 20 });
    const mine = await economicsFor(row);
    expect(mine.handlingPriceFactor).toBeLessThan(1);
  });

  it('moves the fare floor with it', async () => {
    // The failure a player would have met: on walk-up their floor was drawn as
    // though they held a standard contract, so it permitted fares below the cost
    // the settlement was about to charge them.
    const a = await fixtures.create();
    const origin = await makeAirport('EQB1');
    const dest = await makeAirport('EQB2');
    const row = routeRow(a, origin, dest);
    const economicsFor = createEconomicsProvider(db.db);

    const onWalkUp = floorFor(await economicsFor(row), row.greatCircleNm);

    await signContract(db.db, own(a), origin, { serviceLine: 'ramp_baggage', grade: 'standard' });
    const onStandard = floorFor(await economicsFor(row), row.greatCircleNm);

    expect(onWalkUp.floorMinor).toBeGreaterThan(onStandard.floorMinor);
    expect(onWalkUp.variableCostPerSeatMinor).toBeGreaterThan(onStandard.variableCostPerSeatMinor);
  });

  it('reads the origin’s handler, not the destination’s', async () => {
    const a = await fixtures.create();
    const origin = await makeAirport('EQC1');
    const dest = await makeAirport('EQC2');
    const row = routeRow(a, origin, dest);
    const economicsFor = createEconomicsProvider(db.db);

    const before = await economicsFor(row);
    await signContract(db.db, own(a), dest, { serviceLine: 'ramp_baggage', grade: 'budget' });
    const after = await economicsFor(row);

    // A contract at the far end works nobody's departure turn on this route.
    expect(after.handlingPriceFactor).toBe(before.handlingPriceFactor);
  });

  it('is scoped to the airline that owns the route', async () => {
    const a = await fixtures.create();
    const b = await fixtures.create({ worldId: a.world.id });
    const origin = await makeAirport('EQD1');
    const dest = await makeAirport('EQD2');
    const economicsFor = createEconomicsProvider(db.db);

    // B signs a budget handler; A's floor must not move.
    await signContract(db.db, own(b), origin, { serviceLine: 'ramp_baggage', grade: 'budget' });
    const forA = await economicsFor(routeRow(a, origin, dest));
    const forB = await economicsFor(routeRow(b, origin, dest));

    expect(forA.handlingPriceFactor).toBeGreaterThan(1);
    expect(forB.handlingPriceFactor).toBeLessThan(1);
  });

  describe('what a rotation costs to price (BUG-08)', () => {
    /**
     * The provider is asked once per leg, and four of the reads behind it do not
     * vary between legs: the world's fuel context and its pinned economy belong
     * to the world, the social media effects and the active route count to the
     * airline. An eight-leg rotation made thirty-two round trips for four
     * answers.
     *
     * Counted on the pool rather than timed, for the reason
     * `ground/alert-query-count.test.ts` gives: a wall-clock budget on this
     * machine measures its neighbours.
     */
    async function countQueries(run: () => Promise<unknown>): Promise<number> {
      const pool = db.pool as unknown as { query: (...args: unknown[]) => unknown };
      const original = pool.query.bind(pool);
      let count = 0;
      pool.query = (...args: unknown[]) => {
        count += 1;
        return original(...args);
      };
      try {
        await run();
      } finally {
        pool.query = original;
      }
      return count;
    }

    it('reads the shared lookups once, not once per leg', async () => {
      const a = await fixtures.create();
      const stations = await Promise.all(
        ['EQE1', 'EQE2', 'EQE3', 'EQE4'].map((icao) => makeAirport(icao)),
      );
      const economicsFor = createEconomicsProvider(db.db);
      const rows = stations.map((origin, i) =>
        routeRow(a, origin, stations[(i + 1) % stations.length] ?? origin),
      );

      const unscoped = await countQueries(async () => {
        for (const row of rows) await economicsFor(row);
      });

      const scoped = await countQueries(async () => {
        const scope = await primeEconomicsScope(db.db, {
          worldId: a.world.id,
          airlineId: a.airline.id,
          originIcaos: rows.map((r) => r.originIcao),
        });
        for (const row of rows) await economicsFor(row, scope);
      });

      // Four legs: the shared reads happen once instead of four times.
      expect(scoped).toBeLessThan(unscoped);
      // And the saving grows with the leg count rather than being a constant.
      expect(unscoped - scoped).toBeGreaterThanOrEqual(rows.length);
    });

    it('produces the same economics with a scope as without one', async () => {
      // A cache that changed an answer would be worse than the round trips.
      const a = await fixtures.create();
      const origin = await makeAirport('EQF1');
      const dest = await makeAirport('EQF2');
      await signContract(db.db, own(a), origin, { serviceLine: 'ramp_baggage', grade: 'budget' });

      const economicsFor = createEconomicsProvider(db.db);
      const row = routeRow(a, origin, dest);
      const scope = await primeEconomicsScope(db.db, {
        worldId: a.world.id,
        airlineId: a.airline.id,
        originIcaos: [origin],
      });

      const withScope = await economicsFor(row, scope);
      const without = await economicsFor(row);

      expect(withScope.handlingPriceFactor).toBe(without.handlingPriceFactor);
      expect(withScope.originStation).toEqual(without.originStation);
      expect(withScope.settlement).toEqual(without.settlement);
      expect(withScope.fareFloorRatio).toBe(without.fareFloorRatio);
    });
  });
});
