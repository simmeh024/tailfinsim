import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { acquireAircraft, deliverDueAircraftOrders } from '../aircraft/acquisition';
import { moveAirlineCash } from '../airline/cash';
import { createDatabase, type DatabaseHandle } from '../db/client';
import { airframe, airport, flight, flightResult, ledgerEntry, route } from '../db/schema';
import { departFlight } from '../flight/depart';
import { settleArrivedFlight } from '../flight/settle';
import { createAirportIdentities } from '../test-fixtures/airport-codes';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixture,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';

import { planBellyCargo } from './plan';
import { routeCargo } from './route-cargo';

import type { ResolvedPlayerAirline } from '../airline/context';
import type { DispatchDecision } from '../crew/dispatch';

/**
 * Belly cargo, end to end against real Postgres (M8-15, §12.1, §12.2).
 *
 * `cargo/belly.test.ts` and `cargo/lane.test.ts` prove the two models; this is
 * about the wiring, which is where the interesting failures live:
 *
 *  - Does `flight.cargo_kg` — a column that has existed and been zero since
 *    M2-06 — actually get a number written into it?
 *  - Does the settlement bill that number at the **lane's** rate rather than the
 *    world-wide one, and does the `cargo` ledger category (M8-01) receive it?
 *  - Does a belly tank bought at the factory still cost hold space years later,
 *    resolved from `build_option_ids` against the airframe's own pinned
 *    catalogue version?
 *  - Is another player's `airframeId` in the query string indistinguishable from
 *    one that does not exist (ADR-0020, SEC-07)?
 *
 * Requires `DATABASE_URL` against a migrated database; CI provides both. It is
 * destructive by design — see CLAUDE.md.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [cargo/cargo-db.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

const DAY_MS = 24 * 60 * 60 * 1000;

describeDb('belly cargo, against the database', () => {
  let db: DatabaseHandle;
  let fixtures: FoundedAirlineFixtureHarness;
  const madeAirports: string[] = [];
  const nextIdentity = createAirportIdentities('cargo/cargo-db');

  beforeAll(() => {
    db = createDatabase();
    fixtures = createFoundedAirlineFixtureHarness(db.db);
  });

  afterEach(async () => {
    await fixtures.cleanup();
    for (const id of madeAirports.splice(0)) await db.db.delete(airport).where(eq(airport.id, id));
  });

  afterAll(async () => {
    await db.close();
  });

  /**
   * An airport with a §12.2 trade profile.
   *
   * `businessIndex` and `wealthIndex` are what make a lane directional, so they
   * are the point of this helper rather than an afterthought: a "factory" end has
   * output above wealth and a "market" end the reverse, which is the Asia→Europe
   * shape §12.2 names.
   */
  async function makeAirport(profile: {
    kind: 'factory' | 'market' | 'plain';
    /** Degrees of longitude from the origin, which is what sets the sector length. */
    eastOf?: number;
  }): Promise<{ icao: string; ident: string }> {
    const identity = nextIdentity();
    const indices =
      profile.kind === 'factory'
        ? { businessIndex: '2.0000', wealthIndex: '0.7000' }
        : profile.kind === 'market'
          ? { businessIndex: '1.0000', wealthIndex: '1.8000' }
          : { businessIndex: '1.0000', wealthIndex: '1.0000' };

    const [row] = await db.db
      .insert(airport)
      .values({
        sourceId: identity.sourceId,
        ident: identity.ident,
        icaoCode: identity.icaoCode,
        name: `Cargo Test ${identity.icaoCode}`,
        isoCountry: 'NL',
        kind: 'large_airport',
        latitude: 52,
        longitude: 4 + (profile.eastOf ?? 0),
        scheduledService: true,
        hasRunwayData: false,
        tier: 'large',
        slotLevel: 2,
        utcOffsetMinutes: 60,
        catchmentPopulation: 4_000_000,
        ...indices,
      })
      .returning({ id: airport.id });
    if (!row) throw new Error('Could not create a cargo test airport');
    madeAirports.push(row.id);
    return { icao: identity.icaoCode, ident: identity.ident };
  }

  function own(fixture: FoundedAirlineFixture): ResolvedPlayerAirline {
    return { id: fixture.airline.id, worldId: fixture.world.id, status: 'active' };
  }

  async function topUp(fixture: FoundedAirlineFixture): Promise<void> {
    await db.db.transaction((tx) =>
      moveAirlineCash(tx, {
        airlineId: fixture.airline.id,
        amountMinor: 500_000_000_000,
        cause: 'flight_settlement',
        reference: `cargo-top-up-${randomUUID()}`,
        occurredAt: fixture.world.epoch,
      }),
    );
  }

  /** A leased aeroplane, delivered in the request. */
  async function lease(
    fixture: FoundedAirlineFixture,
    designation: string,
    icao: string,
  ): Promise<string> {
    await topUp(fixture);
    const acquired = await acquireAircraft(
      db.db,
      own(fixture),
      {
        requestId: randomUUID(),
        kind: 'lease',
        typeDesignation: designation,
        deliveryAirportIcao: icao,
      },
      fixture.world.launchDate,
    );
    if (!acquired.ok || acquired.airframe === null) {
      throw new Error(`Lease did not deliver: ${JSON.stringify(acquired)}`);
    }
    return acquired.airframe.id;
  }

  /**
   * A **configured** aeroplane, which is the only path that stores options.
   *
   * A lease writes `build_option_ids: []` — the lessor delivers the aircraft as
   * it is — so a test about `cargoVolumeFactor` has to order one from the factory
   * and let the delivery sweep materialise it, exactly as the Worker would.
   */
  async function orderConfigured(
    fixture: FoundedAirlineFixture,
    designation: string,
    optionIds: readonly string[],
    icao: string,
  ): Promise<string> {
    await topUp(fixture);
    const ordered = await acquireAircraft(
      db.db,
      own(fixture),
      {
        requestId: randomUUID(),
        kind: 'new',
        typeDesignation: designation,
        optionIds: [...optionIds],
        deliveryAirportIcao: icao,
      },
      fixture.world.launchDate,
    );
    if (!ordered.ok) throw new Error(`Order refused: ${JSON.stringify(ordered)}`);

    const oneYearOn = new Date(fixture.world.epoch.getTime() + 365 * DAY_MS);
    const swept = await deliverDueAircraftOrders(db.db, fixture.world.id, oneYearOn);
    expect(swept.delivered).toBe(1);

    const [row] = await db.db
      .select({ id: airframe.id })
      .from(airframe)
      .where(eq(airframe.sourceOrderId, ordered.order.id));
    if (!row) throw new Error('Delivery sweep produced no airframe');
    return row.id;
  }

  // -------------------------------------------------------------------------
  // The capacity model, against a real airframe
  // -------------------------------------------------------------------------

  describe('planning a hold', () => {
    it('plans against the seats fitted, and names the binding limit', async () => {
      const from = await makeAirport({ kind: 'factory' });
      const to = await makeAirport({ kind: 'market', eastOf: 6 });
      const fixture = await fixtures.create({ hubIdent: from.ident });
      const airframeId = await lease(fixture, 'A320neo', from.icao);

      const plan = await planBellyCargo(db.db, {
        worldId: fixture.world.id,
        airframeId,
        originIcao: from.icao,
        destinationIcao: to.icao,
      });

      expect(plan).not.toBeNull();
      // The cabin the aeroplane is offering, not an empty one: a load planner
      // does not sell belly capacity the seats it has sold will need.
      expect(plan?.passengers).toBeGreaterThan(100);
      expect(['weight', 'structural', 'volume']).toContain(plan?.capacity.limit);
      // All three allowances travel, because the gap to the runner-up is the
      // decision. See `BellyAllowances`.
      expect(plan?.capacity.allowances.structural).toBeLessThan(
        plan?.capacity.allowances.weight ?? 0,
      );
      expect(plan?.capacity.detail).toContain('belly capacity');
    });

    it('carries the lesser of what fits and what the lane offers', async () => {
      const from = await makeAirport({ kind: 'factory' });
      const to = await makeAirport({ kind: 'market', eastOf: 6 });
      const fixture = await fixtures.create({ hubIdent: from.ident });
      const airframeId = await lease(fixture, 'A320neo', from.icao);

      const plan = await planBellyCargo(db.db, {
        worldId: fixture.world.id,
        airframeId,
        originIcao: from.icao,
        destinationIcao: to.icao,
      });

      const carried = plan?.carriedTonnes ?? -1;
      expect(carried).toBeGreaterThanOrEqual(0);
      expect(carried).toBeLessThanOrEqual(plan?.capacity.availableTonnes ?? 0);
      expect(carried).toBeLessThanOrEqual(plan?.lane.offeredTonnes ?? 0);
      // Whole kilograms, because that is what the column takes.
      expect(plan?.carriedKg).toBe(Math.round(carried * 1000));
    });

    it('charges the belly tank its hold, years after it was ordered', async () => {
      // `cargoVolumeFactor` has reached `effective_spec` since M4-03 and been
      // consumed by nothing. This is the assertion that changes: App. C.4's
      // three-tank build ends at 62% of standard belly volume, and that has to
      // survive a round trip through `build_option_ids` and the pinned catalogue.
      const from = await makeAirport({ kind: 'factory' });
      const to = await makeAirport({ kind: 'market', eastOf: 6 });
      const fixture = await fixtures.create({ hubIdent: from.ident });

      const plain = await orderConfigured(fixture, 'A321neo', [], from.icao);
      const tanked = await orderConfigured(fixture, 'A321neo', ['act-3'], from.icao);

      const lane = { originIcao: from.icao, destinationIcao: to.icao, worldId: fixture.world.id };
      const withoutTanks = await planBellyCargo(db.db, { ...lane, airframeId: plain });
      const withTanks = await planBellyCargo(db.db, { ...lane, airframeId: tanked });

      expect(withoutTanks?.cargoVolumeFactor).toBe(1);
      expect(withTanks?.cargoVolumeFactor).toBeCloseTo(0.62, 10);
      expect(withTanks?.capacity.volume.usableM3 ?? 0).toBeLessThan(
        withoutTanks?.capacity.volume.usableM3 ?? 0,
      );
      expect(withTanks?.capacity.allowances.volume ?? 0).toBeLessThan(
        withoutTanks?.capacity.allowances.volume ?? 0,
      );
    });

    it('answers null for an airframe that is not this world’s', async () => {
      const from = await makeAirport({ kind: 'plain' });
      const to = await makeAirport({ kind: 'plain', eastOf: 3 });
      const fixture = await fixtures.create({ hubIdent: from.ident });

      const plan = await planBellyCargo(db.db, {
        worldId: fixture.world.id,
        airframeId: randomUUID(),
        originIcao: from.icao,
        destinationIcao: to.icao,
      });

      // Not an error: a flight whose belly cannot be planned departs carrying
      // nothing rather than failing to depart.
      expect(plan).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // The departure, which is where the tonnage is decided
  // -------------------------------------------------------------------------

  describe('what a departure loads', () => {
    const DEPART_AT = new Date(Date.UTC(2024, 9, 21, 8, 0, 0));
    const ARRIVE_AT = new Date(Date.UTC(2024, 9, 21, 12, 0, 0));

    const goes = (): DispatchDecision => ({
      status: 'go',
      dutyPeriodId: randomUUID(),
      marginMinutes: 120,
      usedReserve: false,
    });
    const noRoll = (): Promise<null> => Promise.resolve(null);

    async function departingFlight(
      kind: 'scheduled' | 'ferry',
    ): Promise<{ fixture: FoundedAirlineFixture; flightId: string; from: string; to: string }> {
      const from = await makeAirport({ kind: 'factory' });
      const to = await makeAirport({ kind: 'market', eastOf: 6 });
      const fixture = await fixtures.create({ hubIdent: from.ident });
      const airframeId = await lease(fixture, 'A320neo', from.icao);

      const [row] = await db.db
        .insert(flight)
        .values({
          worldId: fixture.world.id,
          airlineId: fixture.airline.id,
          airframeId,
          kind,
          originIcao: from.icao,
          destinationIcao: to.icao,
          scheduledDeparture: DEPART_AT,
          estimatedArrival: ARRIVE_AT,
        })
        .returning({ id: flight.id });
      if (!row) throw new Error('Could not create a cargo test flight');
      return { fixture, flightId: row.id, from: from.icao, to: to.icao };
    }

    async function cargoKgOf(flightId: string): Promise<number> {
      const [row] = await db.db
        .select({ cargoKg: flight.cargoKg })
        .from(flight)
        .where(eq(flight.id, flightId));
      return row?.cargoKg ?? -1;
    }

    it('writes a real tonnage into a column that used to be zero', async () => {
      const { flightId } = await departingFlight('scheduled');

      const outcome = await departFlight(db.db, flightId, DEPART_AT, {
        disruption: noRoll,
        dispatch: () => Promise.resolve(goes()),
      });

      expect(outcome.status).toBe('departed');
      expect(await cargoKgOf(flightId)).toBeGreaterThan(0);
    });

    it('loads nothing into a ferry', async () => {
      // §12.1's freight is *"revenue close to free: the aircraft is already
      // flying"* — true of a scheduled sector, false of a positioning leg,
      // because a ferry is not going where any freight wants to go.
      const { flightId } = await departingFlight('ferry');

      await departFlight(db.db, flightId, DEPART_AT, {
        disruption: noRoll,
        dispatch: () => Promise.resolve(goes()),
      });

      expect(await cargoKgOf(flightId)).toBe(0);
    });

    it('departs an aeroplane whose belly cannot be planned, carrying nothing', async () => {
      // A flight naming an airframe that is not in this world. The crew are
      // committed by this point; a missing catchment row must not cancel a
      // flight.
      const from = await makeAirport({ kind: 'plain' });
      const to = await makeAirport({ kind: 'plain', eastOf: 3 });
      const fixture = await fixtures.create({ hubIdent: from.ident });
      const [row] = await db.db
        .insert(flight)
        .values({
          worldId: fixture.world.id,
          airlineId: fixture.airline.id,
          airframeId: randomUUID(),
          originIcao: from.icao,
          destinationIcao: to.icao,
          scheduledDeparture: DEPART_AT,
          estimatedArrival: ARRIVE_AT,
        })
        .returning({ id: flight.id });
      if (!row) throw new Error('Could not create a cargo test flight');

      const outcome = await departFlight(db.db, row.id, DEPART_AT, {
        disruption: noRoll,
        dispatch: () => Promise.resolve(goes()),
      });

      expect(outcome.status).toBe('departed');
      expect(await cargoKgOf(row.id)).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // The settlement, which is where it becomes money
  // -------------------------------------------------------------------------

  describe('what the hold earns', () => {
    const DEPART_AT = new Date(Date.UTC(2024, 9, 21, 8, 0, 0));
    const ARRIVE_AT = new Date(Date.UTC(2024, 9, 21, 12, 0, 0));

    /**
     * A flown flight carrying a known tonnage, settled.
     *
     * The tonnage is written directly rather than departed, because these tests
     * are about the *yield*: fixing the kilograms is what makes the headhaul and
     * the backhaul comparable at all.
     */
    async function settleWithCargo(
      cargoKg: number,
      direction: 'headhaul' | 'backhaul',
    ): Promise<{ cargoMinor: number; fixture: FoundedAirlineFixture }> {
      const factory = await makeAirport({ kind: 'factory' });
      const market = await makeAirport({ kind: 'market', eastOf: 6 });
      const [from, to] = direction === 'headhaul' ? [factory, market] : [market, factory];

      const fixture = await fixtures.create({ hubIdent: from.ident });
      const airframeId = await lease(fixture, 'A320neo', from.icao);

      const [row] = await db.db
        .insert(flight)
        .values({
          worldId: fixture.world.id,
          airlineId: fixture.airline.id,
          airframeId,
          originIcao: from.icao,
          destinationIcao: to.icao,
          scheduledDeparture: DEPART_AT,
          estimatedArrival: ARRIVE_AT,
          actualDeparture: DEPART_AT,
          phase: 'cruise',
          cargoKg,
          load: '{}',
        })
        .returning({ id: flight.id });
      if (!row) throw new Error('Could not create a cargo test flight');

      const outcome = await db.db.transaction((tx) => settleArrivedFlight(tx, row.id, ARRIVE_AT));
      expect(outcome.status).toBe('settled');

      const lines = await db.db
        .select({ amountMinor: ledgerEntry.amountMinor, category: ledgerEntry.category })
        .from(ledgerEntry)
        .where(and(eq(ledgerEntry.flightId, row.id), eq(ledgerEntry.category, 'cargo')));

      expect(lines).toHaveLength(1);
      return { cargoMinor: lines[0]?.amountMinor ?? 0, fixture };
    }

    it('posts belly freight to the cargo ledger category (M8-01, §12.1)', async () => {
      const { cargoMinor } = await settleWithCargo(4_000, 'headhaul');
      // The category, the counterparty and the P&L row have all existed since
      // M8-01. This is the first time anything puts money through them.
      expect(cargoMinor).toBeGreaterThan(0);
    });

    it('pays the headhaul more than the backhaul for the same tonnage (§12.2)', async () => {
      const out = await settleWithCargo(4_000, 'headhaul');
      const back = await settleWithCargo(4_000, 'backhaul');

      // The same four tonnes, the same sector, the same aeroplane. The only
      // difference is which way round the trade runs — which is §12.2's whole
      // point, and the reason a cargo lane must be priced as a round trip.
      expect(out.cargoMinor).toBeGreaterThan(back.cargoMinor);
    });

    it('records the tonnage on the flight result, so a P&L can be explained', async () => {
      const factory = await makeAirport({ kind: 'factory' });
      const market = await makeAirport({ kind: 'market', eastOf: 6 });
      const fixture = await fixtures.create({ hubIdent: factory.ident });
      const airframeId = await lease(fixture, 'A320neo', factory.icao);

      const [row] = await db.db
        .insert(flight)
        .values({
          worldId: fixture.world.id,
          airlineId: fixture.airline.id,
          airframeId,
          originIcao: factory.icao,
          destinationIcao: market.icao,
          scheduledDeparture: DEPART_AT,
          estimatedArrival: ARRIVE_AT,
          actualDeparture: DEPART_AT,
          phase: 'cruise',
          cargoKg: 3_200,
          load: '{}',
        })
        .returning({ id: flight.id });
      if (!row) throw new Error('Could not create a cargo test flight');

      await db.db.transaction((tx) => settleArrivedFlight(tx, row.id, ARRIVE_AT));

      const [result] = await db.db
        .select({ cargoKg: flightResult.cargoKg, breakdown: flightResult.breakdown })
        .from(flightResult)
        .where(eq(flightResult.flightId, row.id));

      expect(result?.cargoKg).toBe(3_200);
      // The rate the flight was billed at is in the detail sentence, which is
      // what keeps an old settlement explicable after a retune (invariant 4).
      expect(result?.breakdown).toContain('belly freight at');
    });
  });

  // -------------------------------------------------------------------------
  // The projection, and its concealment
  // -------------------------------------------------------------------------

  describe('the route readout', () => {
    async function ownedRouteRow(
      fixture: FoundedAirlineFixture,
      from: string,
      to: string,
    ): Promise<{
      id: string;
      worldId: string;
      airlineId: string;
      originIcao: string;
      destinationIcao: string;
    }> {
      const [row] = await db.db
        .insert(route)
        .values({
          worldId: fixture.world.id,
          airlineId: fixture.airline.id,
          originIcao: from,
          destinationIcao: to,
          greatCircleNm: 1_200,
        })
        .returning({ id: route.id });
      if (!row) throw new Error('Could not create a cargo test route');
      return {
        id: row.id,
        worldId: fixture.world.id,
        airlineId: fixture.airline.id,
        originIcao: from,
        destinationIcao: to,
      };
    }

    it('reports the binding constraint and both legs’ rates', async () => {
      const from = await makeAirport({ kind: 'factory' });
      const to = await makeAirport({ kind: 'market', eastOf: 6 });
      const fixture = await fixtures.create({ hubIdent: from.ident });
      await lease(fixture, 'A320neo', from.icao);
      const row = await ownedRouteRow(fixture, from.icao, to.icao);

      const view = await routeCargo(db.db, row);

      expect(view).not.toBeNull();
      expect(view?.direction).toBe('headhaul');
      // §12.2's trap made visible: two rates, always, so a player cannot read
      // one leg and assume the other.
      expect(view?.ratePerTonneMinor).toBeGreaterThan(view?.reverseRatePerTonneMinor ?? 0);
      expect(view?.belly).not.toBeNull();
      expect(['weight', 'structural', 'volume']).toContain(view?.belly?.limit);
      expect(view?.belly?.detail).toContain('belly capacity');
    });

    it('gives a fleetless airline the lane and no belly', async () => {
      const from = await makeAirport({ kind: 'factory' });
      const to = await makeAirport({ kind: 'market', eastOf: 6 });
      const fixture = await fixtures.create({ hubIdent: from.ident });
      const row = await ownedRouteRow(fixture, from.icao, to.icao);

      const view = await routeCargo(db.db, row);

      // The lane belongs to the market and answers without an aeroplane; the
      // belly does not exist without one, and an invented reference airframe
      // would be worse than saying so.
      expect(view?.belly).toBeNull();
      expect(view?.ratePerTonneMinor).toBeGreaterThan(0);
      expect(view?.offeredTonnes).toBeGreaterThan(0);
    });

    it('hides another airline’s airframe exactly as it hides a missing one', async () => {
      const from = await makeAirport({ kind: 'factory' });
      const to = await makeAirport({ kind: 'market', eastOf: 6 });
      const mine = await fixtures.create({ hubIdent: from.ident });
      // A second airline in the same world, so the only thing separating the two
      // airframes is ownership.
      const theirs = await fixtures.create({
        worldId: mine.world.id,
        hubIdent: from.ident,
      });

      await lease(mine, 'A320neo', from.icao);
      const theirAirframe = await lease(theirs, 'A320neo', from.icao);
      const row = await ownedRouteRow(mine, from.icao, to.icao);

      // SEC-07's five cases, on a query parameter naming an owned resource.
      expect(await routeCargo(db.db, row, theirAirframe)).toBeNull();
      expect(await routeCargo(db.db, row, randomUUID())).toBeNull();
      expect(await routeCargo(db.db, row, 'not-a-uuid')).toBeNull();
      expect(await routeCargo(db.db, row, '')).toBeNull();
      // Absent is the one that answers, and it answers about the caller's own.
      const own = await routeCargo(db.db, row);
      expect(own?.belly).not.toBeNull();
      expect(own?.belly?.airframeId).not.toBe(theirAirframe);
    });
  });
});
