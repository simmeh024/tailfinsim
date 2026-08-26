import type { ApiError, HireOfficeRequest, OfficeRole, OfficeStateResponse } from '@tailfin/shared';

/**
 * The Headquarters page's half of the client API (M5-04, §9.1).
 *
 * Types only, as everywhere in the client: the zod schemas stay out of the
 * bundle, and `packages/web` never imports `@tailfin/sim`. The server owns which
 * seats are filled, what they cost and whether the Safety & Compliance seat has
 * unlocked long-haul authority; this only asks and shows.
 *
 * Every call returns the **whole office state**, not the one hire — hiring the
 * gate seat flips `hasExtendedAuthority`, and a client that patched its own copy
 * would be recomputing the server's answer.
 */

export interface OfficeFailure extends ApiError {
  status: number;
}

export type OfficeOutcome =
  { ok: true; state: OfficeStateResponse } | { ok: false; failure: OfficeFailure };

async function readOutcome(response: Response, label: string): Promise<OfficeOutcome> {
  const payload: unknown = await response.json().catch(() => ({}));
  if (response.status === 200) return { ok: true, state: payload as OfficeStateResponse };
  const error = payload as Partial<ApiError>;
  return {
    ok: false,
    failure: {
      status: response.status,
      code: error.code ?? 'unknown',
      message: error.message ?? `${label} failed with ${String(response.status)}`,
    },
  };
}

/** The office as it stands, or null for a player with no airline (409). */
export async function fetchOffice(): Promise<OfficeStateResponse | null> {
  const response = await fetch('/api/office', {
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
  });
  if (response.status === 409 || response.status === 401) return null;
  const outcome = await readOutcome(response, 'GET /api/office');
  return outcome.ok ? outcome.state : null;
}

export async function hireOffice(request: HireOfficeRequest): Promise<OfficeOutcome> {
  const response = await fetch('/api/office/hires', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(request),
  });
  return readOutcome(response, 'POST /api/office/hires');
}

export async function dismissOffice(role: OfficeRole): Promise<OfficeOutcome> {
  const response = await fetch(`/api/office/hires/${role}`, {
    method: 'DELETE',
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
  });
  return readOutcome(response, 'DELETE /api/office/hires');
}
