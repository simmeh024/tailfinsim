import type {
  CabinClass,
  FarePreviewResponse,
  FareTable,
  FareWaterfallResponse,
  SetFaresResponse,
} from '@tailfin/shared';

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

  // Checked rather than cast. A cast turns a malformed response into
  // `undefined` and hands it to the page as though it were a list, where it
  // crashes on `.length` — which is a blank screen for what is really "the
  // server said something unexpected". Failing here reaches the caller's
  // error state instead.
  const routes = (body as { routes?: unknown }).routes;
  if (!Array.isArray(routes)) {
    throw new Error('GET /api/routes did not return a list of routes');
  }
  return routes as RouteSummary[];
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
  | { kind: 'active-world-required' }
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
  if (status === 409) {
    const code = (body as { code?: unknown }).code;
    if (code === 'duplicate_route') return { ok: false, kind: 'duplicate' };
    if (code === 'airline_required') return { ok: false, kind: 'no-airline' };
    if (code === 'active_world_required') return { ok: false, kind: 'active-world-required' };
  }
  if (status === 422) return body as OpenRouteOutcome;
  throw new Error(`Opening a route failed with ${String(status)}`);
}

/**
 * Close a route — remove it from the network.
 *
 * The counterpart to {@link openRoute}. A 404 (someone else's route, or a stale
 * id) is the server's considered answer and would only mislead as a thrown error;
 * a genuinely broken request still throws.
 */
export async function closeRoute(routeId: string): Promise<{ ok: boolean }> {
  const { status } = await json(`/api/routes/${routeId}`, { method: 'DELETE' });
  if (status === 200) return { ok: true };
  if (status === 404 || status === 409) return { ok: false };
  throw new Error(`Closing a route failed with ${String(status)}`);
}

/** Who else sells this pair, and in which cabins. */
export interface RouteRival {
  id: string;
  cabins: CabinClass[];
}

/** The rival list arrives on every outcome, so the picker never disappears. */
export function rivalsOf(outcome: WaterfallOutcome): RouteRival[] {
  return outcome.ok ? outcome.waterfall.rivals : outcome.rivals;
}

/**
 * Why you are losing, or why the question does not apply (M3-10, App. A.9).
 *
 * The refusals are answers, not errors. "You have this route to yourself" is
 * the honest state of every route today — there are no AI carriers until
 * M3-12 — and a page that reported it as a failure would be lying about a
 * monopoly.
 */
export type WaterfallOutcome =
  | { ok: true; waterfall: FareWaterfallResponse }
  | { ok: false; kind: 'no-rival'; rivals: RouteRival[] }
  | { ok: false; kind: 'unknown-rival'; rivals: RouteRival[] }
  | { ok: false; kind: 'cabin-not-contested'; cabin: CabinClass; rivals: RouteRival[] };

export async function fetchWaterfall(
  routeId: string,
  cabin: CabinClass,
  rival?: string,
): Promise<WaterfallOutcome> {
  const query = new URLSearchParams({ cabin, ...(rival ? { rival } : {}) });
  const { status, body } = await json(`/api/routes/${routeId}/waterfall?${query.toString()}`);

  if (status === 200) return { ok: true, waterfall: body as FareWaterfallResponse };
  if (status === 422) return body as WaterfallOutcome;
  throw new Error(`GET /api/routes/${routeId}/waterfall failed with ${String(status)}`);
}
