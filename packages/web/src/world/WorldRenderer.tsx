import { MapView, _GlobeView as GlobeView, type Layer, type MapViewState } from '@deck.gl/core';
import { IconLayer, PathLayer } from '@deck.gl/layers';
import DeckGL, { type DeckGLRef } from '@deck.gl/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';

import { fetchFleetAirframes, fetchFleetCatalogue } from '../fleet/api';
import { useTheme } from '../theme/ThemeProvider';

import { fetchWorldAirports } from './airports-api';
import { clampViewState, focusViewState } from './camera';
import { flightPath, planesForRoutes, routeSeed, type WorldPlane } from './flight';
import { COARSE_WORLD, LAND_DETAIL_ZOOM, loadDetailedWorld, type WorldGeometry } from './land';
import {
  airportLevelForZoom,
  createWorldLayers,
  visibleAirportsAtLevel,
  type RendererQuality,
  type WorldAirport,
  type WorldLayerVisibility,
  type WorldRoute,
} from './layers';
import {
  fetchWorldMap,
  type WorldMapData,
  type WorldMapRoute,
  type WorldMapTrafficRoute,
} from './map-api';
import { readWorldPalette } from './palette';
import { SustainedFrameRateMonitor, type FrameRateSample } from './performance';
import { persistProjection, readInitialProjection, type WorldProjection } from './projection';
import { bestHub, fleetMaxRangeNm, reachableAirportIcaos } from './route-create';
import { createDarknessField } from './terminator';
import { useWorldClock } from './useWorldClock';
import { WorldClockDisplay } from './WorldClockDisplay';

import type { WorldPalette } from './palette';
import type { ReactNode } from 'react';

const INITIAL_VIEW_STATE: MapViewState = {
  longitude: 8,
  latitude: 24,
  zoom: 0.35,
  pitch: 0,
  bearing: 0,
  minZoom: -0.5,
  maxZoom: 12,
};

const CONTROLLER = {
  dragPan: true,
  // deck.gl's GlobeController cannot animate around a pointer. One DOM handler
  // below unprojects and focuses the clicked point for both views instead.
  doubleClickZoom: false,
  inertia: true,
  keyboard: true,
  scrollZoom: true,
  touchZoom: true,
};

/**
 * The zoom past which the atmosphere glow is hidden.
 *
 * `.world-renderer__atmosphere` is a CSS ellipse inset 5% of the *container*. It
 * has no idea where the globe actually is, which is fine while the planet sits
 * small and centred in the frame and is exactly what makes it read as a planet in
 * space. Zoom in far enough that the globe overflows the frame and the ring stops
 * tracking anything: it becomes a bright arc sweeping across the map, brightest
 * where it crosses the pole.
 *
 * So it is shown only while the whole globe is still in view. Chosen against the
 * default camera, which is `0.35`, and the point at which the sphere starts to
 * exceed the shorter side of a typical stage.
 */
const ATMOSPHERE_MAX_ZOOM = 1;

const DEFAULT_VISIBILITY: WorldLayerVisibility = {
  graticule: true,
  routes: true,
  terminator: true,
  borders: true,
  terrain: true,
  airports: true,
};

/**
 * A north-up plane silhouette, tinted at draw time (IconLayer `mask`), so the one
 * data URI serves both themes. On its own line so the colour-literal guard skips
 * it (it exempts `data:image/svg+xml`).
 */
// prettier-ignore
const PLANE_ICON = 'data:image/svg+xml;charset=utf-8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="%23000" d="M12 2c-.8 0-1.4 1.3-1.4 3v4.9L2 15v2l8.6-2.6V20l-2.2 1.4V23L12 22l3.6 1v-1.6L13.4 20v-5.6L22 17v-2l-8.6-5.1V5c0-1.7-.6-3-1.4-3z"/></svg>';

/** How fast a plane crosses its whole route: ~1/26 per second, so a full pass is ~26s. */
const PLANE_SPEED_PER_SECOND = 0.038;

export interface WorldRendererProps {
  routes?: readonly WorldRoute[];
}

