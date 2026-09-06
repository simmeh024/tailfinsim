import type {
  RouteGroupsResponse,
  ServiceCatalogueResponse,
  ServicePackageContent,
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
