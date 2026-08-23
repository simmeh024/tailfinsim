import { ArcLayer } from '@deck.gl/layers';
import { describe, expect, it } from 'vitest';

import { createWorldLayers } from './layers';
import { createDarknessField } from './terminator';

import type { WorldRoute } from './layers';
import type { WorldPalette } from './palette';
import type { Layer } from '@deck.gl/core';

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
      projection: 'flat',
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
      projection: 'flat',
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
      projection: 'flat',
      visibility: { graticule: false, routes: true, terminator: false },
    });
    const reduced = createWorldLayers({
      palette,
      quality: 'reduced',
      routes: [antimeridianRoute],
      darkness: DARKNESS,
      projection: 'flat',
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

  /**
   * The bug this guards is invisible in the layer list and fatal on screen.
   *
   * `BitmapLayer` rebuilds its mesh only when `props.bounds` changes by *reference*,
   * and tessellates to the viewport's resolution — a flat quad for `MapView`, a
   * sphere-following mesh for `GlobeView`. One shared frozen constant meant the flat
   * quad survived the switch to the globe and cut straight through the planet, so the
   * sea and the day/night shading vanished behind `GlobeView`'s own backdrop and the
   * globe rendered black with land floating on it.
   */
  it('gives each projection its own bounds instance, so the mesh re-tessellates', () => {
    const options = {
      palette,
      quality: 'full' as const,
      routes: [],
      darkness: DARKNESS,
      visibility: { graticule: true, routes: true, terminator: true },
    };
    const boundsFor = (projection: 'flat' | 'globe') =>
      createWorldLayers({ ...options, projection })
        .filter((layer): layer is Layer => layer !== false)
        .filter((layer) => layer.id === 'world-ocean' || layer.id === 'world-terminator')
        .map((layer) => (layer.props as unknown as { bounds: unknown }).bounds);

    const flat = boundsFor('flat');
    const globe = boundsFor('globe');
    expect(flat).toHaveLength(2);
    expect(globe).toHaveLength(2);

    // Equal in value, different in identity. Both halves matter: the same numbers,
    // so the two views cover the same world, and a different reference, so deck.gl
    // knows to rebuild.
    expect(flat[0]).toEqual([-180, -90, 180, 90]);
    expect(globe[0]).toEqual([-180, -90, 180, 90]);
    expect(flat[0]).not.toBe(globe[0]);
    expect(flat[1]).not.toBe(globe[1]);

    // And stable within a projection, so an ordinary re-render does not churn the
    // mesh every time the palette or the terminator updates.
    expect(boundsFor('flat')[0]).toBe(flat[0]);
  });

  /**
   * The other half of the black globe, and the one I could not see.
   *
   * A world-sized quad wraps the whole sphere, so its near and far halves have
   * opposite apparent winding once projected. Back-face culling discards one of
   * them; when that is the near one, all that is left sits behind `GlobeView`'s
   * opaque backdrop and is rejected by the depth test.
   *
   * The layers that kept rendering on the globe — the graticule and the routes —
   * are exactly the ones that already used `none`.
   */
  it('never back-face culls a layer that covers the whole sphere', () => {
    const layers = createWorldLayers({
      palette,
      quality: 'full',
      routes: [antimeridianRoute],
      darkness: DARKNESS,
      projection: 'globe',
      visibility: { graticule: true, routes: true, terminator: true },
    }).filter((layer): layer is Layer => layer !== false);

    for (const id of ['world-ocean', 'world-terminator']) {
      const layer = layers.find((candidate) => candidate.id === id);
      const parameters = (layer?.props as unknown as { parameters?: { cullMode?: string } })
        .parameters;
      expect(parameters?.cullMode, id).toBe('none');
    }
  });

  it('tells deck.gl the night field is equirectangular', () => {
    const layers = createWorldLayers({
      palette,
      quality: 'full',
      routes: [],
      darkness: DARKNESS,
      projection: 'flat',
      visibility: { graticule: false, routes: false, terminator: true },
    }).filter((layer): layer is Layer => layer !== false);

    // The field is sampled at equal degrees of latitude per row. `BitmapLayer`
    // otherwise interpolates texture coordinates in the viewport's own system,
    // which on the flat map is Web Mercator — so the night boundary drifted from
    // its true latitude, further the closer to the poles.
    const terminator = layers.find((layer) => layer.id === 'world-terminator');
    expect(
      (terminator?.props as unknown as { _imageCoordinateSystem?: string })._imageCoordinateSystem,
    ).toBe('lnglat');
  });

  /**
   * The one that was actually making the world black.
   *
   * luma.gl's default sampler is `minFilter: linear, mipmapFilter: linear`, which
   * becomes WebGL's `LINEAR_MIPMAP_LINEAR`. A texture uploaded from a typed array
   * has a single mip level, so that filter makes it an **incomplete texture** — and
   * an incomplete texture samples as opaque black, with no warning and no GL error.
   *
   * Setting `minFilter: 'linear'` alone does not help: the mipmap half of the pair
   * comes from the default and stays. Measured on the live texture, the WebGL
   * minification filter goes from `LINEAR_MIPMAP_LINEAR` to `LINEAR` once
   * `mipmapFilter: 'none'` is set.
   */
  it('never leaves a data texture on a mipmapping filter', () => {
    const layers = createWorldLayers({
      palette,
      quality: 'full',
      routes: [],
      darkness: DARKNESS,
      projection: 'globe',
      visibility: { graticule: true, routes: true, terminator: true },
    }).filter((layer): layer is Layer => layer !== false);

    for (const id of ['world-ocean', 'world-terminator']) {
      const layer = layers.find((candidate) => candidate.id === id);
      const sampler = (
        layer?.props as unknown as {
          textureParameters?: { mipmapFilter?: string; minFilter?: string };
        }
      ).textureParameters;
      expect(
        sampler?.mipmapFilter,
        `${id} must not sample from a mipmap chain it has not got`,
      ).toBe('none');
      expect(sampler?.minFilter, id).toBe('linear');
    }
  });
});
