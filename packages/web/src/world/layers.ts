import { ArcLayer, BitmapLayer, GeoJsonLayer, PathLayer } from '@deck.gl/layers';
import { feature } from 'topojson-client';
import landTopologyJson from 'world-atlas/land-110m.json';

import type { WorldPalette } from './palette';
import type { WorldProjection } from './projection';
import type { DarknessField, LngLat } from './terminator';
import type { Layer } from '@deck.gl/core';
import type { GeometryCollection, Topology } from 'topojson-specification';

export type RendererQuality = 'full' | 'reduced';

export interface WorldLayerVisibility {
  graticule: boolean;
  routes: boolean;
  terminator: boolean;
}

export interface WorldRoute {
  id: string;
  source: LngLat;
  target: LngLat;
}

export interface CreateWorldLayersOptions {
  palette: WorldPalette;
  quality: RendererQuality;
  routes: readonly WorldRoute[];
  darkness: DarknessField;
  visibility: WorldLayerVisibility;
  /**
   * The projection these layers are about to be drawn into.
   *
   * **Not** used to choose a layer — the list is identical for both views, which is
   * this file's contract. It selects which `bounds` array instance the world-sized
   * `BitmapLayer`s are given, and that is load-bearing for a reason worth writing
   * down.
   *
   * `BitmapLayer.updateState` rebuilds its mesh only when `props.bounds` changes by
   * **reference**, and `createMesh` tessellates according to the viewport's
   * `resolution` — absent on `MapView`, so a flat two-triangle quad; five degrees on
   * `GlobeView`, so a mesh that follows the sphere. Hand both views one frozen
   * constant and the quad built for the flat map survives the switch: two triangles
   * cutting straight through the planet, ending up inside it and occluded by
   * `GlobeView`'s own opaque backdrop.
   *
   * The symptom is a **black globe with land floating on it**, because the land is
   * drawn from real multi-vertex coastlines and tessellates on its own, while the
   * sea and the day/night shading do not appear at all.
   */
  projection: WorldProjection;
}

interface GraticulePath {
  id: string;
  path: LngLat[];
}

const topology = landTopologyJson as unknown as Topology<{ land: GeometryCollection }>;
const LAND = feature(topology, topology.objects.land);

function graticulePaths(): GraticulePath[] {
  const paths: GraticulePath[] = [];
  for (let latitude = -60; latitude <= 60; latitude += 30) {
    const path: LngLat[] = [];
    for (let longitude = -180; longitude <= 180; longitude += 5) {
      path.push([longitude, latitude]);
    }
    paths.push({ id: `latitude-${String(latitude)}`, path });
  }
  for (let longitude = -150; longitude <= 180; longitude += 30) {
    const path: LngLat[] = [];
    for (let latitude = -85; latitude <= 85; latitude += 5) {
      path.push([longitude, latitude]);
    }
    paths.push({ id: `longitude-${String(longitude)}`, path });
  }
  return paths;
}

const GRATICULE = graticulePaths();

/**
 * West, south, east, north — the whole sphere, once per projection.
 *
 * Two arrays with identical values, deliberately. See `projection` above: the
 * *identity* is what tells `BitmapLayer` to rebuild its mesh, and each view needs
 * a different tessellation of the same bounds.
 */
const WORLD_BOUNDS: Record<WorldProjection, [number, number, number, number]> = {
  flat: [-180, -90, 180, 90],
  globe: [-180, -90, 180, 90],
};

