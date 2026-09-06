import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import {
  SERVICE_CATEGORIES,
  SERVICE_LADDERS,
  ServicePackageContent,
  validateServicePackage,
  type CreateRouteGroupRequest,
  type RouteGroupsResponse,
  type RouteGroupSummary,
  type ServiceCatalogueResponse,
  type ServicePackageSummary,
  type ServiceSelectionProblem,
  type UpdateRouteGroupRequest,
  type WriteServicePackageRequest,
  type EconomyConfig,
} from '@tailfin/shared';

import { route, routeGroup, routeGroupMember, servicePackage, world } from '../db/schema';
import { loadEconomyConfig } from '../economy/loader';

import type { ResolvedPlayerAirline } from '../airline/context';
import type { Database } from '../db/client';

/**
 * Service packages and route groups (M8-03, App. D.2 and D.5).
 *
 * Everything here is **owner-scoped by query**, not by a check after the fact:
 * every statement carries `airline_id = <the session's airline>`, so a package
 * or group belonging to somebody else is not found rather than found and
 * refused. That is ADR-0020's rule, and it is what makes the 404 on a
 * cross-owner id identical to the 404 on an id that never existed.
 *
 * ## The catalogue is the world's, not the build's
 *
 * `readCatalogue` merges the ladders from `@tailfin/shared` with the prices from
 * the **world's pinned** `EconomyConfig.service`. Two worlds on different
 * economy versions see different prices for the same named tier, which is the
 * whole point of the balance living in a pinned payload — and it is why the
 * catalogue is an endpoint rather than a constant the client could bundle.
 *
 * ## What a route group resolves to
 *
 * {@link servicePackageForRoutes} is the answer to App. D.5's promise that a
 * package *"applies to all flights in it"*. A `flight` row carries no route id —
 * it carries an airline and an airport pair, and `route`'s unique
 * `(airline_id, origin_icao, destination_icao)` is what turns that back into one
 * route. So the resolution is keyed on the pair, and a flight inherits its
 * service from the group its route sits in without anything being copied onto
 * the flight.
 */

/** The catalogue as one world sees it: shared ladders, that world's prices. */
export function catalogueFrom(economy: EconomyConfig): ServiceCatalogueResponse {
  return {
    categories: SERVICE_CATEGORIES.map((category) => ({
      category,
      tiers: SERVICE_LADDERS[category].map((definition) => {
        const balance = economy.service.categories[category].tiers[definition.tier];
        return {
          tier: definition.tier,
          name: definition.name,
          requires: definition.requires.map((requirement) => ({ ...requirement })),
          // A ladder longer than its priced counterpart cannot happen against a
          // stored config — the schema requires one rung per tier — but the type
          // is an array, so the absent case is answered rather than asserted.
          costPerPaxMinor: balance?.costPerPaxMinor ?? 0,
          revenuePerPaxMinor: balance?.revenuePerPaxMinor ?? 0,
          scoreBand: balance?.scoreBand ?? { min: 0, max: 0 },
          turnaroundDeltaMinutes: balance?.turnaroundDeltaMinutes ?? 0,
        };
      }),
    })),
    commercialIntensity: { ...economy.service.commercialIntensity },
  };
}

/** The catalogue for the airline's world, priced by the version that world pins. */
export async function readCatalogue(
  db: Database,
  own: ResolvedPlayerAirline,
): Promise<ServiceCatalogueResponse> {
  const [worldRow] = await db
    .select({ economyConfigVersion: world.economyConfigVersion })
    .from(world)
    .where(eq(world.id, own.worldId))
    .limit(1);
  if (worldRow === undefined) throw new Error(`airline ${own.id} has no world`);
  const economy = await loadEconomyConfig(db, worldRow.economyConfigVersion);
  return catalogueFrom(economy);
}

