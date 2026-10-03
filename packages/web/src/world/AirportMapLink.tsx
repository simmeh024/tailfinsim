import { Link, useInRouterContext } from 'react-router';

import type { ReactNode } from 'react';

/**
 * Where an airport's map lives: the world page, opened on its schematic
 * (M7-07, App. B.7).
 *
 * `/world?airport=ICAO` rather than a route of its own, because §H.2 makes the
 * airport map the innermost band of the world's zoom rather than a separate
 * page: arriving by this link and zooming in from the globe are the same state,
 * and leaving it lands on the world centred on that airport either way.
 */
export function airportMapHref(icao: string): string {
  return `/world?airport=${encodeURIComponent(icao)}`;
}

/**
 * A link into an airport's map from anywhere in the client.
 *
 * A router `Link` wherever there is a router, which is everywhere in the app —
 * a bare anchor reloads the whole bundle and throws away every fetch the
 * session has made. The anchor is only the fallback for a surface rendered on
 * its own, as the Gates view's tests do; it still goes to the right place.
 */
export function AirportMapLink({
  icao,
  className,
  children,
}: {
  icao: string;
  className?: string;
  children: ReactNode;
}): ReactNode {
  const routed = useInRouterContext();
  const href = airportMapHref(icao);
  return routed ? (
    <Link to={href} className={className}>
      {children}
    </Link>
  ) : (
    <a href={href} className={className}>
      {children}
    </a>
  );
}
