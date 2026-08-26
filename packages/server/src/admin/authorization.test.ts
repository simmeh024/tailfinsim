import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FLAGSHIP_CONFIG } from '@tailfin/shared';

import { createDatabase, type DatabaseHandle } from '../db/client';
import { adminAudit, adminGrant, airline, economyConfig, session, world } from '../db/schema';
import { type ServerEnv } from '../env';
import {
  createAuthorizationTestSuite,
  type AuthorizationTestSuite,
} from '../test-fixtures/authorization';
import { collectRegisteredRoutes, isAdminRoute } from '../test-fixtures/route-inventory';
import { createWorld } from '../world/lifecycle';

import type { WorldRow } from '../db/schema';
import type { InjectOptions } from 'fastify';

/**
 * Every admin endpoint, proven closed to guests and players (SEC-04).
 *
 * These are the highest-consequence endpoints in the product.
 * `POST /api/admin/worlds/:worldId/reset` destroys every airline in a world and
 * rewinds its clock, and there is no undo. The console hides the admin link from
 * a non-admin, but that is a courtesy rather than a control — the only thing
 * between a signed-in player and that endpoint is one `onRequest` hook.
 *
 * The coverage that existed before this file was hand-written per module and
 * uneven: `worlds`, `speed`, `lifecycle`, `players` and `health` each asserted a
 * route or two, while `overview`, `audit` and `admins` had no such test at all.
 * Worse, it could not notice a *new* route, which is the way a gap actually
 * arrives.
 *
 * So the list of routes here is taken from the router rather than written down.
 * `authorization-inventory.test.ts` proves that list agrees with
 * `docs/authorization-matrix.md`; this proves the running server agrees with
 * both. Adding an admin route without a guard now fails here without anyone
 * having to remember this file exists.
 *
 * **401 and 403 are asserted separately**, because collapsing them into "not
 * 200" would hide a guard answering the wrong one. ADR-0020 owns that
 * vocabulary: 401 is no valid session, 403 is a valid identity without a
 * permission that is safe to disclose.
 */

const url = process.env.DATABASE_URL;
if (!url) {
  console.warn(
    '\n  [admin/authorization.test] DATABASE_URL not set — skipping admin gate tests.\n',
  );
}
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

/**
 * A syntactically valid id that resolves to nothing.
 *
 * The sweep below calls every admin route as the administrator too, and that is
 * only safe if the request cannot do anything. A well-formed id that matches no
 * row means the handler reaches its own 404 having changed nothing — which is
 * also the honest shape of the assertion, because a malformed id would be
 * refused by validation before the guard was ever the reason.
 */
const ABSENT_UUID = '00000000-0000-4000-8000-000000000000';
const ABSENT_VERSION = 'v-authorization-sweep-absent';

/** Path parameters, filled with values that resolve to nothing. */
function fillParams(path: string): string {
  return path.replaceAll(':version', ABSENT_VERSION).replaceAll(/:[A-Za-z]+/g, ABSENT_UUID);
}

/**
 * A request for a route that cannot succeed at doing anything.
 *
 * Write routes get an empty object rather than a plausible payload: validation
 * refuses it before the handler acts, so the sweep exercises the guard without
 * ever exercising the effect. The census in the sweep proves that claim rather
 * than trusting it.
 */
function syntheticRequest(method: string, path: string): InjectOptions {
  const request: InjectOptions = {
    method: method as InjectOptions['method'],
    url: fillParams(path),
  };
  if (method !== 'GET') return { ...request, payload: {} };
  return request;
}

/** Row counts that must not move while nobody is authorised to move them. */
async function census(db: DatabaseHandle) {
  const [worlds] = await db.db.select({ value: count() }).from(world);
  const [airlines] = await db.db.select({ value: count() }).from(airline);
  const [sessions] = await db.db.select({ value: count() }).from(session);
  const [grants] = await db.db.select({ value: count() }).from(adminGrant);
  const [configs] = await db.db.select({ value: count() }).from(economyConfig);
  return {
    worlds: worlds?.value ?? -1,
    airlines: airlines?.value ?? -1,
    sessions: sessions?.value ?? -1,
    grants: grants?.value ?? -1,
    economyConfigs: configs?.value ?? -1,
  };
}

