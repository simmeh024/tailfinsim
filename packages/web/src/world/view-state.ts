import type { WorldLayerVisibility } from './layers';
import type { MapViewState } from '@deck.gl/core';

/**
 * The view the player left the map in, and the view a link asks for (WORLD-05).
 *
 * ## What was remembered before
 *
 * One thing: the projection. `persistProjection` writes globe-or-flat to
 * `localStorage`, and a saved choice always wins over the device default. That
 * was the whole of it — the camera and all seven layer toggles were plain
 * `useState` with a constant default, so setting the map up the way you wanted
 * it and going to the Fleet page for ten seconds threw the lot away.
 *
 * ## Two sources, and which wins
 *
 * A **link** beats a **memory** beats the **network fit** (WORLD-04) beats the
 * whole-world default. That order is the only one that makes a shared link
 * work: somebody who sends you a view of Heathrow means for you to arrive at
 * Heathrow, not wherever you happened to leave the camera.
 *
 * ## Why the camera is in the URL at all
 *
 * The map is the one page in Tailfin where *where you are looking* is most of
 * the state, and none of it was addressable — `/world` was `/world` whether you
 * were looking at the whole planet or at one apron. A camera in the query string
 * makes the view a thing you can send, bookmark, or come back to from the route
 * planner.
 */

export const WORLD_VIEW_STORAGE_KEY = 'tailfin.world.view';

export interface StoredView {
  longitude: number;
  latitude: number;
  zoom: number;
  visibility: WorldLayerVisibility;
  rivals: boolean;
  legend: boolean;
}

export interface Camera {
  longitude: number;
  latitude: number;
  zoom: number;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function readVisibility(value: unknown, fallback: WorldLayerVisibility): WorldLayerVisibility {
  if (typeof value !== 'object' || value === null) return fallback;
  const stored = value as Record<string, unknown>;
  const next = { ...fallback };
  for (const key of Object.keys(fallback) as (keyof WorldLayerVisibility)[]) {
    if (typeof stored[key] === 'boolean') next[key] = stored[key];
  }
  return next;
}

/**
 * What was stored, filtered through today's shape.
 *
 * Every field is checked rather than trusted: this is a JSON blob a previous
 * build wrote, and a layer added or removed since then must not leave the map
 * with a `visibility` object missing a key — which renders as "off" and reads
 * as a layer that has stopped working.
 */
export function readStoredView(defaults: WorldLayerVisibility): Partial<StoredView> {
  let parsed: unknown;
  try {
    const raw = globalThis.localStorage?.getItem(WORLD_VIEW_STORAGE_KEY) ?? null;
    if (raw === null) return {};
    parsed = JSON.parse(raw);
  } catch {
    // An unreadable store and unparseable JSON are the same answer: the map
    // opens the way it would for somebody who had never been here.
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null) return {};

  const stored = parsed as Record<string, unknown>;
  const view: Partial<StoredView> = {
    visibility: readVisibility(stored.visibility, defaults),
    rivals: stored.rivals === true,
    legend: stored.legend === true,
  };
  if (
    isFiniteNumber(stored.longitude) &&
    isFiniteNumber(stored.latitude) &&
    isFiniteNumber(stored.zoom)
  ) {
    view.longitude = stored.longitude;
    view.latitude = stored.latitude;
    view.zoom = stored.zoom;
  }
  return view;
}

export function persistView(view: StoredView): void {
  try {
    globalThis.localStorage?.setItem(WORLD_VIEW_STORAGE_KEY, JSON.stringify(view));
  } catch {
    // A private-mode or policy-disabled store must not make the map unusable —
    // the same trade `projection.ts` makes for the same reason.
  }
}

/** Enough precision to land on an apron, and not enough to make an ugly URL. */
function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * The camera as query parameters.
 *
 * `lng`/`lat`/`z` rather than one packed value, so the link is legible and can
 * be edited by hand — which is half the reason to have it.
 */
export function cameraSearch(camera: Camera): Record<string, string> {
  return {
    lng: String(round(camera.longitude, 4)),
    lat: String(round(camera.latitude, 4)),
    z: String(round(camera.zoom, 2)),
  };
}

function readNumber(params: URLSearchParams, key: string): number | null {
  const raw = params.get(key);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * A camera from a link, or `null`.
 *
 * All three parameters or none: two of them describe a place the camera cannot
 * actually be put, and quietly filling in the third from wherever the map
 * happened to be is worse than ignoring an incomplete link.
 */
export function cameraFromSearch(params: URLSearchParams): Camera | null {
  const longitude = readNumber(params, 'lng');
  const latitude = readNumber(params, 'lat');
  const zoom = readNumber(params, 'z');
  if (longitude === null || latitude === null || zoom === null) return null;
  return { longitude, latitude, zoom };
}

/**
 * An airport code from a link — `/world?at=EGLL`.
 *
 * The hand-writable form, and the one worth sending to somebody. It resolves
 * only once the airport list has arrived, and the camera it produces is then
 * written back as `lng`/`lat`/`z` like any other, so the address bar always
 * describes where the map actually is.
 */
export function icaoFromSearch(params: URLSearchParams): string | null {
  const raw = params.get('at');
  if (raw === null) return null;
  const code = raw.trim().toUpperCase();
  return /^[A-Z0-9]{3,4}$/.test(code) ? code : null;
}

/** Whether a camera has moved enough to be worth rewriting the URL for. */
export function sameCamera(a: Camera, b: Camera): boolean {
  const search = cameraSearch(a);
  const other = cameraSearch(b);
  return search.lng === other.lng && search.lat === other.lat && search.z === other.z;
}

/** The camera out of a deck.gl view state, which carries a great deal more. */
export function cameraOf(viewState: MapViewState): Camera {
  return {
    longitude: viewState.longitude,
    latitude: viewState.latitude,
    zoom: viewState.zoom,
  };
}