/** Parse a stored `content` payload, or null when this build cannot read it. */
function readContent(raw: unknown): ServicePackageContent | null {
  const parsed = ServicePackageContent.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * The airline's packages, each with how many groups hold it.
 *
 * A grouped count rather than a correlated subquery in the select list, which
 * has come back empty against real PostgreSQL before (CLAUDE.md records it) and
 * is the pattern `countWorldContents` and `listPlayers` already avoid.
 */
export async function listPackages(
  db: Database,
  own: ResolvedPlayerAirline,
): Promise<ServicePackageSummary[]> {
  const rows = await db
    .select()
    .from(servicePackage)
    .where(eq(servicePackage.airlineId, own.id))
    .orderBy(servicePackage.name);

  const counts = new Map<string, number>();
  if (rows.length > 0) {
    const grouped = await db
      .select({ packageId: routeGroup.servicePackageId, held: sql<number>`count(*)::int` })
      .from(routeGroup)
      .where(
        and(
          eq(routeGroup.airlineId, own.id),
          inArray(
            routeGroup.servicePackageId,
            rows.map((row) => row.id),
          ),
        ),
      )
      .groupBy(routeGroup.servicePackageId);
    for (const entry of grouped) {
      if (entry.packageId !== null) counts.set(entry.packageId, entry.held);
    }
  }

  return rows.flatMap((row) => {
    const content = readContent(row.content);
    // A package this build cannot parse is omitted rather than returned broken —
    // the same rule `wireAirline` applies to an unsupported logo. The row is
    // untouched, so a build that understands it again lists it again.
    if (content === null) return [];
    return [
      {
        id: row.id,
        name: row.name,
        content,
        assignedGroups: counts.get(row.id) ?? 0,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      },
    ];
  });
}

/** Why a write was refused. */
export type ServiceWriteFailure =
  | { code: 'invalid_selection'; problems: ServiceSelectionProblem[] }
  | { code: 'duplicate_name' }
  | { code: 'not_found' }
  | { code: 'package_in_use'; groups: string[] }
  | { code: 'unknown_routes'; routeIds: string[] };

export type ServiceWriteResult<T> =
  { ok: true; value: T } | { ok: false; failure: ServiceWriteFailure };

/** Postgres' unique-violation code, walked out of drizzle's wrapper. */
function isUniqueViolation(error: unknown): boolean {
  let cause: unknown = error;
  for (let depth = 0; depth < 5 && cause !== null && cause !== undefined; depth += 1) {
    if (
      typeof cause === 'object' &&
      'code' in cause &&
      (cause as { code?: string }).code === '23505'
    )
      return true;
    cause = (cause as { cause?: unknown }).cause;
  }
  return false;
}

export async function createPackage(
  db: Database,
  own: ResolvedPlayerAirline,
  request: WriteServicePackageRequest,
): Promise<ServiceWriteResult<ServicePackageSummary>> {
  const problems = validateServicePackage(request.content);
  if (problems.length > 0) return { ok: false, failure: { code: 'invalid_selection', problems } };

  try {
    const [row] = await db
      .insert(servicePackage)
      .values({
        worldId: own.worldId,
        airlineId: own.id,
        name: request.name,
        content: request.content,
      })
      .returning();
    if (row === undefined) throw new Error('insert returned no row');
    return {
      ok: true,
      value: {
        id: row.id,
        name: row.name,
        content: request.content,
        assignedGroups: 0,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      },
    };
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, failure: { code: 'duplicate_name' } };
    throw error;
  }
}

export async function updatePackage(
  db: Database,
  own: ResolvedPlayerAirline,
  packageId: string,
  request: WriteServicePackageRequest,
): Promise<ServiceWriteResult<ServicePackageSummary>> {
  const problems = validateServicePackage(request.content);
  if (problems.length > 0) return { ok: false, failure: { code: 'invalid_selection', problems } };

  try {
    const [row] = await db
      .update(servicePackage)
      .set({ name: request.name, content: request.content, updatedAt: new Date() })
      // Scoped by owner, so somebody else's package is not found rather than refused.
      .where(and(eq(servicePackage.id, packageId), eq(servicePackage.airlineId, own.id)))
      .returning();
    if (row === undefined) return { ok: false, failure: { code: 'not_found' } };
    const held = await db
      .select({ held: sql<number>`count(*)::int` })
      .from(routeGroup)
      .where(and(eq(routeGroup.airlineId, own.id), eq(routeGroup.servicePackageId, row.id)));
    return {
      ok: true,
      value: {
        id: row.id,
        name: row.name,
        content: request.content,
        assignedGroups: held[0]?.held ?? 0,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      },
    };
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, failure: { code: 'duplicate_name' } };
    throw error;
  }
}

