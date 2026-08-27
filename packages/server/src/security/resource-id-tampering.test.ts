import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ECONOMY_CONFIG_V1_VERSION } from '@tailfin/shared';

import { acquireAircraft } from '../aircraft/acquisition';
import { seedAircraftCatalogue } from '../aircraft/catalogue';
import { refreshUsedAircraftMarket } from '../aircraft/used-market';
import { moveAirlineCash } from '../airline/cash';
import { type ResolvedPlayerAirline } from '../airline/context';
import { createDatabase, type DatabaseHandle } from '../db/client';
import {
  aircraftOrder,
  airframe,
  airline,
  airport,
  crewBase,
  crewPool,
  groundContract,
  player,
  usedAircraftListing,
  world,
} from '../db/schema';
import { type ServerEnv } from '../env';
import { readStation, signContract } from '../ground/contracts';
import { createOwnershipTestSuite, type OwnershipTestSuite } from '../test-fixtures/ownership';
import {
  ABSENT_RESOURCE_UUID,
  MALFORMED_RESOURCE_IDS,
  resourceIdCases,
} from '../test-fixtures/resource-id';

import type { InjectOptions } from 'fastify';

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [resource-id-tampering.test] DATABASE_URL not set — skipping.\n');
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
  sessionSecret: 's'.repeat(48),
  authEnabled: true,
  sessionTtlHours: 24,
  adminSessionTtlHours: 12,
  allowRegistration: false,
};

