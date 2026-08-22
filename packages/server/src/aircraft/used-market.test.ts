import { randomInt, randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { UsedMarketResponse } from '@tailfin/shared';

import { moveAirlineCash } from '../airline/cash';
import { type ResolvedPlayerAirline } from '../airline/context';
import { createDatabase, type DatabaseHandle } from '../db/client';
import { airframe, airport, usedAircraftListing, type WorldRow } from '../db/schema';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixture,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';

import { acquireAircraft } from './acquisition';
import { seedAircraftCatalogue } from './catalogue';
import { listUsedMarket, refreshUsedAircraftMarket } from './used-market';

/**
 * M4-05 against real Postgres.
 *
 * The valuation is proved without a database in
 * `packages/sim/src/aircraft/used-market.test.ts`. What needs Postgres is the
 * part that only Postgres can promise, and it is the issue's second acceptance
 * criterion: **inventory does not become infinite or exhausted.**
 *
 *   - not infinite, because a berth holds one aircraft and there are `slots`;
 *   - not exhausted, because generations keep arriving and refilling berths;
 *   - and idempotent under an engine that calls the refresh every second, which
 *     is a unique constraint doing the work rather than a lock or a memory.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [used-market.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

const DAY_MS = 86_400_000;

describeDb('the used aircraft market', () => {
  let db: DatabaseHandle;
  let fixtures: FoundedAirlineFixtureHarness;
  const madeAirports: string[] = [];

  beforeAll(async () => {
    db = createDatabase();
    fixtures = createFoundedAirlineFixtureHarness(db.db);
    await seedAircraftCatalogue(db.db);
    // The generator needs somewhere to park an aeroplane, and it only draws from
    // tiered airports with scheduled service.
    for (let i = 0; i < 3; i += 1) await makeMarketAirport();
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

  async function makeMarketAirport(): Promise<string> {
    const tag = Array.from({ length: 3 }, () => String.fromCharCode(randomInt(65, 91))).join('');
    const icao = `U${tag}`;
    const [created] = await db.db
      .insert(airport)
      .values({
        sourceId: randomInt(-2_147_483_648, 0),
        ident: icao,
        icaoCode: icao,
        name: `Used market test ${tag}`,
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
    if (!created) throw new Error('Market airport was not created');
    madeAirports.push(created.id);
    return icao;
  }

  /**
   * The real-time instant at which this world's game clock reads
   * `epoch + days`.
   *
   * `gameTime = epoch + speed × (now − launchDate)`, inverted. Written out
   * because the market's cadence is in **game** days while the caller passes a
   * wall-clock instant, and getting that backwards would make every timing
   * assertion below meaningless in a way that still passed.
   */
  function atGameDay(world: WorldRow, days: number): Date {
    const speed = Number(world.speedMultiplier);
    return new Date(world.launchDate.getTime() + (days * DAY_MS) / speed);
  }

  function own(fixture: FoundedAirlineFixture): ResolvedPlayerAirline {
    return { id: fixture.airline.id, worldId: fixture.world.id, status: 'active' };
  }

  async function available(worldId: string) {
    return db.db
      .select()
      .from(usedAircraftListing)
      .where(
        and(eq(usedAircraftListing.worldId, worldId), eq(usedAircraftListing.status, 'available')),
      );
  }

  it('fills every berth once, and never more than the ceiling', async () => {
    const fixture = await fixtures.create();
    const first = await refreshUsedAircraftMarket(
      db.db,
      fixture.world.id,
      atGameDay(fixture.world, 0),
    );

    expect(first.refreshed).toBe(true);
    expect(first.generation).toBe(0);
    expect(first.created).toBeGreaterThan(0);

    const listings = await available(fixture.world.id);
    const market = await listUsedMarket(db.db, fixture.world.id);
    expect(listings).toHaveLength(market.slots);
    expect(first.created).toBe(market.slots);

    // Every berth is occupied exactly once.
    const slots = listings.map((row) => row.slotIndex).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(slots).toEqual(Array.from({ length: market.slots }, (_unused, i) => i));
  });

  /**
   * The engine calls this every tick — tens of thousands of times per game week.
   * It has to do nothing on all but the first, and it must not rely on the
   * caller remembering that.
   */
  it('does nothing on the second call in the same generation, or the hundredth', async () => {
    const fixture = await fixtures.create();
    const at = atGameDay(fixture.world, 0);
    const first = await refreshUsedAircraftMarket(db.db, fixture.world.id, at);
    expect(first.created).toBeGreaterThan(0);

    for (let i = 0; i < 5; i += 1) {
      const again = await refreshUsedAircraftMarket(db.db, fixture.world.id, at);
      expect(again.created, `call ${String(i + 2)}`).toBe(0);
      expect(again.withdrawn).toBe(0);
      expect(again.refreshed).toBe(true);
    }

    const market = await listUsedMarket(db.db, fixture.world.id);
    expect(market.listings).toHaveLength(market.slots);
  });

  /**
   * Two workers can run this concurrently during a rolling handover. The unique
   * constraint is what makes that safe, so it is asserted rather than assumed.
   */
  it('creates one aircraft per berth even when two refreshes race', async () => {
    const fixture = await fixtures.create();
    const at = atGameDay(fixture.world, 0);

    const [a, b] = await Promise.all([
      refreshUsedAircraftMarket(db.db, fixture.world.id, at),
      refreshUsedAircraftMarket(db.db, fixture.world.id, at),
    ]);

    const market = await listUsedMarket(db.db, fixture.world.id);
    expect(a.created + b.created).toBe(market.slots);
    expect(market.listings).toHaveLength(market.slots);
  });

  it('leaves a sold berth empty until the next generation, then refills it', async () => {
    const fixture = await fixtures.create();
    await refreshUsedAircraftMarket(db.db, fixture.world.id, atGameDay(fixture.world, 0));

    const before = await available(fixture.world.id);
    const target = before.reduce((cheapest, row) =>
      row.askingPriceMinor < cheapest.askingPriceMinor ? row : cheapest,
    );

    // Enough cash for whatever the market's cheapest aeroplane costs.
    await db.db.transaction((tx) =>
      moveAirlineCash(tx, {
        airlineId: fixture.airline.id,
        amountMinor: target.askingPriceMinor,
        cause: 'flight_settlement',
        reference: `used-market-test-${randomUUID()}`,
        occurredAt: fixture.world.epoch,
      }),
    );

    const bought = await acquireAircraft(
      db.db,
      own(fixture),
      { requestId: randomUUID(), kind: 'used', listingId: target.id },
      atGameDay(fixture.world, 1),
    );
    expect(bought.ok).toBe(true);

    // Same generation: the berth stays empty, because its row already exists.
    const sameGeneration = await refreshUsedAircraftMarket(
      db.db,
      fixture.world.id,
      atGameDay(fixture.world, 1),
    );
    expect(sameGeneration.created).toBe(0);
    const afterSale = await available(fixture.world.id);
    expect(afterSale).toHaveLength(before.length - 1);
    expect(afterSale.map((r) => r.slotIndex)).not.toContain(target.slotIndex);

    // Next generation: the berth is refilled. This is "not exhausted".
    const refreshInterval = 7;
    const next = await refreshUsedAircraftMarket(
      db.db,
      fixture.world.id,
      atGameDay(fixture.world, refreshInterval),
    );
    expect(next.generation).toBe(1);
    expect(next.created).toBe(1);

    const refilled = await available(fixture.world.id);
    expect(refilled).toHaveLength(before.length);
    expect(refilled.map((r) => r.slotIndex)).toContain(target.slotIndex);
  });

  it('withdraws a listing that has been on the market too long, and refills its berth', async () => {
    const fixture = await fixtures.create();
    await refreshUsedAircraftMarket(db.db, fixture.world.id, atGameDay(fixture.world, 0));
    const before = await available(fixture.world.id);
    expect(before.length).toBeGreaterThan(0);

    // Past the longest lifetime any listing can have: base 21 game days plus the
    // full unusual linger of 28.
    const wellPastExpiry = atGameDay(fixture.world, 21 + 28 + 7);
    const swept = await refreshUsedAircraftMarket(db.db, fixture.world.id, wellPastExpiry);

    expect(swept.withdrawn).toBe(before.length);
    // Every berth freed by the sweep is refilled in the same call, so the market
    // is never briefly empty.
    expect(swept.created).toBe(before.length);

    const after = await available(fixture.world.id);
    expect(after).toHaveLength(before.length);
    const carriedOver = new Set(before.map((r) => r.id));
    expect(after.every((r) => !carriedOver.has(r.id))).toBe(true);
  });

  it('offers nothing before the world has launched', async () => {
    const fixture = await fixtures.create();
    const beforeLaunch = new Date(fixture.world.launchDate.getTime() - 5 * DAY_MS);
    const result = await refreshUsedAircraftMarket(db.db, fixture.world.id, beforeLaunch);

    expect(result.refreshed).toBe(false);
    expect(result.generation).toBe(-1);
    expect(result.created).toBe(0);
    expect(await available(fixture.world.id)).toHaveLength(0);
  });

  it('does nothing at all for a world that does not exist', async () => {
    const result = await refreshUsedAircraftMarket(db.db, randomUUID(), new Date());
    expect(result).toMatchObject({ created: 0, withdrawn: 0, refreshed: false });
  });

  describe('what the market tells a player', () => {
    it('returns a price that is exactly the product of the factors it shows', async () => {
      const fixture = await fixtures.create();
      await refreshUsedAircraftMarket(db.db, fixture.world.id, atGameDay(fixture.world, 0));

      const market = await listUsedMarket(db.db, fixture.world.id);
      expect(UsedMarketResponse.safeParse(market).success).toBe(true);
      expect(market.listings.length).toBeGreaterThan(0);

      for (const listing of market.listings) {
        const v = listing.valuation;
        const recomputed = Math.round(
          v.anchorMinor * v.ageFactor * v.utilisationFactor * v.configurationFactor,
        );
        expect(recomputed, `${listing.typeDesignation} ${listing.registration}`).toBe(
          listing.askingPriceMinor,
        );
        // Each option fitted has its own line, so the discount is attributable.
        expect(v.configurationDrags).toHaveLength(listing.buildOptionIds.length);
        expect(listing.builtAt < listing.availableAt).toBe(true);
      }
    });

    it('shows an unusual airframe as unusual, and a plain one as plain', async () => {
      const fixture = await fixtures.create();
      await refreshUsedAircraftMarket(db.db, fixture.world.id, atGameDay(fixture.world, 0));
      const market = await listUsedMarket(db.db, fixture.world.id);

      for (const listing of market.listings) {
        if (listing.buildOptionIds.length === 0) {
          expect(listing.valuation.unusualness, listing.registration).toBe(0);
          expect(listing.valuation.configurationFactor).toBe(1);
        }
      }
      // A generated market of 24 should contain at least one standard airframe,
      // or "unusual" has nothing to be unusual against.
      expect(market.listings.some((l) => l.buildOptionIds.length === 0)).toBe(true);
    });

    it('sorts cheapest first, so the market opens on what a new airline can afford', async () => {
      const fixture = await fixtures.create();
      await refreshUsedAircraftMarket(db.db, fixture.world.id, atGameDay(fixture.world, 0));
      const prices = (await listUsedMarket(db.db, fixture.world.id)).listings.map(
        (l) => l.askingPriceMinor,
      );
      expect([...prices].sort((a, b) => a - b)).toEqual(prices);
    });
  });

  /**
   * M4-04's third acceptance criterion, extended by the fact M4-05 adds.
   *
   * A used airframe already arrived with its previous owner's configuration; it
   * now also arrives with its age. An aeroplane that was twelve years old in the
   * listing and brand new the moment it was bought would be the most visible
   * possible way to break "buying someone else's decisions".
   */
  it('carries a bought aircraft’s build date onto the airframe', async () => {
    const fixture = await fixtures.create();
    await refreshUsedAircraftMarket(db.db, fixture.world.id, atGameDay(fixture.world, 0));

    const listings = await available(fixture.world.id);
    const target = listings.reduce((cheapest, row) =>
      row.askingPriceMinor < cheapest.askingPriceMinor ? row : cheapest,
    );
    expect(target.builtAt).not.toBeNull();

    await db.db.transaction((tx) =>
      moveAirlineCash(tx, {
        airlineId: fixture.airline.id,
        amountMinor: target.askingPriceMinor,
        cause: 'flight_settlement',
        reference: `used-market-age-${randomUUID()}`,
        occurredAt: fixture.world.epoch,
      }),
    );

    const bought = await acquireAircraft(
      db.db,
      own(fixture),
      { requestId: randomUUID(), kind: 'used', listingId: target.id },
      atGameDay(fixture.world, 1),
    );
    expect(bought.ok).toBe(true);
    if (!bought.ok || bought.airframe === null) return;

    const [frame] = await db.db
      .select({ builtAt: airframe.builtAt, hours: airframe.hours, cycles: airframe.cycles })
      .from(airframe)
      .where(eq(airframe.id, bought.airframe.id));

    expect(frame?.builtAt?.getTime()).toBe(target.builtAt?.getTime());
    expect(frame?.hours).toBe(target.hours);
    expect(frame?.cycles).toBe(target.cycles);
  });
});
