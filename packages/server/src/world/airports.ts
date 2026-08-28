import { isNotNull } from 'drizzle-orm';

import { airport } from '../db/schema';

import type { Database } from '../db/client';

/**
 * The airports the world map draws (§22.2, the world view).
 *
 * Reference data, not world state: the airport table is the same for every world,
 * so this is a plain global read with no ownership. It returns every airport a
 * player could serve — the ones with a **classified tier** (App. B.3), ~4,045 of
 * ~86,000, which is exactly the set that has a demand pool and so can be a route
 * endpoint. An airstrip with no service has no tier and is not a city anyone flies
 * to, so it is left off. Position is `[lon, lat]`, ready for deck.gl, and the tier
 * comes along so the map can size a flagship larger than a regional field.
 *
 * The list never changes within a process (a re-import needs a restart anyway), so
 * it is read once and memoised — the map fetches it on every load.
 */
export interface WorldAirportRecord {
  /** `[longitude, latitude]`, ready for deck.gl. */
  position: [number, number];
  name: string;
  iata: string | null;
  /** App. B.3 tier — flagship, large, medium, small, regional. Never null here. */
  tier: string;
}

let cache: Promise<WorldAirportRecord[]> | null = null;

export async function readWorldAirports(db: Database): Promise<WorldAirportRecord[]> {
  cache ??= db
    .select({
      longitude: airport.longitude,
      latitude: airport.latitude,
      name: airport.name,
      iata: airport.iataCode,
      tier: airport.tier,
    })
    .from(airport)
    .where(isNotNull(airport.tier))
    .then((rows) =>
      rows.map((row) => ({
        position: [row.longitude, row.latitude] as [number, number],
        name: row.name,
        iata: row.iata,
        tier: row.tier ?? 'regional',
      })),
    );
  return cache;
}

/** Test seam: drop the memoised list so a fresh read runs. */
export function resetWorldAirportsCache(): void {
  cache = null;
}