async function auditCount(db: DatabaseHandle): Promise<number> {
  const [row] = await db.db.select({ value: count() }).from(adminAudit);
  return row?.value ?? -1;
}

describeDb('every admin endpoint is closed to guests and players (SEC-04)', () => {
  let db: DatabaseHandle;
  let authorization: AuthorizationTestSuite;
  let adminRoutes: { method: string; url: string; key: string }[];

  beforeAll(async () => {
    db = createDatabase();
    authorization = await createAuthorizationTestSuite({
      db,
      env,
      suite: 'admin-authorization',
    });
    adminRoutes = (await collectRegisteredRoutes()).filter((route) => isAdminRoute(route.url));
  });

  afterAll(async () => {
    await authorization.cleanup();
    await db.close();
  });

  it('sweeps a non-trivial number of admin routes', () => {
    // Guards the guard: an empty list would make every sweep below pass without
    // asserting anything at all.
    expect(adminRoutes.length).toBeGreaterThanOrEqual(20);
  });

  it('answers 401 to a guest on every admin route', async () => {
    const wrong: string[] = [];
    for (const route of adminRoutes) {
      const response = await authorization.app.inject(syntheticRequest(route.method, route.url));
      if (response.statusCode !== 401) wrong.push(`${route.key} → ${response.statusCode}`);
    }

    expect(
      wrong,
      `A guest must meet 401 on every admin route — no session, so nothing to disclose:\n  ${wrong.join('\n  ')}`,
    ).toEqual([]);
  });

  it('answers 403 to a signed-in non-admin on every admin route', async () => {
    /*
     * Both ordinary players, not one. They are indistinguishable to
     * `requireAdmin`, but asserting a single player would leave a guard that
     * happened to key off one particular id looking correct.
     */
    const wrong: string[] = [];
    for (const actor of ['playerA', 'playerB'] as const) {
      for (const route of adminRoutes) {
        const response = await authorization.app.inject({
          ...syntheticRequest(route.method, route.url),
          headers: { cookie: authorization.identities[actor].cookie! },
        });
        if (response.statusCode !== 403) {
          wrong.push(`${actor} ${route.key} → ${response.statusCode}`);
        }
      }
    }

    expect(
      wrong,
      `A signed-in player must meet 403 — a valid identity lacking a permission it is safe to name:\n  ${wrong.join('\n  ')}`,
    ).toEqual([]);
  });

  it('lets the administrator past the guard on every admin route', async () => {
    /*
     * The other half of the boundary, and the one that catches a guard applied
     * to the wrong thing. A route that answered 403 to everybody would satisfy
     * both sweeps above and be entirely broken.
     *
     * The assertion is "not refused" rather than an exact status, because these
     * requests carry absent ids and empty bodies on purpose: the interesting
     * answers are the handler's own 404 and 400, and pinning each one would be a
     * test of validation rather than of authorization.
     */
    const wrong: string[] = [];
    for (const route of adminRoutes) {
      const response = await authorization.app.inject({
        ...syntheticRequest(route.method, route.url),
        headers: { cookie: authorization.identities.admin.cookie! },
      });
      if (response.statusCode === 401 || response.statusCode === 403) {
        wrong.push(`${route.key} → ${response.statusCode}`);
      }
      if (response.statusCode >= 500) {
        wrong.push(`${route.key} → ${response.statusCode} (server error, not a boundary)`);
      }
    }

    expect(
      wrong,
      `An administrator must not be refused by the guard:\n  ${wrong.join('\n  ')}`,
    ).toEqual([]);
  });

  it('changes nothing while sweeping every admin route as every identity', async () => {
    /*
     * The safety net under the three sweeps above, and the reason it is safe to
     * point them at destructive endpoints at all.
     *
     * The admin sweep really does reach the handlers — that is the point of it —
     * so "the ids resolve to nothing and the bodies fail validation" needs to be
     * proven rather than asserted in a comment. If a reset ever ran, or a world
     * were created from an empty body, these counts would move.
     */
    const before = await census(db);
    for (const route of adminRoutes) {
      for (const cookie of [
        undefined,
        authorization.identities.playerA.cookie,
        authorization.identities.admin.cookie,
      ]) {
        await authorization.app.inject({
          ...syntheticRequest(route.method, route.url),
          ...(cookie === undefined ? {} : { headers: { cookie } }),
        });
      }
    }
    expect(await census(db)).toEqual(before);
  });

  it('writes no audit row for a refused request', async () => {
    /*
     * A refusal is not an action. The audit log is what §22 offers as the record
     * of what an administrator did, and filling it with requests that did
     * nothing would make the one entry that matters harder to find — while also
     * letting any signed-in player write to it at will.
     *
     * Only the refused identities are swept here. An administrator *reading*
     * `GET /api/admin/players/:playerId` deliberately writes an audit row —
     * disclosing a player's email is itself an act — so including the admin
     * would assert the opposite of the intended behaviour.
     */
    const before = await auditCount(db);
    for (const route of adminRoutes) {
      for (const cookie of [undefined, authorization.identities.playerB.cookie]) {
        await authorization.app.inject({
          ...syntheticRequest(route.method, route.url),
          ...(cookie === undefined ? {} : { headers: { cookie } }),
        });
      }
    }
    expect(await auditCount(db)).toBe(before);
  });

  it('conceals the player detail route, which discloses an email address', async () => {
    /*
     * Named separately from the sweep because of what it returns. §22's player
     * browser hands over a player's email, their linked identities and their
     * live sessions — the most privacy-sensitive read in the product, and the
     * one whose non-admin coverage was a single case before this.
     *
     * Asserted against a player id that certainly exists, so a 403 cannot be
     * mistaken for "there was nothing there anyway".
     */
    const target = authorization.identities.playerA.playerId!;
    await authorization.expectAuthorization({
      request: { method: 'GET', url: `/api/admin/players/${target}` },
      guest: 401,
      playerA: 403,
      playerB: 403,
      admin: 200,
    });

    const disclosed = await authorization.app.inject({
      method: 'GET',
      url: `/api/admin/players/${target}`,
      headers: { cookie: authorization.identities.playerB.cookie! },
    });
    expect(disclosed.body).not.toContain(authorization.identities.playerA.displayName);
  });

  describe('a refused destructive request leaves the world exactly as it was', () => {
    let worldId: string;
    let before: WorldRow;

    beforeAll(async () => {
      // Its own world, because this suite refuses destructive requests against
      // it and a shared one would make that a bet on test ordering.
      const created = await createWorld(db.db, {
        ...FLAGSHIP_CONFIG,
        name: `SEC-04 authorization ${Date.now().toString(36)}`,
      });
      worldId = created.world.id;
      before = created.world;
    });

    afterAll(async () => {
      await db.db.delete(world).where(eq(world.id, worldId));
    });

    /*
     * A 403 is necessary and not sufficient. These three routes re-anchor a live
     * clock, archive a world and destroy every airline in one; a guard that
     * answered 403 *after* doing the work would pass every assertion above.
     */
    /*
     * Real, well-formed payloads on purpose. A player is refused at the guard
     * before validation ever runs, so the point of a valid body is the
     * counterfactual: were the guard absent, *this* request would re-anchor the
     * clock, archive the world or destroy its airlines. `reset` needs the world's
     * own name and a reason; a placeholder body would be refused by validation
     * even past a broken guard, which would prove nothing.
     */
    it.each(['speed', 'status', 'reset'] as const)(
      'refuses %s to a guest and to a player, and changes nothing',
      async (path) => {
        // Built here, not in the `it.each` table: the table is evaluated at
        // collection time, before `beforeAll` has created the world whose name
        // the reset body needs.
        const body =
          path === 'speed'
            ? { speedMultiplier: 8, expectedSpeedMultiplier: 2 }
            : path === 'status'
              ? { status: 'archived' }
              : { confirmName: before.name, reason: 'SEC-04 negative test' };

        for (const cookie of [undefined, authorization.identities.playerA.cookie]) {
          const response = await authorization.app.inject({
            method: 'POST',
            url: `/api/admin/worlds/${worldId}/${path}`,
            payload: body,
            ...(cookie === undefined ? {} : { headers: { cookie } }),
          });
          expect(response.statusCode).toBe(cookie === undefined ? 401 : 403);
        }

        const [after] = await db.db.select().from(world).where(eq(world.id, worldId));
        expect(after).toEqual(before);
      },
    );
  });
});
