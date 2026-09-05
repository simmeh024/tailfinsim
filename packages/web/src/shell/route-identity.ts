import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router';

/**
 * What page this is, said out loud (UX-04).
 *
 * A single-page app changes its whole content without changing anything a
 * browser or an assistive technology notices. Tailfin had `<title>Tailfin</title>`
 * for all twenty routes and nothing else: every browser tab, history entry,
 * bookmark and shared screenshot was identical, and a screen-reader user
 * activated a navigation link and heard **silence** — the page had changed and
 * there was no way to know.
 *
 * Three things fix that, and they are one concern rather than three:
 *
 *   1. the document title says which page this is;
 *   2. focus moves to the page's own heading, which is also what makes a screen
 *      reader announce the new page;
 *   3. a skip link lets a keyboard user reach the content without tabbing the
 *      whole navigation rail first.
 *
 * ## Why focus rather than a live region
 *
 * Announcing the route name through an `aria-live` region would say the name and
 * leave the reader's focus back on the link they just activated, so their next
 * key press continues through the navigation. Moving focus to the heading
 * announces the same name *and* puts them at the top of the new page, which is
 * what following a link does everywhere else. It is the behaviour a browser
 * gives for free on a document navigation and that a router takes away.
 *
 * ## Why it does not fire on the first render
 *
 * A page that steals focus on load is a page that fights the browser: the user
 * has not navigated yet, and moving focus away from the document start on
 * arrival is its own bug. So the first pathname is recorded and skipped, and
 * only changes after it move focus. The title is set every time, because a
 * title is not focus.
 */

/**
 * The name of a route, for a title.
 *
 * A table rather than a `useDocumentTitle` call in twenty page components,
 * because the second shape means every new page is a chance to forget one — and
 * a page with no title silently inherits whatever the last one set, which is
 * worse than a static title because it is *wrong* rather than merely uninformative.
 *
 * Longest prefix wins, so `/admin/players/:id` is "Players" without needing a
 * row per identifier, and the admin console's nested layout gets both halves of
 * its name.
 */
const ROUTE_NAMES: readonly (readonly [string, string])[] = [
  ['/admin/worlds', 'Worlds · Admin'],
  ['/admin/players', 'Players · Admin'],
  ['/admin/airlines', 'Airline · Admin'],
  ['/admin/carriers', 'Carriers · Admin'],
  ['/admin/economy', 'Economy · Admin'],
  ['/admin/system', 'System health · Admin'],
  ['/admin/audit', 'Audit log · Admin'],
  ['/admin', 'Admin console'],
  ['/world', 'World'],
  ['/fleet/cabin', 'Cabin · Fleet'],
  ['/fleet', 'Fleet'],
  ['/network', 'Network'],
  ['/finance', 'Finance'],
  ['/crew', 'Crew'],
  ['/headquarters', 'Headquarters'],
  ['/c-suite', 'C-Suite'],
  ['/design', 'Design'],
  ['/board', 'Board'],
  ['/settings', 'Settings'],
  ['/found', 'Found your airline'],
  ['/login', 'Sign in'],
];

/** `Fleet · Tailfin`, or just `Tailfin` for a path with no name. */
export function titleFor(pathname: string): string {
  const match = ROUTE_NAMES.find(
    ([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
  return match ? `${match[1]} · Tailfin` : 'Tailfin';
}

/** The id the skip link points at, and the focus target on navigation. */
export const STAGE_ID = 'stage';

/**
 * Keep the document title and the focus in step with the route.
 *
 * Called once, from the shell. The focus target is the stage rather than a
 * heading element because the shell does not own the pages' headings — a page
 * whose first element is a `<h1>` gets that read out anyway, since the stage is
 * where the reader is placed and the heading is what follows.
 */
export function useRouteIdentity(): void {
  const { pathname } = useLocation();
  const first = useRef(true);

  useEffect(() => {
    document.title = titleFor(pathname);

    if (first.current) {
      // Arriving, not navigating. Stealing focus here fights the browser.
      first.current = false;
      return;
    }

    const stage = document.getElementById(STAGE_ID);
    if (stage === null) return;
    // `preventScroll`, because the stage is already at the top of a fresh route
    // and a scroll here only fights whatever the page does on mount.
    stage.focus({ preventScroll: true });
  }, [pathname]);
}
