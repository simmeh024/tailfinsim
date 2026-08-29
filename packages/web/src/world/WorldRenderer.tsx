import { MapView, _GlobeView as GlobeView, type MapViewState } from '@deck.gl/core';
import DeckGL, { type DeckGLRef } from '@deck.gl/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTheme } from '../theme/ThemeProvider';

import { fetchWorldAirports } from './airports-api';
import { clampViewState, focusViewState } from './camera';
import { COARSE_WORLD, LAND_DETAIL_ZOOM, loadDetailedWorld, type WorldGeometry } from './land';
import {
  createWorldLayers,
  type RendererQuality,
  type WorldAirport,
  type WorldLayerVisibility,
  type WorldRoute,
} from './layers';
import { readWorldPalette } from './palette';
import { SustainedFrameRateMonitor, type FrameRateSample } from './performance';
import { persistProjection, readInitialProjection, type WorldProjection } from './projection';
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
  const layers = useMemo(
    () =>
      createWorldLayers({
        palette,
        projection,
        quality,
        routes,
        airports,
        darkness,
        land: geometry.land,
        borders: geometry.borders,
        visibility,
      }),
    [palette, projection, quality, routes, airports, darkness, geometry, visibility],
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
          layers={layers}
          useDevicePixels={quality === 'full' ? true : 1}
          onViewStateChange={({ viewState: next }) => {
            setViewState(clampViewState(next));
          }}
          onError={() => setRendererFailed(true)}
          _onMetrics={observeMetrics}
        />
      </div>

      <div className="world-renderer__atmosphere" aria-hidden="true" />

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
