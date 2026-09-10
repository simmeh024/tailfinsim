/**
 * `GET /api/routes/:routeId/cargo` — the belly a route is worth (M8-15, §12.1).
 *
 * §12.1's requirement is not the arithmetic, it is the visibility: *"the game
 * should make that discoverable rather than stated"*. So this projects the same
 * functions the departure loads against, over the same world, and adds nothing of
 * its own — a preview that quietly used different coefficients from the
 * settlement would be worse than no preview, because a player would price
 * against it.
 *
 * ## Two halves, honestly separated
 *
 * The **lane** is a property of the market. It answers on a world with no fleet,
 * no worker and no flights, because it is a statement about what freight moves
 * between two cities and what it pays.
 *
 * The **belly** is a property of your aeroplane, and there is no honest answer
 * without one. Rather than invent a reference airframe to fill the gap — which
 * would let a player price against an aeroplane they do not own — that half is
 * `null` and the client says so.
 *
 * ## Which aeroplane
 *
 * Whichever the caller names, or the airline's most recently delivered aircraft
 * in service. A named one is scoped by airline and world in the same predicate,
 * so somebody else's airframe is indistinguishable from one that does not exist
 * (ADR-0020) — the concealment happens in the query rather than in a check
 * afterwards.
 */

import { and, desc, eq } from 'drizzle-orm';

import { RouteCargoResponse, Uuid, type RouteCargoResponse as Response } from '@tailfin/shared';
import type { CargoLane } from '@tailfin/sim';

import { airframe } from '../db/schema';
import { loadWorldEconomyConfig } from '../economy/loader';

import { cargoLaneFor, planBellyCargo } from './plan';

import type { Database } from '../db/client';

/** The route this reads, as `ownedRoute` already resolves it. */
export interface CargoRouteRow {
  id: string;
  worldId: string;
  airlineId: string;
  originIcao: string;
  destinationIcao: string;
}

/** An airframe the caller owns, or the two ways there isn't one. */
type AirframeChoice =
  | { status: 'chosen'; id: string; typeDesignation: string; registration: string }
  /** The airline owns nothing this could measure — an empty state, not a refusal. */
  | { status: 'fleetless' }
  /** A named id the caller may not see, or one that is not a uuid at all. */
  | { status: 'refused' };

/**
 * Assemble the projection, or `null` when there is nothing the caller may see.
 *
 * `null` covers an `airframeId` the caller does not own, one that is malformed,
 * and a route whose airports are missing from the world. The endpoint turns all
 * three into its own identical 404: a query parameter naming somebody else's
 * aeroplane must not be distinguishable from one naming nothing.
 */
export async function routeCargo(
  db: Database,
  row: CargoRouteRow,
  airframeId?: string,
): Promise<Response | null> {
  const economy = await loadWorldEconomyConfig(db, row.worldId);

  const choice = await chooseAirframe(db, row, airframeId);
  if (choice.status === 'refused') return null;

  if (choice.status === 'fleetless') {
    const resolved = await cargoLaneFor(db, row.originIcao, row.destinationIcao, economy.cargo);
    if (resolved === null) return null;
    return RouteCargoResponse.parse({
      ...laneView(row, resolved.distanceNm, resolved.lane, resolved.reverse),
      belly: null,
    });
  }

  const plan = await planBellyCargo(db, {
    worldId: row.worldId,
    airframeId: choice.id,
    originIcao: row.originIcao,
    destinationIcao: row.destinationIcao,
    economy,
  });
  if (plan === null) return null;

  return RouteCargoResponse.parse({
    ...laneView(row, plan.distanceNm, plan.lane, plan.reverseLane),
    belly: {
      airframeId: choice.id,
      typeDesignation: choice.typeDesignation,
      registration: choice.registration,
      cargoVolumeFactor: plan.cargoVolumeFactor,
      plannedPassengers: plan.passengers,
      fuelTonnes: plan.fuelTonnes,
      availableTonnes: plan.capacity.availableTonnes,
      limit: plan.capacity.limit,
      allowances: plan.capacity.allowances,
      volume: plan.capacity.volume,
      detail: plan.capacity.detail,
      carriedTonnes: plan.carriedTonnes,
      revenueMinor: plan.revenueMinor,
      // The round trip's other half, at the same tonnage. §12.2's trap is that
      // these are two different numbers, so the client is given both rather than
      // left to assume the leg it is looking at is representative.
      reverseRevenueMinor: Math.round(plan.carriedTonnes * plan.reverseLane.ratePerTonneMinor),
    },
  });
}

/** The market half, identical on both paths. */
function laneView(
  row: CargoRouteRow,
  distanceNm: number,
  lane: CargoLane,
  reverse: CargoLane,
): Omit<Response, 'belly'> {
  return {
    routeId: row.id,
    originIcao: row.originIcao,
    destinationIcao: row.destinationIcao,
    distanceNm,
    direction: lane.direction,
    imbalance: lane.imbalance,
    ratePerTonneMinor: lane.ratePerTonneMinor,
    reverseRatePerTonneMinor: lane.reverseRatePerTonneMinor,
    offeredTonnes: lane.offeredTonnes,
    reverseOfferedTonnes: reverse.offeredTonnes,
    laneDetail: lane.detail,
  };
}

/**
 * The airframe to measure.
 *
 * `in_service` only when picking a default. An aeroplane in a C-check is not a
 * thing to plan a hold against and a grounded one is not going anywhere, so
 * answering a capacity question with either would be answering about an aircraft
 * that cannot fly. A **named** airframe is not filtered that way: a player asking
 * about a specific aeroplane is asking about that aeroplane, and refusing because
 * it happens to be in a hangar this week would hide the answer they wanted.
 */
async function chooseAirframe(
  db: Database,
  row: CargoRouteRow,
  airframeId?: string,
): Promise<AirframeChoice> {
  const columns = {
    id: airframe.id,
    typeDesignation: airframe.typeDesignation,
    registration: airframe.registration,
  };

  if (airframeId !== undefined) {
    // Parsed before the query: Postgres' uuid type error would turn an ordinary
    // miss into a 500, and a malformed id must read the same as a foreign one.
    if (!Uuid.safeParse(airframeId).success) return { status: 'refused' };

    const [named] = await db
      .select(columns)
      .from(airframe)
      .where(
        and(
          eq(airframe.id, airframeId),
          eq(airframe.airlineId, row.airlineId),
          eq(airframe.worldId, row.worldId),
        ),
      )
      .limit(1);
    return named ? { status: 'chosen', ...named } : { status: 'refused' };
  }

  const [newest] = await db
    .select(columns)
    .from(airframe)
    .where(
      and(
        eq(airframe.airlineId, row.airlineId),
        eq(airframe.worldId, row.worldId),
        eq(airframe.status, 'in_service'),
      ),
    )
    // Registration as the tie-break, so the default is stable rather than
    // whatever Postgres felt like returning that day (invariant 2). Ordering by
    // the structural payload — which is the figure a cargo question really wants
    // — lives inside the JSON `effective_spec` and would need an expression
    // index to stay cheap; the client can name an airframe explicitly instead.
    .orderBy(desc(airframe.deliveredAt), desc(airframe.registration))
    .limit(1);

  return newest ? { status: 'chosen', ...newest } : { status: 'fleetless' };
}
