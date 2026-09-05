import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { acquireAircraft, deliverDueAircraftOrders } from '../aircraft/acquisition';
import { seedAircraftCatalogue } from '../aircraft/catalogue';
import { loadFlightAirframe, UnknownAirframeError } from '../aircraft/performance';
import { moveAirlineCash } from '../airline/cash';
import { type ResolvedPlayerAirline } from '../airline/context';
import { createDatabase, type DatabaseHandle } from '../db/client';
import { airframe, airport, flight, flightResult } from '../db/schema';
import { createAirportIdentities } from '../test-fixtures/airport-codes';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixture,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';

import { createFlightArriveHandler } from './settle';

/**
 * Settling against the aeroplane that actually flew (IMPROVE-02).
 *
 * Every flight in the game used to be costed as a 23-tonne turboprop, whatever
 * it was. A player who leased a 777 was billed an ATR's fuel and an ATR's
 * landing fee, so the one decision the fleet page exists to support did not
 * reach their balance sheet at all.
 *
 * This suite is the one that proves otherwise, and it deliberately does so
 * through the **production** path: `createFlightArriveHandler()` with no
 * arguments, which is exactly what `engine/handlers.ts` registers. Every other
 * settlement suite substitutes a fixture aeroplane on the line, because their
 * subject is the money rather than the fleet — so if the resolver were wrong,
 * this is the only file that would notice.
 *
 * The aircraft are acquired through `acquireAircraft` and, for the option
 * variant, delivered by `deliverDueAircraftOrders` — the same two functions the
 * API and the worker call. Hand-inserting an `airframe` row would have been
 * shorter and would have proved nothing about whether a real fleet resolves.
 *
 * Requires `DATABASE_URL` against a migrated database; CI provides both.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [flight/settle-aircraft.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

/** Game-time instants, on the flagship world's calendar. */
const DEPARTS = new Date('2024-11-03T08:00:00.000Z');
const ARRIVES = new Date('2024-11-03T10:00:00.000Z');

/**
 * A full aeroplane, so the revenue side is identical between the two types.
 *
 * The comparison below has to be about **cost**. Seats and passengers come from
 * `flight.load`, which the departure writes and the settlement only reads, so
 * pinning the same load on both flights is what isolates the aircraft.
 */
const LOAD = JSON.stringify({
  economy: { seats: 70, passengers: 70, revenue: 7_000_000 },
});

