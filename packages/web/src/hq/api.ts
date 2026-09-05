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
  /**
   * The HTTP status, or **0** when the request never reached a server.
   *
   * Zero is the whole reason this is not just `Response.status`. A hire that
   * came back 409 and a hire that never left the browser are different answers —
   * one is the server saying no, the other is not knowing — and the page paints
   * them as `refused` and `broken` accordingly.
   */
  status: number;
}

/**
 * Whether a failure is the server's answer or the absence of one (idea #8).
 *
 * A 4xx is a decision: the seat is taken, the candidate is employed, the cash is
 * not there. A transport failure or a 5xx is not a decision at all, and telling
 * a player "the seat is unavailable" when the truth is "nobody answered" sends
 * them looking for a game rule that does not exist.
 */
export function officeFailureKind(failure: OfficeFailure): 'refused' | 'broken' {
  return failure.status === 0 || failure.status >= 500 ? 'broken' : 'refused';
}

/**
 * The failure a request that never completed produces.
 *
 * Before this, only `fetchOffice` caught a transport error; `hireOffice` and its
 * siblings let it reject, so a dropped connection mid-hire became an unhandled
 * rejection inside the page's click handler and the button simply stayed
 * disabled with nothing said. Every mutation goes through {@link send} now.
 */
const UNREACHED: OfficeFailure = {
  status: 0,
  code: 'unreachable',
  message: 'The server could not be reached. Nothing was changed.',
};

/**
 * A mutation that answers with an outcome rather than throwing.
 *
 * Generic over the outcome so the executive floor's calls — which the
 * Headquarters page also drives, through the plan's upper floor — get the same
 * treatment as the office's without a second copy of it.
 */
async function send<T>(
  request: () => Promise<Response>,
  read: (response: Response, label: string) => Promise<{ ok: false; failure: OfficeFailure } | T>,
  label: string,
): Promise<{ ok: false; failure: OfficeFailure } | T> {
  let response: Response;
  try {
    response = await request();
  } catch {
    return { ok: false, failure: UNREACHED };
  }
  return read(response, label);
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
  return send(
    () =>
      fetch('/api/office/hires', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(request),
      }),
    readOutcome,
    'POST /api/office/hires',
  );
}

export async function dismissOffice(seat: OfficeSeatId): Promise<OfficeOutcome> {
  return send(
    () =>
      fetch(`/api/office/hires/${seat}`, {
        method: 'DELETE',
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      }),
    readOutcome,
    'DELETE /api/office/hires',
  );
}

/** Buy the next headquarters expansion — two more neutral offices. */
export async function expandOffice(): Promise<OfficeOutcome> {
  return send(
    () =>
      fetch('/api/office/expansion', {
        method: 'POST',
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      }),
    readOutcome,
    'POST /api/office/expansion',
  );
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
  return send(
    () =>
      fetch('/api/office/executive/unlock', {
        method: 'POST',
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      }),
    readExecutiveOutcome,
    'POST /api/office/executive/unlock',
  );
}

/** Open the next executive office in sequence. */
export async function unlockExecutiveOffice(): Promise<ExecutiveOutcome> {
  return send(
    () =>
      fetch('/api/office/executive/offices', {
        method: 'POST',
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      }),
    readExecutiveOutcome,
    'POST /api/office/executive/offices',
  );
}

/**
 * Hire a C-Suite candidate into an executive office. Pass `officeIndex` to place
 * them in a specific office (a click on the plan); omit it (a hire from the roster)
 * and the server puts them in the lowest free office.
 */
export async function hireExecutive(
  candidateId: string,
  officeIndex?: number,
): Promise<ExecutiveOutcome> {
  return send(
    () =>
      fetch('/api/office/executive/hires', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(
          officeIndex === undefined ? { candidateId } : { candidateId, officeIndex },
        ),
      }),
    readExecutiveOutcome,
    'POST /api/office/executive/hires',
  );
}

/** Let a C-Suite member go, freeing their office. */
export async function dismissExecutive(candidateId: string): Promise<ExecutiveOutcome> {
  return send(
    () =>
      fetch(`/api/office/executive/hires/${encodeURIComponent(candidateId)}`, {
        method: 'DELETE',
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      }),
    readExecutiveOutcome,
    'DELETE /api/office/executive/hires',
  );
}
