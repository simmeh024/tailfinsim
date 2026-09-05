import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type DatabaseHandle } from '../db/client';
import { airport, flight, flightResult, world } from '../db/schema';
import { loadWorldFuelContext, marketAt, stationFor } from '../economy/fuel';
import { loadWorldEconomyConfig } from '../economy/loader';
import { createAirportIdentities } from '../test-fixtures/airport-codes';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';

import { settleArrivedFlight } from './settle';

/**
 * A serial rather than a draw: `airport` has three unique columns and random
 * codes collide (BUG-11). The namespace keeps this suite clear of every
 * other one, which matters because vitest runs them together.
 */
const nextAirport = createAirportIdentities('flight/settle-fuel');

/**
 * Per-station fuel pricing, where it becomes money (M5-07, §9.3, §11).
 *
 * The model is proven in `@tailfin/sim`. What only a database can settle is the
 * issue's own task — *"flight cost uses the origin station's price"* — and its
 * first acceptance criterion, *"fuel cost differs measurably between stations on
 * the same route"*. Before M5-07 every airport in the world was charged
 * `fuel.defaultStation`, so the two flights below cost the same to the cent and
 * the criterion was unmeetable by construction.
 *
 * ## Vary one thing
 *
 * A station's price carries a ±4% spread drawn from its ICAO code, and that is
 * larger than the tier's effect on the into-plane fee — the fee is ~3% of the
 * all-in price, so a factor of two on it moves the bill by less than the spread
 * does. So a test comparing two *different* airports can only prove the effects
 * that beat the spread, which is the region (0.78 against 1.22) and nothing else.
 * Everything narrower is proven by mutating **one** airport and settling again:
 * same code, same spread, one column different.
 *
 * Requires `DATABASE_URL` against a migrated database; CI provides both.
 */

const url = process.env.DATABASE_URL;
if (!url) {
  console.warn(
    '\n  [flight/settle-fuel.test] DATABASE_URL not set — skipping fuel station tests.\n',
  );
}
const describeDb = url ? describe : describe.skip;

const DEPARTS = new Date('2026-08-17T06:00:00.000Z');
const BLOCK_MS = 75 * 60_000;

/** A 70-seat cabin at 47 passengers — §13.4's airline, near enough. */
const LOAD = JSON.stringify({ economy: { seats: 70, passengers: 47, revenue: 47 * 7_500 } });

type Tier = 'flagship' | 'large' | 'medium' | 'small' | 'regional';

interface Place {
  continent: string | null;
  isoCountry: string;
  tier: Tier | null;
}

interface CostLine {
  source: string;
  amountMinor: number;
  detail: string;
}

interface Settled {
  fuel: CostLine;
  costMinor: number;
}