export function WorldRenderer({ routes = [] }: WorldRendererProps): ReactNode {
  const { theme } = useTheme();
  const initial = useMemo(() => readInitialProjection(), []);
  const [projection, setProjection] = useState<WorldProjection>(initial.projection);
  const [quality, setQuality] = useState<RendererQuality>(initial.lowPower ? 'reduced' : 'full');
  const [viewState, setViewState] = useState<MapViewState>(INITIAL_VIEW_STATE);
  const [visibility, setVisibility] = useState<WorldLayerVisibility>(DEFAULT_VISIBILITY);
  const [now, setNow] = useState(() => new Date());
  const [transitioning, setTransitioning] = useState(false);
  const [performanceOffer, setPerformanceOffer] = useState(false);
  const [performanceOfferDismissed, setPerformanceOfferDismissed] = useState(false);
  const [rendererFailed, setRendererFailed] = useState(false);
  const [palette, setPalette] = useState<WorldPalette>(() => readWorldPalette());
  const [geometry, setGeometry] = useState<WorldGeometry>(COARSE_WORLD);
  const [airports, setAirports] = useState<readonly WorldAirport[]>([]);
  const [map, setMap] = useState<WorldMapData>({ hubs: [], routes: [], traffic: [] });
  const [maxRangeNm, setMaxRangeNm] = useState(0);
  const [phase, setPhase] = useState(0);
  const [selectedAirport, setSelectedAirport] = useState<WorldAirport | null>(null);
  const [selectedRoute, setSelectedRoute] = useState<WorldMapTrafficRoute | null>(null);
  const navigate = useNavigate();
  const transitionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const frameRateMonitor = useRef(new SustainedFrameRateMonitor());
  const deckRef = useRef<DeckGLRef<MapView | GlobeView> | null>(null);
  const lastTouch = useRef<{ at: number; x: number; y: number } | null>(null);

  useEffect(() => {
    const timer = globalThis.setInterval(() => setNow(new Date()), 60_000);
    return () => globalThis.clearInterval(timer);
  }, []);

  // The served airports/cities, fetched once. A resilient read: it resolves to an
  // empty list rather than throwing, so the globe renders with or without dots.
  useEffect(() => {
    let live = true;
    void fetchWorldAirports().then((list) => {
      if (live) setAirports(list);
    });
    return () => {
      live = false;
    };
  }, []);

  // The player's own overlay — hubs and routes. Also resilient: no airline yet is a
  // 409, which resolves to an empty overlay, so the map draws without it.
  useEffect(() => {
    let live = true;
    void fetchWorldMap().then((data) => {
      if (live) setMap(data);
    });
    return () => {
      live = false;
    };
  }, []);

  // The fleet's longest range, joined from owned airframes to the catalogue's
  // per-type range. It decides which airports the map lights as reachable and
  // whether the panel offers to open a route. Resilient: any failure leaves it 0,
  // which simply lights nothing — the same as owning no aircraft.
  useEffect(() => {
    let live = true;
    void Promise.all([fetchFleetAirframes(), fetchFleetCatalogue()])
      .then(([fleet, catalogue]) => {
        if (live) setMaxRangeNm(fleetMaxRangeNm(fleet.airframes, catalogue.types));
      })
      .catch(() => {
        /* no fleet yet, or not signed in: nothing is in range, which is correct. */
      });
    return () => {
      live = false;
    };
  }, []);

  // Simulated flights: advance the animation phase each frame while there are
  // routes to fly. requestAnimationFrame pauses itself when the tab is hidden, and
  // the plane layer is the only thing that depends on `phase`, so the land, sea and
  // day/night bitmaps are not rebuilt as it ticks.
  const hasRoutes = map.traffic.length > 0;
  useEffect(() => {
    if (!hasRoutes) return;
    let raf = 0;
    let last = performance.now();
    const step = (now: number): void => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      setPhase((p) => (p + dt * PLANE_SPEED_PER_SECOND) % 1);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [hasRoutes]);

  const { inGameTime, speedMultiplier } = useWorldClock();

  useEffect(() => {
    // ThemeProvider applies its root data attribute after rendering. Resample on
    // the next task so deck.gl sees the committed CSS tokens, not the old theme.
    const timer = globalThis.setTimeout(() => setPalette(readWorldPalette()), 0);
    return () => globalThis.clearTimeout(timer);
  }, [theme]);

  useEffect(
    () => () => {
      if (transitionTimer.current !== undefined) globalThis.clearTimeout(transitionTimer.current);
    },
    [],
  );

  useEffect(() => {
    frameRateMonitor.current.reset();
  }, [projection]);

  /*
   * Fetch the finer coastline the first time the camera goes in far enough to see
   * the difference, and never again.
   *
   * `110m` is a degree between vertices: perfect for a whole globe, and visibly a
   * row of straight segments once a degree is tens of pixels. `50m` is ten times
   * the bytes, so it is not in the first paint — most sessions never zoom this far,
   * and the ones that do can wait a moment for the coastline to sharpen.
   *
   * `loadDetailedLand` is idempotent and resolves to the coarse outline if the
   * chunk cannot be fetched, so this needs no retry and no error branch: the world
   * stays drawn either way.
   */
  useEffect(() => {
    if (viewState.zoom < LAND_DETAIL_ZOOM || geometry !== COARSE_WORLD) return;
    let live = true;
    void loadDetailedWorld().then((detailed) => {
      if (live) setGeometry(detailed);
    });
    return () => {
      live = false;
    };
  }, [viewState.zoom, geometry]);

  /*
   * Which instant the day/night field describes.
   *
   * **The world's clock, not the reader's.** A world runs from its own epoch at
   * its own speed — the flagship one begins in October 2024 and advances at 2× —
   * so shading it by wall-clock time draws the terminator for the wrong date
   * entirely, and it drifts further every day the world runs. `null` before the
   * first sync, and for a player who has not founded an airline and so has no
   * world; wall-clock time is the only thing left to draw then, and it is better
   * than a globe with no terminator on it at all.
   */
  const shadingTime = inGameTime ?? now;

  /*
   * Bucketed to the in-game minute rather than memoised on the instant.
   *
   * `useWorldClock` re-renders once a second so the displayed time is not late,
   * and rebuilding a 512x256 field of trigonometry at that rate would be absurd.
   * A minute of game time moves the terminator a quarter of a degree, and a texel
   * is seven tenths of one, so the bucket is well inside a texel and nothing is
   * visibly quantised. At the flagship 2x that is a rebuild every thirty real
   * seconds, which is what the wall-clock version cost before.
   */
  const shadingMinute = Math.floor(shadingTime.getTime() / 60_000);

  // Sampled at the quality the device is coping with. Half the resolution is
  // still far finer than the twilight band it has to describe: the gradient spans
  // twelve degrees of solar elevation, and a reduced texel is two.
  // `projection` is in here because the *rows* differ between the two views, not
  // just the bounds: the flat map spaces them in Web Mercator and the globe in
  // degrees. `layers.ts` explains why that is done in the field rather than in a
  // shader.
  const darkness = useMemo(
    () =>
      createDarknessField(
        new Date(shadingMinute * 60_000),
        quality === 'full' ? 512 : 256,
        quality === 'full' ? 256 : 128,
        projection === 'globe' ? 'equirectangular' : 'mercator',
      ),
    [shadingMinute, quality, projection],
  );
  // `projection` is a dependency, and not because the layer list differs between
  // the views — it does not. Switching projection has to rebuild the layers so the
  // world-sized bitmaps re-tessellate for the new viewport; see `layers.ts`.
  // The arcs draw the player's own routes (an explicit `routes` prop overrides, for
  // tests). Clicking an airport the player flies to opens its route panel; an
  // airport with no route of theirs does nothing.
  const playerRoutes = routes.length > 0 ? routes : map.routes;
  const routesThrough = useCallback(
    (icao: string): WorldMapRoute[] =>
      map.routes.filter((r) => r.originIcao === icao || r.destinationIcao === icao),
    [map.routes],
  );
  const hubIcaos = useMemo(() => new Set(map.hubs.map((h) => h.icao)), [map.hubs]);

  // Declutter by zoom: only the major airports on the whole-world view, smaller
  // fields revealing as the camera comes in. Keyed to a discrete level so the list
  // is refiltered on a threshold crossing, not on every scroll frame.
  const airportLevel = airportLevelForZoom(viewState.zoom);
  const visibleAirports = useMemo(
    () => visibleAirportsAtLevel(airports, airportLevel),
    [airports, airportLevel],
  );

  // Which airports the fleet can reach from a hub, for the map's highlight — but
  // only when there is a fleet and a hub to highlight *against*. With no aircraft
  // yet (or before the fleet loads) there is no in-range subset, so the highlight is
  // `undefined` and every airport draws at full strength: a new player must still
  // see the whole map, not a field faded to nothing. The reachable set fades the
  // rest back only once some airports genuinely stand out from it. Scoped to the
  // airports actually shown at this zoom.
  const reachableIcaos = useMemo(
    () =>
      maxRangeNm > 0 && map.hubs.length > 0
        ? reachableAirportIcaos(visibleAirports, map.hubs, maxRangeNm)
        : undefined,
    [visibleAirports, map.hubs, maxRangeNm],
  );

  // Any airport opens the panel now — reachable or not — so a click can offer to
  // plan a route, show why it can't, or list the routes already there.
  const onAirportClick = useCallback((airport: WorldAirport) => {
    setSelectedAirport(airport);
    setSelectedRoute(null);
  }, []);

  // The map is for discovery; opening a route happens in the route planner. Hand it
  // the origin and destination so the "Open a route" form arrives pre-filled.
  const planRoute = useCallback(
    (originIcao: string, destinationIcao: string) => {
      void navigate(`/network?from=${originIcao}&to=${destinationIcao}`);
    },
    [navigate],
  );

  const layers = useMemo(
    () =>
      createWorldLayers({
        palette,
        projection,
        quality,
        routes: playerRoutes,
        airports: visibleAirports,
        hubs: map.hubs,
        reachableIcaos,
        onAirportClick,
        darkness,
        land: geometry.land,
        borders: geometry.borders,
        visibility,
      }),
    [
      palette,
      projection,
      quality,
      playerRoutes,
      visibleAirports,
      map.hubs,
      reachableIcaos,
      onAirportClick,
      darkness,
      geometry,
      visibility,
    ],
  );

  // The world's live traffic — every active route flown by any carrier, the player's
  // own and the NPCs' — is what the planes ride. A lookup by route id turns a clicked
  // plane back into the carrier behind it, and the own-route set colours a player's
  // own flights apart from the competition's.
  const trafficById = useMemo(() => new Map(map.traffic.map((r) => [r.id, r])), [map.traffic]);
  const ownRouteIds = useMemo(
    () => new Set(map.traffic.filter((r) => r.own).map((r) => r.id)),
    [map.traffic],
  );

  // A plane is selected out of the animated layer, so its route is redrawn even when
  // that carrier's line is not otherwise on the map (NPC routes have no line of their
  // own until one is clicked). Cleared if its route leaves the world's traffic.
  useEffect(() => {
    if (selectedRoute !== null && !trafficById.has(selectedRoute.id)) setSelectedRoute(null);
  }, [selectedRoute, trafficById]);

  // The animated plane layer is kept out of `layers` on purpose: it changes every
  // frame with `phase`, and folding it into the memo above would rebuild the land,
  // sea and day/night bitmaps sixty times a second.
  const planeLayer = useMemo(() => {
    const planes = planesForRoutes(map.traffic, phase, 1);
    return new IconLayer<WorldPlane>({
      id: 'world-planes',
      data: planes,
      getPosition: (p) => p.position,
      getIcon: () => ({ url: PLANE_ICON, width: 24, height: 24, mask: true }),
      getSize: 16,
      sizeUnits: 'pixels',
      getAngle: (p) => p.angle,
      // The player's own flights in the route blue; the competition's in the amber
      // FlightRadar reads on — both theme tokens, so no colour literal here.
      getColor: (p) => (ownRouteIds.has(p.sourceId) ? palette.route : palette.airport),
      updateTriggers: { getColor: [ownRouteIds, palette.route, palette.airport] },
      // Clickable so a plane can name its carrier and draw its route; a fatter pick
      // radius (set on DeckGL) makes the small icons easy to hit.
      pickable: true,
      onClick: (info) => {
        const plane = info.object as WorldPlane | undefined;
        if (!plane) return false;
        const carrierRoute = trafficById.get(plane.sourceId);
        if (carrierRoute) {
          setSelectedRoute(carrierRoute);
          setSelectedAirport(null);
        }
        return true;
      },
      billboard: true,
      // Lift the plane off the surface like the routes and airports, so it is not
      // depth-rejected by the terrain at the whole-globe zoom.
      getPolygonOffset: () => [0, -60000],
      parameters: { cullMode: 'none' },
    });
  }, [map.traffic, phase, palette.route, palette.airport, ownRouteIds, trafficById]);

  // The clicked plane's route, drawn on demand: an NPC's line does not otherwise
  // appear, and this is what "show their route" puts on the map. Coloured like its
  // planes — own blue, competition amber — and lifted off the surface like the rest
  // of the overlay so it clears the terrain at the far-out zoom.
  const selectedRouteLayer = useMemo(() => {
    if (selectedRoute === null) return false;
    const line = selectedRoute.own ? palette.route : palette.airport;
    return new PathLayer<WorldMapTrafficRoute>({
      id: 'world-selected-route',
      data: [selectedRoute],
      getPath: (r) => flightPath(r.source, r.target, routeSeed(r.id), quality === 'full' ? 64 : 32),
      getColor: [line[0], line[1], line[2], 255],
      getWidth: 4,
      widthUnits: 'pixels',
      widthMinPixels: 3,
      widthMaxPixels: 8,
      capRounded: true,
      jointRounded: true,
      parameters: { cullMode: 'none' },
      getPolygonOffset: () => [0, -60000],
    });
  }, [selectedRoute, palette.route, palette.airport, quality]);

  const allLayers = useMemo<(Layer | false)[]>(
    () => [...layers, selectedRouteLayer, planeLayer],
    [layers, selectedRouteLayer, planeLayer],
  );
  const view = useMemo(
    () =>
      projection === 'globe'
        ? new GlobeView({
            id: 'world-renderer',
            controller: CONTROLLER,
            /*
             * Degrees per mesh vertex on the sphere, and it is the day/night
             * layer's edge quality more than anything else.
             *
             * The night field is a texture, and `BitmapLayer` interpolates its
             * texture coordinates **across each flat facet** of this mesh. At five
             * degrees the facets are large enough that a diagonal terminator breaks
             * into a visible staircase of five-degree steps — the smooth field is
             * there, the mesh cannot express it. Two degrees is roughly six times
             * the triangles for a boundary that reads as a curve.
             *
             * It also tessellates the land and route geometry on the globe, so the
             * coastlines gain from it too. Reduced quality keeps five, which is what
             * a device that could not hold the frame budget was already getting.
             */
            resolution: quality === 'full' ? 2 : 5,
          })
        : new MapView({
            id: 'world-renderer',
            controller: CONTROLLER,
            repeat: true,
          }),
    [projection, quality],
  );

  const chooseProjection = useCallback(
    (next: WorldProjection) => {
      if (projection === next) return;
      persistProjection(next);
      setProjection(next);
      setTransitioning(true);
      setPerformanceOffer(false);
      if (transitionTimer.current !== undefined) globalThis.clearTimeout(transitionTimer.current);
      transitionTimer.current = globalThis.setTimeout(() => setTransitioning(false), 180);
    },
    [projection],
  );

  const toggleLayer = useCallback((layer: keyof WorldLayerVisibility) => {
    setVisibility((current) => ({ ...current, [layer]: !current[layer] }));
  }, []);

  const observeMetrics = useCallback(
    (metrics: FrameRateSample) => {
      if (
        projection === 'globe' &&
        !performanceOfferDismissed &&
        frameRateMonitor.current.observe(metrics)
      ) {
        setQuality('reduced');
        setPerformanceOffer(true);
      }
    },
    [performanceOfferDismissed, projection],
  );

  const focusAtClientPoint = useCallback(
    (element: HTMLDivElement, clientX: number, clientY: number) => {
      const viewport = deckRef.current?.deck?.getViewports()[0];
      if (!viewport) return;
      const bounds = element.getBoundingClientRect();
      const coordinate = viewport.unproject([clientX - bounds.left, clientY - bounds.top]);
      if (!Number.isFinite(coordinate[0]) || !Number.isFinite(coordinate[1])) return;
      setViewState((current) => focusViewState(current, [coordinate[0]!, coordinate[1]!]));
    },
    [],
  );

  const focusAtPointer = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      focusAtClientPoint(event.currentTarget, event.clientX, event.clientY);
    },
    [focusAtClientPoint],
  );

  const focusAtDoubleTap = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.pointerType !== 'touch') return;
      const previous = lastTouch.current;
      const closeInTime = previous !== null && event.timeStamp - previous.at <= 350;
      const closeInSpace =
        previous !== null &&
        Math.hypot(event.clientX - previous.x, event.clientY - previous.y) <= 32;
      if (closeInTime && closeInSpace) {
        lastTouch.current = null;
        focusAtClientPoint(event.currentTarget, event.clientX, event.clientY);
        return;
      }
      lastTouch.current = { at: event.timeStamp, x: event.clientX, y: event.clientY };
    },
    [focusAtClientPoint],
  );

  return (
    <section
      className="world-renderer"
      data-projection={projection}
      data-quality={quality}
      data-atmosphere={viewState.zoom < ATMOSPHERE_MAX_ZOOM ? 'on' : 'off'}
      data-transitioning={transitioning}
      aria-label="Interactive world renderer"
    >
      <div
        className="world-renderer__canvas"
        role="application"
        aria-label={`${projection === 'globe' ? 'Globe' : 'Flat'} world map. Drag to move, scroll or pinch to zoom, and double tap to focus.`}
        onDoubleClick={focusAtPointer}
        onPointerUp={focusAtDoubleTap}
      >
        <DeckGL
          ref={deckRef}
          views={view}
          viewState={viewState}
          layers={allLayers}
          // A few pixels of slack so the small airport dots are easy to click.
          pickingRadius={5}
          useDevicePixels={quality === 'full' ? true : 1}
          onViewStateChange={({ viewState: next }) => {
            setViewState(clampViewState(next));
          }}
          onError={() => setRendererFailed(true)}
          _onMetrics={observeMetrics}
        />
      </div>

      <div className="world-renderer__atmosphere" aria-hidden="true" />

      {selectedAirport !== null &&
        (() => {
          const airport = selectedAirport;
          const isHub = hubIcaos.has(airport.icao);
          const existing = routesThrough(airport.icao);
          const reach = isHub ? null : bestHub(airport.position, map.hubs, maxRangeNm);
          const alreadyFromHub =
            reach !== null &&
            existing.some(
              (r) => r.originIcao === reach.hub.icao && r.destinationIcao === airport.icao,
            );
          const distance = (nm: number): string => Math.round(nm).toLocaleString();
          return (
            <div
              className="world-renderer__route-panel"
              role="dialog"
              aria-label={`Routes at ${airport.name}`}
            >
              <div className="world-renderer__route-head">
                <div>
                  <p className="world-renderer__route-eyebrow">
                    {isHub ? 'Your hub' : 'Route planner'}
                  </p>
                  <p className="world-renderer__route-title">{airport.name}</p>
                  <p className="world-renderer__route-code">{airport.icao}</p>
                </div>
                <button
                  type="button"
                  className="world-renderer__route-close"
                  aria-label="Close"
                  onClick={() => setSelectedAirport(null)}
                >
                  ×
                </button>
              </div>

              <div className="world-renderer__route-create">
                {isHub ? (
                  <p className="world-renderer__route-muted">One of your hubs.</p>
                ) : map.hubs.length === 0 ? (
                  <p className="world-renderer__route-muted">
                    Found an airline and a hub to open routes.
                  </p>
                ) : maxRangeNm <= 0 ? (
                  <p className="world-renderer__route-muted">
                    No aircraft yet — acquire one to open routes from here.
                  </p>
                ) : reach === null ? null : alreadyFromHub ? (
                  <p className="world-renderer__route-muted">
                    Already flying from {reach.hub.name}.
                  </p>
                ) : reach.reachable ? (
                  <button
                    type="button"
                    className="world-renderer__route-cta"
                    onClick={() => {
                      planRoute(reach.hub.icao, airport.icao);
                    }}
                  >
                    Open route from {reach.hub.name} · {distance(reach.distanceNm)} nm
                  </button>
                ) : (
                  <p className="world-renderer__route-muted">
                    Out of range — {distance(reach.distanceNm)} nm from {reach.hub.name}, but your
                    aircraft reach {distance(maxRangeNm)} nm.
                  </p>
                )}
              </div>

              {existing.length > 0 && (
                <ul className="world-renderer__route-list">
                  {existing.map((r) => {
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

              <a href={`/network?to=${airport.icao}`} className="world-renderer__route-link">
                Open route planner
              </a>
            </div>
          );
        })()}

      {selectedRoute !== null && (
        <div
          className="world-renderer__route-panel"
          role="dialog"
          aria-label={`Flight ${selectedRoute.originIcao} to ${selectedRoute.destinationIcao}`}
        >
          <div className="world-renderer__route-head">
            <div>
              <p className="world-renderer__route-eyebrow">
                {selectedRoute.own ? 'Your flight' : selectedRoute.airlineName}
              </p>
              <p className="world-renderer__route-title">
                {selectedRoute.originName} → {selectedRoute.destinationName}
              </p>
              <p className="world-renderer__route-code">
                {selectedRoute.originIcao} → {selectedRoute.destinationIcao}
              </p>
            </div>
            <button
              type="button"
              className="world-renderer__route-close"
              aria-label="Close"
              onClick={() => setSelectedRoute(null)}
            >
              ×
            </button>
          </div>
          <p className="world-renderer__route-muted">
            {selectedRoute.own ? 'One of your routes.' : `Flown by ${selectedRoute.airlineName}.`}
          </p>
        </div>
      )}

      <WorldClockDisplay inGameTime={inGameTime} speedMultiplier={speedMultiplier} />

      <div className="world-renderer__controls">
        <div className="world-renderer__control-group" role="group" aria-label="Projection">
          <button
            type="button"
            aria-pressed={projection === 'globe'}
            onClick={() => chooseProjection('globe')}
          >
            Globe
          </button>
          <button
            type="button"
            aria-pressed={projection === 'flat'}
            onClick={() => chooseProjection('flat')}
          >
            Flat
          </button>
        </div>

        <div className="world-renderer__control-group" role="group" aria-label="Map layers">
          <button
            type="button"
            aria-pressed={visibility.terminator}
            onClick={() => toggleLayer('terminator')}
          >
            Day/night
          </button>
          <button
            type="button"
            aria-pressed={visibility.routes}
            onClick={() => toggleLayer('routes')}
          >
            Routes
          </button>
          <button
            type="button"
            aria-pressed={visibility.airports}
            onClick={() => toggleLayer('airports')}
          >
            Airports
          </button>
          <button
            type="button"
            aria-pressed={visibility.terrain}
            onClick={() => toggleLayer('terrain')}
          >
            Terrain
          </button>
          <button
            type="button"
            aria-pressed={visibility.borders}
            onClick={() => toggleLayer('borders')}
          >
            Borders
          </button>
          <button
            type="button"
            aria-pressed={visibility.graticule}
            onClick={() => toggleLayer('graticule')}
          >
            Grid
          </button>
        </div>
      </div>

      {performanceOffer && (
        <div className="world-renderer__performance" role="status">
          <p>The globe is running below the smooth-frame budget. Reduced detail is active.</p>
          <div>
            <button type="button" onClick={() => chooseProjection('flat')}>
              Switch to flat
            </button>
            <button
              type="button"
              onClick={() => {
                setPerformanceOffer(false);
                setPerformanceOfferDismissed(true);
              }}
            >
              Keep globe
            </button>
          </div>
        </div>
      )}

      {rendererFailed && (
        <p className="world-renderer__failure" role="alert">
          The hardware renderer could not start. The rest of Tailfin remains available.
        </p>
      )}
    </section>
  );
}
