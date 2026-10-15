import type { AcademiesResponse, AcademyModuleKind, ApiError } from '@tailfin/shared';

/**
 * The training academy's half of the client API (SURFACE-10, M9-01, §10.1).
 *
 * All four of `/api/academies`' routes, and nothing computed here: what a level
 * or a module costs, how many weeks it takes, what it adds to the monthly bill,
 * what the academy permits and what may be built next are all the server's —
 * priced from the world's pinned economy config. Types only, so the zod
 * schemas stay out of the bundle.
 *
 * **Every write answers with the whole academy state**, which replaces the
 * page's: founding, levelling and equipping each change cash, the ceiling and
 * what may be built next at once.
 *
 * **No write is retried.** Each one charges capital through AIR-06 and the
 * endpoints take no idempotency key, so a retry after a dropped response could
 * pay for a second building. A request that fails in flight is reported as
 * *unknown* and the player reloads before deciding again.
 */

export interface AcademyFailure extends ApiError {
  status: number;
}

export type AcademyWrite =
  { ok: true; state: AcademiesResponse } | { ok: false; refusal: AcademyFailure };

/**
 * Is this actually an academies payload?
 *
 * The same shape-check `fetchCrew` makes, for the reason it gives: the shell's
 * routing test answers every unrecognised URL with `{}`, and a `200` with the
 * wrong body must fail the read rather than throw two property accesses later.
 */
export function isAcademiesResponse(value: unknown): value is AcademiesResponse {
  if (typeof value !== 'object' || value === null) return false;
  const body = value as Record<string, unknown>;
  return (
    Array.isArray(body.academies) &&
    Array.isArray(body.sites) &&
    Array.isArray(body.families) &&
    typeof body.outsourcedConversionPerHeadMinor === 'number'
  );
}

/**
 * `GET /api/academies` — every academy, every crew base without one, and what
 * each next build would cost.
 *
 * `null` for a player with no airline (401/409), the ordinary state the Crew
 * page already answers before this panel renders.
 */
export async function fetchAcademies(): Promise<AcademiesResponse | null> {
  const response = await fetch('/api/academies', {
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
  });
  if (response.status === 401 || response.status === 409) return null;
  if (!response.ok) throw new Error(`GET /api/academies failed with ${String(response.status)}`);
  const body: unknown = await response.json();
  if (!isAcademiesResponse(body)) throw new Error('GET /api/academies returned an unexpected body');
  return body;
}

/**
 * One write, sent once.
 *
 * A body that is neither the whole state nor a `{ code, message }` refusal is a
 * fault, and throws — the page then says the outcome is unknown rather than
 * claiming a refusal it never received. It is never sent a second time.
 */
async function post(path: string, input?: unknown): Promise<AcademyWrite> {
  const response = await fetch(path, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      ...(input === undefined ? {} : { 'content-type': 'application/json' }),
    },
    credentials: 'same-origin',
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
  const body: unknown = await response.json();
  if (response.status === 200 && isAcademiesResponse(body)) return { ok: true, state: body };
  const error = body as Partial<ApiError> | null;
  // Only a 4xx is a refusal: the request was answered and the answer is no. A 5xx
  // may have failed after the money moved, so it is an unknown outcome, not a no.
  if (
    response.status >= 400 &&
    response.status < 500 &&
    typeof error?.code === 'string' &&
    typeof error.message === 'string'
  ) {
    return {
      ok: false,
      refusal: { status: response.status, code: error.code, message: error.message },
    };
  }
  throw new Error(`POST ${path} failed with ${String(response.status)}`);
}

/** `POST /api/academies` — found an academy at a crew base and start level 1. */
export function foundAcademy(crewBaseId: string): Promise<AcademyWrite> {
  return post('/api/academies', { crewBaseId });
}

/**
 * `POST /api/academies/:id/levels` — start the next level.
 *
 * Bodyless on purpose: the server decides which level is next and what it
 * costs, so there is nothing for the client to name.
 */
export function upgradeAcademy(academyId: string): Promise<AcademyWrite> {
  return post(`/api/academies/${encodeURIComponent(academyId)}/levels`);
}

/**
 * `POST /api/academies/:id/modules` — build a module.
 *
 * `family` only for the full-flight sim, which is the one module built per
 * aircraft family; the server refuses a family on anything else.
 */
export function buildAcademyModule(
  academyId: string,
  kind: AcademyModuleKind,
  family?: string,
): Promise<AcademyWrite> {
  return post(`/api/academies/${encodeURIComponent(academyId)}/modules`, {
    kind,
    ...(family === undefined ? {} : { family }),
  });
}
