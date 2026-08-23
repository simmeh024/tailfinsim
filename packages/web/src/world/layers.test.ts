import { ArcLayer } from '@deck.gl/layers';
import { describe, expect, it } from 'vitest';

import { COARSE_LAND } from './land';
import { createWorldLayers } from './layers';
import { createDarknessField, WEB_MERCATOR_MAX_LATITUDE } from './terminator';

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
      land: COARSE_LAND,
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
      land: COARSE_LAND,
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
      land: COARSE_LAND,
      projection: 'flat',
      visibility: { graticule: false, routes: true, terminator: false },
    });
    const reduced = createWorldLayers({
      palette,
      quality: 'reduced',
      routes: [antimeridianRoute],
      darkness: DARKNESS,
      land: COARSE_LAND,
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
      land: COARSE_LAND,
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

    // Different in identity, which is what makes deck.gl rebuild the mesh. They
    // are no longer equal in value either — see the bounds test below, which owns
    // that half — so this asserts only the reference.
    expect(flat[0]).not.toBe(globe[0]);
    expect(flat[1]).not.toBe(globe[1]);

    // And stable within a projection, so an ordinary re-render does not churn the
    // mesh every time the palette or the terminator updates.
    expect(boundsFor('flat')[0]).toBe(flat[0]);
  });

  it('gives each quality tier its own bounds instance too', () => {
    // Reduced quality coarsens the globe's mesh resolution, so it is a different
    // tessellation of the same bounds — and `BitmapLayer` only notices a new
    // reference. Keyed on projection alone, dropping to reduced quality left the
    // fine mesh in place and the coarsening silently did nothing.
    const at = (quality: 'full' | 'reduced') =>
      createWorldLayers({
        palette,
        quality,
        routes: [],
        darkness: DARKNESS,
        land: COARSE_LAND,
        projection: 'globe',
        visibility: { graticule: false, routes: false, terminator: true },
      })
        .filter((layer): layer is Layer => layer !== false)
        .find((layer) => layer.id === 'world-terminator');

    const full = (at('full')?.props as unknown as { bounds: unknown }).bounds;
    const reduced = (at('reduced')?.props as unknown as { bounds: unknown }).bounds;
    expect(full).toEqual(reduced);
    expect(full).not.toBe(reduced);
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
      land: COARSE_LAND,
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

  it('bounds each projection where its own coordinate system stops', () => {
    const boundsOf = (projection: 'flat' | 'globe') => {
      const layers = createWorldLayers({
        palette,
        quality: 'full',
        routes: [],
        darkness: DARKNESS,
        land: COARSE_LAND,
        projection,
        visibility: { graticule: false, routes: false, terminator: true },
      }).filter((layer): layer is Layer => layer !== false);
      const terminator = layers.find((layer) => layer.id === 'world-terminator');
      return (terminator?.props as unknown as { bounds: number[] }).bounds;
    };

    // Web Mercator runs to infinity at the poles, so a flat quad cannot reach
    // +-90. Given it anyway, deck.gl squashed the whole night field into a
    // tapering wedge across the equator on the deployed flat map.
    expect(boundsOf('flat')).toEqual([
      -180,
      -WEB_MERCATOR_MAX_LATITUDE,
      180,
      WEB_MERCATOR_MAX_LATITUDE,
    ]);
    expect(boundsOf('globe')).toEqual([-180, -90, 180, 90]);
  });

  it('converts no texture coordinates, because the field already matches', () => {
    const layers = createWorldLayers({
      palette,
      quality: 'full',
      routes: [],
      darkness: DARKNESS,
      land: COARSE_LAND,
      projection: 'flat',
      visibility: { graticule: false, routes: false, terminator: true },
    }).filter((layer): layer is Layer => layer !== false);

    /*
     * `_imageCoordinateSystem: 'lnglat'` is deck.gl's shader-side answer to an
     * equirectangular image on a mercator viewport, and on a world-sized quad it
     * does not work: the flat map showed a tapering wedge and the globe showed
     * hard-edged blocks of full night over land in daylight.
     *
     * The rows are generated to match the projection instead, so there is nothing
     * left to convert. This asserts the prop is *absent* rather than that some
     * other value is set, because any value at all re-enters that shader path.
     */
    // deck.gl defaults the prop to `'default'` rather than leaving it unset, so
    // the assertion is on that value: anything else re-enters the shader path.
    const terminator = layers.find((layer) => layer.id === 'world-terminator');
    expect(
      (terminator?.props as unknown as { _imageCoordinateSystem?: string })._imageCoordinateSystem,
    ).toBe('default');
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
      land: COARSE_LAND,
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

  /**
   * The bug that actually made the world black, and the one every other
   * diagnostic missed.
   *
   * `BitmapLayer` accepts `image` as an object, and handed
   * `{ data: Uint8Array, width, height }` it builds a texture of exactly the right
   * dimensions **containing nothing** — `readDataSyncWebGL` came back all zeros
   * across 524,288 bytes. Everything short of a texture readback said the layer was
   * healthy: mesh built, model present, texture reporting `rgba8unorm 512x256`.
   *
   * `ImageData` is a real image source, so deck.gl uploads it. Asserting the type
   * is the cheap proxy for "the pixels will actually reach the GPU".
   */
  it('hands deck.gl an image source it will upload, not a bag of numbers', () => {
    const layers = createWorldLayers({
      palette,
      quality: 'full',
      routes: [],
      darkness: DARKNESS,
      land: COARSE_LAND,
      projection: 'flat',
      visibility: { graticule: false, routes: false, terminator: true },
    }).filter((layer): layer is Layer => layer !== false);

    for (const id of ['world-ocean', 'world-terminator']) {
      const image = (
        layers.find((layer) => layer.id === id)?.props as unknown as {
          image?: unknown;
        }
      ).image;
      expect(image, `${id} must be an ImageData`).toBeInstanceOf(ImageData);
    }
  });

  it('fills the ocean texture with the palette colour, opaque', () => {
    const layers = createWorldLayers({
      palette,
      quality: 'full',
      routes: [],
      darkness: DARKNESS,
      land: COARSE_LAND,
      projection: 'flat',
      visibility: { graticule: false, routes: false, terminator: false },
    }).filter((layer): layer is Layer => layer !== false);

    const image = (
      layers.find((layer) => layer.id === 'world-ocean')?.props as unknown as {
        image: ImageData;
      }
    ).image;

    // Every texel, so a half-filled buffer cannot pass.
    for (let texel = 0; texel < image.width * image.height; texel += 1) {
      expect([...image.data.slice(texel * 4, texel * 4 + 4)]).toEqual(palette.ocean);
    }
  });

  it('scales the night field by the palette alpha and leaves day transparent', () => {
    const layers = createWorldLayers({
      palette,
      quality: 'full',
      routes: [],
      darkness: DARKNESS,
      land: COARSE_LAND,
      projection: 'flat',
      visibility: { graticule: false, routes: false, terminator: true },
    }).filter((layer): layer is Layer => layer !== false);

    const image = (
      layers.find((layer) => layer.id === 'world-terminator')?.props as unknown as {
        image: ImageData;
      }
    ).image;

    const alphas: number[] = [];
    for (let texel = 0; texel < image.width * image.height; texel += 1) {
      // The colour is the palette's everywhere; only the alpha varies.
      expect([...image.data.slice(texel * 4, texel * 4 + 3)]).toEqual(palette.night.slice(0, 3));
      alphas.push(image.data[texel * 4 + 3] ?? -1);
    }
    expect(Math.min(...alphas)).toBe(0);
    expect(Math.max(...alphas)).toBe(palette.night[3]);
  });

  /**
   * The Arctic ring, which was neither the atmosphere nor the shading nor the
   * mesh — all three of which I checked first.
   *
   * `land-110m` stores longitudes in `[-180, 180]`, so a coastline crossing the
   * antimeridian has consecutive vertices like `179.99` and `-180`. Neighbours on a
   * sphere; **360 degrees apart in the space the layers tessellate in**. The
   * coastline `PathLayer` drew that as a segment sweeping the whole way round the
   * world, which on the globe is a smooth arc across the Arctic with no coastline
   * under it.
   */
  it('leaves no ring jumping the antimeridian', () => {
    const rings: number[][][] = [];
    const collect = (geometry: { type: string; coordinates: unknown }) => {
      if (geometry.type === 'Polygon') rings.push(...(geometry.coordinates as number[][][]));
      else if (geometry.type === 'MultiPolygon')
        for (const polygon of geometry.coordinates as number[][][][]) rings.push(...polygon);
    };
    const land = (
      createWorldLayers({
        palette,
        quality: 'full',
        routes: [],
        darkness: DARKNESS,
        land: COARSE_LAND,
        projection: 'globe',
        visibility: { graticule: false, routes: false, terminator: false },
      }).find((layer) => layer !== false && layer.id === 'world-land') as Layer
    ).props.data as { features?: { geometry: { type: string; coordinates: unknown } }[] };

    for (const shape of land.features ?? []) collect(shape.geometry);
    expect(rings.length).toBeGreaterThan(100);

    const jumps = rings.flatMap((ring) =>
      ring
        .map((point, index) =>
          index === 0 ? 0 : Math.abs((point[0] ?? 0) - (ring[index - 1]?.[0] ?? 0)),
        )
        .filter((delta) => delta > 180),
    );
    expect(jumps, 'consecutive coastline vertices 360 degrees apart').toEqual([]);
  });
});
