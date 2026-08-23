import type {
  ApiError,
  AircraftAcquisitionInput,
  AircraftAcquisitionQuoteInput,
  AircraftAcquisitionQuoteResponse,
  AircraftAcquisitionResponse,
  AirframeDetailResponse,
  FleetAirframesResponse,
  FleetCatalogueResponse,
  UsedMarketResponse,
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

export interface FleetApiRefusal extends ApiError {
  status: number;
}

export type FleetApiOutcome<T> = { ok: true; value: T } | { ok: false; refusal: FleetApiRefusal };

async function postJson<T>(path: string, input: unknown): Promise<FleetApiOutcome<T>> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(input),
  });
  const body: unknown = await response.json();
  if (response.ok) return { ok: true, value: body as T };
  if (
    (response.status === 400 ||
      response.status === 404 ||
      response.status === 409 ||
      response.status === 422) &&
    typeof (body as Partial<ApiError>).code === 'string' &&
    typeof (body as Partial<ApiError>).message === 'string'
  ) {
    const refusal = body as ApiError;
    return { ok: false, refusal: { ...refusal, status: response.status } };
  }
  throw new Error(`POST ${path} failed with ${String(response.status)}`);
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

export async function fetchUsedMarket(): Promise<UsedMarketResponse> {
  const body = await readJson('/api/fleet/used-market');
  const listings = (body as { listings?: unknown }).listings;
  if (!Array.isArray(listings)) {
    throw new Error('GET /api/fleet/used-market did not return a list of aircraft');
  }
  return body as UsedMarketResponse;
}

export function quoteAircraft(
  input: AircraftAcquisitionQuoteInput,
): Promise<FleetApiOutcome<AircraftAcquisitionQuoteResponse>> {
  return postJson('/api/fleet/acquisition-quotes', input);
}

export function acquireAircraft(
  input: AircraftAcquisitionInput,
): Promise<FleetApiOutcome<AircraftAcquisitionResponse>> {
  return postJson('/api/fleet/acquisitions', input);
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
