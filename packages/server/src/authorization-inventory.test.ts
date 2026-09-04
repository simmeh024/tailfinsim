import { describe, expect, it } from 'vitest';

import { ADMIN_CAPABILITIES } from './admin/capabilities';
import {
  collectRegisteredRoutes,
  isAdminRoute,
  readAuthorizationMatrix,
  type RegisteredRoute,
} from './test-fixtures/route-inventory';

/**
 * The authorization matrix agrees with the router (SEC-04).
 *
 * This is the half of SEC-04 that keeps working as the API grows. Every other
 * assertion in the milestone names a route, so every one of them stops covering
 * the surface the moment somebody adds a route and does not think of it. This
 * one cannot: it asks the router what exists.
 *
 * **No database.** Route registration never touches the pool, so this runs on
 * every pull request rather than only where `DATABASE_URL` is set — which is the
 * point, because a missing matrix row is exactly the mistake that arrives from
 * someone who never ran the database suites.
 */
describe('the authorization matrix and the router agree', () => {
  it('finds a non-trivial number of routes on both sides', async () => {
    // Guards the guard. Every assertion below compares two sets, and two empty
    // sets agree perfectly — a broken build or a moved marker would otherwise
    // turn this whole file into a pass.
    const registered = await collectRegisteredRoutes();
    const matrix = readAuthorizationMatrix();

    expect(registered.length).toBeGreaterThanOrEqual(40);
    expect(matrix.length).toBeGreaterThanOrEqual(40);
    expect(registered.filter((route) => isAdminRoute(route.url)).length).toBeGreaterThanOrEqual(20);
  });

  it('has a matrix row for every registered route', async () => {
    /*
     * The failure this exists to cause: a route added without a row.
     *
     * CONTRIBUTING.md asks for the row in the same pull request as the route,
     * and until now nothing made that true — the reviewer had to notice. An
     * unrecorded route is not merely undocumented; it is a boundary nobody has
     * stated, so nobody can say whether its guard is the intended one.
     */
    const registered = await collectRegisteredRoutes();
    const matrix = new Set(readAuthorizationMatrix().map((row) => row.key));

    const missing = registered.filter((route) => !matrix.has(route.key)).map((route) => route.key);

    expect(
      missing,
      `These routes are registered but absent from docs/authorization-matrix.md.\n` +
        `Add a row stating the intended boundary — derived from the design, not from the hook the code happens to carry:\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  it('has a registered route for every matrix row', async () => {
    /*
     * The other direction, and not symmetry for its own sake. A row whose route
     * no longer exists is a claim that something is guarded when nothing is
     * serving it, and it is the form the document rots into: routes get renamed
     * and the old row reads as current.
     */
    const registered = new Set((await collectRegisteredRoutes()).map((route) => route.key));
    const matrix = readAuthorizationMatrix();

    const stale = matrix.filter((row) => !registered.has(row.key)).map((row) => row.key);

    expect(
      stale,
      `These rows are in docs/authorization-matrix.md but no such route is registered.\n` +
        `A row for a route that does not exist claims a boundary nobody is enforcing:\n  ${stale.join('\n  ')}`,
    ).toEqual([]);
  });

  it('records every admin route as closed to guests and to signed-in non-admins', () => {
    /*
     * The matrix is prose, and prose can say the wrong thing confidently. These
     * are the routes that create worlds, re-anchor a live clock, archive a world
     * and destroy every airline in one, so the intended answer is not a matter of
     * taste: a guest is 401 because there is no session, a signed-in player is
     * 403 because there is a session without the grant, and only an admin is
     * allowed. ADR-0020 owns that vocabulary.
     *
     * `admin/authorization.test.ts` proves the running server agrees. This proves
     * the document is asking for the right thing in the first place — without it,
     * a row could record "403 / 403 / 403 / 403" and the two files would agree
     * with each other about a broken boundary.
     */
    const matrix = readAuthorizationMatrix().filter((row) => isAdminRoute(row.url));
    expect(matrix.length).toBeGreaterThanOrEqual(20);

    /*
     * The mechanism is either the blanket admin gate or a named capability
     * (M11-01). A capability is accepted only if it is one the model actually
     * defines, so a typo in the document — `requireCapability('wrold.reset')` —
     * fails here rather than reading as a guarded route that no role can reach.
     */
    const capabilityRow = /^`requireCapability\('([^']+)'\)`$/;
    const guards = (mechanism: string): boolean => {
      if (mechanism === '`requireAdmin`') return true;
      const named = capabilityRow.exec(mechanism)?.[1];
      return named !== undefined && (ADMIN_CAPABILITIES as readonly string[]).includes(named);
    };

    const wrong = matrix
      .filter(
        (row) =>
          !guards(row.mechanism) ||
          row.guest !== '401' ||
          row.player !== '403' ||
          row.owner !== '403' ||
          !row.admin.startsWith('Allow'),
      )
      .map(
        (row) =>
          `${row.key} — mechanism ${row.mechanism}, guest ${row.guest}, player ${row.player}, owner ${row.owner}, admin ${row.admin}`,
      );

    expect(
      wrong,
      `Every /api/admin/* row must read: requireAdmin or requireCapability('<known capability>'), ` +
        `guest 401, player 403, owner 403, admin Allow.\n  ${wrong.join('\n  ')}`,
    ).toEqual([]);
  });

  it('exposes no admin route under a path that does not announce itself', () => {
    /*
     * `isAdminRoute` is a prefix test, and every gate in this file leans on it —
     * so an admin-only route registered somewhere else entirely would be swept
     * up by neither this file's admin checks nor the sweep in
     * `admin/authorization.test.ts`, while still passing the row check above.
     *
     * The matrix is the thing that knows: any row whose mechanism is
     * `requireAdmin` must live under `/api/admin/`.
     */
    const misfiled = readAuthorizationMatrix()
      .filter((row) => row.mechanism === '`requireAdmin`' && !isAdminRoute(row.url))
      .map((row) => row.key);

    expect(
      misfiled,
      `An admin-guarded route outside /api/admin/ escapes the sweep that proves the guard:\n  ${misfiled.join('\n  ')}`,
    ).toEqual([]);
  });

  it('registers no duplicate method and path', async () => {
    // Two registrations of one method/path cannot both be reachable, and the one
    // that loses may be the one carrying the guard.
    const registered: RegisteredRoute[] = await collectRegisteredRoutes();
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const route of registered) {
      if (seen.has(route.key)) duplicates.push(route.key);
      seen.add(route.key);
    }

    expect(duplicates, `Duplicate route registrations:\n  ${duplicates.join('\n  ')}`).toEqual([]);
  });
});
