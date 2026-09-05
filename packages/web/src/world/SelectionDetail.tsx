import { Link } from 'react-router';

import { airportCodes } from './hover';
import { bestHub } from './route-create';

import type { WorldAirport } from './layers';
import type { WorldHub, WorldMapFlight, WorldMapRoute, WorldMapTrafficRoute } from './map-api';
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

/**
 * An aeroplane that is actually in the air (WORLD-10).
 *
 * The old flight card said "Flown by Rival Air." and stopped, because the plane
 * behind it was decoration: one per active route, riding a looping phase,
 * whether or not anything was flying that leg. There was nothing else true to
 * say about it.
 *
 * A real flight has an aeroplane, two instants and a delay, so it says those.
 */
const CLOCK = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** Game time, formatted the way the world clock over the map formats it. */
function at(iso: string): string {
  const when = new Date(iso);
  return Number.isNaN(when.getTime()) ? '—' : `${CLOCK.format(when)} UTC`;
}

/** Whole minutes between two instants, or null when either is unreadable. */
export function minutesBetween(fromIso: string, toIso: string): number | null {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.round((to - from) / 60_000);
}

/**
 * How late it left, as a sentence — or nothing at all when it left on time.
 *
 * A minute either way is rounding rather than a delay, and a card that says
 * "0 min late" on every punctual flight teaches a player to stop reading it.
 */
export function departureDelay(flight: {
  scheduledDeparture: string;
  departedAt: string;
}): string | null {
  const minutes = minutesBetween(flight.scheduledDeparture, flight.departedAt);
  if (minutes === null || minutes < 2) return null;
  return `Left ${String(minutes)} min late.`;
}

export function airborneSubtitle(flight: WorldMapFlight): string {
  return `${flight.originIcao} → ${flight.destinationIcao}`;
}

export function AirborneDetail({
  flight,
  now,
}: {
  flight: WorldMapFlight;
  /** The world's own time, so "due in" is measured on the world's clock. */
  now: Date;
}): ReactNode {
  const late = departureDelay(flight);
  const remaining = minutesBetween(now.toISOString(), flight.arrivesAt);

  return (
    <div className="world-selection">
      <p className="world-renderer__route-muted">
        {flight.own ? 'One of your aircraft, in the air now.' : `Flown by ${flight.airlineName}.`}
      </p>

      <ul className="world-renderer__route-list">
        <li className="world-renderer__route-item">
          <span className="world-renderer__route-name">{flight.originName}</span>
          <span className="world-renderer__route-code">{at(flight.departedAt)}</span>
        </li>
        <li className="world-renderer__route-item">
          <span className="world-renderer__route-name">{flight.destinationName}</span>
          <span className="world-renderer__route-code">{at(flight.arrivesAt)}</span>
        </li>
      </ul>

      <p className="world-renderer__route-muted">
        {flight.registration === null
          ? 'Aircraft unknown.'
          : `${flight.registration}${flight.typeDesignation === null ? '' : ` · ${flight.typeDesignation}`}`}
        {remaining === null
          ? ''
          : remaining > 0
            ? ` · due in ${String(remaining)} min`
            : ' · overdue'}
      </p>

      {late !== null && <p className="world-renderer__route-muted">{late}</p>}
    </div>
  );
}

/**
 * A route somebody flies, as opposed to an aeroplane in the air.
 *
 * Still reachable: clicking a rival's route *line* selects the route rather than
 * a flight, and the network is worth drawing whether or not anything is on it
 * right now.
 */
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
