import { TRANSITION_EVENTS, type MapViewState } from '@deck.gl/core';

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
/** The camera's floor and ceiling, shared by both projections and by `bands.ts`. */
export const MIN_ZOOM = -0.5;
export const MAX_ZOOM = 12;

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * Reduce a view state to the camera, inside the range both projections render.
 *
 * `pitch` and `bearing` are pinned flat because neither projection offers a way
 * to change them and a tilted globe has no meaning here.
 *
 * `transitionDuration`, `transitionInterpolator` and `transitionInterruption` are
 * carried through when set, which is what lets drag inertia finish and an
 * application fly land: they are instructions to deck.gl about the camera, not
 * facts about the viewport.
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
    ...(viewState.transitionInterruption === undefined
      ? {}
      : { transitionInterruption: viewState.transitionInterruption }),
  };
}

/**
 * A camera move the application makes, that nothing incidental may cancel.
 *
 * deck.gl's default interruption is `BREAK`: during a transition, any view-state
 * update that is not the transition's own frame cancels it **where it stands**.
 * That is right for a user's drag and wrong for what else arrives mid-flight. The
 * hand-off out of an airport map selects the airport it left, which on a phone
 * grows the context panel under the stage; the canvas resizes, deck re-applies
 * the controlled view state at the new size, that state is a frame behind the
 * transition — and the fly-out stopped dead at the ceiling. Measured on the
 * running app at phone width: the camera stayed at zoom 12, in the airport band,
 * so the next scroll tick re-opened the map the player had just closed.
 *
 * `IGNORE` lets these flights land. They are short — the hand-off's 420 ms, a
 * search result's 700 ms — so a gesture during one simply waits for it.
 */
export const LANDING_TRANSITION = { transitionInterruption: TRANSITION_EVENTS.IGNORE } as const;

/** deck.gl's `GLOBE_RADIUS` (common units) and `GlobeViewport`'s default camera altitude. */
const GLOBE_COMMON_RADIUS = 256;
const GLOBE_CAMERA_ALTITUDE = 1.5;
/** A stage height for when deck.gl has not measured the canvas yet. */
const REFERENCE_STAGE_HEIGHT = 800;

/**
 * How big the globe is on screen: the radius of its limb, in CSS pixels.
 *
 * What the atmosphere ring needs, and what it did not have — it was a fixed
 * ellipse inset 5 % from the stage, so at the zoom the map opens at it hung
 * well clear of a planet a third of the stage tall, a halo around nothing.
 *
 * `_GlobeView`'s camera, from deck.gl 9.3's `GlobeViewport`: the sphere is
 * `GLOBE_RADIUS` units scaled by `2^(zoom − log2(π·cos lat)) / height`, the eye
 * sits `altitude` (1.5) stage-heights **above the surface**, and the vertical
 * field of view is `2·atan(0.5 / altitude)`. The limb is where a sight line is
 * tangent to the sphere. Checked against canvas pixels on the running app —
 * zoom 0.5, 1 and 1.5 at the equator and zoom 1 at 45°N measured 106, 145.5,
 * 197.5 and 198 px on an 860 px stage — and `camera.test.ts` holds those numbers.
 * Projection-only maths: if deck.gl changes its globe camera, that test fails.
 */
export function globeRadiusPixels(zoom: number, latitude: number, height?: number): number {
  const stage = height !== undefined && height > 0 ? height : REFERENCE_STAGE_HEIGHT;
  const clampedLatitude = clamp(latitude, -MAX_LATITUDE, MAX_LATITUDE);
  const scale = 2 ** zoom / (Math.PI * Math.cos((clampedLatitude * Math.PI) / 180));
  const radius = (GLOBE_COMMON_RADIUS * scale) / stage;
  const tangent = Math.asin(radius / (GLOBE_CAMERA_ALTITUDE + radius));
  return GLOBE_CAMERA_ALTITUDE * stage * Math.tan(tangent);
}

/**
 * The zoom at which the globe's limb fills most of the stage — its radius 44% of
 * the stage's shorter side, so the atmosphere and a margin still show.
 *
 * The inverse of {@link globeRadiusPixels}, by bisection: that function rises
 * monotonically with zoom, and this runs once per frame request, not per frame.
 */
export function globeFillZoom(latitude: number, size?: { width: number; height: number }): number {
  const width = size !== undefined && size.width > 0 ? size.width : REFERENCE_STAGE_HEIGHT;
  const height = size !== undefined && size.height > 0 ? size.height : REFERENCE_STAGE_HEIGHT;
  const target = 0.44 * Math.min(width, height);
  let low = MIN_ZOOM;
  let high = 6;
  for (let step = 0; step < 40; step += 1) {
    const middle = (low + high) / 2;
    if (globeRadiusPixels(middle, latitude, height) < target) low = middle;
    else high = middle;
  }
  return low;
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
