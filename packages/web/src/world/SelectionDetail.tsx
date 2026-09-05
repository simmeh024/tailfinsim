import { Link } from 'react-router';

import { airportCodes } from './hover';
import { bestHub } from './route-create';

import type { WorldAirport } from './layers';
import type { WorldHub, WorldMapRoute, WorldMapTrafficRoute } from './map-api';
import type { ReactNode } from 'react';

/**
 * What the context panel shows when something on the map is selected (WORLD-07).
 *
 * ## Why this moved out of the renderer
 *
 * These two were `role="dialog"` blocks floating over the bottom-right corner of
 * the map — the only surface in Tailfin that answered a selection that way.
 * Crew, the aircraft marketplace, the livery studio and the route planner all
 * publish through `useContextSelection`, and App. H.4 asks for a context panel
 * *"that never covers the world"* — which the World page then covered the world
 * with.
 *
 * It was also the reason that corner was contested: the panel, the performance
 * offer, the renderer-failure alert and (on a narrow viewport) the world clock
 * were all anchored to it.
 *
 * The header, the subtitle and the dismissal are the panel's, so they are gone
 * from here; what is left is the detail itself.
 */

export interface AirportDetailProps {
  airport: WorldAirport;
  /** The player's hubs, for reach and for "one of your hubs". */
  hubs: readonly WorldHub[];
  /** The player's own routes through this airport, either way round. */
  routes: readonly WorldMapRoute[];
  /** Whether this airport is one of the player's own hubs. */
  isHub: boolean;
  /** The fleet's longest range, or 0 with no aircraft. */
  maxRangeNm: number;
  onPlanRoute: (originIcao: string, destinationIcao: string) => void;
}

function distance(nm: number): string {
  return Math.round(nm).toLocaleString();
}

export function AirportDetail({
  airport,
  hubs,
  routes,
  isHub,
  maxRangeNm,
  onPlanRoute,
}: AirportDetailProps): ReactNode {
  const reach = isHub ? null : bestHub(airport.position, hubs, maxRangeNm);
  const alreadyFromHub =
    reach !== null &&
    routes.some((r) => r.originIcao === reach.hub.icao && r.destinationIcao === airport.icao);

  return (
    <div className="world-selection">
      <div className="world-renderer__route-create">
        {isHub ? (
          <p className="world-renderer__route-muted">One of your hubs.</p>
        ) : hubs.length === 0 ? (
          <p className="world-renderer__route-muted">Found an airline and a hub to open routes.</p>
        ) : maxRangeNm <= 0 ? (
          <p className="world-renderer__route-muted">
            No aircraft yet — acquire one to open routes from here.
          </p>
        ) : reach === null ? null : alreadyFromHub ? (
          <p className="world-renderer__route-muted">Already flying from {reach.hub.name}.</p>
        ) : reach.reachable ? (
          <button
            type="button"
            className="world-renderer__route-cta"
            onClick={() => {
              onPlanRoute(reach.hub.icao, airport.icao);
            }}
          >
            Open route from {reach.hub.name} · {distance(reach.distanceNm)} nm
          </button>
        ) : (
          <p className="world-renderer__route-muted">
            Out of range — {distance(reach.distanceNm)} nm from {reach.hub.name}, but your aircraft
            reach {distance(maxRangeNm)} nm.
          </p>
        )}
      </div>

      {routes.length > 0 && (
        <ul className="world-renderer__route-list">
          {routes.map((r) => {
            const outbound = r.originIcao === airport.icao;
            const other = outbound ? r.destinationName : r.originName;
            const otherIcao = outbound ? r.destinationIcao : r.originIcao;
            return (
              <li key={r.id} className="world-renderer__route-item">
                <span className="world-renderer__route-dir" aria-hidden="true">
                  {outbound ? '→' : '←'}
                </span>
                <span className="world-renderer__route-name">{other}</span>
                <span className="world-renderer__route-code">{otherIcao}</span>
              </li>
            );
          })}
        </ul>
      )}

      {/* A router link, not a bare anchor: this is inside a single-page app, and
          an `<a href>` here reloaded the whole bundle and threw away every fetch
          the session had made. */}
      <Link to={`/network?to=${airport.icao}`} className="world-renderer__route-link">
        Open route planner
      </Link>
    </div>
  );
}

/** The subtitle the panel shows under an airport's name. */
export function airportSubtitle(airport: WorldAirport, isHub: boolean): string {
  return isHub ? `${airportCodes(airport)} · Your hub` : airportCodes(airport);
}

export function FlightDetail({ route }: { route: WorldMapTrafficRoute }): ReactNode {
  return (
    <div className="world-selection">
      <p className="world-renderer__route-muted">
        {route.own ? 'One of your routes.' : `Flown by ${route.airlineName}.`}
      </p>
      <ul className="world-renderer__route-list">
        <li className="world-renderer__route-item">
          <span className="world-renderer__route-dir" aria-hidden="true">
            →
          </span>
          <span className="world-renderer__route-name">{route.originName}</span>
          <span className="world-renderer__route-code">{route.originIcao}</span>
        </li>
        <li className="world-renderer__route-item">
          <span className="world-renderer__route-dir" aria-hidden="true">
            ←
          </span>
          <span className="world-renderer__route-name">{route.destinationName}</span>
          <span className="world-renderer__route-code">{route.destinationIcao}</span>
        </li>
      </ul>
    </div>
  );
}
