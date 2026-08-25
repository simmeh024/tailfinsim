import { ArcLayer } from '@deck.gl/layers';
import { describe, expect, it } from 'vitest';

import { COARSE_WORLD } from './land';
import { createWorldLayers } from './layers';
import { createDarknessField, WEB_MERCATOR_MAX_LATITUDE } from './terminator';
import { terrainImage } from './terrain';

import type { WorldRoute } from './layers';
import type { WorldPalette } from './palette';
import type { Layer } from '@deck.gl/core';

const palette: WorldPalette = {
  ocean: [1, 2, 3, 255],
  land: [4, 5, 6, 255],
  landLine: [7, 8, 9, 180],
  border: [19, 20, 21, 160],
  grid: [10, 11, 12, 80],
  night: [13, 14, 15, 215],
  route: [16, 17, 18, 230],
  terrain: [200, 210, 220, 204],
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
      land: COARSE_WORLD.land,
      borders: COARSE_WORLD.borders,
      projection: 'flat',
      visibility: {
        graticule: true,
        routes: true,
        terminator: true,
        borders: false,
        terrain: false,
      },
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
      land: COARSE_WORLD.land,
      borders: COARSE_WORLD.borders,
      projection: 'flat',
      visibility: {
        graticule: false,
        routes: true,
        terminator: false,
        borders: false,
        terrain: false,
      },
    });
    expect(layers.filter((layer) => layer !== false).map((layer) => layer.id)).toEqual([
      'world-ocean',
      'world-land',
      'world-routes',
    ]);
  });

  it('draws the terrain over the land fill and under the borders', () => {
    /*
     * Order is the whole of this layer's correctness. The basemap is opaque
     * across every land texel, so beneath the fill it would be invisible, and
     * above the borders it would bury the one line on the map that carries
     * information.
     */
    const ids = createWorldLayers({
      palette,
      quality: 'full',
      routes: [],
      darkness: DARKNESS,
      land: COARSE_WORLD.land,
      borders: COARSE_WORLD.borders,
      projection: 'flat',
      visibility: {
        graticule: false,
        routes: false,
        terminator: false,
        borders: true,
        terrain: true,
      },
    })
      .filter((layer): layer is Layer => layer !== false)
      .map((layer) => layer.id);

    expect(ids).toEqual(['world-ocean', 'world-land', 'world-terrain', 'world-borders']);
  });

  it('gives each projection its own terrain image, because the warp is baked in', () => {
    /*
     * Asserted on `terrainImage` rather than through the layer, and that is not a
     * shortcut. `BitmapLayer.image` is an **async prop**: `layer.props.image`
     * reads as the *resolved* value, which is null until deck.gl has fetched it,
     * so a test reading it off an uninitialised layer proves nothing either way.
     *
     * The claim that matters is here anyway. `BitmapLayer` interpolates texture
     * coordinates linearly in whatever the viewport uses, so one image cannot
     * serve both projections; `_imageCoordinateSystem` is deck.gl's answer and
     * this codebase reverted it (see the terminator). The warp is baked into the
     * asset instead, which only works if each projection gets its own.
     */
    expect(terrainImage('globe')).not.toBe(terrainImage('flat'));
    expect(terrainImage('globe')).toBeTruthy();
    expect(terrainImage('flat')).toBeTruthy();
  });

  it('omits the terrain entirely when it is switched off', () => {
    const ids = createWorldLayers({
      palette,
      quality: 'full',
      routes: [],
      darkness: DARKNESS,
      land: COARSE_WORLD.land,
      borders: COARSE_WORLD.borders,
      projection: 'flat',
      visibility: {
        graticule: false,
        routes: false,
        terminator: false,
        borders: false,
        terrain: false,
      },
    })
      .filter((layer): layer is Layer => layer !== false)
      .map((layer) => layer.id);

    // Not merely hidden: a switched-off layer must not cost the image fetch.
    expect(ids).not.toContain('world-terrain');
  });

  it('takes the terrain tint and opacity from the theme, not from the asset', () => {
    /*
     * One image serves both themes, and this is the only thing that makes that
     * possible. The raster is authored at one brightness; the light theme's sea
     * is nearly white, so untinted the basemap is *lighter than the ocean it
     * sits in* and the coastline stops reading. Hard-coding the tint on the
     * layer would put that decision somewhere `tokens.css` cannot reach it, and
     * the light theme is the one that would silently lose.
     */
    const terrain = createWorldLayers({
      palette,
      quality: 'full',
      routes: [],
      darkness: DARKNESS,
      land: COARSE_WORLD.land,
      borders: COARSE_WORLD.borders,
      projection: 'globe',
      visibility: {
        graticule: false,
        routes: false,
        terminator: false,
        borders: false,
        terrain: true,
      },
    })
      .filter((layer): layer is Layer => layer !== false)
      .find((layer) => layer.id === 'world-terrain');

    expect(terrain?.props).toMatchObject({
      tintColor: [palette.terrain[0], palette.terrain[1], palette.terrain[2]],
    });
    // The alpha is the layer's opacity, so it lives beside the colour in the
    // token rather than as a constant nowhere near the theme.
    expect(terrain?.props.opacity).toBeCloseTo(palette.terrain[3] / 255, 5);
  });

  it('halves route tessellation in reduced mode', () => {
    const full = createWorldLayers({
      palette,
      quality: 'full',
      routes: [antimeridianRoute],
      darkness: DARKNESS,
      land: COARSE_WORLD.land,
      borders: COARSE_WORLD.borders,
      projection: 'flat',
      visibility: {
        graticule: false,
        routes: true,
        terminator: false,
        borders: false,
        terrain: false,
      },
    });
    const reduced = createWorldLayers({
      palette,
      quality: 'reduced',
      routes: [antimeridianRoute],
      darkness: DARKNESS,
      land: COARSE_WORLD.land,
      borders: COARSE_WORLD.borders,
      projection: 'flat',
      visibility: {
        graticule: false,
        routes: true,
        terminator: false,
        borders: false,
        terrain: false,
      },
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
      land: COARSE_WORLD.land,
      borders: COARSE_WORLD.borders,
      visibility: {
        graticule: true,
        routes: true,
        terminator: true,
        borders: false,
        terrain: false,
      },
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
        land: COARSE_WORLD.land,
        borders: COARSE_WORLD.borders,
        projection: 'globe',
        visibility: {
          graticule: false,
          routes: false,
          terminator: true,
          borders: false,
          terrain: false,
        },
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
      land: COARSE_WORLD.land,
      borders: COARSE_WORLD.borders,
      projection: 'globe',
      visibility: {
        graticule: true,
        routes: true,
        terminator: true,
        borders: false,
        terrain: true,
      },
    }).filter((layer): layer is Layer => layer !== false);

    /*
     * The terrain belongs in this list for exactly the reason the other two do:
     * it is a world-sized quad, so its near and far halves project with opposite
     * apparent winding and back-face culling discards one of them. When it
     * discards the near one the planet goes black.
     */
    for (const id of ['world-ocean', 'world-terminator', 'world-terrain']) {
      const layer = layers.find((candidate) => candidate.id === id);
      const parameters = (layer?.props as unknown as { parameters?: { cullMode?: string } })
        .parameters;
      expect(parameters?.cullMode, id).toBe('none');
    }
  });

  it('keeps the day/night wash in front of the land it shades', () => {
    /*
     * The angular patches of undimmed land.
     *
     * `SolidPolygonLayer` does not subdivide for the globe, so earcut joins distant
     * coastline vertices and a single land triangle can span nearly three degrees,
     * its flat interior chording up to about two kilometres below the sphere. The
     * terminator is tessellated *to* the sphere, so land crosses its depth in
     * patches — in front near a coast, behind inland — and the shading was
     * depth-rejected wherever land happened to be nearer. Measured across one
     * patch: a clean alpha ramp either side and a flat zero across the facet.
     */
    const layers = createWorldLayers({
      palette,
      quality: 'full',
      routes: [],
      darkness: DARKNESS,
      land: COARSE_WORLD.land,
      borders: COARSE_WORLD.borders,
      projection: 'globe',
      visibility: {
        graticule: false,
        routes: false,
        terminator: true,
        borders: false,
        terrain: false,
      },
    }).filter((layer): layer is Layer => layer !== false);

    const terminator = layers.find((layer) => layer.id === 'world-terminator');
    const offset = (
      terminator?.props as unknown as {
        getPolygonOffset?: (params: { layerIndex: number }) => [number, number];
      }
    ).getPolygonOffset;
    expect(offset).toBeTypeOf('function');

    const [factor, units] = offset!({ layerIndex: 5 });
    expect(factor).toBe(0);
    // deck.gl's default is `-layerIndex * 100`, a few hundred units, which is not
    // enough to clear the sag. Anything in that range leaves the patches.
    expect(units).toBeLessThan(-1000);

    // And it must beat the land's own bias by a wide margin. Every deck.gl layer
    // carries the default, so the invariant is the *gap*, not the presence.
    const land = layers.find((layer) => layer.id === 'world-land');
    const landOffset = (
      land?.props as unknown as {
        getPolygonOffset: (params: { layerIndex: number }) => [number, number];
      }
    ).getPolygonOffset({ layerIndex: 1 });
    expect(units).toBeLessThan(landOffset[1] - 1000);
  });

  it('rebuilds a world-sized bitmap when the viewport that draws it changes', () => {
    /*
     * The projection-switch black globe.
     *
     * `BitmapLayer` builds its mesh only when `bounds` changes by reference, and it
     * reads the resolution off whatever viewport is in context at that moment.
     * deck.gl updates layers *before* it activates the new viewport, so switching
     * flat to globe built the flat map's two-triangle quad and kept it — a chord
     * straight through the sphere, occluded, and the ocean and day/night both black.
     * Measured on the deployed build: viewport `resolution: 2`, correct bounds, and
     * a mesh of six indices.
     */
    const layers = createWorldLayers({
      palette,
      quality: 'full',
      routes: [],
      darkness: DARKNESS,
      land: COARSE_WORLD.land,
      borders: COARSE_WORLD.borders,
      projection: 'globe',
      visibility: {
        graticule: false,
        routes: false,
        terminator: true,
        borders: false,
        terrain: false,
      },
    }).filter((layer): layer is Layer => layer !== false);

    const worldSized = layers.filter((layer) =>
      ['world-ocean', 'world-terminator'].includes(layer.id),
    );
    expect(worldSized).toHaveLength(2);

    for (const layer of worldSized) {
      // Both world-sized bitmaps, and only those, need the viewport-aware subclass.
      expect((layer.constructor as unknown as { layerName: string }).layerName).toBe(
        'WorldBitmapLayer',
      );

      // A stock `BitmapLayer` ignores a viewport-only change; this one must not,
      // or there is no update on which it could notice the mesh is wrong.
      const viewportOnly = {
        changeFlags: { propsOrDataChanged: false, viewportChanged: true },
      } as never;
      expect(layer.shouldUpdateState(viewportOnly)).toBe(true);

      // ...and an update with nothing changed at all stays cheap.
      const nothing = {
        changeFlags: { propsOrDataChanged: false, viewportChanged: false },
      } as never;
      expect(layer.shouldUpdateState(nothing)).toBe(false);
    }
  });

  it('draws country borders only when asked, and under its own colour', () => {
    const idsWith = (borders: boolean) =>
      createWorldLayers({
        palette,
        quality: 'full',
        routes: [],
        darkness: DARKNESS,
        land: COARSE_WORLD.land,
        borders: COARSE_WORLD.borders,
        projection: 'globe',
        visibility: { graticule: false, routes: false, terminator: false, borders, terrain: false },
      })
        .filter((layer): layer is Layer => layer !== false)
        .map((layer) => layer.id);

    expect(idsWith(true)).toContain('world-borders');
    expect(idsWith(false)).not.toContain('world-borders');

    const layer = createWorldLayers({
      palette,
      quality: 'full',
      routes: [],
      darkness: DARKNESS,
      land: COARSE_WORLD.land,
      borders: COARSE_WORLD.borders,
      projection: 'globe',
      visibility: {
        graticule: false,
        routes: false,
        terminator: false,
        borders: true,
        terrain: false,
      },
    })
      .filter((l): l is Layer => l !== false)
      .find((l) => l.id === 'world-borders');

    const props = layer?.props as unknown as {
      getLineColor: number[];
      filled: boolean;
      data: unknown;
    };
    // Its own token, not the coastline's: the two must be distinguishable, and
    // `palette.test.ts` holds the contrast either way.
    expect(props.getLineColor).toEqual(palette.border);
    expect(props.getLineColor).not.toEqual(palette.landLine);
    // A line mesh has no rings; filling it would be meaningless work.
    expect(props.filled).toBe(false);
    expect(props.data).toBe(COARSE_WORLD.borders);
  });

  it('bounds each projection where its own coordinate system stops', () => {
    const boundsOf = (projection: 'flat' | 'globe') => {
      const layers = createWorldLayers({
        palette,
        quality: 'full',
        routes: [],
        darkness: DARKNESS,
        land: COARSE_WORLD.land,
        borders: COARSE_WORLD.borders,
        projection,
        visibility: {
          graticule: false,
          routes: false,
          terminator: true,
          borders: false,
          terrain: false,
        },
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
      land: COARSE_WORLD.land,
      borders: COARSE_WORLD.borders,
      projection: 'flat',
      visibility: {
        graticule: false,
        routes: false,
        terminator: true,
        borders: false,
        terrain: false,
      },
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
      land: COARSE_WORLD.land,
      borders: COARSE_WORLD.borders,
      projection: 'globe',
      visibility: {
        graticule: true,
        routes: true,
        terminator: true,
        borders: false,
        terrain: false,
      },
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
      land: COARSE_WORLD.land,
      borders: COARSE_WORLD.borders,
      projection: 'flat',
      visibility: {
        graticule: false,
        routes: false,
        terminator: true,
        borders: false,
        terrain: false,
      },
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
      land: COARSE_WORLD.land,
      borders: COARSE_WORLD.borders,
      projection: 'flat',
      visibility: {
        graticule: false,
        routes: false,
        terminator: false,
        borders: false,
        terrain: false,
      },
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
      land: COARSE_WORLD.land,
      borders: COARSE_WORLD.borders,
      projection: 'flat',
      visibility: {
        graticule: false,
        routes: false,
        terminator: true,
        borders: false,
        terrain: false,
      },
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
        land: COARSE_WORLD.land,
        borders: COARSE_WORLD.borders,
        projection: 'globe',
        visibility: {
          graticule: false,
          routes: false,
          terminator: false,
          borders: false,
          terrain: false,
        },
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
