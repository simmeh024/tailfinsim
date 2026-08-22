import { MapView, _GlobeView as GlobeView, type MapViewState } from '@deck.gl/core';
import DeckGL, { type DeckGLRef } from '@deck.gl/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTheme } from '../theme/ThemeProvider';

import { clampViewState, focusViewState } from './camera';
import {
  createWorldLayers,
  type RendererQuality,
  type WorldLayerVisibility,
  type WorldRoute,
} from './layers';
import { readWorldPalette } from './palette';
import { SustainedFrameRateMonitor, type FrameRateSample } from './performance';
import { persistProjection, readInitialProjection, type WorldProjection } from './projection';
import { createDarknessField } from './terminator';

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

const DEFAULT_VISIBILITY: WorldLayerVisibility = {
  graticule: true,
  routes: true,
  terminator: true,
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
  const transitionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const frameRateMonitor = useRef(new SustainedFrameRateMonitor());
  const deckRef = useRef<DeckGLRef<MapView | GlobeView> | null>(null);
  const lastTouch = useRef<{ at: number; x: number; y: number } | null>(null);

  useEffect(() => {
    const timer = globalThis.setInterval(() => setNow(new Date()), 60_000);
    return () => globalThis.clearInterval(timer);
  }, []);

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

  // Sampled once a minute, at the quality the device is coping with. Half the
  // resolution is still far finer than the twilight band it has to describe: the
  // gradient spans twelve degrees of solar elevation, and a reduced texel is two.
  const darkness = useMemo(
    () =>
      quality === 'full' ? createDarknessField(now, 512, 256) : createDarknessField(now, 256, 128),
    [now, quality],
  );
  // `projection` is a dependency, and not because the layer list differs between
  // the views — it does not. Switching projection has to rebuild the layers so the
  // world-sized bitmaps re-tessellate for the new viewport; see `layers.ts`.
  const layers = useMemo(
    () => createWorldLayers({ palette, projection, quality, routes, darkness, visibility }),
    [palette, projection, quality, routes, darkness, visibility],
  );
  const view = useMemo(
    () =>
      projection === 'globe'
        ? new GlobeView({
            id: 'world-renderer',
            controller: CONTROLLER,
            resolution: quality === 'full' ? 5 : 10,
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
