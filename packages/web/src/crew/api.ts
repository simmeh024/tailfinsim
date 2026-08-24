import type {
  ApiError,
  CrewResponse,
  HireCrewInput,
  OpenCrewBaseInput,
  SetCrewPoliciesInput,
  SetCrewReserveInput,
  StartCrewConversionInput,
} from '@tailfin/shared';

/**
 * The crew page's half of the client API (M5-01, §9.2).
 *
 * Types only, as everywhere else in the client, so the zod schemas stay out of
 * the bundle. Nothing here decides how many crew a flight needs, whether a pool
 * can field one, or how fragmented a fleet is — those are `@tailfin/sim`'s, the
 * server computes them, and `packages/web` may not import that package at all
 * (§21).
 *
 * Every mutation returns the **whole crew state** rather than an id. Opening a
 * base, hiring and converting each change cash, availability and fragmentation
 * at once; a client that had to refetch would show a stale purse for a frame,
 * and one that patched its own copy would be recomputing the server's answer.
 */

export interface CrewFailure extends ApiError {
  status: number;
}

export type CrewOutcome = { ok: true; state: CrewResponse } | { ok: false; refusal: CrewFailure };

async function send(path: string, body: unknown, method = 'POST'): Promise<CrewOutcome> {
  const response = await fetch(path, {
    method,
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  });
  const payload: unknown = await response.json();
  if (response.status === 200) return { ok: true, state: payload as CrewResponse };

  // Refusals stay data: `CrewRefusal` is a closed set precisely so the page can
  // place "not enough heads" beside the pool it is about.
  const error = payload as Partial<ApiError>;
  return {
    ok: false,
    refusal: {
      status: response.status,
      code: error.code ?? 'unknown',
      message: error.message ?? `${method} ${path} failed with ${String(response.status)}`,
    },
  };
}

/**
 * Is this actually a crew payload?
 *
 * The same shape-check `fetchOwnAirline` does, and it earns its keep: a `200`
 * carrying the wrong body reaches the page as `undefined` two property accesses
 * later, and the render throws rather than the fetch failing. CI found exactly
 * that — the shell's routing test stubs every unrecognised URL with `{}`, the
 * page crashed on `fragmentation.families`, and locally the promise had simply
 * not resolved before the assertion so it passed.
 */
function isCrewResponse(value: unknown): value is CrewResponse {
  if (typeof value !== 'object' || value === null) return false;
  const body = value as Record<string, unknown>;
  return (
    Array.isArray(body.bases) &&
    typeof body.fragmentation === 'object' &&
    body.fragmentation !== null &&
    typeof body.costs === 'object' &&
    body.costs !== null
  );
}

/**
 * Read the airline's crew.
 *
 * `null` for a player with no airline yet, which the World page's clock also
 * treats as an ordinary state rather than a failure — the shell renders before
 * anybody founds anything.
 */
export async function fetchCrew(): Promise<CrewResponse | null> {
  const response = await fetch('/api/crew', {
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
  });
  if (response.status === 401 || response.status === 409) return null;
  if (!response.ok) throw new Error(`GET /api/crew failed with ${String(response.status)}`);
  const body: unknown = await response.json();
  if (!isCrewResponse(body)) throw new Error('GET /api/crew returned an unexpected body');
  return body;
}

export function openCrewBase(input: OpenCrewBaseInput): Promise<CrewOutcome> {
  return send('/api/crew/bases', input);
}

export function hireCrew(input: HireCrewInput): Promise<CrewOutcome> {
  return send('/api/crew/hires', input);
}

export function startCrewConversion(input: StartCrewConversionInput): Promise<CrewOutcome> {
  return send('/api/crew/conversions', input);
}

/**
 * Set how many of a pool's heads are held back as standby.
 *
 * `PUT`, because a reserve level is a value rather than an event: sending the
 * same request twice leaves the same standby crew. The others are `POST` because
 * hiring twice hires twice.
 */
export function setCrewReserve(input: SetCrewReserveInput): Promise<CrewOutcome> {
  return send('/api/crew/reserves', input, 'PUT');
}

/**
 * Set a base's pay band or hotel tier (M5-03).
 *
 * `PUT` and partial: absent means *leave it alone*, so changing pay does not
 * restate the hotel tier. A client that had to read the current value and write
 * it back would race itself the moment two tabs were open.
 */
export function setCrewPolicies(input: SetCrewPoliciesInput): Promise<CrewOutcome> {
  return send('/api/crew/policies', input, 'PUT');
}
