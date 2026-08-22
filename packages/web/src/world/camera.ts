import type { MapViewState } from '@deck.gl/core';

/**
 * The camera both projections share.
 *
 * The renderer is a *controlled* deck.gl component: deck emits a view state, this
 * normalises it, React stores it, and deck receives it back as a prop.
 *
 * ## Only the camera crosses that loop
 *
 * `onViewStateChange` does not hand back the three numbers a camera is made of.
 * It hands back the controller's **fully resolved internal state**, which in a
 * flat view is:
 *
 * ```
 * { width: 300, height: 150, longitude, latitude, zoom, bearing, pitch,
 *   altitude, minZoom, maxZoom, minPitch, maxPitch, normalize, position,
 *   maxBounds }
 * ```
 *
 * Storing that verbatim was a real bug, and `width`/`height` were the cause of
 * it. They are the canvas dimensions **as deck.gl saw them when the first event
 * fired** — 300 by 150, the default size of an unsized `<canvas>`, captured
 * before deck had measured the element. Feeding them back makes the controlled
 * prop authoritative about viewport geometry, so from then on every pan delta is
 * converted against a 300x150 window while the pointer is actually moving inside
 * a canvas several times that size. The map lurches and settles somewhere other
 * than where it was dragged, which reads exactly like the view snapping back.
 *
 * So this picks the fields the application owns and drops everything deck.gl
 * owns. The size of the canvas is deck.gl's business, and it is the one thing a
 * controlled view state must never claim to know.
 */

/** Mercator degenerates at the poles; 85 is the conventional stop short of it. */
const MAX_LATITUDE = 85;
const MIN_ZOOM = -0.5;
const MAX_ZOOM = 12;

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * Reduce a view state to the camera, inside the range both projections render.
 *
 * `pitch` and `bearing` are pinned flat because neither projection offers a way
 * to change them and a tilted globe has no meaning here.
 *
 * `transitionDuration` and `transitionInterpolator` are carried through when the
 * controller sets them, which is what lets drag inertia finish: they are
 * instructions to deck.gl about the camera, not facts about the viewport.
 */
export function clampViewState(viewState: MapViewState): MapViewState {
  const camera: MapViewState = {
    longitude: viewState.longitude,
    latitude: clamp(viewState.latitude, -MAX_LATITUDE, MAX_LATITUDE),
    zoom: clamp(viewState.zoom, MIN_ZOOM, MAX_ZOOM),
    pitch: 0,
    bearing: 0,
    minZoom: MIN_ZOOM,
    maxZoom: MAX_ZOOM,
  };

  if (viewState.transitionDuration === undefined) return camera;
  return {
    ...camera,
    transitionDuration: viewState.transitionDuration,
    transitionInterpolator: viewState.transitionInterpolator,
  };
}

/**
 * Centre on a point and step one zoom level in.
 *
 * Used by the double-click and double-tap handlers, which exist because
 * `GlobeController` cannot animate around a pointer.
 */
export function focusViewState(
  viewState: MapViewState,
  coordinate: readonly [number, number],
): MapViewState {
  return clampViewState({
    ...viewState,
    longitude: coordinate[0],
    latitude: coordinate[1],
    zoom: viewState.zoom + 1,
  });
}
