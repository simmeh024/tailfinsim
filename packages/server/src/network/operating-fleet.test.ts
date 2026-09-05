import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { acquireAircraft } from '../aircraft/acquisition';
import { seedAircraftCatalogue } from '../aircraft/catalogue';
import { moveAirlineCash } from '../airline/cash';
import { type ResolvedPlayerAirline } from '../airline/context';
import { createDatabase, type DatabaseHandle } from '../db/client';
import { airport, schedule, scheduleLeg } from '../db/schema';
import { createAirportIdentities } from '../test-fixtures/airport-codes';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixture,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';

import { loadOperatingBasis, seatsByCabin } from './operating-fleet';

/**
 * What the airline actually flies on a route (IMPROVE-02).
 *
 * Every fare floor and every projection used to be drawn against a fixed
 * 79-tonne, 174-seat narrowbody whatever the airline owned, so a player flying
 * ATRs read an A320's costs as their own on the one screen where fares are set.
 *
 * These are the tests that make the three cases real rather than described: one
 * type, several types, and none — with the last one still using the reference
 * and **saying so**, which is the part the issue is explicit about.
 *
 * Requires `DATABASE_URL` against a migrated database; CI provides both.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [network/operating-fleet.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

describeDb('the operating fleet on a route', () => {
  let db: DatabaseHandle;
  let fixtures: FoundedAirlineFixtureHarness;
  const identities = createAirportIdentities('network/operating-fleet');
  const madeAirports: string[] = [];

  beforeAll(async () => {
    db = createDatabase();
    fixtures = createFoundedAirlineFixtureHarness(db.db);
    await seedAircraftCatalogue(db.db);
  });

  afterEach(async () => {
    await fixtures.cleanup();
    for (const id of madeAirports.splice(0)) await db.db.delete(airport).where(eq(airport.id, id));
  });

  afterAll(async () => {
    await db.close();
  });

  async function makeAirport(): Promise<{ ident: string; icao: string }> {
    const identity = identities();
    const [created] = await db.db
      .insert(airport)
      .values({
        sourceId: identity.sourceId,
        ident: identity.ident,
        icaoCode: identity.icaoCode,
        name: `Operating fleet test ${identity.icaoCode}`,
        isoCountry: 'NL',
        kind: 'large_airport',
        latitude: 52,
        longitude: 4,
        scheduledService: true,
        hasRunwayData: false,
        tier: 'medium',
        slotLevel: 2,
      })
      .returning({ id: airport.id });
    if (!created) throw new Error('airport was not created');
    madeAirports.push(created.id);
    return { ident: identity.ident, icao: identity.icaoCode };
  }

  function own(fixture: FoundedAirlineFixture): ResolvedPlayerAirline {
    return { id: fixture.airline.id, worldId: fixture.world.id, status: 'active' };
  }

  async function acquire(
    fixture: FoundedAirlineFixture,
    typeDesignation: string,
    deliveryAirportIcao: string,
  ): Promise<string> {
    const acquired = await acquireAircraft(
      db.db,
      own(fixture),
      { requestId: randomUUID(), kind: 'lease', typeDesignation, deliveryAirportIcao },
      fixture.world.launchDate,
    );
    if (!acquired.ok || acquired.airframe === null) {
      throw new Error(`acquisition refused: ${acquired.ok ? 'no airframe' : acquired.kind}`);
    }
    return acquired.airframe.id;
  }

  /**
   * A rotation over one pair, written directly.
   *
   * `createSchedule` is the authoring path and does far more than this needs —
   * route opening, reachability, crew warnings — and `authoring.test.ts` owns
   * all of it. What is under test here is the *read*, so the rows it reads are
   * written plainly, which also lets a paused rotation and a wrong-direction leg
   * be posed in one line each.
   */
  async function rotate(
    fixture: FoundedAirlineFixture,
    airframeId: string,
    legs: readonly { originIcao: string; destinationIcao: string }[],
    options: { active?: boolean } = {},
  ): Promise<string> {
    const [created] = await db.db
      .insert(schedule)
      .values({
        worldId: fixture.world.id,
        airlineId: fixture.airline.id,
        airframeId,
        repeatKind: 'daily',
        active: options.active ?? true,
      })
      .returning({ id: schedule.id });
    if (!created) throw new Error('schedule was not created');

    for (const [index, leg] of legs.entries()) {
      await db.db.insert(scheduleLeg).values({
        scheduleId: created.id,
        legIndex: index,
        originIcao: leg.originIcao,
        destinationIcao: leg.destinationIcao,
        departureMinute: 480 + index * 180,
        blockMinutes: 105,
        turnaroundMinutes: 45,
      });
    }
    return created.id;
  }

  async function topUp(fixture: FoundedAirlineFixture): Promise<void> {
    await db.db.transaction((tx) =>
      moveAirlineCash(tx, {
        airlineId: fixture.airline.id,
        amountMinor: 1_000_000_000,
        cause: 'admin_adjustment',
        reference: `operating-fleet-topup-${randomUUID()}`,
        occurredAt: fixture.world.epoch,
      }),
    );
  }

  it('says a route nobody flies is unassigned', async () => {
    /*
     * The case the issue is most pointed about: a reference aircraft must not be
     * presented as the player's. It is still *used* — a player pricing a route
     * before assigning an aeroplane is asking a hypothetical, and refusing to
     * answer would be worse — but the basis says which case it is, and the
     * provider labels it.
     */
    const fixture = await fixtures.create();
    const from = await makeAirport();
    const to = await makeAirport();

    const basis = await loadOperatingBasis(db.db, {
      worldId: fixture.world.id,
      airlineId: fixture.airline.id,
      originIcao: from.icao,
      destinationIcao: to.icao,
    });

    expect(basis.kind).toBe('unassigned');
    expect(basis.types).toEqual([]);
    expect(basis.label).toMatch(/no aircraft scheduled/i);
  });

  it('names the one type that flies it', async () => {
    const from = await makeAirport();
    const fixture = await fixtures.create({ hubIdent: from.ident });
    const to = await makeAirport();
    const airframeId = await acquire(fixture, 'ATR 72-600', from.icao);
    await rotate(fixture, airframeId, [
      { originIcao: from.icao, destinationIcao: to.icao },
      { originIcao: to.icao, destinationIcao: from.icao },
    ]);

    const basis = await loadOperatingBasis(db.db, {
      worldId: fixture.world.id,
      airlineId: fixture.airline.id,
      originIcao: from.icao,
      destinationIcao: to.icao,
    });

    expect(basis.kind).toBe('single');
    expect(basis.label).toBe('ATR 72-600');
    expect(basis.types).toHaveLength(1);
    // The real aeroplane's numbers, from the catalogue through the same
    // derivation the settlement bills on.
    expect(basis.types[0]?.aircraft.cruiseSpeedKt).toBe(275);
    expect(basis.types[0]?.aircraft.maxTakeoffWeightT).toBe(23);
    expect(basis.types[0]?.aircraft.seatsByCabin.economy).toBeGreaterThan(0);
    // One leg in this direction, not two — the return is the other route.
    expect(basis.types[0]?.departures).toBe(1);
  });

  it('counts only the direction the route flies', async () => {
    // A rotation AMS→LEBL→AMS operates each route once. Counting both legs
    // against one route would double every frequency the market model sees.
    const from = await makeAirport();
    const fixture = await fixtures.create({ hubIdent: from.ident });
    const to = await makeAirport();
    const airframeId = await acquire(fixture, 'ATR 72-600', from.icao);
    await rotate(fixture, airframeId, [
      { originIcao: from.icao, destinationIcao: to.icao },
      { originIcao: to.icao, destinationIcao: from.icao },
      { originIcao: from.icao, destinationIcao: to.icao },
      { originIcao: to.icao, destinationIcao: from.icao },
    ]);

    const outbound = await loadOperatingBasis(db.db, {
      worldId: fixture.world.id,
      airlineId: fixture.airline.id,
      originIcao: from.icao,
      destinationIcao: to.icao,
    });
    expect(outbound.types[0]?.departures).toBe(2);
  });

  it('reports a mixed fleet as mixed, busiest type first', async () => {
    const from = await makeAirport();
    const fixture = await fixtures.create({ hubIdent: from.ident });
    await topUp(fixture);
    const to = await makeAirport();

    const turboprop = await acquire(fixture, 'ATR 72-600', from.icao);
    const narrowbody = await acquire(fixture, 'A320neo', from.icao);

    // The jet flies it twice a day, the turboprop once.
    await rotate(fixture, turboprop, [{ originIcao: from.icao, destinationIcao: to.icao }]);
    await rotate(fixture, narrowbody, [
      { originIcao: from.icao, destinationIcao: to.icao },
      { originIcao: to.icao, destinationIcao: from.icao },
      { originIcao: from.icao, destinationIcao: to.icao },
    ]);

    const basis = await loadOperatingBasis(db.db, {
      worldId: fixture.world.id,
      airlineId: fixture.airline.id,
      originIcao: from.icao,
      destinationIcao: to.icao,
    });

    expect(basis.kind).toBe('mixed');
    expect(basis.label).toMatch(/mixed fleet/i);
    // Busiest first, because the seats the projection uses come from `types[0]`
    // and it should be the aeroplane doing most of the flying.
    expect(basis.types.map((type) => type.typeDesignation)).toEqual(['A320neo', 'ATR 72-600']);
    expect(basis.types[0]?.departures).toBe(2);
    expect(basis.types[1]?.departures).toBe(1);
    // Both are on the wire, because the floor is drawn over all of them.
    expect(basis.types[0]?.aircraft.maxTakeoffWeightT).toBeGreaterThan(
      basis.types[1]!.aircraft.maxTakeoffWeightT,
    );
  });

  it('groups two tails of one type into one entry', async () => {
    // A floor quoted per tail would be the same number twice, and a pricing
    // screen listing every registration is a worse answer than one listing types.
    const from = await makeAirport();
    const fixture = await fixtures.create({ hubIdent: from.ident });
    await topUp(fixture);
    const to = await makeAirport();

    const first = await acquire(fixture, 'ATR 72-600', from.icao);
    const second = await acquire(fixture, 'ATR 72-600', from.icao);
    await rotate(fixture, first, [{ originIcao: from.icao, destinationIcao: to.icao }]);
    await rotate(fixture, second, [{ originIcao: from.icao, destinationIcao: to.icao }]);

    const basis = await loadOperatingBasis(db.db, {
      worldId: fixture.world.id,
      airlineId: fixture.airline.id,
      originIcao: from.icao,
      destinationIcao: to.icao,
    });

    expect(basis.kind).toBe('single');
    expect(basis.types).toHaveLength(1);
    // Both tails' departures, so the frequency is the fleet's rather than one
    // aeroplane's.
    expect(basis.types[0]?.departures).toBe(2);
  });

  it('ignores a paused rotation, which is not flying', async () => {
    // Basing an estimate on a paused schedule would quote for capacity the
    // airline is not offering.
    const from = await makeAirport();
    const fixture = await fixtures.create({ hubIdent: from.ident });
    const to = await makeAirport();
    const airframeId = await acquire(fixture, 'ATR 72-600', from.icao);
    await rotate(fixture, airframeId, [{ originIcao: from.icao, destinationIcao: to.icao }], {
      active: false,
    });

    const basis = await loadOperatingBasis(db.db, {
      worldId: fixture.world.id,
      airlineId: fixture.airline.id,
      originIcao: from.icao,
      destinationIcao: to.icao,
    });
    expect(basis.kind).toBe('unassigned');
  });

  it('does not read another airline’s rotations', async () => {
    // The route belongs to an airline, so the fleet flying it does too. Reading
    // a rival's schedule here would quote a player their competitor's costs.
    const from = await makeAirport();
    const mine = await fixtures.create({ hubIdent: from.ident });
    const theirs = await fixtures.create({
      worldId: mine.world.id,
      hubIdent: from.ident,
    });
    const to = await makeAirport();

    const airframeId = await acquire(theirs, 'ATR 72-600', from.icao);
    await rotate(theirs, airframeId, [{ originIcao: from.icao, destinationIcao: to.icao }]);

    expect(
      await loadOperatingBasis(db.db, {
        worldId: mine.world.id,
        airlineId: mine.airline.id,
        originIcao: from.icao,
        destinationIcao: to.icao,
      }),
    ).toMatchObject({ kind: 'unassigned' });

    expect(
      await loadOperatingBasis(db.db, {
        worldId: theirs.world.id,
        airlineId: theirs.airline.id,
        originIcao: from.icao,
        destinationIcao: to.icao,
      }),
    ).toMatchObject({ kind: 'single' });
  });
});