/**
 * Delete a package, unless a route group still flies it.
 *
 * Refused rather than cascaded to null: silently emptying a group's service
 * because a package was tidied away elsewhere is a change to what the airline
 * serves, made by a delete that did not mention it. The 409 names the groups so
 * the player knows where to look.
 */
export async function deletePackage(
  db: Database,
  own: ResolvedPlayerAirline,
  packageId: string,
): Promise<ServiceWriteResult<null>> {
  const holders = await db
    .select({ name: routeGroup.name })
    .from(routeGroup)
    .where(and(eq(routeGroup.airlineId, own.id), eq(routeGroup.servicePackageId, packageId)))
    .orderBy(routeGroup.name);
  if (holders.length > 0) {
    return {
      ok: false,
      failure: { code: 'package_in_use', groups: holders.map((holder) => holder.name) },
    };
  }
  const deleted = await db
    .delete(servicePackage)
    .where(and(eq(servicePackage.id, packageId), eq(servicePackage.airlineId, own.id)))
    .returning({ id: servicePackage.id });
  return deleted.length === 0
    ? { ok: false, failure: { code: 'not_found' } }
    : { ok: true, value: null };
}

/** The airline's groups, their routes, and the routes in no group at all. */
export async function listRouteGroups(
  db: Database,
  own: ResolvedPlayerAirline,
): Promise<RouteGroupsResponse> {
  const groups = await db
    .select({
      id: routeGroup.id,
      name: routeGroup.name,
      servicePackageId: routeGroup.servicePackageId,
      servicePackageName: servicePackage.name,
      createdAt: routeGroup.createdAt,
      updatedAt: routeGroup.updatedAt,
    })
    .from(routeGroup)
    .leftJoin(servicePackage, eq(servicePackage.id, routeGroup.servicePackageId))
    .where(eq(routeGroup.airlineId, own.id))
    .orderBy(routeGroup.name);

  const members = await db
    .select({
      groupId: routeGroupMember.routeGroupId,
      routeId: route.id,
      originIcao: route.originIcao,
      destinationIcao: route.destinationIcao,
    })
    .from(routeGroupMember)
    .innerJoin(route, eq(route.id, routeGroupMember.routeId))
    .innerJoin(routeGroup, eq(routeGroup.id, routeGroupMember.routeGroupId))
    .where(eq(routeGroup.airlineId, own.id))
    .orderBy(route.originIcao, route.destinationIcao);

  const byGroup = new Map<string, RouteGroupSummary['routes']>();
  for (const member of members) {
    const list = byGroup.get(member.groupId) ?? [];
    list.push({
      routeId: member.routeId,
      originIcao: member.originIcao,
      destinationIcao: member.destinationIcao,
    });
    byGroup.set(member.groupId, list);
  }

  const ungrouped = await db
    .select({
      routeId: route.id,
      originIcao: route.originIcao,
      destinationIcao: route.destinationIcao,
    })
    .from(route)
    .leftJoin(routeGroupMember, eq(routeGroupMember.routeId, route.id))
    .where(and(eq(route.airlineId, own.id), isNull(routeGroupMember.routeId)))
    .orderBy(route.originIcao, route.destinationIcao);

  return {
    groups: groups.map((group) => ({
      id: group.id,
      name: group.name,
      servicePackageId: group.servicePackageId,
      servicePackageName: group.servicePackageName,
      routes: byGroup.get(group.id) ?? [],
      createdAt: group.createdAt.toISOString(),
      updatedAt: group.updatedAt.toISOString(),
    })),
    ungrouped,
  };
}