/**
 * Sampler settings every data texture here needs.
 *
 * **`mipmapFilter: 'none'` is the load-bearing one, and its absence renders black.**
 * luma.gl's default sampler is `minFilter: linear, mipmapFilter: linear`, which
 * `convertMinFilterMode` turns into WebGL's `LINEAR_MIPMAP_LINEAR`. A texture
 * uploaded from a typed array has one mip level and no mipmap chain, so that
 * filter makes it an **incomplete texture** — and an incomplete texture samples as
 * opaque black, silently, with no warning and no GL error.
 *
 * That is what a black sea and a missing terminator were: not culling, not
 * tessellation, not the palette. Both bitmap layers were sampling a texture the
 * driver considered unusable. Setting `minFilter: 'linear'` alone does not help,
 * because the mipmap half of the pair comes from the default and stays.
 *
 * Linear filtering is otherwise the point of using a texture at all: it is what
 * turns the sampled darkness field into a smooth gradient. Clamped rather than
 * repeated, so the poles do not sample across to the opposite pole.
 */
const DATA_TEXTURE_SAMPLER = {
  minFilter: 'linear',
  magFilter: 'linear',
  mipmapFilter: 'none',
  addressModeU: 'clamp-to-edge',
  addressModeV: 'clamp-to-edge',
} as const;

/**
 * A solid fill covering the whole world, as a texture.
 *
 * The ocean used to be a `SolidPolygonLayer` holding one six-vertex rectangle in
 * longitude/latitude, which is exactly right on a flat map and **cannot wrap a
 * sphere**. `SolidPolygonLayer` tessellates in the coordinate system it is given
 * and does not subdivide for the globe, so those two long edges became straight
 * chords cutting through the planet: the fill ended up inside the sphere, occluded
 * by `GlobeView`'s own opaque backdrop, and the globe rendered black.
 *
 * That was invisible for as long as the ocean was `#060f1b`, which is very nearly
 * the same black. Retuning the palette to a legible navy is what exposed it — the
 * land, drawn from real multi-vertex coastlines, took the new colour while the sea
 * did not.
 *
 * `BitmapLayer` tessellates its `bounds` to the viewport's resolution, so a
 * two-by-two texture of one colour fills either projection correctly from a single
 * layer — provided each view gets its own `bounds` instance, which is what the
 * `projection` option above is for. Keeping one layer list for both views is this
 * file's whole contract; forking the ocean per projection would break it to fix a
 * fill.
 */
function solidTexture(colour: readonly [number, number, number, number]): ImageData {
  const data = new Uint8ClampedArray(2 * 2 * 4);
  for (let texel = 0; texel < 4; texel += 1) {
    data.set([colour[0], colour[1], colour[2], colour[3]], texel * 4);
  }
  return new ImageData(data, 2, 2);
}

/**
 * Expand a one-byte-per-texel darkness field into an RGBA texture in the
 * palette's night colour.
 *
 * Built here rather than in `terminator.ts` because the colour is the theme's and
 * the field is the sun's; keeping them apart means a theme change re-colours the
 * night without recomputing any astronomy.
 *
 * ## Why `ImageData` and not a plain object
 *
 * `BitmapLayer` accepts `image` as an object, and handed
 * `{ data: Uint8Array, width, height }` it produces a texture of **exactly the
 * right dimensions containing nothing at all** — `readDataSyncWebGL` comes back
 * all zeros. The size is read from the object; the pixels are not uploaded. So it
 * renders as a flat transparent-black rectangle and every diagnostic short of a
 * texture readback says the layer is healthy: the mesh is built, the model exists,
 * the texture reports `rgba8unorm 512x256`.
 *
 * `ImageData` is a real image source, so deck.gl uploads it. It also needs no 2D
 * canvas context, which matters because jsdom has `ImageData` but no working
 * `getContext('2d')`.
 */
function nightTexture(
  field: DarknessField,
  night: readonly [number, number, number, number],
): ImageData {
  const data = new Uint8ClampedArray(field.width * field.height * 4);
  // Indexed rather than destructured: `tokens.test.ts` forbids CSS colour names
  // outside the theme file, and `const [red, green, blue] = night` is three of
  // them. The guard is right to be blunt about it — a stray literal is exactly
  // what survives review and then only shows up in the other theme.
  const opacity = night[3];
  for (let texel = 0; texel < field.alpha.length; texel += 1) {
    const offset = texel * 4;
    data[offset] = night[0];
    data[offset + 1] = night[1];
    data[offset + 2] = night[2];
    // The palette's own alpha is the ceiling; the field scales it.
    data[offset + 3] = Math.round((opacity * (field.alpha[texel] ?? 0)) / 255);
  }
  return new ImageData(data, field.width, field.height);
}

