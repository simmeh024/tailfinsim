import type { LngLat } from './terminator';

/**
 * The player's own map overlay — hubs and routes — from `GET /api/world/map`.
 *
 * World-scoped and behind the airline guard, so a player with no airline (the
 * globe renders before anyone founds one) gets a 409. Like the clock, that is an
 * ordinary pre-founding state and resolves to an empty overlay rather than
 * throwing: the map still draws, just without the player's own routes on it.
 * A failure that is *not* an answer resolves to `null` — see below.
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
  /** The carrier's brand colour (`#RRGGBB`), for its plane/mark and route line. */
  colour: string;
}

/**
 * One aeroplane actually in the air (WORLD-10).
 *
 * The server sends the two game-time instants rather than a position, because
 * the overlay refreshes once a minute and the browser already runs the world's
 * clock: a position would freeze the whole fleet between refreshes, while two
 * instants let it fly.
 */
export interface WorldMapFlight extends WorldMapRoute {
  airlineId: string;
  airlineName: string;
  own: boolean;
  colour: string;
  registration: string | null;
  typeDesignation: string | null;
  scheduledDeparture: string;
  departedAt: string;
  arrivesAt: string;
}

export interface WorldMapData {
  hubs: WorldHub[];
  routes: WorldMapRoute[];
  traffic: WorldMapTrafficRoute[];
  flights: WorldMapFlight[];
}

export const EMPTY_WORLD_MAP: WorldMapData = { hubs: [], routes: [], traffic: [], flights: [] };

/**
 * Read the player's overlay.
 *
 * ## Empty and unknown are different answers, and WORLD-06 needs them to be
 *
 * This used to resolve to an empty overlay for *every* failure. On a single
 * read at mount that was right — a player with no airline gets a 409 through
 * the airline guard, and "nothing to draw yet" is the truth.
 *
 * Once the overlay refreshes on a timer it is no longer right: one dropped
 * request would wipe a drawn map and the player would watch their whole network
 * vanish for a minute. So:
 *
 *   - **401 or 409** — a real answer. No session or no airline, so there is
 *     genuinely nothing to draw, and the map draws nothing.
 *   - **anything else** — `null`, meaning *unknown*. The caller keeps whatever
 *     it last had.
 */
export async function fetchWorldMap(): Promise<WorldMapData | null> {
  let response: Response;
  try {
    response = await fetch('/api/world/map', {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
    });
  } catch {
    return null;
  }
  if (response.status === 401 || response.status === 409) return EMPTY_WORLD_MAP;
  if (!response.ok) return null;
  const body: unknown = await response.json().catch(() => null);
  if (body === null) return null;
  const data = body as Partial<WorldMapData>;
  return {
    hubs: Array.isArray(data.hubs) ? data.hubs : [],
    routes: Array.isArray(data.routes) ? data.routes : [],
    traffic: Array.isArray(data.traffic) ? data.traffic : [],
    // Defaulted, so a client ahead of its server draws a map with no aeroplanes
    // rather than throwing on the first render.
    flights: Array.isArray(data.flights) ? data.flights : [],
  };
}
