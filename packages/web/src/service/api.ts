import type {
  RouteGroupsResponse,
  ServiceCatalogueResponse,
  ServicePackageContent,
  ServicePackagesResponse,
  ServicePaybackResponse,
} from '@tailfin/shared';

/**
 * The service configurator's half of the client API (M8-03, M8-05).
 *
 * Types only, as everywhere in the client: the zod schemas stay out of the
 * bundle, and `packages/web` never imports `@tailfin/sim`.
 *
 * That second rule is the reason {@link fetchPayback} exists at all. App. D.4
 * wants the table live *as options are toggled*, which sounds like arithmetic
 * for the browser — but computing it here would be a second implementation of
 * App. A.3's utility function, and the whole point of M8-05's third acceptance
 * criterion is that there is one. So the draft package goes to the server on
 * every change and the table comes back. No row is written; it is a calculation
 * behind a POST because the body is the thing being priced.
 */

async function readJson<T>(path: string, init?: RequestInit): Promise<T | null> {
  let response: Response;
  try {
    response = await fetch(path, {
      headers: {
        accept: 'application/json',
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
      },
      credentials: 'same-origin',
      ...init,
    });
  } catch {
    return null;
  }
  if (response.status !== 200) return null;
  return (await response.json().catch(() => null)) as T | null;
}

/**
 * A body this build cannot read is treated as no body at all.
 *
 * The client validates *shape*, not content — the zod schemas stay out of the
 * bundle — but it has to validate something, because a 200 carrying a payload
 * from a different release, or from a stub in a test, otherwise reaches the
 * renderer and takes the page down on the first `.map`. The page's `broken`
 * state is a better answer than a blank screen, and it is the answer the rest
 * of this client already gives (see `wireAirline`'s treatment of a logo it
 * cannot parse).
 */
function shaped<T>(value: unknown, has: (candidate: Record<string, unknown>) => boolean): T | null {
  if (value === null || typeof value !== 'object') return null;
  return has(value as Record<string, unknown>) ? (value as T) : null;
}

/** The world's ladders and its prices. Null for a player with no airline. */
export async function fetchCatalogue(): Promise<ServiceCatalogueResponse | null> {
  const body = await readJson<unknown>('/api/service/catalogue');
  return shaped<ServiceCatalogueResponse>(body, (candidate) => Array.isArray(candidate.categories));
}

/** The airline's route groups, and the routes in none of them. */
export async function fetchRouteGroups(): Promise<RouteGroupsResponse | null> {
  const body = await readJson<unknown>('/api/service/route-groups');
  return shaped<RouteGroupsResponse>(body, (candidate) => Array.isArray(candidate.groups));
}

/**
 * Price a draft package against the airline's own routes.
 *
 * Returns null rather than throwing on any failure — the configurator keeps
 * working with the last good table rather than collapsing because one keystroke
 * raced a network blip.
 */
export async function fetchPayback(
  content: ServicePackageContent,
  routeGroupId?: string,
): Promise<ServicePaybackResponse | null> {
  const body = await readJson<unknown>('/api/service/payback', {
    method: 'POST',
    body: JSON.stringify(routeGroupId === undefined ? { content } : { content, routeGroupId }),
  });
  return shaped<ServicePaybackResponse>(
    body,
    (candidate) =>
      Array.isArray(candidate.segments) &&
      Array.isArray(candidate.cabins) &&
      typeof candidate.context === 'object',
  );
}

/* ---- Saving, and putting a package to work ------------------------------ */

/** What a write came back with, or why it did not. */
export type ServiceWrite =
  { ok: true } | { ok: false; status: number; code: string; message: string };

/** A write that did not land. */
export type ServiceWriteFailure = ServiceWrite & { ok: false };

/**
 * How a failed write is shown: `refused` when the server answered no (or the
 * page itself declined before asking), `broken` when no answer came back.
 *
 * Decided by the code rather than by status 0, because the page's own "give it
 * a name first" also has no status and is a refusal, not a fault.
 */
export function writeFailureKind(failure: ServiceWriteFailure): 'refused' | 'broken' {
  return failure.code === 'unreachable' || failure.status >= 500 ? 'broken' : 'refused';
}

/**
 * Send one write. `body` is omitted for a delete: the id is in the path, the
 * server reads no body (SEC-06), and a JSON content type with nothing after it
 * is a malformed request rather than an empty one.
 */
async function write(path: string, method: string, body?: unknown): Promise<ServiceWrite> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      credentials: 'same-origin',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    // Status 0 is "never reached a server", which is a different answer from any
    // refusal the server could give — the same distinction `officeFailureKind`
    // draws for the office.
    return {
      ok: false,
      status: 0,
      code: 'unreachable',
      message: 'The server could not be reached.',
    };
  }
  if (response.status === 200 || response.status === 201 || response.status === 204) {
    return { ok: true };
  }
  const payload = (await response.json().catch(() => ({}))) as {
    code?: string;
    message?: string;
  };
  return {
    ok: false,
    status: response.status,
    code: payload.code ?? 'unknown',
    message: payload.message ?? `The change could not be saved (${String(response.status)}).`,
  };
}

/** The airline's saved packages. */
export async function fetchPackages(): Promise<ServicePackagesResponse | null> {
  const body = await readJson<unknown>('/api/service/packages');
  return shaped<ServicePackagesResponse>(body, (candidate) => Array.isArray(candidate.packages));
}

/** Save a new package under this name. */
export function createPackage(name: string, content: ServicePackageContent): Promise<ServiceWrite> {
  return write('/api/service/packages', 'POST', { name, content });
}

/** Replace an existing package — the same shape, by id. */
export function updatePackage(
  id: string,
  name: string,
  content: ServicePackageContent,
): Promise<ServiceWrite> {
  return write(`/api/service/packages/${id}`, 'PUT', { name, content });
}

/**
 * Put a package to work, or take it off.
 *
 * The route group is what App. D.5 assigns to, so this is the step that makes a
 * saved package actually reach a flight. `null` clears the assignment and drops
 * the group's routes back to the baseline product.
 */
export function assignPackage(
  routeGroupId: string,
  servicePackageId: string | null,
): Promise<ServiceWrite> {
  return write(`/api/service/route-groups/${routeGroupId}`, 'PUT', { servicePackageId });
}

/**
 * Delete a saved package.
 *
 * The server refuses while any route group still flies it (`package_in_use`,
 * naming the groups) rather than quietly dropping those groups to baseline
 * service, so the page does not pre-judge it: the refusal is the answer.
 */
export function deletePackage(id: string): Promise<ServiceWrite> {
  return write(`/api/service/packages/${id}`, 'DELETE');
}

/* ---- Route groups (App. D.5, M8-03's definition) ------------------------- */

/**
 * Create a route group: a name, and optionally the airline's routes to start with.
 *
 * That is the whole of M8-03's definition — a group is player-defined, keyed by
 * route and by nothing else — so it is the whole of what this sends. A route
 * already in another group **moves**: one group per route is a database
 * guarantee, so joining this group is leaving that one.
 *
 * The 201 carries the new group without its routes, so the caller re-reads the
 * configuration rather than patching its own copy.
 */
export function createRouteGroup(name: string, routeIds: readonly string[]): Promise<ServiceWrite> {
  return write(
    '/api/service/route-groups',
    'POST',
    routeIds.length === 0 ? { name } : { name, routeIds },
  );
}

/** Delete a route group. Its routes fall back to the baseline product, not to another group. */
export function deleteRouteGroup(id: string): Promise<ServiceWrite> {
  return write(`/api/service/route-groups/${id}`, 'DELETE');
}
