import { ArcLayer } from '@deck.gl/layers';
import { describe, expect, it } from 'vitest';

import { createWorldLayers } from './layers';
import { createDarknessField } from './terminator';

import type { WorldRoute } from './layers';
import type { WorldPalette } from './palette';

const palette: WorldPalette = {
  ocean: [1, 2, 3, 255],
  land: [4, 5, 6, 255],
  landLine: [7, 8, 9, 180],
  grid: [10, 11, 12, 80],
  night: [13, 14, 15, 215],
  route: [16, 17, 18, 230],
};

/** Small enough to keep the test fast; the field's own tests own its contents. */
const DARKNESS = createDarknessField(new Date('2026-08-22T12:00:00.000Z'), 16, 8);

const antimeridianRoute: WorldRoute = {
  id: 'antimeridian',
  source: [170, 35],
  target: [-170, 40],
};

describe('projection-independent world layers', () => {
  it('uses one great-circle arc layer for an antimeridian crossing', () => {
    const layers = createWorldLayers({
      palette,
      quality: 'full',
      routes: [antimeridianRoute],
      darkness: DARKNESS,
      visibility: { graticule: true, routes: true, terminator: true },
    });
    const routes = layers.find(
      (layer): layer is ArcLayer<WorldRoute> =>
        layer instanceof ArcLayer && layer.id === 'world-routes',
    );

    expect(routes).toBeInstanceOf(ArcLayer);
    expect(routes?.props.greatCircle).toBe(true);
    expect(routes?.props.data).toEqual([antimeridianRoute]);
  });

  it('keeps the layer ids and visibility independent of projection', () => {
    const layers = createWorldLayers({
      palette,
      quality: 'reduced',
      routes: [],
      darkness: DARKNESS,
      visibility: { graticule: false, routes: true, terminator: false },
    });
    expect(layers.filter((layer) => layer !== false).map((layer) => layer.id)).toEqual([
      'world-ocean',
      'world-land',
      'world-routes',
    ]);
  });

  it('halves route tessellation in reduced mode', () => {
    const full = createWorldLayers({
      palette,
      quality: 'full',
      routes: [antimeridianRoute],
      darkness: DARKNESS,
      visibility: { graticule: false, routes: true, terminator: false },
    });
    const reduced = createWorldLayers({
      palette,
      quality: 'reduced',
      routes: [antimeridianRoute],
      darkness: DARKNESS,
      visibility: { graticule: false, routes: true, terminator: false },
    });
    const fullRoutes = full.find(
      (layer): layer is ArcLayer<WorldRoute> =>
        layer instanceof ArcLayer && layer.id === 'world-routes',
    );
    const reducedRoutes = reduced.find(
      (layer): layer is ArcLayer<WorldRoute> =>
        layer instanceof ArcLayer && layer.id === 'world-routes',
    );
    expect(fullRoutes?.props.numSegments).toBe(100);
    expect(reducedRoutes?.props.numSegments).toBe(50);
  });
});
