import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  AIRCRAFT_CATALOGUE_V1,
  AircraftAcquisitionResponse,
  AircraftOrderListResponse,
} from '@tailfin/shared';
import { computeEffectiveBuild } from '@tailfin/sim';

import { moveAirlineCash, reconcileAirlineCash } from '../airline/cash';
import { type ResolvedPlayerAirline } from '../airline/context';
import { buildApp } from '../app';
import { createSession, SESSION_COOKIE } from '../auth/session';
import { createDatabase, type DatabaseHandle } from '../db/client';
import { aircraftOrder, airframe, airline, airport, usedAircraftListing } from '../db/schema';
import { type ServerEnv } from '../env';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixture,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';

import { acquireAircraft, deliverDueAircraftOrders, LEASE_DEPOSIT_MONTHS } from './acquisition';
import { seedAircraftCatalogue } from './catalogue';

/**
 * M4-04 against real Postgres.
 *
 * Each issue acceptance criterion is a test below:
 *
 *   1. App. B.4's $500k start pays a two-month ATR deposit and leaves $330k;
 *   2. factory options put a real, measurable gap between delivery dates;
 *   3. a used airframe carries its prior owner's exact configuration and history.
 */

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [acquisition.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

const env: ServerEnv = {
  nodeEnv: 'test',
  databaseUrl: url ?? 'postgres://unused',
  databasePoolMax: 2,
  databaseConnectTimeoutMs: 5_000,
  logLevel: 'silent',
  webSurface: 'holding',
  environmentLabel: 'local',
  publicOrigin: 'http://localhost:3000',
  googleClientId: 'test-client-id.apps.googleusercontent.com',
  googleClientSecret: 'test-client-secret',
  sessionSecret: 'a'.repeat(48),
  authEnabled: true,
  sessionTtlHours: 24,
  adminSessionTtlHours: 12,
  allowRegistration: false,
};

describeDb('aircraft acquisition', () => {
  let db: DatabaseHandle;
  let fixtures: FoundedAirlineFixtureHarness;
  const madeAirports: string[] = [];
  let sequence = 0;

  beforeAll(async () => {
    db = createDatabase();
    fixtures = createFoundedAirlineFixtureHarness(db.db);
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

  /*
   * A counter, not a random tag.
   *
   * These four suites each drew a random three-letter tag from 26^3, and a suite
   * making twenty airports has a ~1% chance of drawing the same one twice --
   * which lands as `Failed query: insert into "airport"` on a PR that touched
   * nothing near it. It bit `maintenance.test.ts` (VPEO) and `fleet.test.ts` on
   * unrelated branches before it was diagnosed.
   *
   * `sourceId` was random over the whole negative int range too, which is a
   * second, rarer instance of the same bug.
   *
   * The crew suites already do it this way, and CLAUDE.md records why they had
   * to: a prefix per suite and a counter for the rest, so a collision is a
   * counting fact rather than a probability.
   *
   * The one prefix worth checking is `acquisition`'s `T`, which shares a letter
   * with the crew suites' `TC`, `TD`, `TL`, `TM`, `TP` and `TY`. A counter
   * starting at `AAA` reaches `CAA` only after 1,352 airports, and these suites
   * make tens -- so it is bounded rather than impossible, which is worth knowing
   * before anyone writes a loop that makes thousands.
   */
  async function makeDeliveryAirport(): Promise<string> {
    const n = sequence++;
    const tag = `${LETTERS[Math.floor(n / 676) % 26]}${LETTERS[Math.floor(n / 26) % 26]}${LETTERS[n % 26]}`;
    const icao = `T${tag}`;
    const [created] = await db.db
      .insert(airport)
      .values({
        sourceId: -(8_700_000 + n),
        ident: icao,
        icaoCode: icao,
        name: `Aircraft delivery test ${tag}`,
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
    if (!created) throw new Error('Delivery airport was not created');
    madeAirports.push(created.id);
    return icao;
  }

  function own(fixture: FoundedAirlineFixture): ResolvedPlayerAirline {
    return { id: fixture.airline.id, worldId: fixture.world.id, status: 'active' };
  }

  async function topUp(fixture: FoundedAirlineFixture, amountMinor: number): Promise<void> {
    await db.db.transaction((tx) =>
      moveAirlineCash(tx, {
        airlineId: fixture.airline.id,
        amountMinor,
        cause: 'flight_settlement',
        reference: `test-top-up-${randomUUID()}`,
        occurredAt: fixture.world.epoch,
      }),
    );
  }

  it('takes App. B.4’s two-month ATR deposit from the $500k opening balance', async () => {
    const fixture = await fixtures.create();
    const deliveryAirportIcao = await makeDeliveryAirport();
    const requestId = randomUUID();

    const acquired = await acquireAircraft(
      db.db,
      own(fixture),
      {
        requestId,
        kind: 'lease',
        typeDesignation: 'ATR 72-600',
        deliveryAirportIcao,
      },
      fixture.world.launchDate,
    );

    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    expect(acquired.order.monthlyLeaseRateMinor).toBe(8_500_000);
    expect(acquired.order.chargedMinor).toBe(8_500_000 * LEASE_DEPOSIT_MONTHS);
    expect(acquired.order.status).toBe('delivered');
    expect(acquired.airframe).toMatchObject({
      typeDesignation: 'ATR 72-600',
      ownership: 'leased',
      deliveredToIcao: deliveryAirportIcao,
    });

    // $500k − $170k = $330k. These are cents, so the stored answer is $330k × 100.
    const expectedBalance = 33_000_000;
    expect(await reconcileAirlineCash(db.db, fixture.airline.id)).toMatchObject({
      balanceMinor: expectedBalance,
      movementTotalMinor: expectedBalance,
      reconciles: true,
    });

    // A timed-out POST can be replayed without paying a second deposit or
    // creating a second physical aircraft.
    const replay = await acquireAircraft(
      db.db,
      own(fixture),
      {
        requestId,
        kind: 'lease',
        typeDesignation: 'A380-800',
        deliveryAirportIcao,
      },
      new Date(fixture.world.launchDate.getTime() + 1_000),
    );
    expect(replay).toMatchObject({ ok: true, replayed: true });
    expect(
      await db.db.select().from(aircraftOrder).where(eq(aircraftOrder.id, requestId)),
    ).toHaveLength(1);
    expect(
      await db.db.select().from(airframe).where(eq(airframe.sourceOrderId, requestId)),
    ).toHaveLength(1);
  });

  it('delivers a standard new aircraft measurably before a heavily optioned build', async () => {
    const fixture = await fixtures.create();
    const deliveryAirportIcao = await makeDeliveryAirport();
    await topUp(fixture, 50_000_000_000);

    const type = AIRCRAFT_CATALOGUE_V1.types.find((entry) => entry.designation === 'A321neo');
    if (!type) throw new Error('A321neo is missing from the shipped catalogue');
    const optionById = new Map(AIRCRAFT_CATALOGUE_V1.options.map((option) => [option.id, option]));
    const heavyOptionIds: string[] = [];
    for (const optionId of type.availableOptionIds) {
      const option = optionById.get(optionId);
      if (!option || option.leadTimeWeeks === 0 || option.requiresResearch.length > 0) continue;
      if (
        heavyOptionIds.some((selected) =>
          (option.conflictsWith as readonly string[]).includes(selected),
        )
      )
        continue;
      heavyOptionIds.push(optionId);
      if (heavyOptionIds.length === 4) break;
    }
    expect(heavyOptionIds).toHaveLength(4);

    const orderedAt = fixture.world.launchDate;
    const standard = await acquireAircraft(
      db.db,
      own(fixture),
      {
        requestId: randomUUID(),
        kind: 'new',
        typeDesignation: type.designation,
        optionIds: [],
        deliveryAirportIcao,
      },
      orderedAt,
    );
    const heavy = await acquireAircraft(
      db.db,
      own(fixture),
      {
        requestId: randomUUID(),
        kind: 'new',
        typeDesignation: type.designation,
        optionIds: heavyOptionIds,
        deliveryAirportIcao,
      },
      orderedAt,
    );
    expect(standard.ok).toBe(true);
    expect(heavy.ok).toBe(true);
    if (!standard.ok || !heavy.ok) return;

    expect(standard.order.status).toBe('pending');
    expect(heavy.order.optionLeadTimeWeeks).toBeGreaterThan(0);
    expect(Date.parse(heavy.order.deliveryAt)).toBeGreaterThan(
      Date.parse(standard.order.deliveryAt),
    );

    const atStandardDelivery = new Date(standard.order.deliveryAt);
    expect(await deliverDueAircraftOrders(db.db, fixture.world.id, atStandardDelivery)).toEqual({
      delivered: 1,
    });

    const [standardAfter, heavyAfter] = await Promise.all([
      db.db.select().from(aircraftOrder).where(eq(aircraftOrder.id, standard.order.id)).limit(1),
      db.db.select().from(aircraftOrder).where(eq(aircraftOrder.id, heavy.order.id)).limit(1),
    ]);
    expect(standardAfter[0]?.status).toBe('delivered');
    expect(heavyAfter[0]?.status).toBe('pending');

    expect(
      await deliverDueAircraftOrders(db.db, fixture.world.id, new Date(heavy.order.deliveryAt)),
    ).toEqual({ delivered: 1 });
    expect(
      (await db.db.select().from(airframe).where(eq(airframe.sourceOrderId, heavy.order.id)))[0]
        ?.buildOptionIds,
    ).toBe(JSON.stringify(heavyOptionIds.slice().sort()));
  });

  it('delivers a used airframe with the prior owner’s configuration intact', async () => {
    const fixture = await fixtures.create();
    const locationIcao = await makeDeliveryAirport();
    const atr = AIRCRAFT_CATALOGUE_V1.types.find((type) => type.designation === 'ATR 72-600');
    const option = AIRCRAFT_CATALOGUE_V1.options.find((entry) => entry.id === 'lightweight-cabin');
    if (!atr || !option) throw new Error('Used-aircraft test catalogue facts are missing');
    const build = computeEffectiveBuild({ baseSpec: atr.baseSpec, options: [option] });
    const cabinConfigId = randomUUID();
    const liveryId = randomUUID();
    const ownerHistory = [
      {
        ownerLabel: 'Prior Regional',
        acquiredAt: '2018-01-01T00:00:00.000Z',
        releasedAt: '2024-09-01T00:00:00.000Z',
      },
    ];
    const [listing] = await db.db
      .insert(usedAircraftListing)
      .values({
        worldId: fixture.world.id,
        catalogueVersion: AIRCRAFT_CATALOGUE_V1.version,
        typeDesignation: atr.designation,
        registration: 'PH-OLD',
        buildOptionIds: JSON.stringify(build.optionIds),
        cabinConfigId,
        liveryId,
        effectiveSpec: JSON.stringify(build.spec),
        ownerHistory: JSON.stringify(ownerHistory),
        hours: 12_345.5,
        cycles: 9_876,
        askingPriceMinor: 10_000_000,
        locationIcao,
      })
      .returning();
    if (!listing) throw new Error('Used listing was not created');

    const acquired = await acquireAircraft(
      db.db,
      own(fixture),
      { requestId: randomUUID(), kind: 'used', listingId: listing.id },
      fixture.world.launchDate,
    );
    expect(acquired.ok).toBe(true);
    if (!acquired.ok || !acquired.airframe) return;

    expect(acquired.airframe).toMatchObject({
      registration: 'PH-OLD',
      buildOptionIds: build.optionIds,
      cabinConfigId,
      liveryId,
      effectiveSpec: build.spec,
      hours: 12_345.5,
      cycles: 9_876,
      ownerHistory,
      ownership: 'owned',
      deliveredToIcao: locationIcao,
    });
    expect(
      (
        await db.db.select().from(usedAircraftListing).where(eq(usedAircraftListing.id, listing.id))
      )[0],
    ).toMatchObject({ status: 'sold', soldAt: fixture.world.launchDate });
  });

  it('rolls the order and movement back when the airline cannot afford it', async () => {
    const fixture = await fixtures.create();
    const deliveryAirportIcao = await makeDeliveryAirport();
    const requestId = randomUUID();
    const before = fixture.airline.cash;

    const result = await acquireAircraft(
      db.db,
      own(fixture),
      {
        requestId,
        kind: 'new',
        typeDesignation: 'A321neo',
        optionIds: [],
        deliveryAirportIcao,
      },
      fixture.world.launchDate,
    );
    expect(result).toMatchObject({
      ok: false,
      kind: 'insufficient-funds',
      availableMinor: before,
    });
    expect(await db.db.select().from(aircraftOrder).where(eq(aircraftOrder.id, requestId))).toEqual(
      [],
    );
    expect(
      (await db.db.select().from(airline).where(eq(airline.id, fixture.airline.id)))[0]?.cashMinor,
    ).toBe(before);
  });

  it('exposes the typed mutation and owner-scoped order list over HTTP', async () => {
    const fixture = await fixtures.create();
    const deliveryAirportIcao = await makeDeliveryAirport();
    const session = await createSession(db.db, fixture.player.id, env.sessionTtlHours);
    const app = buildApp({ env, db });

    try {
      const anonymous = await app.inject({
        method: 'POST',
        url: '/api/fleet/acquisitions',
        payload: {},
      });
      expect(anonymous.statusCode).toBe(401);

      const created = await app.inject({
        method: 'POST',
        url: '/api/fleet/acquisitions',
        headers: {
          cookie: `${SESSION_COOKIE}=${session.token}`,
          'x-tailfin-world-id': fixture.world.id,
        },
        payload: {
          requestId: randomUUID(),
          kind: 'lease',
          typeDesignation: 'ATR 72-600',
          deliveryAirportIcao,
        },
      });
      expect(created.statusCode).toBe(201);
      expect(AircraftAcquisitionResponse.parse(created.json())).toMatchObject({
        replayed: false,
        order: { kind: 'lease', status: 'delivered' },
        airframe: { ownership: 'leased' },
      });

      const listed = await app.inject({
        method: 'GET',
        url: '/api/fleet/orders',
        headers: {
          cookie: `${SESSION_COOKIE}=${session.token}`,
          'x-tailfin-world-id': fixture.world.id,
        },
      });
      expect(listed.statusCode).toBe(200);
      expect(AircraftOrderListResponse.parse(listed.json()).orders).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});
