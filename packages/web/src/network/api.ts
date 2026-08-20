import type { FarePreviewResponse, FareTable, SetFaresResponse } from '@tailfin/shared';

/**
 * The network pages' half of the client API (M3-09).
 *
 * Types only, as everywhere else in the client, so the zod schemas stay out of
 * the bundle.
 *
 * **Nothing here computes anything.** The projected share, the market average
 * and the price floor all arrive from the server, because invariant 1 makes the
 * server authoritative for economic outcomes and `packages/web` may not import
 * `@tailfin/sim` at all. That is not a limitation to work around — it is what
 * makes M3-09's "the preview uses the same sim code as resolution" true by
 * construction rather than by discipline.
 */

export interface RouteSummary {
  id: string;
  originIcao: string;
  destinationIcao: string;
  greatCircleNm: number;
  fares: FareTable;
  active: boolean;
}

async function json(path: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const response = await fetch(path, {
    ...init,
    headers: {
      accept: 'application/json',
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
    },
    credentials: 'same-origin',
  });
  return { status: response.status, body: await response.json() };
}

export async function fetchRoutes(): Promise<RouteSummary[]> {
  const { status, body } = await json('/api/routes');
  if (status !== 200) throw new Error(`GET /api/routes failed with ${String(status)}`);
  return (body as { routes: RouteSummary[] }).routes;
}

export async function previewFares(
  routeId: string,
  fares: FareTable,
): Promise<FarePreviewResponse> {
  const { status, body } = await json(`/api/routes/${routeId}/fares/preview`, {
    method: 'POST',
    body: JSON.stringify({ fares }),
  });
  if (status !== 200) throw new Error(`Preview failed with ${String(status)}`);
  return body as FarePreviewResponse;
}

/**
 * Save the fares, or find out why not.
 *
 * A 422 is **not** an error here — it is the server's considered answer, with
 * the floor attached. Throwing on it would lose exactly the information M3-09
 * requires the player to see, so it comes back as data.
 */
export async function saveFares(routeId: string, fares: FareTable): Promise<SetFaresResponse> {
  const { status, body } = await json(`/api/routes/${routeId}/fares`, {
    method: 'PUT',
    body: JSON.stringify({ fares }),
  });
  if (status !== 200 && status !== 422) {
    throw new Error(`Saving fares failed with ${String(status)}`);
  }
  return body as SetFaresResponse;
}

/** Why a route could not be opened, in the server's own words. */
export type OpenRouteFailure =
  | { kind: 'unknown-airport'; icao: string }
  | { kind: 'no-airline' }
  | { kind: 'same-airport' }
  | { kind: 'duplicate' }
  | { kind: 'unreachable'; reachability: { reason: string; detail: string } };

export type OpenRouteOutcome =
  { ok: true; routeId: string; greatCircleNm: number } | ({ ok: false } & OpenRouteFailure);

/**
 * Open a route, or find out which check refused it.
 *
 * A 422 and a 409 are answers, not errors — App. B.4 requires the player to be
 * told *which* of the seven checks failed, and throwing would discard exactly
 * that. Only a genuinely broken request throws.
 */
export async function openRoute(
  originIcao: string,
  destinationIcao: string,
): Promise<OpenRouteOutcome> {
  const { status, body } = await json('/api/routes', {
    method: 'POST',
    body: JSON.stringify({ originIcao, destinationIcao }),
  });

  if (status === 201) return body as OpenRouteOutcome;
  if (status === 409) return { ok: false, kind: 'duplicate' };
  if (status === 422) return body as OpenRouteOutcome;
  throw new Error(`Opening a route failed with ${String(status)}`);
}
