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
    // The row order is not a detail: `BitmapLayer` maps an image's top edge to
    // the northern bound, so getting it backwards swaps day and night — which
    // looks like a palette bug and is not one.
    const northernSummer = createDarknessField(new Date('2026-06-21T12:00:00.000Z'), 8, 8);
    const southernSummer = createDarknessField(new Date('2026-12-21T12:00:00.000Z'), 8, 8);
    const topRow = (field: { alpha: Uint8Array; width: number }) => [
      ...field.alpha.slice(0, field.width),
    ];

    // Midsummer above the Arctic circle: lit all the way round.
    expect(topRow(northernSummer).every((alpha) => alpha === 0)).toBe(true);
    // Midwinter: dark all the way round.
    expect(topRow(southernSummer).every((alpha) => alpha === 255)).toBe(true);
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
