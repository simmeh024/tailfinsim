import type { ApronResponse } from '@tailfin/shared';

/**
 * The airport map's client (M7-07, App. B.7).
 *
 * One read. Leasing and releasing from the map go through the gates endpoints
 * `network/api.ts` already wraps (`leaseStand`, `releaseStand`), whose answer is
 * the `gates` half of this response — so a lease made on the map can be folded
 * into the picture without a second request.
 */

/** The apron, or null for an airport that does not exist (404). Throws on anything else. */
export async function fetchApron(icao: string): Promise<ApronResponse | null> {
  const response = await fetch(`/api/airports/${encodeURIComponent(icao)}/apron`, {
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`GET /api/airports/${icao}/apron failed with ${String(response.status)}`);
  }
  const body: unknown = await response.json();
  if (!isApronResponse(body)) {
    throw new Error(`GET /api/airports/${icao}/apron returned an unexpected body`);
  }
  return body;
}

/**
 * Is this actually an apron payload?
 *
 * The shape check `fetchResearch` and `fetchCrew` make, for their reason: the
 * shell's routing test stubs every unrecognised URL with `{}`, and a `200` with
 * the wrong body would otherwise crash the render two property accesses later.
 */
export function isApronResponse(value: unknown): value is ApronResponse {
  if (typeof value !== 'object' || value === null) return false;
  const body = value as Record<string, unknown>;
  return (
    typeof body.icao === 'string' &&
    typeof body.gameNow === 'string' &&
    typeof body.gates === 'object' &&
    body.gates !== null &&
    Array.isArray(body.aircraft) &&
    Array.isArray(body.runways)
  );
}
