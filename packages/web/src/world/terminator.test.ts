import { describe, expect, it } from 'vitest';

import { createDarknessField, darknessAt, subsolarPoint } from './terminator';

describe('day/night terminator geometry', () => {
  it('puts the equinox subsolar point near the equator and the noon meridian', () => {
    const sun = subsolarPoint(new Date('2026-03-20T12:00:00.000Z'));
    expect(Math.abs(sun.latitude)).toBeLessThan(1);
    // Equation-of-time means solar noon is a few degrees away from Greenwich.
    expect(Math.abs(sun.longitude)).toBeLessThan(4);
  });

  it('tracks the northern and southern solstices', () => {
    expect(subsolarPoint(new Date('2026-06-21T12:00:00.000Z')).latitude).toBeCloseTo(23.45, 0);
    expect(subsolarPoint(new Date('2026-12-21T12:00:00.000Z')).latitude).toBeCloseTo(-23.45, 0);
  });

  it('makes the subsolar side daylight and the antipode night', () => {
    const sun = subsolarPoint(new Date('2026-08-22T12:00:00.000Z'));
    expect(darknessAt(sun.longitude, sun.latitude, sun)).toBe(0);
    expect(darknessAt(sun.longitude + 180, -sun.latitude, sun)).toBe(1);
  });

  it('samples a full field at both qualities', () => {
    const now = new Date('2026-08-22T12:00:00.000Z');
    const full = createDarknessField(now, 512, 256);
    const reduced = createDarknessField(now, 256, 128);
    expect(full.alpha).toHaveLength(512 * 256);
    expect(reduced.alpha).toHaveLength(256 * 128);
  });

  it('refuses a field too small to interpolate', () => {
    expect(() => createDarknessField(new Date(), 1, 64)).toThrow(/at least 2/);
    expect(() => createDarknessField(new Date(), 64.5, 64)).toThrow(/integer/);
  });

  it('puts the north pole in row zero', () => {
    // The row order is not a detail: `BitmapLayer` maps an image's top edge to the
    // northern bound, so getting it backwards swaps day and night — which looks
    // like a palette bug and is not one.
    const northernSummer = createDarknessField(new Date('2026-06-21T12:00:00.000Z'), 8, 8);
    const southernSummer = createDarknessField(new Date('2026-12-21T12:00:00.000Z'), 8, 8);
    const topRow = (field: { alpha: Uint8Array; width: number }) => [
      ...field.alpha.slice(0, field.width),
    ];

    // Midsummer above the Arctic circle: lit all the way round.
    expect(topRow(northernSummer).every((alpha) => alpha === 0)).toBe(true);
    // Midwinter: dark all the way round — though not *pitch* dark. Row zero samples
    // 78.75N, where the midwinter sun sits about twelve degrees down: nautical
    // twilight, inside the band rather than past it.
    expect(topRow(southernSummer).every((alpha) => alpha > 200)).toBe(true);
  });

  it('spreads twilight across the real elevation band', () => {
    /*
     * With the sun overhead at (0, 0), a point on the equator at longitude L sees
     * the sun at an elevation of `90 - L` degrees. That makes the band directly
     * addressable, which is clearer than picking latitudes and hoping.
     */
    const sun = { longitude: 0, latitude: 0 };
    const atElevation = (degrees: number) => darknessAt(90 - degrees, 0, sun);

    // Full day from +6 up, full night from -18 down: astronomical twilight, not an
    // invented pair of numbers.
    // Exactly on an edge the smoothstep lands a denormal away from its limit, so
    // the boundary itself is checked to tolerance and the interior exactly.
    expect(atElevation(6)).toBeLessThan(1e-9);
    expect(atElevation(20)).toBe(0);
    expect(atElevation(-18)).toBeGreaterThan(1 - 1e-9);
    expect(atElevation(-40)).toBe(1);

    // The geometric terminator — sunset — is still mostly lit, which is what a sky
    // at sunset is. The perceived edge sits later, at civil twilight.
    expect(atElevation(0)).toBeGreaterThan(0.1);
    expect(atElevation(0)).toBeLessThan(0.25);
    expect(atElevation(-6)).toBeGreaterThan(0.4);
    expect(atElevation(-6)).toBeLessThan(0.6);

    // And it only ever gets darker on the way down.
    let previous = -1;
    for (let elevation = 20; elevation >= -30; elevation -= 1) {
      const value = atElevation(elevation);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it('produces a gradient rather than a step across the terminator', () => {
    // The complaint the texture replaced a flat-shaded mesh to fix: a night edge
    // built from 5-degree cells of uniform darkness is a staircase. A sampled
    // field has intermediate values, and this asserts there are plenty of them.
    const field = createDarknessField(new Date('2026-08-22T12:00:00.000Z'), 512, 256);
    const partial = [...field.alpha].filter((alpha) => alpha > 4 && alpha < 251);
    expect(partial.length).toBeGreaterThan(2_000);
  });

  it('is deterministic for the same instant', () => {
    const at = new Date('2026-08-22T12:00:00.000Z');
    expect([...createDarknessField(at, 32, 16).alpha]).toEqual([
      ...createDarknessField(at, 32, 16).alpha,
    ]);
  });
});
