import { describe, expect, it } from 'vitest';

import {
  MAX_ROUTE_WIDTH,
  MIN_ROUTE_WIDTH,
  ROUTE_OPACITY_FLOOR,
  routeIsFlown,
  routeLines,
  routeOpacityForLoad,
  routeWidthForFrequency,
  UNKNOWN_ROUTE_WIDTH,
} from './route-lines';

import type { WorldRoute } from './layers';
import type { RgbaColor } from './palette';

/**
 * §H.3's encodings of the player's own lines (world map pass).
 *
 * > Thickness — weekly frequency. Opacity — load factor: busy routes glow, weak
 * > ones fade. Dashed — seasonal or suspended.
 *
 * M7-03 deferred all three for want of data. These hold the reading, not the
 * pixels: more departures is thicker, a fuller aeroplane is stronger, a paused
 * route is broken into dashes, and a number nobody sent changes nothing.
 */

const SEGMENTS = 64;
/** A ramp whose alpha is all 200, so the opacity multiplier is easy to read back. */
const RAMP: RgbaColor[] = Array.from({ length: SEGMENTS + 1 }, (_, i) => [i, 0, 0, 200]);

const LHR: [number, number] = [-0.4614, 51.4775];
const JFK: [number, number] = [-73.7781, 40.6413];
const CDG: [number, number] = [2.5479, 49.0097];

const route = (id: string, overrides: Partial<WorldRoute> = {}): WorldRoute => ({
  id,
  source: LHR,
  target: JFK,
  ...overrides,
});

describe('thickness is weekly frequency', () => {
  it('grows with departures a week, between a floor and a ceiling', () => {
    const widths = [0, 2, 7, 14, 28].map(routeWidthForFrequency);
    for (let i = 1; i < widths.length; i += 1) expect(widths[i]!).toBeGreaterThan(widths[i - 1]!);
    expect(routeWidthForFrequency(0)).toBe(MIN_ROUTE_WIDTH);
    expect(routeWidthForFrequency(500)).toBe(MAX_ROUTE_WIDTH);
  });

  it('keeps a daily long-haul legible beside a shuttle', () => {
    // Logarithmic: four times the departures is not four times the ink.
    expect(routeWidthForFrequency(28) / routeWidthForFrequency(7)).toBeLessThan(2);
  });

  it('leaves a line whose frequency was not sent at the width it always had', () => {
    expect(routeWidthForFrequency(undefined)).toBe(UNKNOWN_ROUTE_WIDTH);
  });
});

describe('opacity is load factor', () => {
  it('fades an emptier route, down to a floor', () => {
    expect(routeOpacityForLoad(1)).toBe(1);
    expect(routeOpacityForLoad(0.5)).toBeLessThan(routeOpacityForLoad(0.9));
    expect(routeOpacityForLoad(0)).toBe(ROUTE_OPACITY_FLOOR);
    expect(ROUTE_OPACITY_FLOOR).toBeGreaterThan(0);
  });

  it('does not fade a route nothing has settled on yet', () => {
    // Unknown is not empty — and it is every route on a node with no worker.
    expect(routeOpacityForLoad(null)).toBe(1);
    expect(routeOpacityForLoad(undefined)).toBe(1);
  });

  it('applies the opacity to every vertex of the ramp', () => {
    const [line] = routeLines([route('r', { loadFactor: 0 })], SEGMENTS, RAMP);
    expect(line?.colors).toHaveLength(SEGMENTS + 1);
    for (const colour of line!.colors)
      expect(colour[3]).toBe(Math.round(200 * ROUTE_OPACITY_FLOOR));
  });
});

describe('a city pair is one line', () => {
  it('draws an out-and-back once, not as two translucent lines on top of each other', () => {
    const lines = routeLines(
      [route('out'), route('back', { source: JFK, target: LHR })],
      SEGMENTS,
      RAMP,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]?.routeIds.sort()).toEqual(['back', 'out']);
  });

  it('takes the busier direction and the mean of the known loads', () => {
    const [line] = routeLines(
      [
        route('out', { weeklyFrequency: 7, loadFactor: 0.9 }),
        route('back', { source: JFK, target: LHR, weeklyFrequency: 3, loadFactor: 0.5 }),
      ],
      SEGMENTS,
      RAMP,
    );
    expect(line?.width).toBe(routeWidthForFrequency(7));
    expect(line?.colors[0]?.[3]).toBe(Math.round(200 * routeOpacityForLoad(0.7)));
  });

  it('keeps different pairs apart', () => {
    const lines = routeLines([route('a'), route('b', { target: CDG })], SEGMENTS, RAMP);
    expect(lines).toHaveLength(2);
  });

  it('hands deck.gl one flat, already-normalised path per line', () => {
    const [line] = routeLines([route('a')], SEGMENTS, RAMP);
    expect(line?.path).toBeInstanceOf(Float64Array);
    expect(line!.path.length / 2).toBe(line!.colors.length);
  });
});

describe('dashed is suspended', () => {
  it('breaks a suspended pair into dashes along its track', () => {
    const lines = routeLines([route('paused', { active: false })], SEGMENTS, RAMP);
    expect(lines.length).toBeGreaterThan(5);
    for (const dash of lines) {
      expect(dash.suspended).toBe(true);
      expect(dash.path.length / 2).toBe(dash.colors.length);
      expect(dash.path.length / 2).toBeGreaterThanOrEqual(2);
    }
    // Gaps, not one line cut into touching pieces.
    const drawn = lines.reduce((sum, dash) => sum + dash.path.length / 2 - 1, 0);
    expect(drawn).toBeLessThan(SEGMENTS);
  });

  it('stays whole while either direction still flies', () => {
    const lines = routeLines(
      [route('out', { active: false }), route('back', { source: JFK, target: LHR })],
      SEGMENTS,
      RAMP,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]?.suspended).toBe(false);
  });
});

describe('what the shimmer runs along', () => {
  it('is a route something is scheduled to fly', () => {
    expect(routeIsFlown(route('r'))).toBe(true);
    expect(routeIsFlown(route('r', { weeklyFrequency: 3 }))).toBe(true);
    expect(routeIsFlown(route('r', { weeklyFrequency: 0 }))).toBe(false);
    expect(routeIsFlown(route('r', { active: false }))).toBe(false);
  });
});
