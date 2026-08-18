import { distanceKm, TIER_WEIGHTS, type AirportTier, type CatchmentAirport } from './derive';

/**
 * The proximity connection boost.
 *
 * An airport sitting close to others is better connected than an identical one
 * in the middle of nowhere — passengers can be fed to it, crews and ground
 * handlers are shared, and a missed connection has somewhere to go. That is a
 * real advantage and it should show up in usage.
 *
 * ## The rule
 *
 *   - Airports within **15 km** of each other are neighbours.
 *   - Only `regional`, `small` and `medium` are boosted. Large and flagship
 *     airports are already the popular ones; a further boost there would widen a
 *     gap that is already the widest thing on the map.
 *   - **The boost can never let an airport overtake the tier above it.** A
 *     regional field beside two medium airports is a better regional field. It is
 *     not a medium airport, and no amount of neighbours makes it one.
 *
 * That last clause is the load-bearing one, and it is enforced structurally
 * rather than by choosing tame numbers: the boost is clamped so that
 *
 *     tierWeight × boost  <  weight of the tier above
 *
 * always holds, whatever the per-neighbour rate is later tuned to. `ceilingFor`
 * computes that bound from `TIER_WEIGHTS`, so changing the weights moves the
 * ceiling with them and the invariant cannot silently lapse. There is a test that
 * drives the rate absurdly high and checks the ordering still holds.
 */

/** Two airports this close share a catchment in practice, whatever their tiers. */
export const NEIGHBOUR_RADIUS_KM = 15;

/** Each neighbour adds this much, before the ceiling is applied. */
export const BOOST_PER_NEIGHBOUR = 0.06;

/** Neighbours past this add nothing — the fourth nearby airport is not news. */
export const MAX_COUNTED_NEIGHBOURS = 4;

/** Tiers that already dominate their markets and are left alone. */
const UNBOOSTED: ReadonlySet<AirportTier> = new Set<AirportTier>(['large', 'flagship']);

/** Ascending, so "the tier above" is a lookup rather than a switch. */
const TIER_ORDER: readonly AirportTier[] = ['regional', 'small', 'medium', 'large', 'flagship'];

/**
 * The largest boost this tier may receive without reaching the tier above.
 *
 * Strictly below, not equal: a boosted regional airport that exactly matched an
 * unboosted small one would make the tiers meaningless at the boundary, which is
 * the outcome the rule exists to prevent. The margin keeps it visibly beneath.
 */
export function ceilingFor(tier: AirportTier): number {
  if (UNBOOSTED.has(tier)) return 1;

  const position = TIER_ORDER.indexOf(tier);
  const above = TIER_ORDER[position + 1];
  if (above === undefined) return 1;

  const mine = TIER_WEIGHTS[tier];
  const theirs = TIER_WEIGHTS[above];
  if (mine <= 0 || theirs <= mine) return 1;

  // 0.98 of the way to the tier above, so the best-connected regional airport in
  // the world still sits below the worst-connected small one.
  const ceiling = (theirs / mine) * 0.98;
  return Math.max(1, ceiling);
}

export interface Connectivity {
  index: number;
  neighbours: number;
  /** True when the ceiling bit rather than the per-neighbour rate. */
  cappedByTier: boolean;
}

/**
 * Counts neighbours and turns the count into a multiplier.
 *
 * Exported separately from the whole-dataset pass so the rule can be tested on
 * numbers rather than on coordinates.
 */
export function connectivityFor(tier: AirportTier, neighbours: number): Connectivity {
  if (UNBOOSTED.has(tier)) {
    return { index: 1, neighbours, cappedByTier: false };
  }

  const counted = Math.min(Math.max(0, neighbours), MAX_COUNTED_NEIGHBOURS);
  const raw = 1 + BOOST_PER_NEIGHBOUR * counted;
  const ceiling = ceilingFor(tier);

  return {
    index: Math.min(raw, ceiling),
    neighbours,
    cappedByTier: raw > ceiling,
  };
}

/**
 * Computes connectivity for every airport in one pass.
 *
 * Same grid trick as the catchment allocation: 4,359 airports against each other
 * is 19 million pairs, and bucketing by a coarse cell makes it a few thousand
 * comparisons instead. 15 km is well under a degree everywhere, so one cell of
 * slack either side is enough.
 */
export function deriveConnectivity(
  airports: readonly CatchmentAirport[],
): Map<string, Connectivity> {
  const cellSize = 0.5;
  const grid = new Map<string, CatchmentAirport[]>();
  const key = (lat: number, lon: number): string =>
    `${String(Math.floor(lat / cellSize))}:${String(Math.floor(lon / cellSize))}`;

  for (const airport of airports) {
    const cell = key(airport.latitude, airport.longitude);
    const bucket = grid.get(cell);
    if (bucket) bucket.push(airport);
    else grid.set(cell, [airport]);
  }

  const result = new Map<string, Connectivity>();

  for (const airport of airports) {
    const latCell = Math.floor(airport.latitude / cellSize);
    const lonCell = Math.floor(airport.longitude / cellSize);
    let neighbours = 0;

    for (let dLat = -1; dLat <= 1; dLat += 1) {
      for (let dLon = -1; dLon <= 1; dLon += 1) {
        const bucket = grid.get(`${String(latCell + dLat)}:${String(lonCell + dLon)}`);
        if (!bucket) continue;
        for (const other of bucket) {
          if (other.id === airport.id) continue;
          const km = distanceKm(
            airport.latitude,
            airport.longitude,
            other.latitude,
            other.longitude,
          );
          if (km <= NEIGHBOUR_RADIUS_KM) neighbours += 1;
        }
      }
    }

    result.set(airport.id, connectivityFor(airport.tier, neighbours));
  }

  return result;
}

/**
 * The effective usage weight an airport carries after its boost.
 *
 * The number the ordering invariant is stated about, and what a demand model
 * should consult rather than re-deriving the product itself.
 */
export function effectiveUsageWeight(tier: AirportTier, connectivityIndex: number): number {
  return TIER_WEIGHTS[tier] * connectivityIndex;
}
