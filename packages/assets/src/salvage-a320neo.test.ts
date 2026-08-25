import { describe, expect, it } from 'vitest';

import { classifyA320neoSurface, type A320neoSurfaceClass } from './salvage-a320neo';

const defaults = {
  centre: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 1, z: 0 },
  colour: { x: 210, y: 210, z: 210 },
  componentCentre: { x: 0, y: 0, z: 0 },
  componentSize: { x: 0.8, y: 0.2, z: 0.9 },
  componentTriangles: 40_000,
};

describe('A320neo semantic salvage classifier', () => {
  const cases: readonly (readonly [
    A320neoSurfaceClass,
    Partial<Parameters<typeof classifyA320neoSurface>[0]>,
  ])[] = [
    ['lights', { centre: { x: 0.497, y: 0, z: 0 } }],
    [
      'rubber_tyres',
      {
        centre: { x: 0.18, y: -0.145, z: 0.13 },
        componentCentre: { x: 0.18, y: -0.145, z: 0.13 },
        componentSize: { x: 0.02, y: 0.02, z: 0.02 },
        componentTriangles: 800,
      },
    ],
    [
      'engine_interiors',
      {
        centre: { x: 0.18, y: -0.1, z: 0.15 },
        normal: { x: 0, y: 0, z: 1 },
        colour: { x: 45, y: 45, z: 45 },
      },
    ],
    [
      'cockpit_glass',
      {
        centre: { x: 0.04, y: 0, z: 0.4 },
        normal: { x: 1, y: 0, z: 0 },
        colour: { x: 35, y: 35, z: 35 },
      },
    ],
    [
      'cabin_windows',
      {
        centre: { x: 0.05, y: -0.02, z: 0 },
        normal: { x: 1, y: 0, z: 0 },
        colour: { x: 35, y: 35, z: 35 },
      },
    ],
    ['winglets', { centre: { x: 0.45, y: 0.02, z: 0 } }],
    ['fin', { centre: { x: 0.01, y: 0.1, z: -0.4 } }],
    ['horizontal_stabilisers', { centre: { x: 0.15, y: 0.04, z: -0.4 } }],
    ['wings', { centre: { x: 0.3, y: 0, z: 0 } }],
    [
      'nacelle_exteriors',
      {
        centre: { x: 0.18, y: -0.1, z: 0.15 },
        normal: { x: 0, y: 1, z: 0 },
      },
    ],
    ['fuselage', {}],
  ];

  it.each(cases)('classifies a representative %s triangle', (expected, input) => {
    expect(classifyA320neoSurface({ ...defaults, ...input })).toBe(expected);
  });
});
