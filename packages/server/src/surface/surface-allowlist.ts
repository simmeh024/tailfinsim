/**
 * Player routes with no client consumer, each with its reason (SURFACE-01).
 *
 * The guard in `surface-reachability.test.ts` fails a pull request that adds a
 * player-facing route nothing in the client calls. Every route that is
 * deliberately in that state is listed here, **with a one-line reason and an
 * issue number, in the same diff** — the way `allow-ghsas` works for Dependency
 * Review: the gap stays visible and reviewable rather than suppressed.
 *
 * Three lists, because they are three different facts:
 *
 *   - {@link NOT_A_SURFACE} — routes no page should ever call: a provider's
 *     redirect target, an operator's recovery tool. Permanent.
 *   - {@link SURFACE_BASELINE} — player routes shipped ahead of their surface.
 *     Each names the issue that will consume it. **Temporary**: the guard fails
 *     on an entry whose route has since gained a consumer, so the list is trimmed
 *     when the surface lands rather than remembered later.
 *   - {@link ADMIN_BASELINE} — the same for the admin console, scored apart:
 *     an admin route without a control is a different fact from a player route
 *     without a page, and M11 owns the console's backlog.
 *
 * Reasons must not describe an unshipped security control in a way that is
 * useful to an attacker (SURFACE-01's security note). None here does.
 */

export interface SurfaceException {
  /** `METHOD /path`, exactly as `docs/authorization-matrix.md` spells it. */
  route: string;
  /** The issue that decided it, or that will consume it. */
  issue: number;
  /** One line: why there is no consumer. */
  reason: string;
  /**
   * False when no surface issue has been filed yet, so `issue` is the one that
   * shipped the route. Listed rather than hidden, so filing one is a visible
   * debt rather than a silent one.
   */
  surfaceIssueFiled?: false;
}

/** Routes no page should call. */
export const NOT_A_SURFACE: readonly SurfaceException[] = [
  {
    route: 'GET /api/auth/google/callback',
    issue: 11,
    reason:
      'The provider’s redirect target: the browser arrives here from Google, never from a page.',
  },
  {
    route: 'GET /api/auth/discord/callback',
    issue: 294,
    reason:
      'The provider’s redirect target: the browser arrives here from Discord, never from a page.',
  },
  {
    route: 'GET /api/auth/twitch/callback',
    issue: 294,
    reason:
      'The provider’s redirect target: the browser arrives here from Twitch, never from a page.',
  },
];

/** Player routes shipped ahead of their surface, each with the issue that consumes it. */
export const SURFACE_BASELINE: readonly SurfaceException[] = [
  {
    route: 'GET /api/routes/:routeId/flights',
    issue: 1129,
    reason:
      'SURFACE-06: the flight rung of the statistics drill-down (route → flight → waterfall).',
  },
  ...[
    'GET /api/hubs',
    'GET /api/hubs/candidates',
    'POST /api/hubs',
    'POST /api/hubs/:hubId/facilities',
  ].map((route): SurfaceException => ({
    route,
    issue: 1211,
    reason:
      'SURFACE-09: M7-04 shipped hub purchase and facilities with no page; the world map shows the hubs an airline holds, but buying one is API-only.',
  })),
];

/** Admin routes with no console control, scored apart from the player's. */
export const ADMIN_BASELINE: readonly SurfaceException[] = [
  {
    route: 'GET /api/admin/world-presets',
    issue: 102,
    reason: 'M11-02: the world-creation form does not yet offer the era presets.',
  },
  {
    route: 'GET /api/admin/worlds/:worldId/config',
    issue: 102,
    reason: 'M11-02: exporting a world’s configuration has no console control yet.',
  },
  {
    route: 'PATCH /api/admin/airlines/:airlineId/identity',
    issue: 541,
    reason: 'M11-22: the moderation workbench is where a forced rename belongs.',
  },
  {
    route: 'POST /api/admin/economy-config',
    issue: 971,
    reason:
      'M11-37’s console reads, compares and pins versions; writing a new version is still an API call.',
  },
  {
    route: 'POST /api/admin/events/requeue',
    issue: 454,
    reason:
      'SCALE-05’s manual recovery path, run by an operator against a known paused type; System Health shows the counts.',
  },
];