describe('seatsByCabin', () => {
  it('splits a two-class layout the way the reference aircraft did', () => {
    // 12 of 174 was `REFERENCE_AIRFRAME`'s split, kept exactly so that moving
    // to a real aeroplane changes the aeroplane and not, silently, the cabin
    // mix as well.
    expect(seatsByCabin(174)).toEqual({ business: 12, economy: 162 });
  });

  it('scales with the aeroplane', () => {
    const atr = seatsByCabin(70);
    const neo = seatsByCabin(165);
    expect((atr.economy ?? 0) + (atr.business ?? 0)).toBe(70);
    expect((neo.economy ?? 0) + (neo.business ?? 0)).toBe(165);
    expect(neo.business ?? 0).toBeGreaterThan(atr.business ?? 0);
  });

  it('gives a small aeroplane no business cabin rather than a fractional one', () => {
    // `selfAsOperator` sells only the cabins with seats in them, so an empty
    // business cabin is a real answer. At 7%, that is anything under eight
    // seats — a commuter type, not a mistake.
    expect(seatsByCabin(5)).toEqual({ economy: 5 });
    expect(seatsByCabin(0)).toEqual({});
    // Ten seats does round to one business seat, and the split still sums.
    expect(seatsByCabin(10)).toEqual({ business: 1, economy: 9 });
  });
});
