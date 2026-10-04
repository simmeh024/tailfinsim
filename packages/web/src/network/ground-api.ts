import type {
  ApiError,
  GroundContractsResponse,
  GroundServiceLine,
  GroundStationResponse,
  HandlerGrade,
} from '@tailfin/shared';

/**
 * Ground handling's half of the client API (M5-06, SURFACE-05).
 *
 * All six of `/api/ground`'s routes, and nothing computed here: every capacity,
 * price index, term and penalty is the server's. Every write answers with the
 * station's whole picture, so a sign, a termination or a restaff replaces the
 * page's state rather than editing it.
 *
 * **No write is retried.** Signing and terminating move money and the endpoints
 * take no idempotency key, so a retry after a timeout could charge a break fee
 * twice. A failed request is reported and the player decides.
 */

export type GroundWrite =
  | { ok: true; station: GroundStationResponse }
  | { ok: false; refusal: ApiError & { status: number } };

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

function isStation(body: unknown): body is GroundStationResponse {
  return (
    typeof body === 'object' &&
    body !== null &&
    typeof (body as { icao?: unknown }).icao === 'string' &&
    Array.isArray((body as { lines?: unknown }).lines)
  );
}

async function write(
  path: string,
  method: 'POST' | 'DELETE',
  input?: unknown,
): Promise<GroundWrite> {
  const response = await fetch(path, {
    method,
    headers: {
      accept: 'application/json',
      ...(input === undefined ? {} : { 'content-type': 'application/json' }),
    },
    credentials: 'same-origin',
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
  const body: unknown = await response.json();
  if (response.status === 200 && isStation(body)) return { ok: true, station: body };
  if (
    typeof (body as Partial<ApiError>).code === 'string' &&
    typeof (body as Partial<ApiError>).message === 'string'
  ) {
    return { ok: false, refusal: { ...(body as ApiError), status: response.status } };
  }
  throw new Error(`${method} ${path} failed with ${String(response.status)}`);
}

/** `GET /api/ground/contracts` — every arrangement, with the expiry and shortfall alerts. */
export async function fetchGroundContracts(): Promise<GroundContractsResponse> {
  const body = await readJson('/api/ground/contracts');
  if (!Array.isArray((body as { contracts?: unknown }).contracts)) {
    throw new Error('GET /api/ground/contracts did not return a list of contracts');
  }
  return body as GroundContractsResponse;
}

/** `GET /api/ground/:icao` — one station's vendors, its self-handling offer, and yours. */
export async function fetchGroundStation(icao: string): Promise<GroundStationResponse> {
  const body = await readJson(`/api/ground/${encodeURIComponent(icao)}`);
  if (!isStation(body)) throw new Error(`GET /api/ground/${icao} returned an unexpected body`);
  return body;
}

/** `POST /api/ground/:icao/contracts` — sign a grade for a line. Breaks what was working it. */
export function signGroundContract(
  icao: string,
  serviceLine: GroundServiceLine,
  grade: HandlerGrade,
): Promise<GroundWrite> {
  return write(`/api/ground/${encodeURIComponent(icao)}/contracts`, 'POST', { serviceLine, grade });
}

/** `POST /api/ground/:icao/self-handling` — open, or restaff, a line with your own people. */
export function openSelfHandling(
  icao: string,
  serviceLine: GroundServiceLine,
  headcount: number,
): Promise<GroundWrite> {
  return write(`/api/ground/${encodeURIComponent(icao)}/self-handling`, 'POST', {
    serviceLine,
    headcount,
  });
}

/** `DELETE /api/ground/contracts/:id` — break a vendor contract early, paying for it. */
export function terminateGroundContract(id: string): Promise<GroundWrite> {
  return write(`/api/ground/contracts/${encodeURIComponent(id)}`, 'DELETE');
}

/** `DELETE /api/ground/self-handling/:id` — close an operation of your own. */
export function closeSelfHandling(id: string): Promise<GroundWrite> {
  return write(`/api/ground/self-handling/${encodeURIComponent(id)}`, 'DELETE');
}
