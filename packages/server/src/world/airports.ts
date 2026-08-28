import { eq } from 'drizzle-orm';

import { airport } from '../db/schema';

import type { Database } from '../db/client';

/**
 * The airports the world map draws (§22.2, the world view).
 *
 * Reference data, not world state: the airport table is the same for every world,
 * so this is a plain global read with no ownership. It returns the **served**
 * airports — the ones OurAirports marks with scheduled service, ~4,400 of ~86,000
 * — because those are the cities a flight game cares about, and shipping every
 * closed strip and heliport would be a multi-megabyte payload of dots nobody flies
 * to. Position is `[lon, lat]` so the client can hand it straight to deck.gl.
 *
 * The list never changes within a process (a re-import needs a restart anyway), so
 * it is read once and memoised — the map fetches it on every load.
 */
export interface WorldAirportRecord {
  /** `[longitude, latitude]`, ready for deck.gl. */
  position: [number, number];
  name: string;
  iata: string | null;
  kind: string;
}

let cache: Promise<WorldAirportRecord[]> | null = null;

export async function readWorldAirports(db: Database): Promise<WorldAirportRecord[]> {
  cache ??= db
    .select({
      longitude: airport.longitude,
      latitude: airport.latitude,
      name: airport.name,
      iata: airport.iataCode,
      kind: airport.kind,
    })
    .from(airport)
    .where(eq(airport.scheduledService, true))
    .then((rows) =>
      rows.map((row) => ({
        position: [row.longitude, row.latitude] as [number, number],
        name: row.name,
        iata: row.iata,
        kind: row.kind,
      })),
    );
  return cache;
}

/** Test seam: drop the memoised list so a fresh read runs. */
export function resetWorldAirportsCache(): void {
  cache = null;
}