/**
 * One projection-agnostic layer list. MapView and GlobeView consume these exact
 * instances; projection switching never forks route, terminator, or toggle logic.
 */
export function createWorldLayers({
  palette,
  quality,
  darkness,
  projection,
  routes,
  visibility,
}: CreateWorldLayersOptions): (Layer | false)[] {
  const bounds = WORLD_BOUNDS[projection];
  return [
    new BitmapLayer({
      id: 'world-ocean',
      bounds,
      image: solidTexture(palette.ocean),
      textureParameters: DATA_TEXTURE_SAMPLER,
      // `cullMode: 'none'`, and this is the second half of the black globe.
      //
      // A world-sized quad wraps the entire sphere, so its near and far halves
      // have *opposite* apparent winding once projected. Back-face culling
      // therefore discards one of them — and when it discards the near one, what
      // is left is the far half, sitting behind `GlobeView`'s own opaque backdrop
      // and rejected by the depth test. Nothing reaches the screen and the planet
      // is black.
      //
      // Culling a flat overlay buys nothing anyway: there is one quad, the depth
      // buffer already hides the far side, and the graticule and route layers have
      // always used `none` — which is exactly why those two kept rendering on the
      // globe while the sea and the shading did not.
      //
      // No `_imageCoordinateSystem`: the fill is one colour, so it samples the same
      // whatever the texture coordinates mean.
      parameters: { cullMode: 'none' },
    }),
    new GeoJsonLayer({
      id: 'world-land',
      data: LAND,
      filled: true,
      stroked: true,
      getFillColor: palette.land,
      getLineColor: palette.landLine,
      lineWidthMinPixels: 0.5,
      parameters: { cullMode: 'back' },
    }),
    visibility.graticule &&
      new PathLayer<GraticulePath>({
        id: 'world-graticule',
        data: GRATICULE,
        getPath: ({ path }) => path,
        getColor: palette.grid,
        getWidth: 1,
        widthUnits: 'pixels',
        parameters: { cullMode: 'none' },
      }),
    visibility.terminator &&
      new BitmapLayer({
        id: 'world-terminator',
        // The whole sphere, once. `BitmapLayer` maps the image's top edge to the
        // northern bound, which is why `createDarknessField` puts +90° in row 0.
        bounds,
        image: nightTexture(darkness, palette.night),
        textureParameters: DATA_TEXTURE_SAMPLER,
        /*
         * The field is sampled on an equirectangular grid — equal degrees of
         * latitude per row — and `BitmapLayer`'s *default* is to interpolate texture
         * coordinates in whatever the viewport uses. On the globe that is already
         * lng/lat, but on the flat map it is **Web Mercator**, which stretches
         * towards the poles. Left on the default, the night boundary sat at the
         * wrong latitude on the flat map, increasingly so away from the equator.
         *
         * Saying `lnglat` tells deck.gl what the image actually is, and its shader
         * converts on the way in.
         */
        _imageCoordinateSystem: 'lnglat',
        // See the ocean layer: a full-sphere quad must not be back-face culled.
        parameters: { cullMode: 'none' },
      }),
    visibility.routes &&
      new ArcLayer<WorldRoute>({
        id: 'world-routes',
        data: routes,
        getSourcePosition: ({ source }) => source,
        getTargetPosition: ({ target }) => target,
        getSourceColor: palette.route,
        getTargetColor: palette.route,
        getWidth: 1.5,
        widthMinPixels: 1,
        widthMaxPixels: 3,
        greatCircle: true,
        numSegments: quality === 'full' ? 100 : 50,
        parameters: { cullMode: 'none' },
      }),
  ];
}