describeDb('SEC-07 resource id tampering at owner-scoped HTTP boundaries', () => {
  let db: DatabaseHandle;
  let suite: OwnershipTestSuite;
  const madeAirportIds: string[] = [];
  let ownBaseId: string;
  let competitorBaseId: string;
  let ownAirframeId: string;
  let ownMaintenanceAirframeId: string;
  let competitorAirframeId: string;
  let ownListingId: string;
  let crossWorldListingId: string;
  let ownContractId: string;
  let competitorContractId: string;
  let otherWorldContractId: string;
  let extraAirlineId: string | undefined;

  function own(airlineFixture: OwnershipTestSuite['airlineA']): ResolvedPlayerAirline {
    return {
      id: airlineFixture.airline.id,
      worldId: airlineFixture.world.id,
      status: 'active',
    };
  }

  async function makeAirport(icaoCode: string, sourceId: number): Promise<void> {
    const [created] = await db.db
      .insert(airport)
      .values({
        sourceId,
        ident: icaoCode,
        icaoCode,
        name: `SEC-07 Airport ${icaoCode}`,
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
    if (!created) throw new Error(`SEC-07 airport ${icaoCode} was not created`);
    madeAirportIds.push(created.id);
  }

  async function topUp(
    airlineId: string,
    reference: string,
    amountMinor = 10_000_000_000,
  ): Promise<void> {
    await db.db.transaction((tx) =>
      moveAirlineCash(tx, {
        airlineId,
        amountMinor,
        cause: 'flight_settlement',
        reference,
        occurredAt: suite.worldMain.epoch,
      }),
    );
  }

  async function lease(
    airlineFixture: OwnershipTestSuite['airlineA'],
    deliveryAirportIcao: string,
  ): Promise<string> {
    const acquired = await acquireAircraft(db.db, own(airlineFixture), {
      requestId: randomUUID(),
      kind: 'lease',
      typeDesignation: 'ATR 72-600',
      deliveryAirportIcao,
    });
    if (!acquired.ok || acquired.airframe === null) throw new Error('SEC-07 lease did not deliver');
    return acquired.airframe.id;
  }

  beforeAll(async () => {
    db = createDatabase();
    await seedAircraftCatalogue(db.db);
    suite = await createOwnershipTestSuite({ db, env, suite: 'resource-id-tampering' });
    await suite.app.ready();

    await makeAirport('SZAA', -9_707_001);
    await makeAirport('SZAB', -9_707_002);
    await makeAirport('SZAC', -9_707_003);
    async function makeContract(
      airlineFixture: OwnershipTestSuite['airlineA'],
      icao: string,
    ): Promise<string> {
      const station = await readStation(db.db, own(airlineFixture), icao);
      const line = station?.lines[0];
      const offer = line?.offers[0];
      if (!line || !offer) throw new Error('SEC-07 ground offer was not available');
      const signed = await signContract(db.db, own(airlineFixture), icao, {
        serviceLine: line.serviceLine,
        grade: offer.grade,
      });
      if (!signed.ok) throw new Error('SEC-07 ground contract was not signed');
      const id = signed.station.lines.find((value) => value.serviceLine === line.serviceLine)
        ?.contracted?.id;
      if (!id) throw new Error('SEC-07 ground contract was not returned');
      return id;
    }
    ownContractId = await makeContract(suite.airlineA, 'SZAA');
    competitorContractId = await makeContract(suite.airlineB, 'SZAB');
    otherWorldContractId = await makeContract(suite.airlineAOther, 'SZAC');
    await topUp(suite.airlineA.airline.id, 'sec-07-player-a-top-up');
    await topUp(suite.airlineB.airline.id, 'sec-07-player-b-top-up');

    const [ownBase] = await db.db
      .insert(crewBase)
      .values({
        worldId: suite.worldMain.id,
        airlineId: suite.airlineA.airline.id,
        airportIcao: 'SZAA',
        openedAt: suite.worldMain.epoch,
      })
      .returning({ id: crewBase.id });
    const [competitorBase] = await db.db
      .insert(crewBase)
      .values({
        worldId: suite.worldMain.id,
        airlineId: suite.airlineB.airline.id,
        airportIcao: 'SZAB',
        openedAt: suite.worldMain.epoch,
      })
      .returning({ id: crewBase.id });
    if (!ownBase || !competitorBase) throw new Error('SEC-07 crew bases were not created');
    ownBaseId = ownBase.id;
    competitorBaseId = competitorBase.id;

    await db.db.insert(crewPool).values([
      {
        crewBaseId: ownBaseId,
        family: 'A320neo',
        rank: 'captain',
        headcount: 10,
      },
      {
        crewBaseId: competitorBaseId,
        family: 'A320neo',
        rank: 'captain',
        headcount: 10,
      },
    ]);

    ownAirframeId = await lease(suite.airlineA, 'SZAA');
    ownMaintenanceAirframeId = await lease(suite.airlineA, 'SZAA');
    competitorAirframeId = await lease(suite.airlineB, 'SZAB');

    await refreshUsedAircraftMarket(db.db, suite.worldMain.id, suite.worldMain.launchDate);
    await refreshUsedAircraftMarket(db.db, suite.worldOther.id, suite.worldOther.launchDate);
    const [ownListing] = await db.db
      .select({
        id: usedAircraftListing.id,
        askingPriceMinor: usedAircraftListing.askingPriceMinor,
      })
      .from(usedAircraftListing)
      .where(
        and(
          eq(usedAircraftListing.worldId, suite.worldMain.id),
          eq(usedAircraftListing.status, 'available'),
        ),
      )
      .limit(1);
    const [crossWorldListing] = await db.db
      .select({ id: usedAircraftListing.id })
      .from(usedAircraftListing)
      .where(
        and(
          eq(usedAircraftListing.worldId, suite.worldOther.id),
          eq(usedAircraftListing.status, 'available'),
        ),
      )
      .limit(1);
    if (!ownListing || !crossWorldListing) throw new Error('SEC-07 used listings were not created');
    ownListingId = ownListing.id;
    crossWorldListingId = crossWorldListing.id;
    // The generated market may offer a widebody. Fund the exact sampled price
    // so the allowed-ID control tests authorization, not random affordability.
    await topUp(
      suite.airlineA.airline.id,
      'sec-07-used-listing-funds',
      ownListing.askingPriceMinor,
    );
  });

  afterAll(async () => {
    if (extraAirlineId !== undefined) {
      await db.db.delete(airline).where(eq(airline.id, extraAirlineId));
    }
    await suite.cleanup();
    for (const id of madeAirportIds.splice(0)) {
      await db.db.delete(airport).where(eq(airport.id, id));
    }
    await db.close();
  });

  const crewSurfaces: {
    name: string;
    request: (crewBaseId: string) => InjectOptions;
  }[] = [
    {
      name: 'hire',
      request: (crewBaseId) => ({
        method: 'POST',
        url: '/api/crew/hires',
        payload: { crewBaseId, family: 'A320neo', rank: 'captain', heads: 1 },
      }),
    },
    {
      name: 'conversion',
      request: (crewBaseId) => ({
        method: 'POST',
        url: '/api/crew/conversions',
        payload: {
          crewBaseId,
          fromFamily: 'A320neo',
          toFamily: 'B737',
          rank: 'captain',
          heads: 1,
        },
      }),
    },
    {
      name: 'reserve',
      request: (crewBaseId) => ({
        method: 'PUT',
        url: '/api/crew/reserves',
        payload: { crewBaseId, family: 'A320neo', rank: 'captain', reserve: 1 },
      }),
    },
    {
      name: 'policies',
      request: (crewBaseId) => ({
        method: 'PUT',
        url: '/api/crew/policies',
        payload: { crewBaseId, payBand: 'generous' },
      }),
    },
  ];

  it.each(crewSurfaces)('$name resolves playerA’s own crew base', async ({ request }) => {
    const response = await suite.as(
      { actor: 'playerA', worldId: suite.worldMain.id },
      request(ownBaseId),
    );
    expect(response.statusCode).toBe(200);
  });

  it.each(crewSurfaces)(
    '$name conceals another player, an absent uuid and a wrong entity type identically',
    async ({ request }) => {
      const before = {
        base: await db.db.select().from(crewBase).where(eq(crewBase.id, competitorBaseId)),
        pools: await db.db.select().from(crewPool).where(eq(crewPool.crewBaseId, competitorBaseId)),
        cash: await db.db
          .select({ id: airline.id, cashMinor: airline.cashMinor })
          .from(airline)
          .where(eq(airline.id, suite.airlineA.airline.id)),
      };
      const denied = await Promise.all(
        resourceIdCases({
          own: ownBaseId,
          anotherPlayer: competitorBaseId,
          wrongEntity: suite.worldMain.id,
          absent: ABSENT_RESOURCE_UUID,
        })
          .filter(({ expected }) => expected === 'conceal')
          .map(({ id }) =>
            suite.as({ actor: 'playerA', worldId: suite.worldMain.id }, request(id)),
          ),
      );

      for (const response of denied) {
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ code: 'base_absent', message: 'No such crew base' });
      }
      expect(new Set(denied.map(({ body }) => body)).size).toBe(1);
      expect({
        base: await db.db.select().from(crewBase).where(eq(crewBase.id, competitorBaseId)),
        pools: await db.db.select().from(crewPool).where(eq(crewPool.crewBaseId, competitorBaseId)),
        cash: await db.db
          .select({ id: airline.id, cashMinor: airline.cashMinor })
          .from(airline)
          .where(eq(airline.id, suite.airlineA.airline.id)),
      }).toEqual(before);
    },
  );

  it.each(crewSurfaces)('$name rejects malformed body ids without a 500', async ({ request }) => {
    for (const malformed of MALFORMED_RESOURCE_IDS) {
      const response = await suite.as(
        { actor: 'playerA', worldId: suite.worldMain.id },
        request(malformed),
      );
      expect(response.statusCode).toBe(400);
    }
  });

  it('applies the four-case matrix to an airframe path id', async () => {
    const cases = resourceIdCases({
      own: ownAirframeId,
      anotherPlayer: competitorAirframeId,
      wrongEntity: suite.worldMain.id,
    });
    for (const testCase of cases) {
      const response = await suite.as(
        { actor: 'playerA', worldId: suite.worldMain.id },
        { method: 'GET', url: `/api/fleet/airframes/${testCase.id}` },
      );
      if (testCase.expected === 'allow') {
        expect(response.statusCode).toBe(200);
      } else {
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({
          code: 'airframe_not_found',
          message: 'No such aircraft in your fleet',
        });
      }
    }
    for (const malformed of MALFORMED_RESOURCE_IDS) {
      const response = await suite.as(
        { actor: 'playerA', worldId: suite.worldMain.id },
        { method: 'GET', url: `/api/fleet/airframes/${encodeURIComponent(malformed)}` },
      );
      expect([400, 404]).toContain(response.statusCode);
    }
  });

  it('conceals ground contract ids and leaves every refused termination untouched', async () => {
    const snapshot = async () => ({
      contracts: await db.db
        .select()
        .from(groundContract)
        .where(eq(groundContract.id, competitorContractId)),
      own: await db.db.select().from(groundContract).where(eq(groundContract.id, ownContractId)),
      otherWorld: await db.db
        .select()
        .from(groundContract)
        .where(eq(groundContract.id, otherWorldContractId)),
      cash: await db.db
        .select({ cashMinor: airline.cashMinor })
        .from(airline)
        .where(eq(airline.id, suite.airlineA.airline.id)),
    });
    const before = await snapshot();
    const denied = resourceIdCases({
      own: ownContractId,
      anotherPlayer: competitorContractId,
      wrongEntity: suite.worldMain.id,
    }).filter(({ expected }) => expected === 'conceal');
    for (const id of [
      ...denied.map((testCase) => testCase.id),
      otherWorldContractId,
      ...MALFORMED_RESOURCE_IDS,
    ]) {
      const response = await suite.as(
        { actor: 'playerA', worldId: suite.worldMain.id },
        { method: 'DELETE', url: `/api/ground/contracts/${encodeURIComponent(id)}` },
      );
      expect(response.statusCode, response.body).toBe(404);
      if (id !== '') {
        expect(response.json()).toEqual({ code: 'not_found', message: 'No such contract' });
      }
      expect(await snapshot()).toEqual(before);
    }
    const allowed = await suite.as(
      { actor: 'playerA', worldId: suite.worldMain.id },
      { method: 'DELETE', url: `/api/ground/contracts/${ownContractId}` },
    );
    expect(allowed.statusCode, allowed.body).toBe(200);
    expect(
      await db.db.select().from(groundContract).where(eq(groundContract.id, ownContractId)),
    ).toMatchObject([{ status: 'terminated' }]);
  });

  it('conceals refused maintenance targets and leaves the foreign airframe unchanged', async () => {
    const allowed = await suite.as(
      { actor: 'playerA', worldId: suite.worldMain.id },
      {
        method: 'POST',
        url: '/api/fleet/maintenance/checks',
        payload: { airframeId: ownMaintenanceAirframeId, tier: 'a' },
      },
    );
    expect(allowed.statusCode, allowed.body).toBe(201);

    const before = {
      airframe: await db.db.select().from(airframe).where(eq(airframe.id, competitorAirframeId)),
      cash: await db.db
        .select({ id: airline.id, cashMinor: airline.cashMinor })
        .from(airline)
        .where(eq(airline.id, suite.airlineA.airline.id)),
    };
    const deniedCases = resourceIdCases({
      own: ownMaintenanceAirframeId,
      anotherPlayer: competitorAirframeId,
      wrongEntity: suite.worldMain.id,
    }).filter(({ expected }) => expected === 'conceal');
    for (const testCase of deniedCases) {
      const response = await suite.as(
        { actor: 'playerA', worldId: suite.worldMain.id },
        {
          method: 'POST',
          url: '/api/fleet/maintenance/checks',
          payload: { airframeId: testCase.id, tier: 'a' },
        },
      );
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        code: 'airframe_not_found',
        message: 'No such aircraft in your fleet',
      });
    }
    for (const malformed of MALFORMED_RESOURCE_IDS) {
      const response = await suite.as(
        { actor: 'playerA', worldId: suite.worldMain.id },
        {
          method: 'POST',
          url: '/api/fleet/maintenance/checks',
          payload: { airframeId: malformed, tier: 'a' },
        },
      );
      expect(response.statusCode).toBe(400);
    }
    expect({
      airframe: await db.db.select().from(airframe).where(eq(airframe.id, competitorAirframeId)),
      cash: await db.db
        .select({ id: airline.id, cashMinor: airline.cashMinor })
        .from(airline)
        .where(eq(airline.id, suite.airlineA.airline.id)),
    }).toEqual(before);
  });

  it('scopes a used-listing body id to the active world and preserves refused targets', async () => {
    const before = {
      listing: await db.db
        .select()
        .from(usedAircraftListing)
        .where(eq(usedAircraftListing.id, crossWorldListingId)),
      cash: await db.db
        .select({ cashMinor: airline.cashMinor })
        .from(airline)
        .where(eq(airline.id, suite.airlineA.airline.id)),
      orders: await db.db
        .select({ id: aircraftOrder.id })
        .from(aircraftOrder)
        .where(eq(aircraftOrder.airlineId, suite.airlineA.airline.id)),
    };

    for (const listingId of [
      crossWorldListingId,
      ABSENT_RESOURCE_UUID,
      suite.airlineB.airline.id,
    ]) {
      const response = await suite.as(
        { actor: 'playerA', worldId: suite.worldMain.id },
        {
          method: 'POST',
          url: '/api/fleet/acquisitions',
          payload: { requestId: randomUUID(), kind: 'used', listingId },
        },
      );
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        code: 'used_aircraft_not_available',
        message: 'That used aircraft is no longer available',
      });
    }
    for (const malformed of MALFORMED_RESOURCE_IDS) {
      const response = await suite.as(
        { actor: 'playerA', worldId: suite.worldMain.id },
        {
          method: 'POST',
          url: '/api/fleet/acquisitions',
          payload: { requestId: randomUUID(), kind: 'used', listingId: malformed },
        },
      );
      expect(response.statusCode).toBe(400);
    }

    expect({
      listing: await db.db
        .select()
        .from(usedAircraftListing)
        .where(eq(usedAircraftListing.id, crossWorldListingId)),
      cash: await db.db
        .select({ cashMinor: airline.cashMinor })
        .from(airline)
        .where(eq(airline.id, suite.airlineA.airline.id)),
      orders: await db.db
        .select({ id: aircraftOrder.id })
        .from(aircraftOrder)
        .where(eq(aircraftOrder.airlineId, suite.airlineA.airline.id)),
    }).toEqual(before);

    const allowed = await suite.as(
      { actor: 'playerA', worldId: suite.worldMain.id },
      {
        method: 'POST',
        url: '/api/fleet/acquisitions',
        payload: { requestId: randomUUID(), kind: 'used', listingId: ownListingId },
      },
    );
    expect(allowed.statusCode, allowed.body).toBe(201);
  });

  it('treats requestId as an idempotency token, while refusing another player’s token', async () => {
    const [competitorOrder] = await db.db
      .select()
      .from(aircraftOrder)
      .where(eq(aircraftOrder.airlineId, suite.airlineB.airline.id))
      .limit(1);
    if (!competitorOrder) throw new Error('SEC-07 competitor order was not created');

    const before = await db.db
      .select()
      .from(aircraftOrder)
      .where(eq(aircraftOrder.id, competitorOrder.id));
    const refused = await suite.as(
      { actor: 'playerA', worldId: suite.worldMain.id },
      {
        method: 'POST',
        url: '/api/fleet/acquisitions',
        payload: {
          requestId: competitorOrder.id,
          kind: 'lease',
          typeDesignation: 'ATR 72-600',
          deliveryAirportIcao: 'SZAA',
        },
      },
    );
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'aircraft_request_id_conflict' });
    expect(
      await db.db.select().from(aircraftOrder).where(eq(aircraftOrder.id, competitorOrder.id)),
    ).toEqual(before);

    for (const malformed of MALFORMED_RESOURCE_IDS) {
      const response = await suite.as(
        { actor: 'playerA', worldId: suite.worldMain.id },
        {
          method: 'POST',
          url: '/api/fleet/acquisitions',
          payload: {
            requestId: malformed,
            kind: 'lease',
            typeDesignation: 'ATR 72-600',
            deliveryAirportIcao: 'SZAA',
          },
        },
      );
      expect(response.statusCode).toBe(400);
    }
  });

  it('validates world parent references before founding a child airline', async () => {
    const adminPlayerId = suite.authorization.identities.admin.playerId;
    const adminCookie = suite.authorization.identities.admin.cookie;
    if (adminPlayerId === null || adminCookie === undefined) {
      throw new Error('SEC-07 admin identity was not seated');
    }
    const headers = { cookie: adminCookie };
    const codePayload = (worldId: string) => ({
      worldId,
      name: 'Secure Seven Air',
      iataCode: 'ZQ',
      icaoCode: 'SZQ',
    });
    const foundingPayload = (worldId: string) => ({
      ...codePayload(worldId),
      callsign: 'SECURE SEVEN',
      baseCountry: 'NL',
      hubIdent: 'SZAC',
    });

    const availability = await suite.app.inject({
      method: 'POST',
      url: '/api/airlines/code-availability',
      headers,
      payload: codePayload(suite.worldMain.id),
    });
    expect(availability.statusCode).toBe(200);

    for (const worldId of [ABSENT_RESOURCE_UUID, suite.airlineA.airline.id]) {
      for (const [endpoint, payload] of [
        ['/api/airlines/code-availability', codePayload(worldId)],
        ['/api/airlines', foundingPayload(worldId)],
      ] as const) {
        const response = await suite.app.inject({
          method: 'POST',
          url: endpoint,
          headers,
          payload,
        });
        expect(response.statusCode).toBe(404);
        expect(response.json()).toMatchObject({ code: 'world_not_found' });
      }
    }
    for (const malformed of MALFORMED_RESOURCE_IDS) {
      for (const [endpoint, payload] of [
        ['/api/airlines/code-availability', codePayload(malformed)],
        ['/api/airlines', foundingPayload(malformed)],
      ] as const) {
        const response = await suite.app.inject({
          method: 'POST',
          url: endpoint,
          headers,
          payload,
        });
        expect(response.statusCode).toBe(400);
      }
    }
    expect(await db.db.select().from(airline).where(eq(airline.playerId, adminPlayerId))).toEqual(
      [],
    );

    const founded = await suite.app.inject({
      method: 'POST',
      url: '/api/airlines',
      headers,
      payload: foundingPayload(suite.worldMain.id),
    });
    expect(founded.statusCode).toBe(201);
    extraAirlineId = founded.json<{ airline: { id: string } }>().airline.id;
  });

  it('refuses absent and wrong-entity UUIDs across every admin resource path', async () => {
    const adminCookie = suite.authorization.identities.admin.cookie;
    const playerId = suite.authorization.identities.playerA.playerId;
    if (adminCookie === undefined || playerId === null) {
      throw new Error('SEC-07 authorization identities were not seated');
    }
    const headers = { cookie: adminCookie };
    const requests: {
      name: string;
      wrongEntityId: string;
      request: (id: string) => InjectOptions;
    }[] = [
      {
        name: 'player detail',
        wrongEntityId: suite.worldMain.id,
        request: (id) => ({ method: 'GET', url: `/api/admin/players/${id}` }),
      },
      {
        name: 'player session revocation',
        wrongEntityId: suite.worldMain.id,
        request: (id) => ({ method: 'POST', url: `/api/admin/players/${id}/sessions/revoke` }),
      },
      {
        name: 'airline detail',
        wrongEntityId: playerId,
        request: (id) => ({ method: 'GET', url: `/api/admin/airlines/${id}` }),
      },
      {
        name: 'airline identity remedy',
        wrongEntityId: playerId,
        request: (id) => ({
          method: 'PATCH',
          url: `/api/admin/airlines/${id}/identity`,
          payload: {
            name: 'Untouched Airline',
            callsign: 'UNTOUCHED',
            reason: 'SEC-07 wrong-entity refusal',
          },
        }),
      },
      {
        name: 'world speed',
        wrongEntityId: playerId,
        request: (id) => ({
          method: 'POST',
          url: `/api/admin/worlds/${id}/speed`,
          payload: { speedMultiplier: 3, expectedSpeedMultiplier: 2 },
        }),
      },
      {
        name: 'world status',
        wrongEntityId: playerId,
        request: (id) => ({
          method: 'POST',
          url: `/api/admin/worlds/${id}/status`,
          payload: { status: 'locked', expectedStatus: 'open' },
        }),
      },
      {
        name: 'world reset',
        wrongEntityId: playerId,
        request: (id) => ({
          method: 'POST',
          url: `/api/admin/worlds/${id}/reset`,
          payload: {
            confirmName: 'No such world',
            reason: 'SEC-07 wrong-entity refusal',
            expectedStatus: 'open',
          },
        }),
      },
      {
        name: 'world economy pin',
        wrongEntityId: playerId,
        request: (id) => ({
          method: 'POST',
          url: `/api/admin/worlds/${id}/economy-config`,
          payload: {
            version: ECONOMY_CONFIG_V1_VERSION,
            expectedVersion: ECONOMY_CONFIG_V1_VERSION,
          },
        }),
      },
      {
        name: 'world NPC report',
        wrongEntityId: playerId,
        request: (id) => ({ method: 'GET', url: `/api/admin/worlds/${id}/npc` }),
      },
    ];
    const before = {
      player: await db.db.select().from(player).where(eq(player.id, playerId)),
      world: await db.db.select().from(world).where(eq(world.id, suite.worldMain.id)),
    };

    for (const descriptor of requests) {
      const responses = await Promise.all(
        [ABSENT_RESOURCE_UUID, descriptor.wrongEntityId].map((id) =>
          suite.app.inject({ ...descriptor.request(id), headers }),
        ),
      );
      for (const response of responses) {
        expect(response.statusCode, `${descriptor.name}: ${response.body}`).toBe(404);
      }
      expect(responses[0]?.body, descriptor.name).toBe(responses[1]?.body);
    }
    expect({
      player: await db.db.select().from(player).where(eq(player.id, playerId)),
      world: await db.db.select().from(world).where(eq(world.id, suite.worldMain.id)),
    }).toEqual(before);
  });
});