/** Every one of these route ids that is not this airline's, in request order. */
async function foreignRoutes(
  db: Database,
  own: ResolvedPlayerAirline,
  routeIds: readonly string[],
): Promise<string[]> {
  if (routeIds.length === 0) return [];
  const owned = await db
    .select({ id: route.id })
    .from(route)
    .where(and(eq(route.airlineId, own.id), inArray(route.id, [...routeIds])));
  const known = new Set(owned.map((row) => row.id));
  return routeIds.filter((id) => !known.has(id));
}

export async function createRouteGroup(
  db: Database,
  own: ResolvedPlayerAirline,
  request: CreateRouteGroupRequest,
): Promise<ServiceWriteResult<RouteGroupSummary>> {
  const routeIds = [...new Set(request.routeIds ?? [])];
  const foreign = await foreignRoutes(db, own, routeIds);
  if (foreign.length > 0) {
    return { ok: false, failure: { code: 'unknown_routes', routeIds: foreign } };
  }

  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(routeGroup)
        .values({ worldId: own.worldId, airlineId: own.id, name: request.name })
        .returning();
      if (row === undefined) throw new Error('insert returned no row');
      if (routeIds.length > 0) {
        // A route belongs to one group, so joining this one is leaving another.
        await tx.delete(routeGroupMember).where(inArray(routeGroupMember.routeId, routeIds));
        await tx
          .insert(routeGroupMember)
          .values(routeIds.map((routeId) => ({ routeGroupId: row.id, routeId })));
      }
      return {
        ok: true as const,
        value: {
          id: row.id,
          name: row.name,
          servicePackageId: null,
          servicePackageName: null,
          routes: [],
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        },
      };
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, failure: { code: 'duplicate_name' } };
    throw error;
  }
}

/**
 * Replace a group's name, membership and package.
 *
 * Membership is replaced whole rather than added to, because a route sits in at
 * most one group: an add is always also a removal from wherever it was, and two
 * calls for one move is two chances to leave it half-done. An absent `routeIds`
 * leaves membership alone; a present one is the complete list.
 */
export async function updateRouteGroup(
  db: Database,
  own: ResolvedPlayerAirline,
  groupId: string,
  request: UpdateRouteGroupRequest,
): Promise<ServiceWriteResult<null>> {
  const routeIds = request.routeIds === undefined ? undefined : [...new Set(request.routeIds)];
  if (routeIds !== undefined) {
    const foreign = await foreignRoutes(db, own, routeIds);
    if (foreign.length > 0) {
      return { ok: false, failure: { code: 'unknown_routes', routeIds: foreign } };
    }
  }
  if (request.servicePackageId !== undefined && request.servicePackageId !== null) {
    const [owned] = await db
      .select({ id: servicePackage.id })
      .from(servicePackage)
      .where(
        and(eq(servicePackage.id, request.servicePackageId), eq(servicePackage.airlineId, own.id)),
      )
      .limit(1);
    // Somebody else's package is as unavailable as one that does not exist.
    if (owned === undefined) return { ok: false, failure: { code: 'not_found' } };
  }

  try {
    return await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: routeGroup.id })
        .from(routeGroup)
        .where(and(eq(routeGroup.id, groupId), eq(routeGroup.airlineId, own.id)))
        .limit(1);
      if (existing === undefined)
        return { ok: false as const, failure: { code: 'not_found' as const } };

      await tx
        .update(routeGroup)
        .set({
          ...(request.name === undefined ? {} : { name: request.name }),
          ...(request.servicePackageId === undefined
            ? {}
            : { servicePackageId: request.servicePackageId }),
          updatedAt: new Date(),
        })
        .where(and(eq(routeGroup.id, groupId), eq(routeGroup.airlineId, own.id)));

      if (routeIds !== undefined) {
        await tx.delete(routeGroupMember).where(eq(routeGroupMember.routeGroupId, groupId));
        if (routeIds.length > 0) {
          await tx.delete(routeGroupMember).where(inArray(routeGroupMember.routeId, routeIds));
          await tx
            .insert(routeGroupMember)
            .values(routeIds.map((routeId) => ({ routeGroupId: groupId, routeId })));
        }
      }
      return { ok: true as const, value: null };
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, failure: { code: 'duplicate_name' } };
    throw error;
  }
}

