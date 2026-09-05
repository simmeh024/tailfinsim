import {
  FlyToInterpolator,
  MapView,
  _GlobeView as GlobeView,
  type Layer,
  type MapViewState,
} from '@deck.gl/core';
import { IconLayer, PathLayer } from '@deck.gl/layers';
import DeckGL, { type DeckGLRef } from '@deck.gl/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';

import { fetchFleetAirframes, fetchFleetCatalogue } from '../fleet/api';
import { useTheme } from '../theme/ThemeProvider';

import { fetchWorldAirports } from './airports-api';
import { clampViewState, focusViewState } from './camera';
import { flightPath, greatCirclePath, planesForRoutes, routeSeed, type WorldPlane } from './flight';
import { frameOf, networkPoints } from './frame';
import { airportCodes, airportLabel, flightLabel, tipPlacement, type HoverLabel } from './hover';
import { COARSE_WORLD, LAND_DETAIL_ZOOM, loadDetailedWorld, type WorldGeometry } from './land';
import {
  airportLevelForZoom,
  createWorldLayers,
  planeSpriteSize,
  visibleAirportsAtLevel,
  type HoverPoint,
  type RendererQuality,
  type WorldAirport,
  type WorldLayerVisibility,
  type WorldRoute,
} from './layers';
import { type WorldMapRoute, type WorldMapTrafficRoute } from './map-api';
import { parseHexColor, readWorldPalette, type RgbaColor, type WorldPalette } from './palette';
import { SustainedFrameRateMonitor, type FrameRateSample } from './performance';
import { persistProjection, readInitialProjection, type WorldProjection } from './projection';
import { bundleCorridors, corridorGridForZoom, type Corridor } from './route-corridors';
import { bestHub, fleetMaxRangeNm, reachableAirportIcaos } from './route-create';
import { createDarknessField, type LngLat } from './terminator';
import { useWorldOverlay } from './use-world-overlay';
import { useWorldClock } from './useWorldClock';
import {
  cameraFromSearch,
  cameraOf,
  cameraSearch,
  icaoFromSearch,
  persistView,
  readStoredView,
  sameCamera,
} from './view-state';
import { WorldClockDisplay } from './WorldClockDisplay';

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
  /*
   * What the map opens as: a link, then a memory, then WORLD-04's fit, then the
   * whole world. That order is the only one under which a shared link works —
   * somebody who sends you a view of Heathrow means for you to arrive at
   * Heathrow rather than wherever you last left the camera.
   */
  const [searchParams, setSearchParams] = useSearchParams();
  const linked = useMemo(() => cameraFromSearch(searchParams), [searchParams]);
  const remembered = useMemo(() => readStoredView(DEFAULT_VISIBILITY), []);
  const openingCamera = linked ?? (remembered.zoom !== undefined ? remembered : null);

  const [viewState, setViewState] = useState<MapViewState>(() =>
    openingCamera === null
      ? INITIAL_VIEW_STATE
      : clampViewState({ ...INITIAL_VIEW_STATE, ...openingCamera }),
  );
  const [visibility, setVisibility] = useState<WorldLayerVisibility>(
    remembered.visibility ?? DEFAULT_VISIBILITY,
  );
  const [now, setNow] = useState(() => new Date());
  const [transitioning, setTransitioning] = useState(false);
  const [performanceOffer, setPerformanceOffer] = useState(false);
  const [performanceOfferDismissed, setPerformanceOfferDismissed] = useState(false);
  const [rendererFailed, setRendererFailed] = useState(false);
  const [palette, setPalette] = useState<WorldPalette>(() => readWorldPalette());
  const [geometry, setGeometry] = useState<WorldGeometry>(COARSE_WORLD);
  const [airports, setAirports] = useState<readonly WorldAirport[]>([]);
  // The player's overlay, refreshed while the page is open (WORLD-06).
  const map = useWorldOverlay();
  const [maxRangeNm, setMaxRangeNm] = useState(0);
  const [phase, setPhase] = useState(0);
  const [selectedAirport, setSelectedAirport] = useState<WorldAirport | null>(null);
  /** What the pointer is over, and where — see `hover.ts`. */
  const [hover, setHover] = useState<{ label: HoverLabel; at: HoverPoint } | null>(null);
  const [selectedRoute, setSelectedRoute] = useState<WorldMapTrafficRoute | null>(null);
  const [showRivals, setShowRivals] = useState(remembered.rivals ?? false);
  const [showLegend, setShowLegend] = useState(remembered.legend ?? false);
  const [reducedMotion, setReducedMotion] = useState(
    () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
  );
  const navigate = useNavigate();
  const transitionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const frameRateMonitor = useRef(new SustainedFrameRateMonitor());
  const deckRef = useRef<DeckGLRef<MapView | GlobeView> | null>(null);
  const lastTouch = useRef<{ at: number; x: number; y: number } | null>(null);
  /** Whether a `?at=` link has been resolved; it happens once, like the frame. */
  const addressed = useRef(false);

  /*
   * `/world?at=EGLL` — the hand-written link.
   *
   * It cannot be honoured until the airport list arrives, which is why it is an
   * effect rather than an initial state. An explicit `lng`/`lat`/`z` wins: it
   * says exactly where the camera goes, and a code only says which city.
   *
   * A zoom floor rather than a fixed zoom, so following a link from a close-up
   * view does not throw away the zoom the reader already had.
   */
  useEffect(() => {
    if (addressed.current || linked !== null || airports.length === 0) return;
    const code = icaoFromSearch(searchParams);
    if (code === null) return;
    const airport = airports.find((entry) => entry.icao === code || entry.iata === code);
    if (airport === undefined) return;
    addressed.current = true;
    framed.current = true;
    setSelectedAirport(airport);
    setViewState((current) =>
      clampViewState({
        ...current,
        longitude: airport.position[0],
        latitude: airport.position[1],
        zoom: Math.max(current.zoom, 6),
      }),
    );
  }, [airports, linked, searchParams]);

  /**
   * The canvas, as deck.gl measures it — or nothing, which `frame.ts` handles.
   *
   * `getViewports()` **throws** on a deck that has not initialised, rather than
   * returning an empty array: in jsdom, and in any browser where the hardware
   * renderer failed to start, this is the difference between a fallback frame
   * and an exception thrown out of an effect that takes the whole page down
   * with it. Found by the app-level tests, which mount the real deck.gl.
   */
  const canvasSize = useCallback((): { width: number; height: number } | undefined => {
    try {
      const viewport = deckRef.current?.deck?.getViewports()[0];
      return viewport ? { width: viewport.width, height: viewport.height } : undefined;
    } catch {
      return undefined;
    }
  }, []);

  /**
   * Whether the opening frame has been chosen.
   *
   * Once, and never again: re-framing when the overlay refreshes would drag the
   * camera out from under a player who had gone somewhere to look at something.
   */
  const framed = useRef(openingCamera !== null);

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

  // Watch the reduced-motion preference live, so a change stills or restarts the
  // animation without a reload (M7-03's accessibility criterion).
  useEffect(() => {
    const query = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!query) return;
    const onChange = (): void => setReducedMotion(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

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

  /*
   * Name what the pointer is over.
   *
   * deck.gl fires the same handler with no object as the pointer leaves, which
   * is what clears the label — so there is no separate "leave" path to forget.
   */
  const onAirportHover = useCallback((airport: WorldAirport | null, at: HoverPoint) => {
    setHover(airport === null ? null : { label: airportLabel(airport), at });
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
        onAirportHover,
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
      onAirportHover,
      darkness,
      geometry,
      visibility,
    ],
  );

  // The world's live traffic — every active route flown by any carrier, the player's
  // own and the NPCs' — is what the planes ride. A lookup by route id turns a clicked
  // plane back into the carrier behind it; a colour lookup carries each carrier's
  // brand hue (M7-02) onto its plane, mark and route line.
  const trafficById = useMemo(() => new Map(map.traffic.map((r) => [r.id, r])), [map.traffic]);
  const colourById = useMemo(
    () => new Map(map.traffic.map((r) => [r.id, parseHexColor(r.colour, palette.route)])),
    [map.traffic, palette.route],
  );
  const colourFor = useCallback(
    (plane: WorldPlane): RgbaColor => colourById.get(plane.sourceId) ?? palette.route,
    [colourById, palette.route],
  );

  // A plane is selected out of the animated layer, so its route is redrawn even when
  // that carrier's line is not otherwise on the map (NPC routes have no line of their
  // own until one is clicked). Cleared if its route leaves the world's traffic.
  useEffect(() => {
    if (selectedRoute !== null && !trafficById.has(selectedRoute.id)) setSelectedRoute(null);
  }, [selectedRoute, trafficById]);

  /*
   * The same for an aeroplane, resolved through the route it is flying: the icon
   * carries only a route id, and the carrier behind it is the interesting half.
   */
  const onTrafficHover = useCallback(
    (info: {
      object?: unknown;
      x: number;
      y: number;
      viewport?: { width: number; height: number };
    }): boolean => {
      const routeId =
        (info.object as WorldPlane | undefined)?.sourceId ??
        (info.object as WorldMapTrafficRoute | undefined)?.id;
      const carrierRoute = routeId === undefined ? undefined : trafficById.get(routeId);
      setHover(
        carrierRoute === undefined
          ? null
          : {
              label: flightLabel(carrierRoute),
              at: {
                x: info.x,
                y: info.y,
                width: info.viewport?.width ?? 0,
                height: info.viewport?.height ?? 0,
              },
            },
      );
      return false;
    },
    [trafficById],
  );

  const onPlaneClick = useCallback(
    (info: { object?: unknown }): boolean => {
      const plane = info.object as WorldPlane | undefined;
      if (!plane) return false;
      const carrierRoute = trafficById.get(plane.sourceId);
      if (carrierRoute) {
        setSelectedRoute(carrierRoute);
        setSelectedAirport(null);
      }
      return true;
    },
    [trafficById],
  );

  // The animated aircraft, shared by both level-of-detail layers below. Kept out of
  // `layers` on purpose: it changes every frame with `phase`, and folding it into the
  // land/sea/day-night memo would rebuild those world-sized bitmaps sixty times a
  // second. One plane per live route, at the current animation phase.
  // Planes follow the same ownership toggles as the route lines: your own aircraft
  // with "My routes", the competition's with "Rivals". Drawing every carrier's plane
  // regardless of the toggles piled the whole world's traffic into one clump — so the
  // default view is your own fleet, and all-traffic is opt-in via Rivals.
  const visiblePlaneRoutes = useMemo(
    () => map.traffic.filter((r) => (r.own ? visibility.routes : showRivals)),
    [map.traffic, visibility.routes, showRivals],
  );
  const planes = useMemo(
    () => planesForRoutes(visiblePlaneRoutes, phase, 1),
    [visiblePlaneRoutes, phase],
  );
  const spriteSize = planeSpriteSize(viewState.zoom);

  /*
   * A dark silhouette a little larger than the aircraft, drawn underneath it.
   *
   * `IconLayer` cannot stroke, and a carrier flying a pale brand hue over pale
   * terrain is the same disappearing act the route ends used to perform. So the
   * outline is a second copy of the same sprite: one extra instanced quad per plane,
   * and the aircraft reads over land, sea and the day/night wash alike.
   */
  const planeHaloLayer = useMemo(() => {
    if (planes.length === 0) return false;
    return new IconLayer<WorldPlane>({
      id: 'world-plane-halos',
      data: planes,
      getPosition: (p) => p.position,
      getIcon: () => ({ url: PLANE_ICON, width: 24, height: 24, mask: true }),
      getSize: spriteSize + 3,
      sizeUnits: 'pixels',
      getAngle: (p) => p.angle,
      getColor: [palette.night[0], palette.night[1], palette.night[2], 235],
      // Not pickable: the coloured sprite on top owns the click, and two hit targets
      // at the same point would make the topmost one arbitrary.
      pickable: false,
      billboard: true,
      getPolygonOffset: () => [0, -60000],
      parameters: { cullMode: 'none' },
    });
  }, [planes, spriteSize, palette.night]);

  // The aircraft itself: the top-down silhouette, tinted the carrier's colour and
  // pointed the way it is going, at every zoom.
  const planeLayer = useMemo(() => {
    if (planes.length === 0) return false;
    return new IconLayer<WorldPlane>({
      id: 'world-planes',
      data: planes,
      getPosition: (p) => p.position,
      getIcon: () => ({ url: PLANE_ICON, width: 24, height: 24, mask: true }),
      getSize: spriteSize,
      sizeUnits: 'pixels',
      getAngle: (p) => p.angle,
      getColor: colourFor,
      updateTriggers: { getColor: [colourById] },
      // Clickable so a plane can name its carrier and draw its route; a fatter pick
      // radius (set on DeckGL) makes the small icons easy to hit.
      pickable: true,
      onClick: onPlaneClick,
      onHover: onTrafficHover,
      billboard: true,
      // Lift the plane off the surface like the routes and airports, so it is not
      // depth-rejected by the terrain at the whole-globe zoom.
      getPolygonOffset: () => [0, -61000],
      parameters: { cullMode: 'none' },
    });
  }, [planes, spriteSize, colourFor, colourById, onPlaneClick, onTrafficHover]);

  // The clicked plane's route, drawn on demand: an NPC's line does not otherwise
  // appear, and this is what "show their route" puts on the map. Coloured its
  // carrier's hue and lifted off the surface like the rest of the overlay so it
  // clears the terrain at the far-out zoom.
  const selectedRouteLayer = useMemo(() => {
    if (selectedRoute === null) return false;
    const line = parseHexColor(selectedRoute.colour, palette.route);
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
  }, [selectedRoute, palette.route, quality]);

  // The competition's routes as their own togglable layer — neutral, so ownership reads
  // as colour (M7-03). Below the un-bundle zoom they collapse into corridors so the
  // whole-world "all traffic" view is legible rather than a hairball; above it, every
  // leg draws on its own. The player's own routes always stay individual.
  const rivals = useMemo(() => map.traffic.filter((r) => !r.own), [map.traffic]);
  const corridorGrid = corridorGridForZoom(viewState.zoom);
  const neutral: RgbaColor = palette.border;

  const rivalLinesLayer = useMemo(() => {
    if (!showRivals || corridorGrid > 0 || rivals.length === 0) return false;
    return new PathLayer<WorldMapTrafficRoute>({
      id: 'world-rival-routes',
      data: rivals,
      getPath: (r) => flightPath(r.source, r.target, routeSeed(r.id), quality === 'full' ? 64 : 32),
      getColor: [neutral[0], neutral[1], neutral[2], 175],
      getWidth: 1.5,
      widthUnits: 'pixels',
      widthMinPixels: 1,
      widthMaxPixels: 3,
      capRounded: true,
      jointRounded: true,
      pickable: true,
      onClick: onPlaneClick,
      onHover: onTrafficHover,
      parameters: { cullMode: 'none' },
      getPolygonOffset: () => [0, -60000],
    });
  }, [showRivals, corridorGrid, rivals, neutral, quality, onPlaneClick, onTrafficHover]);

  const corridorLayer = useMemo(() => {
    if (!showRivals || corridorGrid === 0 || rivals.length === 0) return false;
    const corridors = bundleCorridors(rivals, corridorGrid);
    const busiest = corridors.reduce((max, c) => Math.max(max, c.count), 1);
    return new PathLayer<Corridor>({
      id: 'world-corridors',
      data: corridors,
      getPath: (c) => greatCirclePath(c.source, c.target, 24),
      // Weight says how many routes run the corridor; a lone leg reads as thin as it
      // would un-bundled, a trunk corridor as a fat band.
      getColor: [neutral[0], neutral[1], neutral[2], 205],
      getWidth: (c) => 1 + 5 * (c.count / busiest),
      widthUnits: 'pixels',
      widthMinPixels: 1,
      widthMaxPixels: 9,
      capRounded: true,
      jointRounded: true,
      updateTriggers: { getWidth: [busiest] },
      parameters: { cullMode: 'none' },
      getPolygonOffset: () => [0, -60000],
    });
  }, [showRivals, corridorGrid, rivals, neutral]);

  // The player's own route tracks, sampled once per route/quality change rather than
  // every animation frame. Computing each great-circle (trig per segment) sixty times
  // a second is what the shimmer used to do and what dropped the globe below its frame
  // budget; the phase-driven layer below just slices a window out of these.
  const shimmerSegments = quality === 'full' ? 64 : 32;
  const ownPaths = useMemo(
    () =>
      playerRoutes.map((route) => ({
        id: route.id,
        full: flightPath(route.source, route.target, routeSeed(route.id), shimmerSegments),
      })),
    [playerRoutes, shimmerSegments],
  );

  // A slow directional shimmer travelling along the player's own routes — a short
  // brightened window sliding from origin to destination. Purely `phase`-driven, and
  // the phase is frozen under prefers-reduced-motion, so this layer simply is not
  // built then (M7-03's accessibility criterion).
  /*
   * Whether anything on screen is actually moving.
   *
   * This used to be `map.traffic.length > 0` — *the world* having any active
   * route, including every NPC's. But the phase drives two layers and both are
   * narrower than that: the planes are filtered to what the ownership toggles
   * show, and the shimmer needs the player's own routes to be drawn. The default
   * view is your own fleet with `Rivals` off, so a player who has founded an
   * airline and not yet opened a route sat in a world full of NPC carriers
   * running a sixty-times-a-second state update that produced no planes and no
   * trails — on exactly the machines this page already offers to degrade for.
   */
  const animating =
    !reducedMotion && (visiblePlaneRoutes.length > 0 || (visibility.routes && ownPaths.length > 0));

  /*
   * Advance the phase each frame. `requestAnimationFrame` pauses itself when the
   * tab is hidden, and only the plane and shimmer layers depend on `phase`, so
   * the land, sea and day/night bitmaps are not rebuilt as it ticks.
   *
   * Stopping leaves `phase` where it was rather than resetting it, so turning a
   * layer back on resumes the aeroplanes rather than teleporting them home.
   */
  useEffect(() => {
    if (!animating) return;
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
  }, [animating]);

  const shimmerLayer = useMemo(() => {
    // Off with the routes it travels along. The lines are gated on the same flag
    // (`layers.ts`), so without this the trails kept sliding along tracks that
    // were no longer drawn — bright dashes moving across an empty ocean.
    if (reducedMotion || !visibility.routes || ownPaths.length === 0) return false;
    const windowLen = Math.max(2, Math.round(shimmerSegments * 0.1));
    const trails = ownPaths.map(({ id, full }) => {
      const start = Math.min(full.length - windowLen, Math.floor(phase * (full.length - 1)));
      return {
        id,
        path: full.slice(Math.max(0, start), Math.max(windowLen, start + windowLen)),
      };
    });
    const bright: RgbaColor = [
      Math.round((palette.route[0] + 255) / 2),
      Math.round((palette.route[1] + 255) / 2),
      Math.round((palette.route[2] + 255) / 2),
      235,
    ];
    return new PathLayer<{ id: string; path: LngLat[] }>({
      id: 'world-shimmer',
      data: trails,
      getPath: (t) => t.path,
      getColor: bright,
      getWidth: 2,
      widthUnits: 'pixels',
      widthMinPixels: 1.5,
      widthMaxPixels: 5,
      capRounded: true,
      jointRounded: true,
      parameters: { cullMode: 'none' },
      getPolygonOffset: () => [0, -70000],
    });
  }, [reducedMotion, visibility.routes, ownPaths, shimmerSegments, phase, palette.route]);

  const allLayers = useMemo<(Layer | false)[]>(
    () => [
      ...layers,
      rivalLinesLayer,
      corridorLayer,
      selectedRouteLayer,
      shimmerLayer,
      planeHaloLayer,
      planeLayer,
    ],
    [
      layers,
      rivalLinesLayer,
      corridorLayer,
      selectedRouteLayer,
      shimmerLayer,
      planeHaloLayer,
      planeLayer,
    ],
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

  /**
   * The camera that frames this player's own network, at the size the canvas
   * actually is.
   *
   * deck.gl owns the viewport, so it is read from deck rather than assumed —
   * `frame.ts` falls back to a desktop-shaped reference when it has not been
   * measured yet, which is right for a first paint and wrong by a little
   * afterwards.
   */
  const networkFrame = useCallback((): MapViewState | null => {
    return frameOf(networkPoints(map.hubs, map.routes), canvasSize());
  }, [canvasSize, map.hubs, map.routes]);

  /*
   * Open on the player's own network.
   *
   * `INITIAL_VIEW_STATE` is the western Sahara at a whole-globe zoom, and it was
   * where every session began regardless of where the airline flies. It stays
   * the answer for a player who has not founded anything — a new player should
   * still meet the whole world — so a null frame leaves the camera alone.
   */
  useEffect(() => {
    if (framed.current) return;
    const frame = networkFrame();
    if (frame === null) return;
    framed.current = true;
    setViewState(clampViewState(frame));
  }, [networkFrame]);

  /**
   * Back to the network, because the point of a map is that you can wander off it.
   *
   * Animated, so it reads as the camera travelling rather than as the map being
   * replaced — except for a reader who has asked for less motion, who gets the
   * same destination immediately.
   */
  const recentre = useCallback(() => {
    const frame = networkFrame() ?? INITIAL_VIEW_STATE;
    framed.current = true;
    setViewState(
      clampViewState(
        reducedMotion
          ? frame
          : { ...frame, transitionDuration: 700, transitionInterpolator: new FlyToInterpolator() },
      ),
    );
  }, [networkFrame, reducedMotion]);

  /*
   * Remember the view, and keep the address bar describing it.
   *
   * Debounced, because both halves run on a value that changes on every frame
   * of a drag: `localStorage` is synchronous and the router re-renders. Half a
   * second after the camera settles is soon enough for something only read on
   * the next visit.
   *
   * The URL is *replaced* rather than pushed. A history entry per pan would make
   * the back button walk the camera backwards through a drag instead of leaving
   * the page, which is the behaviour every map on the web gets wrong once.
   */
  useEffect(() => {
    const timer = globalThis.setTimeout(() => {
      persistView({
        ...cameraOf(viewState),
        visibility,
        rivals: showRivals,
        legend: showLegend,
      });

      const current = cameraFromSearch(searchParams);
      const camera = cameraOf(viewState);
      if (current !== null && sameCamera(current, camera)) return;
      const next = new URLSearchParams(searchParams);
      // `at` is the hand-written form and has been resolved by now; leaving it
      // would make the link disagree with the camera beside it.
      next.delete('at');
      for (const [key, value] of Object.entries(cameraSearch(camera))) next.set(key, value);
      setSearchParams(next, { replace: true });
    }, 500);
    return () => globalThis.clearTimeout(timer);
  }, [viewState, visibility, showRivals, showLegend, searchParams, setSearchParams]);

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

      {/*
       * The hover label.
       *
       * `aria-hidden`, and deliberately: it says the same thing the selection
       * panel says, it is driven by a pointer a screen-reader user does not
       * have, and a live region that fired on every dot crossed would be
       * unusable. Naming things for a keyboard is WORLD-08's job, and it is a
       * different mechanism rather than this one wired to focus.
       */}
      {hover !== null && (
        <div
          className="world-renderer__tip"
          style={tipPlacement(hover.at)}
          aria-hidden="true"
          data-testid="world-tip"
        >
          <p className="world-renderer__tip-title">{hover.label.title}</p>
          <p className="world-renderer__tip-detail">{hover.label.detail}</p>
        </div>
      )}

      <div className="world-renderer__atmosphere" aria-hidden="true" />

      {/*
       * Everything drawn over the map, in one grid.
       *
       * These used to be six independently absolutely-positioned boxes, and four
       * of them were anchored to the same bottom-right corner: the selection
       * panel (z 5), the performance offer, the renderer-failure alert, and
       * at the mobile breakpoint — the world clock. So a performance offer
       * arriving while a panel was open landed underneath it, and on a phone
       * tapping an airport covered the world time.
       *
       * A grid cannot express that overlap. Each surface owns a named area, the
       * transient ones stack inside `__dock`, and the whole layer is
       * `pointer-events: none` so the map underneath is still draggable through
       * the gaps.
       */}
      <div className="world-renderer__hud">
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

          <div className="world-renderer__control-group" role="group" aria-label="View">
            <button type="button" onClick={recentre}>
              Recentre
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
              My routes
            </button>
            <button
              type="button"
              aria-pressed={showRivals}
              onClick={() => setShowRivals((v) => !v)}
            >
              Rivals
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
            <button
              type="button"
              aria-pressed={showLegend}
              onClick={() => setShowLegend((v) => !v)}
            >
              Legend
            </button>
          </div>
        </div>

        {showLegend && (
          <div className="world-renderer__legend" role="dialog" aria-label="Map legend">
            <div className="world-renderer__legend-head">
              <p className="world-renderer__route-eyebrow">Legend</p>
              <button
                type="button"
                className="world-renderer__route-close"
                aria-label="Close"
                onClick={() => setShowLegend(false)}
              >
                ×
              </button>
            </div>
            <ul className="world-renderer__legend-list">
              <li>
                <span className="world-renderer__legend-line world-renderer__legend-line--own" />
                Your routes — your brand colour
              </li>
              <li>
                <span className="world-renderer__legend-line world-renderer__legend-line--rival" />
                Rivals — the competition’s routes (toggle “Rivals”)
              </li>
              <li>
                <span className="world-renderer__legend-line world-renderer__legend-line--corridor" />
                Bundled corridor — thicker carries more routes; zoom in to split it
              </li>
              <li>
                <span className="world-renderer__legend-dot" />
                Aircraft — the carrier’s colour; a mark far out, a plane up close
              </li>
            </ul>
            <p className="world-renderer__legend-note">
              Motion (planes, the route shimmer) respects your reduced-motion setting.
            </p>
          </div>
        )}

        {/* The corner: whatever is transient, stacked rather than piled. */}
        <div className="world-renderer__dock">
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
                      <p className="world-renderer__route-code">{airportCodes(airport)}</p>
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
                        Out of range — {distance(reach.distanceNm)} nm from {reach.hub.name}, but
                        your aircraft reach {distance(maxRangeNm)} nm.
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

                  {/* A router link, not a bare anchor: this is inside a single-page app,
                  and an `<a href>` here reloaded the whole bundle and threw away
                  every fetch the session had made. */}
                  <Link to={`/network?to=${airport.icao}`} className="world-renderer__route-link">
                    Open route planner
                  </Link>
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
                {selectedRoute.own
                  ? 'One of your routes.'
                  : `Flown by ${selectedRoute.airlineName}.`}
              </p>
            </div>
          )}

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
        </div>
      </div>
    </section>
  );
}
