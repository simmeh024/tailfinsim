import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type DatabaseHandle } from '../db/client';
import { airport, route } from '../db/schema';
import { type ServerEnv } from '../env';
import { createOwnershipTestSuite, type OwnershipTestSuite } from '../test-fixtures/ownership';

import type { InjectOptions } from 'fastify';

/**
 * Cross-player ownership on the route endpoints — the worked example (SEC-05).
 *
 * This is the pattern every owned endpoint is meant to copy, so it is written to
 * be copied: one fixture, three assertions per endpoint, and the one that
 * actually matters made explicit.
 *
 *   playerA → own route          → 200
 *   playerA → playerB's route     → 404, byte-identical to a missing id
 *   playerA → own OTHER-world route (same player id) → 404
 *
 * And, for the write, the target route's stored fares are **unchanged** after the
 * refusal. A handler that answered 404 after writing the row would pass the
 * status check and fail this — which is the whole reason the effect is asserted
 * and not just the code.
 *
 * The routes endpoints resolve ownership in the query — `ownedRoute` scopes its
 * select by the session-resolved airline id (`network/routes.ts`) — so a
 * stranger's route and a nonexistent one are the same 404, and there is never a
 * moment where an unowned row sits in memory to be leaked by a later log line.
 * These tests prove that from the outside.
 *
 * The cross-world case is the subtle one. `airlineAOther` belongs to *the same
 * player*, in a different world; with `worldMain` active the ownership query
 * scopes to `airlineA`, so playerA's own route in the other world is as concealed
 * as a competitor's. A guard that checked the player and forgot the world would
 * pass every other assertion here and fail this.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [cross-owner-routes.test] DATABASE_URL not set — skipping.\n');
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

const MALFORMED_ROUTE_ID = 'not-a-uuid';
const MISSING_ROUTE_ID = '00000000-0000-4000-8000-000000000000';
const STORED_FARES = JSON.stringify({ economy: 12_000 });

describeDb('cross-player ownership on the route endpoints (SEC-05)', () => {
  let db: DatabaseHandle;
  let suite: OwnershipTestSuite;
  const madeAirports: string[] = [];
  let ownRouteId: string;
  let competitorRouteId: string;
  let otherWorldRouteId: string;

  async function makeAirport(icaoCode: string, index: number): Promise<void> {
    const rows = await db.db
      .insert(airport)
      .values({
        sourceId: -(9_400_000 + index),
        ident: icaoCode,
        icaoCode,
        name: `SEC-05 Airport ${icaoCode}`,
        isoCountry: 'NL',
        kind: 'medium_airport',
        latitude: 52 + index / 10_000,
        longitude: 4 + index / 10_000,
        scheduledService: true,
        hasRunwayData: false,
        tier: 'medium',
      })
      .returning({ id: airport.id });
    const id = rows[0]?.id;
    if (!id) throw new Error(`no airport created for ${icaoCode}`);
    madeAirports.push(id);
  }

  // Routes are inserted, not opened: B.4's seven checks belong to the open-route
  // suite, and the AIR-11 "found, never insert" rule is about airlines, not the
  // routes hanging off them.
  async function insertRoute(
    worldId: string,
    airlineId: string,
    origin: string,
    destination: string,
  ): Promise<string> {
    const rows = await db.db
      .insert(route)
      .values({
        worldId,
        airlineId,
        originIcao: origin,
        destinationIcao: destination,
        greatCircleNm: 400,
        fares: STORED_FARES,
      })
      .returning({ id: route.id });
    const id = rows[0]?.id;
    if (!id) throw new Error('no route created');
    return id;
  }

  beforeAll(async () => {
    db = createDatabase();
    suite = await createOwnershipTestSuite({ db, env, suite: 'cross-owner-routes' });

    await makeAirport('CSXA', 0);
    await makeAirport('CSXB', 1);

    ownRouteId = await insertRoute(suite.worldMain.id, suite.airlineA.airline.id, 'CSXA', 'CSXB');
    competitorRouteId = await insertRoute(
      suite.worldMain.id,
      suite.airlineB.airline.id,
      'CSXA',
      'CSXB',
    );
    otherWorldRouteId = await insertRoute(
      suite.worldOther.id,
      suite.airlineAOther.airline.id,
      'CSXA',
      'CSXB',
    );
  });

  afterAll(async () => {
    // The fixture first: deleting its airlines cascades their routes, so the
    // airports are unreferenced by the time they are removed.
    await suite.cleanup();
    for (const id of madeAirports.splice(0)) {
      await db.db.delete(airport).where(eq(airport.id, id));
    }
    await db.close();
  });

  /** The endpoints under test, each as a request against a given route id. */
  const surfaces: { name: string; request: (routeId: string) => InjectOptions }[] = [
    {
      name: 'GET waterfall (read)',
      request: (routeId) => ({ method: 'GET', url: `/api/routes/${routeId}/waterfall` }),
    },
    {
      name: 'PUT fares (write)',
      request: (routeId) => ({
        method: 'PUT',
        url: `/api/routes/${routeId}/fares`,
        payload: { fares: { economy: 99_999 } },
      }),
    },
  ];

  it.each(surfaces)('$name lets playerA reach playerA’s own route', async ({ request }) => {
    const response = await suite.as(
      { actor: 'playerA', worldId: suite.worldMain.id },
      request(ownRouteId),
    );
    expect(response.statusCode).toBe(200);
  });

  it.each(surfaces)(
    '$name conceals playerB’s route from playerA, identically to a missing id',
    async ({ request }) => {
      const denied = await Promise.all(
        [competitorRouteId, MISSING_ROUTE_ID, MALFORMED_ROUTE_ID].map((routeId) =>
          suite.as({ actor: 'playerA', worldId: suite.worldMain.id }, request(routeId)),
        ),
      );

      for (const response of denied) {
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ code: 'not_found', message: 'No such route' });
      }
      // The point of ADR-0020: the three answers are byte-identical, so the
      // endpoint is not an oracle for which ids name a real route.
      expect(new Set(denied.map((response) => response.body)).size).toBe(1);
    },
  );

  it.each(surfaces)(
    '$name conceals playerA’s OTHER-world route while worldMain is active',
    async ({ request }) => {
      // Same player id, different world. The active-world header selects
      // airlineA, and the query scopes to it, so the player's own route in
      // worldOther is refused exactly as a stranger's is.
      const response = await suite.as(
        { actor: 'playerA', worldId: suite.worldMain.id },
        request(otherWorldRouteId),
      );
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ code: 'not_found', message: 'No such route' });
    },
  );

  it('leaves a refused route’s stored fares unchanged (the effect, not just the code)', async () => {
    const write = (routeId: string): InjectOptions => ({
      method: 'PUT',
      url: `/api/routes/${routeId}/fares`,
      payload: { fares: { economy: 99_999 } },
    });

    for (const routeId of [competitorRouteId, otherWorldRouteId]) {
      const response = await suite.as(
        { actor: 'playerA', worldId: suite.worldMain.id },
        write(routeId),
      );
      expect(response.statusCode).toBe(404);
    }

    // Neither refused route moved. Asserting the row is what separates a real
    // guard from one that answers 404 after writing.
    for (const routeId of [competitorRouteId, otherWorldRouteId]) {
      const rows = await db.db
        .select({ fares: route.fares })
        .from(route)
        .where(eq(route.id, routeId));
      expect(rows).toEqual([{ fares: STORED_FARES }]);
    }
  });

  it('rejects privileged fare-body fields before changing the stored row', async () => {
    const before = await db.db
      .select({ airlineId: route.airlineId, worldId: route.worldId, fares: route.fares })
      .from(route)
      .where(eq(route.id, ownRouteId));
    const response = await suite.as(
      { actor: 'playerA', worldId: suite.worldMain.id },
      {
        method: 'PUT',
        url: `/api/routes/${ownRouteId}/fares`,
        payload: {
          fares: { economy: 99_999 },
          airlineId: suite.airlineB.airline.id,
          worldId: suite.worldOther.id,
          cashMinor: 999_999_999,
          isAdmin: true,
          tokenHash: 'attacker-controlled-session-material',
        },
      },
    );

    expect(response.statusCode).toBe(400);
    expect(
      await db.db
        .select({ airlineId: route.airlineId, worldId: route.worldId, fares: route.fares })
        .from(route)
        .where(eq(route.id, ownRouteId)),
    ).toEqual(before);
  });
});
