/**
 * How a player reaches every page the app has (SURFACE-07).
 *
 * The router (`App.tsx`) mounts the pages; this table says, for each one, **how
 * a player gets there without typing a URL** — and why that way. A page with no
 * entry point is a page most players never see: display currency (M8-02) lived
 * on `/settings` for a milestone with nothing in the rail pointing at it.
 *
 * ## A table, for `route-identity.ts`'s reason
 *
 * *"The second shape means every new page is a chance to forget one."* So
 * `reachability.test.tsx` reads the route table out of `App.tsx` itself and
 * fails when a route is in neither list below, when a list names a route the
 * router no longer has, and when a declared way in does not actually render —
 * a rail item that is not in `NAV_ITEMS`, an account link that is not in the
 * rail, a page link that is not on the page.
 *
 * ## Reachability, not rail membership
 *
 * The rail is UX-01's (#462) to restructure, and this does not pre-empt it. A
 * page is reachable when there is a **deliberate** way in: a rail item, the
 * account block at the foot of the rail, the status strip, a link on a related
 * page, or the admin console's own navigation. Each entry records which, and
 * why that is the right one — so UX-01 inherits decisions rather than accidents.
 *
 * Reachability is not authorization. Every page reached from here is still
 * gated by its own session and ownership checks on the server (ADR-0020).
 */

/** How a player reaches an in-shell page. */
export type RouteReach =
  /** One of `NAV_ITEMS`, the rail's destinations. */
  | { means: 'rail'; reason: string }
  /** The account block at the foot of the rail (`AccountBadge`). */
  | { means: 'account'; reason: string }
  /** The status strip along the bottom of every page. */
  | { means: 'strip'; audience: 'everyone' | 'admins'; reason: string }
  /** A link on another in-shell page, which is itself reachable. */
  | { means: 'page'; from: string; reason: string }
  /** The admin console's own section navigation. */
  | { means: 'console'; reason: string }
  /** A record page, reached from a row in a list page. */
  | { means: 'record'; from: string; reason: string };

/**
 * Every in-shell route, by its full path as `App.tsx` mounts it.
 *
 * Keyed by path rather than listed, so a duplicate is a type error and a test
 * can look one up.
 */
export const IN_SHELL_ROUTES: Readonly<Record<string, RouteReach>> = {
  '/dashboard': {
    means: 'rail',
    reason: '§14: the dashboard is the main interface after week one.',
  },
  '/operations': { means: 'rail', reason: '§14.3: the five operational dashboards.' },
  '/alerts': { means: 'rail', reason: '§14.5: a junction to every screen that can act.' },
  '/world': { means: 'rail', reason: 'App. H.4: the world map.' },
  '/fleet': {
    means: 'rail',
    reason: 'App. H.4. Maintenance planning (SURFACE-04) is a section of this page.',
  },
  '/network': {
    means: 'rail',
    reason: 'App. H.4. Slots, gates and ground handling (SURFACE-05) are views of this page.',
  },
  '/finance': { means: 'rail', reason: 'App. H.4.' },
  '/crew': {
    means: 'rail',
    reason:
      'App. H.4. Training academies (SURFACE-10) are a section of this page, at #academies, linked from Research.',
  },
  '/research': { means: 'rail', reason: '§10.3, beside the crews who earn it.' },
  '/headquarters': { means: 'rail', reason: 'M5-04: the office hires.' },
  '/service': { means: 'rail', reason: 'M8-05: what happens in the cabin.' },
  '/design': { means: 'rail', reason: 'App. H.4: the livery builder.' },
  '/board': { means: 'rail', reason: 'App. H.4.' },

  /*
   * The two pages about *who you are* rather than *what you run*. They sit in the
   * account block at the foot of the rail, with the name and the sign-out —
   * where every application keeps them — rather than as two more rail items
   * among the operating destinations. SURFACE-07 found them unreachable; M8-02
   * and AIR-08 had since linked them from the account block, which is the right
   * home, so this records the decision and the test holds it.
   */
  '/settings': {
    means: 'account',
    reason:
      'The player’s own preferences (display currency, sign-in methods): the player’s name in the account block.',
  },
  '/airline': {
    means: 'account',
    reason:
      'The airline’s identity and rebrand: “Manage airline” in the account block, shown once an airline exists.',
  },

  /*
   * The executive floor is the second floor of Headquarters: the same office
   * plan in the context panel pages between the two, and the C-Suite button sits
   * beside Policies on the Headquarters page. A rail item would separate two
   * halves of one building.
   */
  '/c-suite': {
    means: 'page',
    from: '/headquarters',
    reason: 'The executive floor of Headquarters: its C-Suite button.',
  },

  /*
   * The admin console. Its entry is the "admin" link in the status strip's build
   * badge, shown to administrators only — tidiness, not security; `requireAdmin`
   * protects every route the console calls. Inside, the console has its own
   * section navigation, and the two record pages are reached from rows.
   */
  '/admin': {
    means: 'strip',
    audience: 'admins',
    reason: 'The status strip’s “admin” link, for administrators.',
  },
  '/admin/worlds': { means: 'console', reason: 'Admin section.' },
  '/admin/players': { means: 'console', reason: 'Admin section.' },
  '/admin/carriers': { means: 'console', reason: 'Admin section.' },
  '/admin/economy': { means: 'console', reason: 'Admin section.' },
  '/admin/system': { means: 'console', reason: 'Admin section.' },
  '/admin/audit': { means: 'console', reason: 'Admin section.' },
  '/admin/players/:playerId': {
    means: 'record',
    from: '/admin/players',
    reason: 'One player’s record, from their row in the players list.',
  },
  '/admin/airlines/:airlineId': {
    means: 'record',
    from: '/admin/players',
    reason: 'One airline’s support record, from the players list and a player’s record.',
  },
};

/** A route the router mounts outside the shell, or a path that is not a route at all. */
export interface OutOfShellRoute {
  /** Why it is not inside the shell. One line. */
  reason: string;
  /** The in-shell page that links to it, or null when nothing should. */
  reachedFrom: string | null;
  /** True for a path the router deliberately does not mount. */
  notARoute?: true;
}

/** Deliberately outside the shell, each with its reason (SURFACE-07's fourth point). */
export const OUT_OF_SHELL_ROUTES: Readonly<Record<string, OutOfShellRoute>> = {
  '/found': {
    reason:
      'AIR-07’s cold open: there is no game behind it until an airline exists. The index redirect sends a player with no airline here, and so do the empty states that need one.',
    // Only for a player without an airline — a second airline is refused until
    // the client can pick a world (#1193) — so no page an established player sees
    // links to it, and the render check below does not look for one.
    reachedFrom: null,
  },
  '/airline/logo': {
    reason: 'A full-screen builder that owns its own chrome and saves as its own rebrand.',
    reachedFrom: '/airline',
  },
  '/fleet/cabin': {
    reason: 'A full-screen builder (M6-08) that owns its own model and chrome.',
    reachedFrom: '/fleet',
  },
  '/login': {
    reason:
      'Not a route: `RequireSession` renders the sign-in page in place of whatever was asked for.',
    reachedFrom: null,
    notARoute: true,
  },
};

/** Paths in the router that are not destinations, and so need no way in. */
export const NOT_DESTINATIONS: Readonly<Record<string, string>> = {
  '/': 'The index redirect: it decides between the founding desk and the world.',
  '*': 'The not-found page, for a path the router does not know.',
};
