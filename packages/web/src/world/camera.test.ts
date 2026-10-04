import { TRANSITION_EVENTS } from '@deck.gl/core';
import { describe, expect, it } from 'vitest';

import {
  clampViewState,
  focusViewState,
  globeFillZoom,
  globeRadiusPixels,
  LANDING_TRANSITION,
} from './camera';

import type { MapViewState } from '@deck.gl/core';

/**
 * The controlled camera (§21, App. H.3).
 *
 * One property matters more than the clamping: **a stored view state must
 * describe the camera and nothing else.** `onViewStateChange` hands back deck.gl's
 * fully resolved controller state, viewport dimensions included, and storing
 * those made the application authoritative about the size of a canvas it does not
 * own.
 */

/** Exactly what deck.gl's flat controller emits, including the parts we must drop. */
const FROM_DECK = {
  width: 300,
  height: 150,
  longitude: 8,
  latitude: 24,
  zoom: 0.35,
  bearing: 0,
  pitch: 0,
  altitude: 1.5,
  maxZoom: 12,
  minZoom: -0.5,
  maxPitch: 60,
  minPitch: 0,
  normalize: true,
  position: [0, 0, 0],
  maxBounds: [
    [null, -90],
    [null, 90],
  ],
} as unknown as MapViewState;

describe('the stored camera carries no viewport geometry', () => {
  it('drops width and height', () => {
    const stored = clampViewState(FROM_DECK) as Record<string, unknown>;

    // The observed bug: 300x150 is an unsized `<canvas>`, captured before deck.gl
    // had measured the element. Fed back as a controlled prop it makes every pan
    // delta convert against a viewport the pointer is not moving in.
    expect(stored).not.toHaveProperty('width');
    expect(stored).not.toHaveProperty('height');
  });

  it('drops everything else deck.gl owns', () => {
    const stored = clampViewState(FROM_DECK) as Record<string, unknown>;
    // Enumerated rather than snapshotted, so a deck.gl upgrade that adds a field
    // fails this test instead of silently smuggling it into application state.
    expect(Object.keys(stored).sort()).toEqual([
      'bearing',
      'latitude',
      'longitude',
      'maxZoom',
      'minZoom',
      'pitch',
      'zoom',
    ]);
  });

  it('keeps the camera it was given', () => {
    expect(clampViewState(FROM_DECK)).toMatchObject({ longitude: 8, latitude: 24, zoom: 0.35 });
  });
});

describe('range', () => {
  it('stops short of the poles, where Mercator goes to infinity', () => {
    expect(clampViewState({ ...FROM_DECK, latitude: 89 }).latitude).toBe(85);
    expect(clampViewState({ ...FROM_DECK, latitude: -89 }).latitude).toBe(-85);
  });

  it('holds the zoom range', () => {
    expect(clampViewState({ ...FROM_DECK, zoom: 40 }).zoom).toBe(12);
    expect(clampViewState({ ...FROM_DECK, zoom: -9 }).zoom).toBe(-0.5);
  });

  it('leaves longitude alone', () => {
    // `MapView` is configured `repeat: true`, so panning past the antimeridian is
    // meant to keep counting. Re-normalising it here fought the controller's own
    // bookkeeping mid-gesture; deck.gl normalises when it needs to.
    expect(clampViewState({ ...FROM_DECK, longitude: 194 }).longitude).toBe(194);
    expect(clampViewState({ ...FROM_DECK, longitude: -212 }).longitude).toBe(-212);
  });

  it('pins the horizon flat for both projections', () => {
    const tilted = clampViewState({ ...FROM_DECK, pitch: 40, bearing: 90 });
    expect(tilted).toMatchObject({ pitch: 0, bearing: 0 });
  });
});

describe('transitions', () => {
  it('carries a transition through, so drag inertia can finish', () => {
    const inertial = clampViewState({ ...FROM_DECK, transitionDuration: 300 }) as Record<
      string,
      unknown
    >;

    // A transition is an instruction about the camera, not a fact about the
    // viewport — dropping it would end every drag dead on release.
    expect(inertial.transitionDuration).toBe(300);
    expect(inertial).not.toHaveProperty('width');
  });

  it('adds no transition when the controller set none', () => {
    expect(clampViewState(FROM_DECK)).not.toHaveProperty('transitionDuration');
    expect(clampViewState(FROM_DECK)).not.toHaveProperty('transitionInterruption');
  });

  it('keeps an application fly from being cancelled by whatever arrives mid-flight', () => {
    // The airport-map fly-out on a phone: selecting the airport resized the stage,
    // deck re-applied a view state a frame behind the transition, and the default
    // BREAK left the camera at the ceiling, in the band that re-opens the map.
    const landing = clampViewState({
      ...FROM_DECK,
      transitionDuration: 420,
      ...LANDING_TRANSITION,
    });
    expect(landing.transitionInterruption).toBe(TRANSITION_EVENTS.IGNORE);
  });
});

describe('focus', () => {
  it('centres the point and steps one level in', () => {
    expect(focusViewState(FROM_DECK, [130, -34])).toMatchObject({
      longitude: 130,
      latitude: -34,
      zoom: 1.35,
      pitch: 0,
      bearing: 0,
    });
  });

  it('does not smuggle geometry back in through the spread', () => {
    // `focusViewState` spreads its input, so it has to go through the same pick.
    expect(focusViewState(FROM_DECK, [130, -34])).not.toHaveProperty('width');
  });

  it('cannot zoom past the ceiling by double-clicking', () => {
    expect(focusViewState({ ...FROM_DECK, zoom: 11.6 }, [0, 0]).zoom).toBe(12);
  });
});

describe('the globe on screen', () => {
  /*
   * Measured on the running app's canvas — the globe's extent along the stage's
   * centre row, on an 860 px stage — rather than derived. The atmosphere ring is
   * drawn from this, and it used to be a fixed inset ellipse that hung well clear
   * of the planet at the zoom the map opens at.
   */
  it.each([
    [0.5, 0, 106],
    [1, 0, 145.5],
    [1.5, 0, 197.5],
    [1, 45, 198],
  ])('at zoom %f, latitude %f, has a limb of about %f px', (zoom, latitude, measured) => {
    expect(Math.abs(globeRadiusPixels(zoom, latitude, 860) - measured)).toBeLessThan(2);
  });

  it('still answers before deck.gl has measured the stage', () => {
    expect(globeRadiusPixels(1, 0)).toBeGreaterThan(100);
    expect(globeRadiusPixels(1, 0, 0)).toBe(globeRadiusPixels(1, 0));
  });
});

describe('a globe that fills the stage', () => {
  it('is the zoom at which the limb reaches most of the shorter side', () => {
    const size = { width: 880, height: 860 };
    const zoom = globeFillZoom(13.6, size);
    expect(globeRadiusPixels(zoom, 13.6, size.height)).toBeCloseTo(0.44 * 860, 0);
    // Well above the ~0.9 the flat-map fit gives a world-spanning network, which
    // drew a planet a third of the stage tall.
    expect(zoom).toBeGreaterThan(1.8);
  });

  it('follows the narrower side of a phone', () => {
    const phone = globeFillZoom(0, { width: 390, height: 520 });
    const radius = globeRadiusPixels(phone, 0, 520);
    expect(radius).toBeCloseTo(0.44 * 390, 0);
  });
});