describeDb('what a flight pays for its fuel', () => {
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

  /**
   * An airport with a real geography, so the region model has something to read.
   *
   * The coordinates are the sector; the continent, country and tier are the fuel
   * price. Every sector below is the same 200 nm, so the burn is identical and
   * the only thing that can move the fuel bill is the station.
   */
  async function makeAirport(
    place: Place,
    at: { latitude: number; longitude: number },
  ): Promise<string> {
    const identity = nextAirport();
    const icao = identity.icaoCode;
    await db.db.insert(airport).values({
      sourceId: identity.sourceId,
      ident: identity.ident,
      icaoCode: icao,
      name: `Test Field ${icao}`,
      isoCountry: place.isoCountry,
      continent: place.continent,
      tier: place.tier,
      kind: 'large_airport',
      latitude: at.latitude,
      longitude: at.longitude,
      scheduledService: true,
      hasRunwayData: false,
    });
    madeAirports.push(icao);
    return icao;
  }

  /** Amsterdam's position, for every origin. */
  const ORIGIN_AT = { latitude: 52.3086, longitude: 4.76389 };
  /** London's, for every destination — a real 200 nm sector. */
  const DEST_AT = { latitude: 51.4706, longitude: -0.461941 };

  /** A European large field, so a destination never explains a difference. */
  const EUROPEAN_DEST: Place = { continent: 'EU', isoCountry: 'GB', tier: 'large' };

  /** Fly one 200 nm sector out of an existing station and read its fuel line. */
  async function settleFrom(
    originIcao: string,
    options: { worldId?: string; departsAt?: Date; arrivesAt?: Date } = {},
  ): Promise<Settled> {
    const created = await fixtures.create(
      options.worldId === undefined ? {} : { worldId: options.worldId },
    );
    const destIcao = await makeAirport(EUROPEAN_DEST, DEST_AT);

    const departs = options.departsAt ?? DEPARTS;
    const arrives = options.arrivesAt ?? new Date(departs.getTime() + BLOCK_MS);
    const [f] = await db.db
      .insert(flight)
      .values({
        worldId: created.world.id,
        airlineId: created.airline.id,
        airframeId: randomUUID(),
        originIcao,
        destinationIcao: destIcao,
        scheduledDeparture: departs,
        estimatedArrival: arrives,
        load: LOAD,
      })
      .returning({ id: flight.id });
    if (!f) throw new Error('no flight');

    const outcome = await db.db.transaction((tx) => settleArrivedFlight(tx, f.id, arrives));
    expect(outcome.status).toBe('settled');

    const [row] = await db.db.select().from(flightResult).where(eq(flightResult.flightId, f.id));
    if (!row) throw new Error('no result');

    const breakdown = JSON.parse(row.breakdown) as { costs: CostLine[] };
    const fuel = breakdown.costs.find((c) => c.source === 'fuel');
    if (!fuel) throw new Error('no fuel line');

    return { fuel, costMinor: row.costMinor };
  }

  it('differs measurably between two stations on the same sector', async () => {
    // M5-07's first acceptance criterion, in the only place a player meets it:
    // the fuel line of a settled flight. Same distance, same airframe, same
    // load, **same world** — and a bill a fifth apart even against the spread.
    //
    // One world matters: the curve level is a property of the world's seed, so
    // two fixture worlds would have put the two flights at two different points
    // on it, and a ±24% curve swing can outweigh a 56% regional gap. Vary one
    // thing.
    const shared = await fixtures.create();
    const gulf = await settleFrom(
      await makeAirport({ continent: 'AS', isoCountry: 'AE', tier: 'flagship' }, ORIGIN_AT),
      { worldId: shared.world.id },
    );
    const africa = await settleFrom(
      await makeAirport({ continent: 'AF', isoCountry: 'KE', tier: 'large' }, ORIGIN_AT),
      { worldId: shared.world.id },
    );

    expect(gulf.fuel.amountMinor).toBeLessThan(africa.fuel.amountMinor * 0.8);
    // And the difference reached the total, rather than being reported in the
    // breakdown and then billed at some other number.
    expect(gulf.costMinor).toBeLessThan(africa.costMinor);
  });

  it('names the price it was billed at, so the line can be explained later', async () => {
    // Invariant 4. After the economy is retuned, this string is the only thing
    // that can say why a flight in October paid what it did.
    const originIcao = await makeAirport(
      { continent: 'EU', isoCountry: 'NL', tier: 'large' },
      ORIGIN_AT,
    );
    const { fuel } = await settleFrom(originIcao);
    expect(fuel.detail).toContain(originIcao);
    expect(fuel.detail).toMatch(/a tonne/);
  });

  it('buys the fuel at the origin, not at the airport it lands at', async () => {
    // Both destinations are European large fields, so if the destination were
    // being priced these two would differ only by the destination's spread. One
    // world, for the reason the test above gives.
    const shared = await fixtures.create();
    const fromGulf = await settleFrom(
      await makeAirport({ continent: 'AS', isoCountry: 'AE', tier: 'flagship' }, ORIGIN_AT),
      { worldId: shared.world.id },
    );
    const fromAfrica = await settleFrom(
      await makeAirport({ continent: 'AF', isoCountry: 'KE', tier: 'flagship' }, ORIGIN_AT),
      { worldId: shared.world.id },
    );
    expect(fromGulf.fuel.amountMinor).toBeLessThan(fromAfrica.fuel.amountMinor * 0.8);
  });

  it('charges more to uplift at a regional strip than at the same field as a flagship', async () => {
    // One airport in one world, two tiers — so the spread and the curve level are
    // both identical and the into-plane fee is the only thing that can have
    // moved. A trucked-in bowser against a hydrant under the stand.
    const shared = await fixtures.create();
    const originIcao = await makeAirport(
      { continent: 'EU', isoCountry: 'NL', tier: 'flagship' },
      ORIGIN_AT,
    );
    const flagship = await settleFrom(originIcao, { worldId: shared.world.id });

    await db.db.update(airport).set({ tier: 'regional' }).where(eq(airport.icaoCode, originIcao));
    const regional = await settleFrom(originIcao, { worldId: shared.world.id });

    expect(regional.fuel.amountMinor).toBeGreaterThan(flagship.fuel.amountMinor);
  });

  it('prices an origin with no geography at the world default rather than failing', async () => {
    const { fuel } = await settleFrom(
      await makeAirport({ continent: null, isoCountry: 'ZZ', tier: null }, ORIGIN_AT),
    );
    expect(fuel.amountMinor).toBeGreaterThan(0);
  });

  it('reads the curve at the departure, so the arrival cannot change the bill', async () => {
    // Same station, same world, same departure — settled at two arrivals a game
    // year apart. The fuel was bought before the aeroplane left, so the bill is
    // identical. If the arrival were being priced these would differ by most of
    // a commodity cycle.
    const shared = await fixtures.create();
    const originIcao = await makeAirport(
      { continent: 'EU', isoCountry: 'NL', tier: 'large' },
      ORIGIN_AT,
    );

    const promptly = await settleFrom(originIcao, {
      worldId: shared.world.id,
      departsAt: DEPARTS,
      arrivesAt: new Date(DEPARTS.getTime() + BLOCK_MS),
    });
    const eventually = await settleFrom(originIcao, {
      worldId: shared.world.id,
      departsAt: DEPARTS,
      arrivesAt: new Date('2027-08-17T07:15:00.000Z'),
    });

    expect(eventually.fuel.amountMinor).toBe(promptly.fuel.amountMinor);
  });

  it('moves the bill when the departure moves along the curve', async () => {
    // The other half: §11's "fuel price fluctuates on a world curve", billed.
    // Same station, same world, departures a game year apart.
    const shared = await fixtures.create();
    const originIcao = await makeAirport(
      { continent: 'EU', isoCountry: 'NL', tier: 'large' },
      ORIGIN_AT,
    );

    const early = await settleFrom(originIcao, {
      worldId: shared.world.id,
      departsAt: DEPARTS,
    });
    const later = await settleFrom(originIcao, {
      worldId: shared.world.id,
      departsAt: new Date('2027-08-17T06:00:00.000Z'),
    });

    expect(later.fuel.amountMinor).not.toBe(early.fuel.amountMinor);

    // And it moved the way the world's own curve says it should have.
    const ctx = await loadWorldFuelContext(db.db, shared.world.id);
    expect(ctx).not.toBeNull();
    if (!ctx) return;
    const economy = await loadWorldEconomyConfig(db.db, shared.world.id);
    const earlyLevel = marketAt(ctx, DEPARTS, economy).basePricePerTonne;
    const laterLevel = marketAt(
      ctx,
      new Date('2027-08-17T06:00:00.000Z'),
      economy,
    ).basePricePerTonne;
    expect(later.fuel.amountMinor > early.fuel.amountMinor).toBe(laterLevel > earlyLevel);
  });

  it('gives the same station the same price every time it is asked', async () => {
    // A price that moved between two reads would make a fare floor a lie and a
    // replay impossible. The spread is drawn from the world seed and the ICAO
    // code and from nothing else.
    const created = await fixtures.create();
    const ctx = await loadWorldFuelContext(db.db, created.world.id);
    expect(ctx).not.toBeNull();
    if (!ctx) return;
    const economy = await loadWorldEconomyConfig(db.db, created.world.id);
    const row = { icao: 'EHAM', continent: 'EU', isoCountry: 'NL', tier: 'large' as const };
    expect(stationFor('EHAM', row, ctx, economy)).toEqual(stationFor('EHAM', row, ctx, economy));
  });

  it('reads the seed and epoch of the world it was asked about', async () => {
    const created = await fixtures.create();
    const [row] = await db.db
      .select({ seed: world.seed, epoch: world.epoch })
      .from(world)
      .where(eq(world.id, created.world.id));
    const ctx = await loadWorldFuelContext(db.db, created.world.id);
    expect(ctx?.seed).toBe(row?.seed);
    expect(ctx?.epoch).toEqual(row?.epoch);
    // A numeric column comes back from the driver as a string — the trap
    // CLAUDE.md records — so the multiplier must already be a number here.
    expect(typeof ctx?.speedMultiplier).toBe('number');
  });

  it('answers null for a world that is not there', async () => {
    expect(await loadWorldFuelContext(db.db, randomUUID())).toBeNull();
  });
});
