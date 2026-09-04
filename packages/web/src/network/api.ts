import type {
  CabinClass,
  CreateScheduleResponse,
  FarePreviewResponse,
  FareTable,
  FareWaterfallResponse,
  RepeatPattern,
  RouteCompetitionResponse,
  RoutePerformanceResponse,
  ScheduleView,
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
  | { kind: 'unreachable'; reachability: { reason: string; detail: string } }
  | { kind: 'authority-required'; detail: string };

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
  if (status === 422) {
    // A route refused for needing an office unlock (M5-04) is a *different* 422
    // shape from the reachability refusals — it carries a code and a message rather
    // than `{ ok, kind }`. Translate it, or the panel would render an empty alert.
    const code = (body as { code?: unknown }).code;
    if (code === 'office_authority_required') {
      const message = (body as { message?: unknown }).message;
      return {
        ok: false,
        kind: 'authority-required',
        detail: typeof message === 'string' ? message : 'This route needs an office unlock first.',
      };
    }
    return body as OpenRouteOutcome;
  }
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

/**
 * Pause or reopen a route — flip its `active` flag without losing it.
 *
 * The reversible alternative to {@link closeRoute}: a paused route stops selling
 * but keeps its schedule and fares. A 404/409 comes back as `ok: false` rather than
 * throwing; a broken request throws.
 */
export async function setRouteActive(
  routeId: string,
  active: boolean,
): Promise<{ ok: boolean; active?: boolean }> {
  const { status, body } = await json(`/api/routes/${routeId}/active`, {
    method: 'PUT',
    body: JSON.stringify({ active }),
  });
  if (status === 200) return { ok: true, active: (body as { active?: boolean }).active };
  if (status === 404 || status === 409) return { ok: false };
  throw new Error(`Setting a route active failed with ${String(status)}`);
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

/**
 * What the route actually did — its settled flights, rolled up (M2-06).
 *
 * A 404 (a stale or someone else's route) throws like any unexpected status; the
 * caller's error state is the right home for "this is not your route".
 */
export async function fetchPerformance(routeId: string): Promise<RoutePerformanceResponse> {
  const { status, body } = await json(`/api/routes/${routeId}/performance`);
  if (status !== 200) {
    throw new Error(`GET /api/routes/${routeId}/performance failed with ${String(status)}`);
  }
  return body as RoutePerformanceResponse;
}

/** Who else is in this market, and how much of it each takes (M3-12). */
export async function fetchCompetition(routeId: string): Promise<RouteCompetitionResponse> {
  const { status, body } = await json(`/api/routes/${routeId}/competition`);
  if (status !== 200) {
    throw new Error(`GET /api/routes/${routeId}/competition failed with ${String(status)}`);
  }
  return body as RouteCompetitionResponse;
}

/* --------------------------------------------------- schedules (M2-03) ---- */

/** One leg the player authors — a pair of airports and a local departure time. */
export interface AuthoredLeg {
  originIcao: string;
  destinationIcao: string;
  departureMinuteLocal: number;
}

/** The body of a create/edit — an airframe, its stops, and how it repeats. */
export interface ScheduleDraft {
  airframeId: string;
  legs: AuthoredLeg[];
  autoReturn: boolean;
  repeat: RepeatPattern;
}

/**
 * The result of publishing or editing a rotation.
 *
 * A refusal is an answer, not an error — App. B.4 requires the player to be told
 * *which* leg cannot be flown, or why the rotation does not close, so it comes
 * back as data. Only a genuinely broken request throws.
 */
export type PublishScheduleOutcome =
  { ok: true; response: CreateScheduleResponse } | { ok: false; problem: string; detail: string };

/** Every rotation the airline runs. */
export async function fetchSchedules(): Promise<ScheduleView[]> {
  const { status, body } = await json('/api/schedules');
  if (status !== 200) throw new Error(`GET /api/schedules failed with ${String(status)}`);
  const schedules = (body as { schedules?: unknown }).schedules;
  if (!Array.isArray(schedules)) throw new Error('GET /api/schedules did not return a list');
  return schedules as ScheduleView[];
}

/** Turn a create/edit refusal body into the outcome the panel shows. */
function refusalOf(body: unknown): { problem: string; detail: string } {
  const asRefusal = body as {
    problem?: unknown;
    detail?: unknown;
    code?: unknown;
    message?: unknown;
  };
  if (typeof asRefusal.problem === 'string' && typeof asRefusal.detail === 'string') {
    return { problem: asRefusal.problem, detail: asRefusal.detail };
  }
  // A `{ code, message }` apiError — e.g. an aircraft that is not yours.
  return {
    problem: typeof asRefusal.code === 'string' ? asRefusal.code : 'refused',
    detail: typeof asRefusal.message === 'string' ? asRefusal.message : 'The rotation was refused.',
  };
}

/** Publish a new rotation, or find out which leg the aircraft cannot fly. */
export async function publishSchedule(draft: ScheduleDraft): Promise<PublishScheduleOutcome> {
  const { status, body } = await json('/api/schedules', {
    method: 'POST',
    body: JSON.stringify(draft),
  });
  if (status === 201) return { ok: true, response: body as CreateScheduleResponse };
  if (status === 404 || status === 422 || status === 400) return { ok: false, ...refusalOf(body) };
  throw new Error(`POST /api/schedules failed with ${String(status)}`);
}

/** Replace a rotation's legs, or find out why the new one cannot run. */
export async function updateSchedule(
  scheduleId: string,
  draft: Omit<ScheduleDraft, 'airframeId'>,
): Promise<PublishScheduleOutcome> {
  const { status, body } = await json(`/api/schedules/${scheduleId}`, {
    method: 'PUT',
    body: JSON.stringify(draft),
  });
  if (status === 200) return { ok: true, response: body as CreateScheduleResponse };
  if (status === 404 || status === 422 || status === 400) return { ok: false, ...refusalOf(body) };
  throw new Error(`PUT /api/schedules/${scheduleId} failed with ${String(status)}`);
}

/** Pause a rotation, or resume it. */
export async function setScheduleActive(scheduleId: string, active: boolean): Promise<boolean> {
  const { status } = await json(`/api/schedules/${scheduleId}/active`, {
    method: 'PUT',
    body: JSON.stringify({ active }),
  });
  if (status === 200) return true;
  if (status === 404) return false;
  throw new Error(`PUT /api/schedules/${scheduleId}/active failed with ${String(status)}`);
}

/** Delete a rotation, cancelling its future flights. */
export async function deleteSchedule(scheduleId: string): Promise<boolean> {
  const { status } = await json(`/api/schedules/${scheduleId}`, { method: 'DELETE' });
  if (status === 200) return true;
  if (status === 404) return false;
  throw new Error(`DELETE /api/schedules/${scheduleId} failed with ${String(status)}`);
}