/** Remove a group. Its routes fall back to the baseline product, not to another group. */
export async function deleteRouteGroup(
  db: Database,
  own: ResolvedPlayerAirline,
  groupId: string,
): Promise<ServiceWriteResult<null>> {
  const deleted = await db
    .delete(routeGroup)
    .where(and(eq(routeGroup.id, groupId), eq(routeGroup.airlineId, own.id)))
    .returning({ id: routeGroup.id });
  return deleted.length === 0
    ? { ok: false, failure: { code: 'not_found' } }
    : { ok: true, value: null };
}

/* ---- Resolution: which package does a flight fly under? ------------------ */

/** One route's service, as the simulation needs it. */
export interface ResolvedRouteService {
  routeId: string;
  originIcao: string;
  destinationIcao: string;
  routeGroupId: string;
  routeGroupName: string;
  servicePackageId: string;
  servicePackageName: string;
  content: ServicePackageContent;
}

/**
 * The package each of these routes flies under — App. D.5's *"applies to all
 * flights in it"*, resolved rather than copied.
 *
 * Keyed by route id, and a route with no group, or whose group has no package,
 * is **absent from the map** rather than present with a null. Those two states
 * are the same outcome — the baseline product — and giving them a shape of their
 * own would invite a caller to treat "no package" as an empty package, which is
 * a package the player wrote and which costs and scores accordingly.
 *
 * One query. A flight carries no route id, so a settlement resolving service
 * per flight would otherwise do this per flight; taking a list keeps that a
 * single round trip whatever the tick is holding.
 */
export async function servicePackageForRoutes(
  db: Database,
  airlineId: string,
  routeIds: readonly string[],
): Promise<Map<string, ResolvedRouteService>> {
  if (routeIds.length === 0) return new Map();
  const rows = await db
    .select({
      routeId: route.id,
      originIcao: route.originIcao,
      destinationIcao: route.destinationIcao,
      routeGroupId: routeGroup.id,
      routeGroupName: routeGroup.name,
      servicePackageId: servicePackage.id,
      servicePackageName: servicePackage.name,
      content: servicePackage.content,
    })
    .from(route)
    .innerJoin(routeGroupMember, eq(routeGroupMember.routeId, route.id))
    .innerJoin(routeGroup, eq(routeGroup.id, routeGroupMember.routeGroupId))
    .innerJoin(servicePackage, eq(servicePackage.id, routeGroup.servicePackageId))
    .where(and(eq(route.airlineId, airlineId), inArray(route.id, [...routeIds])));

  const resolved = new Map<string, ResolvedRouteService>();
  for (const row of rows) {
    const content = readContent(row.content);
    if (content === null) continue;
    resolved.set(row.routeId, { ...row, content });
  }
  return resolved;
}

/**
 * The package a flight flies under, found from its airport pair.
 *
 * `flight` stores an airline and an origin/destination pair, not a route id, and
 * `route`'s unique `(airline_id, origin_icao, destination_icao)` is what makes
 * that pair resolve to exactly one route. Returns null for a flight whose route
 * is in no group, or whose group holds no package.
 */
export async function servicePackageForFlight(
  db: Database,
  flightRow: { airlineId: string; originIcao: string; destinationIcao: string },
): Promise<ResolvedRouteService | null> {
  const [row] = await db
    .select({ id: route.id })
    .from(route)
    .where(
      and(
        eq(route.airlineId, flightRow.airlineId),
        eq(route.originIcao, flightRow.originIcao),
        eq(route.destinationIcao, flightRow.destinationIcao),
      ),
    )
    .limit(1);
  if (row === undefined) return null;
  const resolved = await servicePackageForRoutes(db, flightRow.airlineId, [row.id]);
  return resolved.get(row.id) ?? null;
}
