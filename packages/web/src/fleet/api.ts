import type { FleetCatalogueResponse } from '@tailfin/shared';

/**
 * The fleet page's half of the client API (M4-02).
 *
 * Types only, as everywhere else in the client, so the zod schemas stay out of
 * the bundle. Nothing here decides whether an aircraft exists — that is the
 * world's clock and the server's answer, and `packages/web` may not import
 * `@tailfin/sim` at all.
 */
export async function fetchFleetCatalogue(): Promise<FleetCatalogueResponse> {
  const response = await fetch('/api/fleet/catalogue', {
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
  });
  if (response.status !== 200) {
    throw new Error(`GET /api/fleet/catalogue failed with ${String(response.status)}`);
  }

  // Checked rather than cast, for the reason `network/api.ts` records: a cast
  // turns a malformed response into `undefined` and crashes the page on
  // `.length`, which reads as a blank screen rather than as a bad response.
  const body: unknown = await response.json();
  const types = (body as { types?: unknown }).types;
  if (!Array.isArray(types)) {
    throw new Error('GET /api/fleet/catalogue did not return a list of types');
  }
  return body as FleetCatalogueResponse;
}
