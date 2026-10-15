import type {
  ApiError,
  HubCandidateListResponse,
  HubFacilityKind,
  HubsResponse,
} from '@tailfin/shared';

/**
 * Hubs' half of the client API (M7-04, SURFACE-09).
 *
 * All four of `/api/hubs`'s routes, and nothing computed here. App. B.5's curve,
 * each tier's price, every annual fee and every facility's opening cost are the
 * server's; the client shows them and **echoes the figure it showed** back on the
 * purchase, so the server can refuse a quote the airline's own last purchase has
 * made stale (`409 hub_cost_changed`) rather than charge a price nobody saw.
 *
 * Both writes answer with the airline's whole hub list, so a purchase or a build
 * replaces the page's state rather than editing it.
 *
 * **No write is retried.** Both move money and neither takes an idempotency key,
 * so a retry after a timeout could buy a hub — or build a facility — twice. A
 * failed request is reported and the player decides.
 *
 * Types only, as everywhere else in the client, so the zod schemas stay out of
 * the bundle.
 */

/** The server's refusal, with its code, exactly as it was given. */
export type HubRefusal = ApiError & { status: number };

export type HubsRead = { ok: true; hubs: HubsResponse } | { ok: false; refusal: HubRefusal };

export type HubCandidatesRead =
  { ok: true; candidates: HubCandidateListResponse } | { ok: false; refusal: HubRefusal };

export type HubWrite = { ok: true; hubs: HubsResponse } | { ok: false; refusal: HubRefusal };

function isRefusal(body: unknown): body is ApiError {
  return (
    typeof body === 'object' &&
    body !== null &&
    typeof (body as Partial<ApiError>).code === 'string' &&
    typeof (body as Partial<ApiError>).message === 'string'
  );
}

function isHubs(body: unknown): body is HubsResponse {
  return (
    typeof body === 'object' &&
    body !== null &&
    Array.isArray((body as { hubs?: unknown }).hubs) &&
    typeof (body as { nextHub?: unknown }).nextHub === 'object'
  );
}

function isCandidates(body: unknown): body is HubCandidateListResponse {
  return (
    typeof body === 'object' &&
    body !== null &&
    Array.isArray((body as { airports?: unknown }).airports) &&
    typeof (body as { nextHub?: unknown }).nextHub === 'object'
  );
}

/**
 * A GET, answered as data or as the server's refusal.
 *
 * A 409 `airline_required` is an answer worth showing with its code, not a fault;
 * anything that is neither the expected body nor a refusal throws, and the caller
 * shows that as broken.
 */
async function readJson(path: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(path, {
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
  });
  return { status: response.status, body: await response.json() };
}

async function write(path: string, method: 'POST', input: unknown): Promise<HubWrite> {
  const response = await fetch(path, {
    method,
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(input),
  });
  const body: unknown = await response.json();
  if (response.status === 200 && isHubs(body)) return { ok: true, hubs: body };
  if (isRefusal(body)) return { ok: false, refusal: { ...body, status: response.status } };
  throw new Error(`${method} ${path} failed with ${String(response.status)}`);
}

/** `GET /api/hubs` — every hub the airline holds, its facilities, and the next hub's price. */
export async function fetchHubs(): Promise<HubsRead> {
  const { status, body } = await readJson('/api/hubs');
  if (status === 200 && isHubs(body)) return { ok: true, hubs: body };
  if (status !== 200 && isRefusal(body)) return { ok: false, refusal: { ...body, status } };
  throw new Error(`GET /api/hubs failed with ${String(status)}`);
}

/**
 * `GET /api/hubs/candidates?query=` — airports the airline could take next, priced.
 *
 * Asked on an explicit search only — never per keystroke and never on a timer.
 * Each answer prices up to twenty airports and measures each one's slot bands,
 * so it is a query plan rather than a row lookup.
 */
export async function searchHubCandidates(query: string): Promise<HubCandidatesRead> {
  const { status, body } = await readJson(
    `/api/hubs/candidates?query=${encodeURIComponent(query)}`,
  );
  if (status === 200 && isCandidates(body)) return { ok: true, candidates: body };
  if (status !== 200 && isRefusal(body)) return { ok: false, refusal: { ...body, status } };
  throw new Error(`GET /api/hubs/candidates failed with ${String(status)}`);
}

/**
 * `POST /api/hubs` — take an airport as the airline's next hub.
 *
 * `expectedCostMinor` is the price the page showed, unchanged. It is not a price
 * the client chose: the server compares it with its own and refuses a mismatch.
 */
export function purchaseHub(airportIdent: string, expectedCostMinor: number): Promise<HubWrite> {
  return write('/api/hubs', 'POST', { airportIdent, expectedCostMinor });
}

/** `POST /api/hubs/:hubId/facilities` — build one facility at one of the airline's hubs. */
export function openHubFacility(
  hubId: string,
  kind: HubFacilityKind,
  expectedCostMinor: number,
): Promise<HubWrite> {
  return write(`/api/hubs/${encodeURIComponent(hubId)}/facilities`, 'POST', {
    kind,
    expectedCostMinor,
  });
}
