import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { ServicePackageContent } from '@tailfin/shared';

import { createDatabase, type DatabaseHandle } from '../db/client';
import { airport, route, routeGroupMember } from '../db/schema';
import { createAirportIdentities } from '../test-fixtures/airport-codes';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixture,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';

import {
  createPackage,
  createRouteGroup,
  deletePackage,
  listPackages,
  listRouteGroups,
  readCatalogue,
  servicePackageForFlight,
  servicePackageForRoutes,
  updateRouteGroup,
} from './store';

import type { ResolvedPlayerAirline } from '../airline/context';

/**
 * Service packages and route groups against real PostgreSQL (M8-03, App. D.5).
 *
 * The criterion this file exists for:
 *
 * > A package can be assigned to a route group and applies to all flights in it.
 *
 * "Applies to all flights in it" is the part that needs a database. A `flight`
 * row carries no route id — it carries an airline and an airport pair — so the
 * package reaches a flight through `route`'s unique
 * `(airline_id, origin_icao, destination_icao)` and then the group's membership.
 * That is three joins and a uniqueness guarantee, and none of it is provable in
 * memory. Requires `DATABASE_URL`; CI provides it.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [service/store.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

const nextAirport = createAirportIdentities('service/store');

function own(fixture: FoundedAirlineFixture): ResolvedPlayerAirline {
  return { id: fixture.airline.id, worldId: fixture.world.id, status: 'active' };
}

const BUDGET: ServicePackageContent = {
  perClass: { economy: { catering: 1, baggage_seating: 0, onboard_retail: 3 } },
  commercialIntensity: 0.5,
};
const PREMIUM: ServicePackageContent = {
  perClass: { economy: { catering: 3, baggage_seating: 3, ife_connectivity: 4 } },
  commercialIntensity: 0,
};

describeDb('service packages and route groups', () => {
  let db: DatabaseHandle;
  let fixtures: FoundedAirlineFixtureHarness;
  const madeAirports: string[] = [];

  beforeAll(() => {
    db = createDatabase();
    fixtures = createFoundedAirlineFixtureHarness(db.db);
  });

  afterEach(async () => {
    await fixtures.cleanup();
  });

  afterAll(async () => {
    for (const icao of madeAirports.splice(0)) {
      await db.db.delete(airport).where(eq(airport.icaoCode, icao));
    }
    await db.close();
  });

  async function makeAirport(): Promise<string> {
    const identity = nextAirport();
    await db.db.insert(airport).values({
      sourceId: identity.sourceId,
      ident: `TEST-${identity.icaoCode}`,
      icaoCode: identity.icaoCode,
      name: `Test Field ${identity.icaoCode}`,
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

  async function makeRoute(
    fixture: FoundedAirlineFixture,
    from: string,
    to: string,
  ): Promise<string> {
    const [row] = await db.db
      .insert(route)
      .values({
        worldId: fixture.world.id,
        airlineId: fixture.airline.id,
        originIcao: from,
        destinationIcao: to,
        greatCircleNm: 500,
      })
      .returning({ id: route.id });
    if (!row) throw new Error('no route');
    return row.id;
  }

  it('prices the catalogue from the world’s own pinned economy', async () => {
    const fixture = await fixtures.create();
    const catalogue = await readCatalogue(db.db, own(fixture));
    const catering = catalogue.categories.find((entry) => entry.category === 'catering');
    // App. D.1's ladder, arriving through the database rather than the bundle.
    expect(catering?.tiers).toHaveLength(6);
    expect(catering?.tiers[3]).toMatchObject({
      name: 'Hot meal service',
      costPerPaxMinor: 840,
      scoreBand: { min: 0.45, max: 0.62 },
    });
  });

  it('assigns a package to a route group, and every route in it flies it', async () => {
    const fixture = await fixtures.create();
    const hub = await makeAirport();
    const leisureA = await makeAirport();
    const leisureB = await makeAirport();
    const business = await makeAirport();

    const routeA = await makeRoute(fixture, hub, leisureA);
    const routeB = await makeRoute(fixture, hub, leisureB);
    const routeC = await makeRoute(fixture, hub, business);

    const pack = await createPackage(db.db, own(fixture), { name: 'Budget', content: BUDGET });
    expect(pack.ok).toBe(true);
    if (!pack.ok) return;

    const group = await createRouteGroup(db.db, own(fixture), {
      name: 'Leisure',
      routeIds: [routeA, routeB],
    });
    expect(group.ok).toBe(true);
    if (!group.ok) return;

    const assigned = await updateRouteGroup(db.db, own(fixture), group.value.id, {
      servicePackageId: pack.value.id,
    });
    expect(assigned.ok).toBe(true);

    // Both routes in the group resolve to the package; the one outside does not.
    const resolved = await servicePackageForRoutes(db.db, fixture.airline.id, [
      routeA,
      routeB,
      routeC,
    ]);
    expect(resolved.get(routeA)?.servicePackageId).toBe(pack.value.id);
    expect(resolved.get(routeB)?.servicePackageId).toBe(pack.value.id);
    expect(resolved.get(routeA)?.content).toEqual(BUDGET);
    // Absent, not present-with-null: no group is the baseline product.
    expect(resolved.has(routeC)).toBe(false);
  });

  it('reaches a flight through its airport pair, which is all a flight carries', async () => {
    const fixture = await fixtures.create();
    const hub = await makeAirport();
    const spoke = await makeAirport();
    const routeId = await makeRoute(fixture, hub, spoke);

    const pack = await createPackage(db.db, own(fixture), { name: 'Premium', content: PREMIUM });
    if (!pack.ok) throw new Error('no package');
    const group = await createRouteGroup(db.db, own(fixture), { name: 'Business' });
    if (!group.ok) throw new Error('no group');
    await updateRouteGroup(db.db, own(fixture), group.value.id, {
      routeIds: [routeId],
      servicePackageId: pack.value.id,
    });

    const forFlight = await servicePackageForFlight(db.db, {
      airlineId: fixture.airline.id,
      originIcao: hub,
      destinationIcao: spoke,
    });
    expect(forFlight?.servicePackageName).toBe('Premium');
    expect(forFlight?.content).toEqual(PREMIUM);

    // The other direction is a different route, and it is in no group.
    const returnLeg = await servicePackageForFlight(db.db, {
      airlineId: fixture.airline.id,
      originIcao: spoke,
      destinationIcao: hub,
    });
    expect(returnLeg).toBeNull();
  });

  it('moves a route out of its old group when it joins a new one', async () => {
    const fixture = await fixtures.create();
    const hub = await makeAirport();
    const spoke = await makeAirport();
    const routeId = await makeRoute(fixture, hub, spoke);

    const first = await createRouteGroup(db.db, own(fixture), {
      name: 'Morning',
      routeIds: [routeId],
    });
    if (!first.ok) throw new Error('no group');
    const second = await createRouteGroup(db.db, own(fixture), {
      name: 'Evening',
      routeIds: [routeId],
    });
    expect(second.ok).toBe(true);

    // One group per route is a database guarantee, not a convention: the second
    // join is also a departure from the first.
    const memberships = await db.db
      .select()
      .from(routeGroupMember)
      .where(eq(routeGroupMember.routeId, routeId));
    expect(memberships).toHaveLength(1);

    const listed = await listRouteGroups(db.db, own(fixture));
    expect(listed.groups.find((group) => group.name === 'Morning')?.routes).toEqual([]);
    expect(listed.groups.find((group) => group.name === 'Evening')?.routes).toHaveLength(1);
    expect(listed.ungrouped).toEqual([]);
  });

  it('lists a route in no group as ungrouped', async () => {
    const fixture = await fixtures.create();
    const hub = await makeAirport();
    const spoke = await makeAirport();
    await makeRoute(fixture, hub, spoke);

    const listed = await listRouteGroups(db.db, own(fixture));
    expect(listed.groups).toEqual([]);
    expect(listed.ungrouped).toHaveLength(1);
    expect(listed.ungrouped[0]).toMatchObject({ originIcao: hub, destinationIcao: spoke });
  });

  it('refuses another airline’s routes without writing anything', async () => {
    const mine = await fixtures.create();
    const theirs = await fixtures.create({ worldId: mine.world.id });
    const hub = await makeAirport();
    const spoke = await makeAirport();
    const theirRoute = await makeRoute(theirs, hub, spoke);

    const outcome = await createRouteGroup(db.db, own(mine), {
      name: 'Poaching',
      routeIds: [theirRoute],
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.code).toBe('unknown_routes');

    // Refused means nothing happened: no group, and their route is untouched.
    expect((await listRouteGroups(db.db, own(mine))).groups).toEqual([]);
    const memberships = await db.db
      .select()
      .from(routeGroupMember)
      .where(eq(routeGroupMember.routeId, theirRoute));
    expect(memberships).toEqual([]);
  });

  it('does not resolve another airline’s package onto your route', async () => {
    const mine = await fixtures.create();
    const theirs = await fixtures.create({ worldId: mine.world.id });
    const hub = await makeAirport();
    const spoke = await makeAirport();
    const myRoute = await makeRoute(mine, hub, spoke);

    const theirPack = await createPackage(db.db, own(theirs), {
      name: 'Theirs',
      content: PREMIUM,
    });
    if (!theirPack.ok) throw new Error('no package');
    const myGroup = await createRouteGroup(db.db, own(mine), {
      name: 'Mine',
      routeIds: [myRoute],
    });
    if (!myGroup.ok) throw new Error('no group');

    const outcome = await updateRouteGroup(db.db, own(mine), myGroup.value.id, {
      servicePackageId: theirPack.value.id,
    });
    // Somebody else's package is as unavailable as one that does not exist.
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure.code).toBe('not_found');
    expect(await servicePackageForRoutes(db.db, mine.airline.id, [myRoute])).toEqual(new Map());
  });

  it('refuses to delete a package a route group still flies, and names the group', async () => {
    const fixture = await fixtures.create();
    const pack = await createPackage(db.db, own(fixture), { name: 'In use', content: BUDGET });
    if (!pack.ok) throw new Error('no package');
    const group = await createRouteGroup(db.db, own(fixture), { name: 'Holiday' });
    if (!group.ok) throw new Error('no group');
    await updateRouteGroup(db.db, own(fixture), group.value.id, {
      servicePackageId: pack.value.id,
    });

    const refused = await deletePackage(db.db, own(fixture), pack.value.id);
    expect(refused.ok).toBe(false);
    if (!refused.ok && refused.failure.code === 'package_in_use') {
      expect(refused.failure.groups).toEqual(['Holiday']);
    } else {
      throw new Error('expected package_in_use');
    }
    expect(await listPackages(db.db, own(fixture))).toHaveLength(1);

    // Clearing the assignment releases it.
    await updateRouteGroup(db.db, own(fixture), group.value.id, { servicePackageId: null });
    expect((await deletePackage(db.db, own(fixture), pack.value.id)).ok).toBe(true);
    expect(await listPackages(db.db, own(fixture))).toEqual([]);
  });

  it('counts how many groups hold each package', async () => {
    const fixture = await fixtures.create();
    const pack = await createPackage(db.db, own(fixture), { name: 'Shared', content: BUDGET });
    if (!pack.ok) throw new Error('no package');
    for (const name of ['One', 'Two']) {
      const group = await createRouteGroup(db.db, own(fixture), { name });
      if (!group.ok) throw new Error('no group');
      await updateRouteGroup(db.db, own(fixture), group.value.id, {
        servicePackageId: pack.value.id,
      });
    }
    const listed = await listPackages(db.db, own(fixture));
    expect(listed[0]?.assignedGroups).toBe(2);
  });

  it('refuses a second package with the same name', async () => {
    const fixture = await fixtures.create();
    expect((await createPackage(db.db, own(fixture), { name: 'Same', content: BUDGET })).ok).toBe(
      true,
    );
    const second = await createPackage(db.db, own(fixture), { name: 'Same', content: PREMIUM });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.failure.code).toBe('duplicate_name');
  });

  it('refuses an incoherent package before it reaches the database', async () => {
    const fixture = await fixtures.create();
    const outcome = await createPackage(db.db, own(fixture), {
      name: 'Duvet and no dinner',
      content: { perClass: { economy: { amenities: 3 } }, commercialIntensity: 0 },
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure.code).toBe('invalid_selection');
    expect(await listPackages(db.db, own(fixture))).toEqual([]);
  });
});
