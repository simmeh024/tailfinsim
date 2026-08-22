import type {
  AirframeDetailResponse,
  FleetAirframesResponse,
  FleetCatalogueResponse,
} from '@tailfin/shared';

/**
 * The fleet page's half of the client API (M4-02, M4-07).
 *
 * Types only, as everywhere else in the client, so the zod schemas stay out of
 * the bundle. Nothing here decides whether an aircraft exists, what it can do, or
 * how overdue it is — that is the world's clock and the server's answer, and
 * `packages/web` may not import `@tailfin/sim` at all.
 */

async function readJson(path: string): Promise<unknown> {
  const response = await fetch(path, {
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
  });
  if (response.status !== 200) {
    throw new Error(`GET ${path} failed with ${String(response.status)}`);
  }
  return response.json();
}

export async function fetchFleetCatalogue(): Promise<FleetCatalogueResponse> {
  const body = await readJson('/api/fleet/catalogue');

  // Checked rather than cast, for the reason `network/api.ts` records: a cast
  // turns a malformed response into `undefined` and crashes the page on
  // `.length`, which reads as a blank screen rather than as a bad response.
  const types = (body as { types?: unknown }).types;
  if (!Array.isArray(types)) {
    throw new Error('GET /api/fleet/catalogue did not return a list of types');
  }
  return body as FleetCatalogueResponse;
}

export async function fetchFleetAirframes(): Promise<FleetAirframesResponse> {
  const body = await readJson('/api/fleet/airframes');
  const airframes = (body as { airframes?: unknown }).airframes;
  if (!Array.isArray(airframes)) {
    throw new Error('GET /api/fleet/airframes did not return a list of aircraft');
  }
  return body as FleetAirframesResponse;
}

export async function fetchAirframeDetail(airframeId: string): Promise<AirframeDetailResponse> {
  const body = await readJson(`/api/fleet/airframes/${encodeURIComponent(airframeId)}`);
  // The decomposition is the reason this endpoint exists, so its absence is a bad
  // response rather than an aircraft with nothing to say about itself.
  const spec = (body as { spec?: { steps?: unknown } }).spec;
  if (!spec || !Array.isArray(spec.steps)) {
    throw new Error('GET /api/fleet/airframes/:id did not return an effective spec');
  }
  return body as AirframeDetailResponse;
}
