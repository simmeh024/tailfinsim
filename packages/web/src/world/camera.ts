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
