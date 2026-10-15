import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RouteGroupSummary, RouteGroupsResponse, ServicePackagesResponse } from '@tailfin/shared';
import type { ServicePackageContent } from '@tailfin/shared';

import { createDatabase, type DatabaseHandle } from '../db/client';
import {
  airline,
  airport,
  cashMovement,
  ledgerEntry,
  route,
  routeGroup,
  routeGroupMember,
  servicePackage,
} from '../db/schema';
import { type ServerEnv } from '../env';
import { createAirportIdentities } from '../test-fixtures/airport-codes';
import { makeAuthedTestEnv } from '../test-fixtures/env';
import { createOwnershipTestSuite, type OwnershipTestSuite } from '../test-fixtures/ownership';
import {
  ABSENT_RESOURCE_UUID,
  MALFORMED_RESOURCE_IDS,
  resourceIdCases,
} from '../test-fixtures/resource-id';

import { createPackage, createRouteGroup, updateRouteGroup } from './store';

import type { ResolvedPlayerAirline } from '../airline/context';
import type { FoundedAirlineFixture } from '../test-fixtures/founded-airline';
import type { InjectOptions } from 'fastify';

/**
 * The service catalogue's lifecycle over HTTP (SURFACE-11, M8-03, SEC-07).
 *
 * The Service page now creates and deletes route groups and deletes packages,
 * and shows every refusal the server gives. This file is the proof the issue
 * asks for at the API boundary: **a refused write leaves packages, groups and
 * assignments unchanged** — the package rows, the group rows with the package
 * each one flies, and every route's membership — for the caller and for the
 * airline whose id was named. The money is checked too, though no service write
 * moves any: App. D's spending happens per passenger, at settlement.
 *
 * `store.test.ts` proves the same refusals one layer down; this one adds the
 * status, the body the page renders, and ADR-0020's identical 404.
 *
 * Requires `DATABASE_URL`; CI provides it.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [service/routes.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

const env: ServerEnv = makeAuthedTestEnv();
const nextAirport = createAirportIdentities('service/routes');

const NOT_FOUND = { code: 'not_found', message: 'No such service package or route group.' };

const BUDGET: ServicePackageContent = {
  perClass: { economy: { catering: 1, onboard_retail: 2 } },
  commercialIntensity: 0.25,
};

function own(fixture: FoundedAirlineFixture): ResolvedPlayerAirline {
  return { id: fixture.airline.id, worldId: fixture.world.id, status: 'active' };
}

describeDb('the service lifecycle endpoints (SURFACE-11)', () => {
  let db: DatabaseHandle;
  let suite: OwnershipTestSuite;
  const madeAirports: string[] = [];

  /** playerA's routes: one per test that needs a fresh one. */
  const routesA: string[] = [];
  /** playerB's route, which playerA must never be able to name. */
  let routeB = '';

  async function makeAirport(): Promise<string> {
    const identity = nextAirport();
    await db.db.insert(airport).values({
      sourceId: identity.sourceId,
      ident: identity.ident,
      icaoCode: identity.icaoCode,
      name: `Service Route Field ${identity.icaoCode}`,
      isoCountry: 'GB',
      kind: 'large_airport',
      latitude: 51.5,
      longitude: -0.1,
      scheduledService: true,
      hasRunwayData: false,
    });
    madeAirports.push(identity.icaoCode);
    return identity.icaoCode;
  }

  async function makeRoute(fixture: FoundedAirlineFixture, from: string, to: string) {
    const [row] = await db.db
      .insert(route)
      .values({
        worldId: fixture.world.id,
        airlineId: fixture.airline.id,
        originIcao: from,
        destinationIcao: to,
        greatCircleNm: 300,
      })
      .returning({ id: route.id });
    if (!row) throw new Error('no route');
    return row.id;
  }

  /**
   * Everything a refused service write must not have touched, for one airline.
   *
   * `updatedAt` is in it on purpose: an UPDATE that rewrote a row with its own
   * values would leave the values equal and still be a write.
   */
  async function stateOf(airlineId: string) {
    const packages = await db.db
      .select({
        id: servicePackage.id,
        name: servicePackage.name,
        content: servicePackage.content,
        updatedAt: servicePackage.updatedAt,
      })
      .from(servicePackage)
      .where(eq(servicePackage.airlineId, airlineId))
      .orderBy(servicePackage.id);
    const groups = await db.db
      .select({
        id: routeGroup.id,
        name: routeGroup.name,
        servicePackageId: routeGroup.servicePackageId,
        updatedAt: routeGroup.updatedAt,
      })
      .from(routeGroup)
      .where(eq(routeGroup.airlineId, airlineId))
      .orderBy(routeGroup.id);
    const memberships = await db.db
      .select({ routeId: routeGroupMember.routeId, routeGroupId: routeGroupMember.routeGroupId })
      .from(routeGroupMember)
      .innerJoin(route, eq(route.id, routeGroupMember.routeId))
      .where(eq(route.airlineId, airlineId))
      .orderBy(routeGroupMember.routeId);
    const [cash] = await db.db
      .select({ cashMinor: airline.cashMinor })
      .from(airline)
      .where(eq(airline.id, airlineId));
    const [movements] = await db.db
      .select({ n: count() })
      .from(cashMovement)
      .where(eq(cashMovement.airlineId, airlineId));
    const [lines] = await db.db
      .select({ n: count() })
      .from(ledgerEntry)
      .where(eq(ledgerEntry.airlineId, airlineId));
    return {
      packages,
      groups,
      memberships,
      cashMinor: cash?.cashMinor,
      movements: movements?.n,
      ledgerLines: lines?.n,
    };
  }

  /** Both airlines in the shared world, which every refusal here must leave alone. */
  async function bothStates() {
    return {
      a: await stateOf(suite.airlineA.airline.id),
      b: await stateOf(suite.airlineB.airline.id),
    };
  }

  function asA(request: InjectOptions) {
    return suite.as({ actor: 'playerA', worldId: suite.worldMain.id }, request);
  }

  /** A package, optionally flown by a new group holding these routes. */
  async function packageFlownBy(
    fixture: FoundedAirlineFixture,
    packageName: string,
    groupName: string | null,
    routeIds: string[] = [],
  ): Promise<{ packageId: string; groupId: string | null }> {
    const pack = await createPackage(db.db, own(fixture), { name: packageName, content: BUDGET });
    if (!pack.ok) throw new Error(`no package: ${pack.failure.code}`);
    if (groupName === null) return { packageId: pack.value.id, groupId: null };
    const group = await createRouteGroup(db.db, own(fixture), { name: groupName, routeIds });
    if (!group.ok) throw new Error(`no group: ${group.failure.code}`);
    const assigned = await updateRouteGroup(db.db, own(fixture), group.value.id, {
      servicePackageId: pack.value.id,
    });
    if (!assigned.ok) throw new Error(`not assigned: ${assigned.failure.code}`);
    return { packageId: pack.value.id, groupId: group.value.id };
  }

  beforeAll(async () => {
    db = createDatabase();
    suite = await createOwnershipTestSuite({ db, env, suite: 'service-routes' });
    const hub = await makeAirport();
    for (let index = 0; index < 4; index += 1) {
      routesA.push(await makeRoute(suite.airlineA, hub, await makeAirport()));
    }
    routeB = await makeRoute(suite.airlineB, hub, await makeAirport());
  });

  afterAll(async () => {
    // The airlines' packages, groups and routes cascade with them.
    await suite.cleanup();
    for (const icao of madeAirports.splice(0)) {
      await db.db.delete(airport).where(eq(airport.icaoCode, icao));
    }
    await db.close();
  });

  it('refuses to delete a package a group still flies, naming it, and changes nothing', async () => {
    const { packageId } = await packageFlownBy(suite.airlineA, 'Held', 'Holiday', [routesA[0]!]);
    const before = await bothStates();

    const response = await asA({ method: 'DELETE', url: `/api/service/packages/${packageId}` });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      code: 'package_in_use',
      message: 'Still flown by Holiday. Reassign those route groups first.',
    });
    // The package, the group still flying it, and the route still in the group.
    expect(await bothStates()).toEqual(before);
    expect(before.a.groups.find((group) => group.name === 'Holiday')?.servicePackageId).toBe(
      packageId,
    );
  });

  it('deletes a package once its group is gone — the path the refusal points to', async () => {
    const { packageId, groupId } = await packageFlownBy(suite.airlineA, 'Released', 'Brief');

    const group = await asA({ method: 'DELETE', url: `/api/service/route-groups/${groupId}` });
    expect(group.statusCode).toBe(204);
    expect(group.body).toBe('');

    const pack = await asA({ method: 'DELETE', url: `/api/service/packages/${packageId}` });
    expect(pack.statusCode).toBe(204);
    const listed = ServicePackagesResponse.parse(
      (await asA({ method: 'GET', url: '/api/service/packages' })).json(),
    );
    expect(listed.packages.map((entry) => entry.id)).not.toContain(packageId);
  });

  it.each([
    ['DELETE /api/service/packages/:id', 'package'],
    ['DELETE /api/service/route-groups/:id', 'group'],
  ] as const)(
    '%s conceals another airline’s id as a missing one, and changes nothing',
    async (_endpoint, kind) => {
      const mine = await packageFlownBy(suite.airlineA, `Mine ${kind}`, `Mine ${kind}`);
      const theirs = await packageFlownBy(suite.airlineB, `Theirs ${kind}`, `Theirs ${kind}`);
      // playerA's own airline in another world: the player matches, the world does not.
      const elsewhere = await packageFlownBy(
        suite.airlineAOther,
        `Elsewhere ${kind}`,
        `Elsewhere ${kind}`,
      );
      const path = kind === 'package' ? '/api/service/packages' : '/api/service/route-groups';
      const idOf = (made: { packageId: string; groupId: string | null }) =>
        kind === 'package' ? made.packageId : (made.groupId ?? '');
      const before = await bothStates();
      const elsewhereBefore = await stateOf(suite.airlineAOther.airline.id);

      const concealed = resourceIdCases({
        own: idOf(mine),
        anotherPlayer: idOf(theirs),
        // The other kind of service id, which exists and is playerA's own.
        wrongEntity: kind === 'package' ? (mine.groupId ?? '') : mine.packageId,
        absent: ABSENT_RESOURCE_UUID,
      })
        .filter(({ expected }) => expected === 'conceal')
        .map(({ id }) => id);
      const responses = [];
      for (const id of [...concealed, idOf(elsewhere)]) {
        responses.push(await asA({ method: 'DELETE', url: `${path}/${id}` }));
      }
      for (const response of responses) {
        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual(NOT_FOUND);
      }
      // ADR-0020: byte-identical, so the endpoint is no oracle for which ids exist.
      expect(new Set(responses.map((response) => response.body)).size).toBe(1);

      // A malformed id never reaches a query: a 404 (the handler's, or the
      // router's for one past Fastify's parameter ceiling), never a 500.
      for (const malformed of MALFORMED_RESOURCE_IDS) {
        const response = await asA({
          method: 'DELETE',
          url: `${path}/${encodeURIComponent(malformed)}`,
        });
        expect([400, 404]).toContain(response.statusCode);
      }
      expect(await bothStates()).toEqual(before);
      expect(await stateOf(suite.airlineAOther.airline.id)).toEqual(elsewhereBefore);
    },
  );

  it('creates a group from a name and routes, moving a route out of the group it was in', async () => {
    const [moving, staying] = [routesA[1]!, routesA[2]!];
    const old = await createRouteGroup(db.db, own(suite.airlineA), {
      name: 'Old home',
      routeIds: [moving, staying],
    });
    if (!old.ok) throw new Error('no group');
    const before = await stateOf(suite.airlineA.airline.id);

    const response = await asA({
      method: 'POST',
      url: '/api/service/route-groups',
      payload: { name: 'New home', routeIds: [moving] },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ name: 'New home', servicePackageId: null });
    // The snapshot every refusal below is compared with does see a real write —
    // so "unchanged" there is a measurement, not a comparison that cannot fail.
    const after = await stateOf(suite.airlineA.airline.id);
    expect(after.groups).toHaveLength(before.groups.length + 1);
    expect(after.memberships).not.toEqual(before.memberships);

    // The page re-reads rather than trusting the 201, and this is what it sees.
    const listed = RouteGroupsResponse.parse(
      (await asA({ method: 'GET', url: '/api/service/route-groups' })).json(),
    );
    const routeIdsOf = (name: string) =>
      listed.groups.find((group) => group.name === name)?.routes.map((entry) => entry.routeId);
    expect(routeIdsOf('New home')).toEqual([moving]);
    expect(routeIdsOf('Old home')).toEqual([staying]);
    // And the 201 already said so: the created group carries its routes, exactly
    // as the list reads them, rather than the `routes: []` it used to answer.
    expect(RouteGroupSummary.parse(response.json()).routes).toEqual(
      listed.groups.find((group) => group.name === 'New home')?.routes,
    );

    // Deleting it drops its route back to no group — the baseline product.
    const created = listed.groups.find((group) => group.name === 'New home');
    const deleted = await asA({
      method: 'DELETE',
      url: `/api/service/route-groups/${created?.id ?? ''}`,
    });
    expect(deleted.statusCode).toBe(204);
    const relisted = RouteGroupsResponse.parse(
      (await asA({ method: 'GET', url: '/api/service/route-groups' })).json(),
    );
    expect(relisted.groups.map((group) => group.name)).not.toContain('New home');
    expect(relisted.ungrouped.map((entry) => entry.routeId)).toContain(moving);
  });

  it('refuses a duplicate group name with a 409, and moves no route', async () => {
    const taken = await createRouteGroup(db.db, own(suite.airlineA), { name: 'Taken' });
    if (!taken.ok) throw new Error('no group');
    const holder = await createRouteGroup(db.db, own(suite.airlineA), {
      name: 'Holder',
      routeIds: [routesA[3]!],
    });
    if (!holder.ok) throw new Error('no group');
    const before = await bothStates();

    // The name collides; the route it names sits in another group. A partial
    // write would have moved the route before the name was refused.
    const response = await asA({
      method: 'POST',
      url: '/api/service/route-groups',
      payload: { name: 'Taken', routeIds: [routesA[3]] },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      code: 'duplicate_name',
      message: 'You already have one with that name.',
    });
    expect(await bothStates()).toEqual(before);
  });

  it('refuses another airline’s route with a 404, and writes nothing to either airline', async () => {
    const before = await bothStates();

    const response = await asA({
      method: 'POST',
      url: '/api/service/route-groups',
      payload: { name: 'Poaching', routeIds: [routesA[3], routeB] },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      code: 'unknown_routes',
      message: 'One or more of those routes is not yours.',
    });
    expect(await bothStates()).toEqual(before);
  });

  it('refuses a body the schema does not take with a 400, and writes nothing', async () => {
    const before = await bothStates();
    for (const payload of [
      {},
      { name: '   ' },
      { name: 'x'.repeat(61) },
      { name: 'Region', region: 'EU' },
      { name: 'Bad ids', routeIds: ['not-a-uuid'] },
      { name: 'Package too', routeIds: [], servicePackageId: ABSENT_RESOURCE_UUID },
    ]) {
      const response = await asA({ method: 'POST', url: '/api/service/route-groups', payload });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      expect(response.json()).toEqual({ code: 'invalid_input', message: 'Expected a group name' });
    }
    expect(await bothStates()).toEqual(before);
  });

  it('refuses all three writes for a restricted airline, and changes nothing', async () => {
    const theirs = await packageFlownBy(suite.airlineB, 'Restricted pack', 'Restricted group');
    await db.db
      .update(airline)
      .set({ status: 'restricted' })
      .where(eq(airline.id, suite.airlineB.airline.id));
    try {
      const before = await bothStates();
      const asB = (request: InjectOptions) =>
        suite.as({ actor: 'playerB', worldId: suite.worldMain.id }, request);

      for (const response of [
        await asB({ method: 'DELETE', url: `/api/service/packages/${theirs.packageId}` }),
        await asB({ method: 'DELETE', url: `/api/service/route-groups/${theirs.groupId ?? ''}` }),
        await asB({
          method: 'POST',
          url: '/api/service/route-groups',
          payload: { name: 'Fresh', routeIds: [routeB] },
        }),
      ]) {
        expect(response.statusCode).toBe(409);
        expect(response.json()).toEqual({
          code: 'airline_restricted',
          message: 'This airline is restricted and cannot make new commitments',
        });
      }
      expect(await bothStates()).toEqual(before);
    } finally {
      await db.db
        .update(airline)
        .set({ status: 'active' })
        .where(eq(airline.id, suite.airlineB.airline.id));
    }
  });
});