describeDb('settling against the aircraft that actually flew', () => {
  let db: DatabaseHandle;
  let fixtures: FoundedAirlineFixtureHarness;
  const identities = createAirportIdentities('flight/settle-aircraft');
  const madeAirports: string[] = [];

  beforeAll(async () => {
    db = createDatabase();
    fixtures = createFoundedAirlineFixtureHarness(db.db);
    // The world the fixture founds pins catalogue `v1`; without the seed there
    // is no type to acquire and every acquisition below refuses.
    await seedAircraftCatalogue(db.db);
  });

  afterEach(async () => {
    await fixtures.cleanup();
    for (const id of madeAirports.splice(0)) {
      await db.db.delete(airport).where(eq(airport.id, id));
    }
  });

  afterAll(async () => {
    await db.close();
  });

  async function makeAirport(latitude: number, longitude: number): Promise<string> {
    const identity = identities();
    const [created] = await db.db
      .insert(airport)
      .values({
        sourceId: identity.sourceId,
        ident: identity.ident,
        icaoCode: identity.icaoCode,
        name: `Settlement aircraft test ${identity.icaoCode}`,
        isoCountry: 'NL',
        kind: 'large_airport',
        latitude,
        longitude,
        scheduledService: true,
        hasRunwayData: false,
        tier: 'medium',
        slotLevel: 2,
      })
      .returning({ id: airport.id });
    if (!created) throw new Error('airport was not created');
    madeAirports.push(created.id);
    return identity.icaoCode;
  }

  function own(fixture: FoundedAirlineFixture): ResolvedPlayerAirline {
    return { id: fixture.airline.id, worldId: fixture.world.id, status: 'active' };
  }

  /** The opening balance buys an ATR deposit and nothing bigger. */
  async function topUp(fixture: FoundedAirlineFixture, amountMinor: number): Promise<void> {
    await db.db.transaction((tx) =>
      moveAirlineCash(tx, {
        airlineId: fixture.airline.id,
        amountMinor,
        cause: 'admin_adjustment',
        reference: `settle-aircraft-topup-${randomUUID()}`,
        occurredAt: fixture.world.epoch,
      }),
    );
  }

  /**
   * Acquire an aeroplane the way the API does, and hand back its id.
   *
   * A lease for the plain cases, because it delivers inside the request. A
   * `new` order for the option variant, because options are a build decision
   * and only a factory order takes them — so that path also has to be walked
   * through the worker's own delivery sweep.
   */
  type AcquireInput =
    | { kind: 'lease'; typeDesignation: string; deliveryAirportIcao: string }
    | {
        kind: 'new';
        typeDesignation: string;
        optionIds: string[];
        deliveryAirportIcao: string;
      };

  async function acquire(fixture: FoundedAirlineFixture, input: AcquireInput): Promise<string> {
    const acquired = await acquireAircraft(
      db.db,
      own(fixture),
      { requestId: randomUUID(), ...input },
      fixture.world.launchDate,
    );
    if (!acquired.ok) throw new Error(`acquisition refused: ${acquired.kind}`);

    if (acquired.airframe !== null) return acquired.airframe.id;

    // A factory order arrives later on the world's own clock (ADR-0026). Ten
    // game years is past every lead time in the catalogue.
    const wellAfter = new Date(fixture.world.epoch.getTime() + 10 * 365 * 86_400_000);
    const swept = await deliverDueAircraftOrders(db.db, fixture.world.id, wellAfter);
    expect(swept.delivered, 'the factory order was not delivered').toBeGreaterThanOrEqual(1);

    const [row] = await db.db
      .select({ id: airframe.id })
      .from(airframe)
      .where(eq(airframe.sourceOrderId, acquired.order.id));
    if (!row) throw new Error('delivery produced no airframe');
    return row.id;
  }

  async function makeFlight(
    fixture: FoundedAirlineFixture,
    airframeId: string,
    originIcao: string,
    destinationIcao: string,
  ): Promise<string> {
    const [created] = await db.db
      .insert(flight)
      .values({
        worldId: fixture.world.id,
        airlineId: fixture.airline.id,
        airframeId,
        originIcao,
        destinationIcao,
        scheduledDeparture: DEPARTS,
        actualDeparture: DEPARTS,
        estimatedArrival: ARRIVES,
        load: LOAD,
      })
      .returning({ id: flight.id });
    if (!created) throw new Error('flight was not created');
    return created.id;
  }

  /**
   * Settle through the handler the worker registers, with no dependencies.
   *
   * `createFlightArriveHandler()` — no arguments. That is the whole point of
   * this file: the resolver under test is the default one, reached the way
   * production reaches it.
   */
  const handler = createFlightArriveHandler();

  async function settle(flightId: string): Promise<void> {
    await db.db.transaction((tx) =>
      handler({ id: 'evt', fireAt: ARRIVES } as Parameters<typeof handler>[0], {
        payload: { flightId },
        tx,
      }),
    );
  }

  interface Settled {
    revenueMinor: number;
    costMinor: number;
    netMinor: number;
    blockSeconds: number;
    fuelTonnes: number;
    aircraft: {
      typeDesignation: string;
      catalogueVersion: string;
      buildOptionIds: string[];
      cruiseSpeedKt: number;
      maxTakeoffWeightT: number;
      cruiseBurnTPerNm: number;
    };
  }

  async function resultOf(flightId: string): Promise<Settled> {
    const [row] = await db.db
      .select()
      .from(flightResult)
      .where(eq(flightResult.flightId, flightId));
    if (!row) throw new Error('flight was not settled');
    const breakdown = JSON.parse(row.breakdown) as {
      fuelTonnes: number;
      aircraft: Settled['aircraft'];
    };
    return {
      revenueMinor: row.revenueMinor,
      costMinor: row.costMinor,
      netMinor: row.netMinor,
      blockSeconds: row.blockSeconds,
      fuelTonnes: breakdown.fuelTonnes,
      aircraft: breakdown.aircraft,
    };
  }

  it('costs a flight as the aeroplane the flight names, not as a placeholder', async () => {
    const fixture = await fixtures.create();
    const home = await makeAirport(52.3086, 4.76389);
    const airframeId = await acquire(fixture, {
      kind: 'lease',
      typeDesignation: 'ATR 72-600',
      deliveryAirportIcao: home,
    });

    const away = await makeAirport(51.4706, -0.461941);
    const flightId = await makeFlight(fixture, airframeId, home, away);
    await settle(flightId);
    const settled = await resultOf(flightId);

    // The identity, from the row rather than from the code that wrote it.
    expect(settled.aircraft.typeDesignation).toBe('ATR 72-600');
    expect(settled.aircraft.catalogueVersion).toBe('v1');
    expect(settled.aircraft.cruiseSpeedKt).toBe(275);
    expect(settled.aircraft.maxTakeoffWeightT).toBe(23);
  });

  it('produces explainable differences between a turboprop and a narrowbody', async () => {
    /*
     * The acceptance criterion, and the assertion that would have been
     * impossible before: the same sector, the same load, two aeroplanes.
     *
     * Each expectation names *why* it should hold, because "the numbers differ"
     * is not evidence that the right thing differs — a bug that swapped the two
     * resolutions would also produce differing numbers.
     */
    const fixture = await fixtures.create();
    // A narrowbody lease deposit is well beyond the $500k founding balance.
    // These are minor units, so this is $10m — enough for both deposits with
    // room to spare, and the exact figure is not what is under test.
    await topUp(fixture, 1_000_000_000);

    const home = await makeAirport(52.3086, 4.76389);
    const away = await makeAirport(48.8566, 2.3522);

    const turboprop = await acquire(fixture, {
      kind: 'lease',
      typeDesignation: 'ATR 72-600',
      deliveryAirportIcao: home,
    });
    const narrowbody = await acquire(fixture, {
      kind: 'lease',
      typeDesignation: 'A320neo',
      deliveryAirportIcao: home,
    });

    const atrFlight = await makeFlight(fixture, turboprop, home, away);
    const neoFlight = await makeFlight(fixture, narrowbody, home, away);
    await settle(atrFlight);
    await settle(neoFlight);

    const atr = await resultOf(atrFlight);
    const neo = await resultOf(neoFlight);

    expect(atr.aircraft.typeDesignation).toBe('ATR 72-600');
    expect(neo.aircraft.typeDesignation).toBe('A320neo');

    // Block time: the A320neo cruises at 447 kt against the ATR's 275, so it
    // gets there sooner. Same distance, same profile — only the speed differs.
    expect(neo.blockSeconds).toBeLessThan(atr.blockSeconds);

    // Fuel: the jet burns far more per hour and does not make it back on the
    // shorter block. This is the figure that was previously identical.
    expect(neo.fuelTonnes).toBeGreaterThan(atr.fuelTonnes);

    // Landing fee: charged per tonne of MTOW, 79 t against 23 t.
    expect(neo.aircraft.maxTakeoffWeightT).toBeGreaterThan(atr.aircraft.maxTakeoffWeightT);
    expect(neo.costMinor).toBeGreaterThan(atr.costMinor);

    // Revenue is the load's, so it is the same both times — which is what makes
    // the net difference attributable to the aeroplane alone.
    expect(neo.revenueMinor).toBe(atr.revenueMinor);
    expect(neo.netMinor).toBeLessThan(atr.netMinor);
    // The whole net gap is cost: same revenue in, so nothing else can be
    // moving it. That is what makes the difference attributable to the
    // aeroplane rather than merely correlated with it.
    expect(atr.netMinor - neo.netMinor).toBe(neo.costMinor - atr.costMinor);
  });

  it('bills a fitted option, because the stored spec already carries it', async () => {
    /*
     * Sharklets are `fuelBurnFactor: 0.965` in App. C.3, folded into
     * `effective_spec` when the aircraft is configured. Nothing in the
     * settlement knows options exist — App. C.6's rule — so this is the test
     * that the fold actually reaches the fuel bill.
     *
     * A factory order rather than a lease, because a lease takes no options.
     */
    const fixture = await fixtures.create();
    await topUp(fixture, 40_000_000_000);

    const home = await makeAirport(52.3086, 4.76389);
    const away = await makeAirport(48.8566, 2.3522);

    const plain = await acquire(fixture, {
      kind: 'new',
      typeDesignation: 'A320neo',
      optionIds: [],
      deliveryAirportIcao: home,
    });
    const sharkleted = await acquire(fixture, {
      kind: 'new',
      typeDesignation: 'A320neo',
      optionIds: ['sharklets'],
      deliveryAirportIcao: home,
    });

    const plainFlight = await makeFlight(fixture, plain, home, away);
    const sharkletedFlight = await makeFlight(fixture, sharkleted, home, away);
    await settle(plainFlight);
    await settle(sharkletedFlight);

    const before = await resultOf(plainFlight);
    const after = await resultOf(sharkletedFlight);

    expect(before.aircraft.buildOptionIds).toEqual([]);
    expect(after.aircraft.buildOptionIds).toEqual(['sharklets']);

    // 3.5% off the burn, and the settlement's per-mile figure carries it
    // exactly — the option is a multiplier on `fuelBurnKgPerHour`, and the
    // derivation is linear in that.
    expect(after.aircraft.cruiseBurnTPerNm / before.aircraft.cruiseBurnTPerNm).toBeCloseTo(
      0.965,
      6,
    );
    expect(after.fuelTonnes).toBeLessThan(before.fuelTonnes);
    expect(after.fuelTonnes / before.fuelTonnes).toBeCloseTo(0.965, 6);

    // Cheaper to fly, therefore worth more. The point of buying the option.
    expect(after.netMinor).toBeGreaterThan(before.netMinor);
    // And the block time is untouched: sharklets are a burn option, not a
    // speed one, so a difference here would mean the wrong field moved.
    expect(after.blockSeconds).toBe(before.blockSeconds);
  });

  it('refuses to settle a flight whose aircraft is not there', async () => {
    /*
     * The deliberate outcome the issue asks for, instead of silent placeholder
     * billing.
     *
     * Refusing is recoverable and mis-billing is not: `flight_result` is unique
     * per flight, so a wrong settlement can never be corrected, while an
     * unsettled arrival can be drained again once the data is fixed. Since
     * IMPROVE-01 the throw also rolls back cleanly and marks the event failed,
     * so this is visible on the System health page rather than silent.
     */
    const fixture = await fixtures.create();
    const home = await makeAirport(52.3086, 4.76389);
    const away = await makeAirport(51.4706, -0.461941);
    const flightId = await makeFlight(fixture, randomUUID(), home, away);

    await expect(settle(flightId)).rejects.toThrow(UnknownAirframeError);

    // Nothing was written and no cash moved: the refusal is total.
    const rows = await db.db
      .select({ id: flightResult.id })
      .from(flightResult)
      .where(eq(flightResult.flightId, flightId));
    expect(rows).toHaveLength(0);
  });

  it('will not settle against another world’s aircraft', async () => {
    // The id alone is unique, so scoping the lookup by world cannot change
    // which row it finds — what it changes is that an aircraft belonging to a
    // different world is *absent* rather than usable. Which is the case a reset
    // produces (ADR-0005).
    const owner = await fixtures.create();
    const other = await fixtures.create();
    const home = await makeAirport(52.3086, 4.76389);
    const away = await makeAirport(51.4706, -0.461941);

    const airframeId = await acquire(owner, {
      kind: 'lease',
      typeDesignation: 'ATR 72-600',
      deliveryAirportIcao: home,
    });

    expect(await loadFlightAirframe(db.db, owner.world.id, airframeId)).not.toBeNull();
    expect(await loadFlightAirframe(db.db, other.world.id, airframeId)).toBeNull();

    const flightId = await makeFlight(other, airframeId, home, away);
    await expect(settle(flightId)).rejects.toThrow(UnknownAirframeError);
  });

  it('settles a real aircraft once, however often the arrival is replayed', async () => {
    // The queue replays after a restart, and the guarantee has to survive the
    // extra read the resolver adds.
    const fixture = await fixtures.create();
    const home = await makeAirport(52.3086, 4.76389);
    const away = await makeAirport(51.4706, -0.461941);
    const airframeId = await acquire(fixture, {
      kind: 'lease',
      typeDesignation: 'ATR 72-600',
      deliveryAirportIcao: home,
    });
    const flightId = await makeFlight(fixture, airframeId, home, away);

    await settle(flightId);
    const once = await resultOf(flightId);
    await settle(flightId);
    await settle(flightId);

    expect(await resultOf(flightId)).toEqual(once);
    const rows = await db.db
      .select({ id: flightResult.id })
      .from(flightResult)
      .where(eq(flightResult.flightId, flightId));
    expect(rows).toHaveLength(1);
  });
});
