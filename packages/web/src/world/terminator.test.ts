import { describe, expect, it } from 'vitest';

import { createTerminatorCells, darknessAt, subsolarPoint } from './terminator';

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

  it('builds a complete non-overlapping world mesh at full and reduced quality', () => {
    const now = new Date('2026-08-22T12:00:00.000Z');
    expect(createTerminatorCells(now, 5)).toHaveLength(2_592);
    expect(createTerminatorCells(now, 10)).toHaveLength(648);
  });

  it('refuses a mesh step that cannot tile the world', () => {
    expect(() => createTerminatorCells(new Date(), 7)).toThrow(/positive divisor/);
  });
});
