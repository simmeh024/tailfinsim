import type {
  ApiError,
  ExecutiveFloorState,
  HireOfficeRequest,
  OfficeSeatId,
  OfficeStateResponse,
} from '@tailfin/shared';

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

/**
 * The office as it stands, or null for a player with no airline (409/401).
 *
 * Never throws: the shell loads this on every screen, so a transport failure
 * must degrade to "no office panel", not an unhandled rejection that takes the
 * whole shell down with it.
 */
export async function fetchOffice(): Promise<OfficeStateResponse | null> {
  let response: Response;
  try {
    response = await fetch('/api/office', {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
    });
  } catch {
    return null;
  }
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

export async function dismissOffice(seat: OfficeSeatId): Promise<OfficeOutcome> {
  const response = await fetch(`/api/office/hires/${seat}`, {
    method: 'DELETE',
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
  });
  return readOutcome(response, 'DELETE /api/office/hires');
}

/** Buy the next headquarters expansion — two more neutral offices. */
export async function expandOffice(): Promise<OfficeOutcome> {
  const response = await fetch('/api/office/expansion', {
    method: 'POST',
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
  });
  return readOutcome(response, 'POST /api/office/expansion');
}

/* ---- The executive floor (§9.1 follow-up) ------------------------------- */

export type ExecutiveOutcome =
  { ok: true; state: ExecutiveFloorState } | { ok: false; failure: OfficeFailure };

async function readExecutiveOutcome(response: Response, label: string): Promise<ExecutiveOutcome> {
  const payload: unknown = await response.json().catch(() => ({}));
  if (response.status === 200) return { ok: true, state: payload as ExecutiveFloorState };
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

/** The executive floor's state, or null for a player with no airline / transport failure. */
export async function fetchExecutiveFloor(): Promise<ExecutiveFloorState | null> {
  let response: Response;
  try {
    response = await fetch('/api/office/executive', {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
    });
  } catch {
    return null;
  }
  if (response.status === 409 || response.status === 401) return null;
  const outcome = await readExecutiveOutcome(response, 'GET /api/office/executive');
  return outcome.ok ? outcome.state : null;
}

/** Open the executive floor (charges $100M behind the revenue gate). */
export async function unlockExecutiveFloor(): Promise<ExecutiveOutcome> {
  const response = await fetch('/api/office/executive/unlock', {
    method: 'POST',
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
  });
  return readExecutiveOutcome(response, 'POST /api/office/executive/unlock');
}

/** Open the next executive office in sequence. */
export async function unlockExecutiveOffice(): Promise<ExecutiveOutcome> {
  const response = await fetch('/api/office/executive/offices', {
    method: 'POST',
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
  });
  return readExecutiveOutcome(response, 'POST /api/office/executive/offices');
}
