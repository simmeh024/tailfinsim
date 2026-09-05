import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { AirportTier, GroundServiceLine } from '@tailfin/shared';
import { realTimeAtGameTime, type WorldClock } from '@tailfin/sim';

import { createDatabase, type DatabaseHandle } from '../db/client';
import { airport, world } from '../db/schema';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixture,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';

import { listAirlineContracts, signContract } from './contracts';

import type { ResolvedPlayerAirline } from '../airline/context';

/**
 * `GET /api/ground/contracts` costs the same whatever an airline holds (BUG-07).
 *
 * The alert used to run one departure `count` per contract, sequentially: four
 * service lines across twenty stations meant eighty round trips on the endpoint
 * a client polls to badge its warnings.
 *
 * This measures the thing the fix is about rather than asserting it. Counting
 * statements on the pool is the only honest way to check "a bounded number of
 * queries" — a wall-clock assertion would measure this machine's neighbours,
 * which CLAUDE.md is explicit is not a criterion.
 *
 * Requires `DATABASE_URL`; CI provides it.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [ground/alert-query-count.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

function own(fixture: FoundedAirlineFixture): ResolvedPlayerAirline {
  return { id: fixture.airline.id, worldId: fixture.world.id, status: 'active' };
}

const LINES: GroundServiceLine[] = ['ramp_baggage', 'fuelling', 'catering', 'cleaning'];

describeDb('the cost of the ground alert endpoint', () => {
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

  async function makeAirport(icao: string, tier: AirportTier): Promise<string> {
    const n = seq++;
    const [created] = await db.db
      .insert(airport)
      .values({
        sourceId: -(9_990_000 + n),
        ident: `COUNT-${icao}`,
        icaoCode: icao,
        name: `Alert Count ${icao}`,
        isoCountry: 'NL',
        continent: 'EU',
        kind: 'large_airport',
        latitude: 52 + n * 0.01,
        longitude: 4 + n * 0.01,
        scheduledService: true,
        hasRunwayData: false,
        tier,
        elevationFt: 0,
      })
      .returning({ id: airport.id });
    if (!created) throw new Error(`no airport ${icao}`);
    madeAirports.push(created.id);
    return icao;
  }

  async function clockOf(worldId: string): Promise<WorldClock> {
    const [row] = await db.db
      .select({
        epoch: world.epoch,
        launchDate: world.launchDate,
        speedMultiplier: world.speedMultiplier,
      })
      .from(world)
      .where(eq(world.id, worldId))
      .limit(1);
    if (!row) throw new Error('no world');
    return { ...row, speedMultiplier: Number(row.speedMultiplier) };
  }

  /** Statements the pool issued while `run` was in flight. */
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

  it('does not grow with the number of contracts an airline holds', async () => {
    const a = await fixtures.create();
    const one = await makeAirport('CQA1', 'flagship');
    await signContract(db.db, own(a), one, { serviceLine: 'ramp_baggage', grade: 'standard' });

    /*
     * Halfway through the term. It has to be: `shortfall` skips the departure
     * count entirely while the pro-rated commitment still rounds to zero, so a
     * list taken the moment the contracts are signed issues no per-contract
     * queries even on the code this fixes — and would pass either way.
     */
    const clock = await clockOf(a.world.id);
    const midTerm = realTimeAtGameTime(clock, new Date(clock.epoch.getTime() + 45 * 86_400_000));

    const withOne = await countQueries(() => listAirlineContracts(db.db, own(a), midTerm));

    // Five more stations, four lines each: twenty-one contracts in total.
    for (const label of ['CQA2', 'CQA3', 'CQA4', 'CQA5', 'CQA6']) {
      const icao = await makeAirport(label, 'flagship');
      for (const serviceLine of LINES) {
        await signContract(db.db, own(a), icao, { serviceLine, grade: 'standard' });
      }
    }

    const listed = await listAirlineContracts(db.db, own(a), midTerm);
    expect(listed.contracts).toHaveLength(21);
    const alerts = listed.contracts;

    const withTwentyOne = await countQueries(() => listAirlineContracts(db.db, own(a), midTerm));

    // Every contract is inside its term and owes a real count, so the old code
    // would have issued one query each.
    expect(alerts.every((c) => (c.departuresFlown ?? -1) >= 0)).toBe(true);

    // Identical, not merely sublinear: the departures are one query whether the
    // airline holds one contract or twenty-one.
    expect(withTwentyOne).toBe(withOne);
  });
});
