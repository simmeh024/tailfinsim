import type { WorldHub } from './map-api';
import type { LngLat } from './terminator';

/**
 * Client-side route-reach hints for the world map's "open a route" flow (M7).
 *
 * The server is authoritative: `POST /api/routes` runs the real App. B.4
 * seven-check reachability and refuses with the reason. This module only draws the
 * *hint* the map shows **before** the click — which airports the player's own
 * aircraft could reach from a hub, so an in-range field reads differently from one
 * that is out of range, and the panel can say how far short a distant one falls.
 *
 * `packages/web` may not import `@tailfin/sim`, so the great-circle maths and the
 * 1.06 route factor are replicated here rather than imported. Kept deliberately
 * simple — a hub-to-airport great circle against the fleet's longest range — and
 * the server still has the final say on runway, curfew, traffic rights and slots.
 */

/** App. B.4's route factor: the flown distance is a little longer than the great circle. */
export const ROUTE_FACTOR = 1.06;

const EARTH_RADIUS_NM = 3440.065;
const RAD = Math.PI / 180;

/** Great-circle distance between two `[lon, lat]` points, in nautical miles. */
export function haversineNm([lon1, lat1]: LngLat, [lon2, lat2]: LngLat): number {
  const dLat = (lat2 - lat1) * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_NM * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** The longest range among the player's owned aircraft, or 0 with no fleet. */
export function fleetMaxRangeNm(
  airframes: readonly { typeDesignation: string }[],
  catalogue: readonly { designation: string; rangeNm: number }[],
): number {
  const rangeByType = new Map(catalogue.map((entry) => [entry.designation, entry.rangeNm]));
  let max = 0;
  for (const airframe of airframes) {
    const range = rangeByType.get(airframe.typeDesignation);
    if (range !== undefined && range > max) max = range;
  }
  return max;
}

export interface HubReach {
  hub: WorldHub;
  distanceNm: number;
  /** Whether the fleet's longest range covers this hub-to-airport leg (× route factor). */
  reachable: boolean;
}

/**
 * The best hub to fly from to reach `airport`: the nearest hub the fleet can
 * actually make, or — if none is in range — the nearest hub of all, marked out of
 * range so the panel can say how much further the airport is than the fleet flies.
 * `null` only when the player has no hub yet.
 */
export function bestHub(
  airport: LngLat,
  hubs: readonly WorldHub[],
  maxRangeNm: number,
): HubReach | null {
  let nearest: HubReach | null = null;
  let nearestReachable: HubReach | null = null;
  for (const hub of hubs) {
    const distanceNm = haversineNm(hub.position, airport);
    const reachable = distanceNm * ROUTE_FACTOR <= maxRangeNm;
    if (nearest === null || distanceNm < nearest.distanceNm) {
      nearest = { hub, distanceNm, reachable };
    }
    if (reachable && (nearestReachable === null || distanceNm < nearestReachable.distanceNm)) {
      nearestReachable = { hub, distanceNm, reachable };
    }
  }
  return nearestReachable ?? nearest;
}

/**
 * The ICAOs of every airport at least one hub can reach, for the map's highlight.
 * Empty with no fleet or no hub — nothing is in range, so nothing is lit.
 */
export function reachableAirportIcaos(
  airports: readonly { icao: string; position: LngLat }[],
  hubs: readonly WorldHub[],
  maxRangeNm: number,
): Set<string> {
  const reachable = new Set<string>();
  if (maxRangeNm <= 0 || hubs.length === 0) return reachable;
  for (const airport of airports) {
    for (const hub of hubs) {
      if (haversineNm(hub.position, airport.position) * ROUTE_FACTOR <= maxRangeNm) {
        reachable.add(airport.icao);
        break;
      }
    }
  }
  return reachable;
}
