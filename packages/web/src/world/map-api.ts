import type { LngLat } from './terminator';

/**
 * The player's own map overlay — hubs and routes — from `GET /api/world/map`.
 *
 * World-scoped and behind the airline guard, so a player with no airline (the
 * globe renders before anyone founds one) gets a 409. Like the clock, that is an
 * ordinary pre-founding state, so it — and any transport failure — resolves to an
 * empty overlay rather than throwing: the map still draws, just without the
 * player's own routes on it.
 */
export interface WorldHub {
  position: LngLat;
  icao: string;
  name: string;
}

export interface WorldMapRoute {
  id: string;
  source: LngLat;
  target: LngLat;
  originIcao: string;
  destinationIcao: string;
  originName: string;
  destinationName: string;
}

/**
 * One live route flown by some carrier in the world — the data behind a plane icon.
 * The player's own routes carry `own: true`; NPC (and any other player's) routes
 * carry `own: false`, so the map can colour and label them apart.
 */
export interface WorldMapTrafficRoute extends WorldMapRoute {
  airlineId: string;
  airlineName: string;
  own: boolean;
}

export interface WorldMapData {
  hubs: WorldHub[];
  routes: WorldMapRoute[];
  traffic: WorldMapTrafficRoute[];
}

const EMPTY: WorldMapData = { hubs: [], routes: [], traffic: [] };

export async function fetchWorldMap(): Promise<WorldMapData> {
  let response: Response;
  try {
    response = await fetch('/api/world/map', {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
    });
  } catch {
    return EMPTY;
  }
  if (!response.ok) return EMPTY;
  const body: unknown = await response.json().catch(() => null);
  const data = body as Partial<WorldMapData> | null;
  return {
    hubs: Array.isArray(data?.hubs) ? data.hubs : [],
    routes: Array.isArray(data?.routes) ? data.routes : [],
    traffic: Array.isArray(data?.traffic) ? data.traffic : [],
  };
}
