import { ArcLayer, BitmapLayer, GeoJsonLayer, PathLayer, SolidPolygonLayer } from '@deck.gl/layers';
import { feature } from 'topojson-client';
import landTopologyJson from 'world-atlas/land-110m.json';

import type { WorldPalette } from './palette';
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
}

interface GraticulePath {
  id: string;
  path: LngLat[];
}

const topology = landTopologyJson as unknown as Topology<{ land: GeometryCollection }>;
const LAND = feature(topology, topology.objects.land);

const OCEAN: LngLat[][] = [
  [
    [-180, 90],
    [0, 90],
    [180, 90],
    [180, -90],
    [0, -90],
    [-180, -90],
  ],
];

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

/** West, south, east, north — the whole sphere, for the night texture. */
const WORLD_BOUNDS: [number, number, number, number] = [-180, -90, 180, 90];

/**
 * Expand a one-byte-per-texel darkness field into an RGBA texture in the
 * palette's night colour.
 *
 * Built here rather than in `terminator.ts` because the colour is the theme's and
 * the field is the sun's; keeping them apart means a theme change re-colours the
 * night without recomputing any astronomy.
 *
 * The shape matters. luma.gl wants `data` flat with `width` and `height` beside
 * it — handed `{ data: { data, width, height } }` it silently produces a 1x1
 * texture, which renders as a single flat wash over the entire world and looks
 * like a palette bug rather than a shape bug.
 */
function nightTexture(
  field: DarknessField,
  night: readonly [number, number, number, number],
): { data: Uint8Array; width: number; height: number } {
  const data = new Uint8Array(field.width * field.height * 4);
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
  return { data, width: field.width, height: field.height };
}

/**
 * One projection-agnostic layer list. MapView and GlobeView consume these exact
 * instances; projection switching never forks route, terminator, or toggle logic.
 */
export function createWorldLayers({
  palette,
  quality,
  darkness,
  routes,
  visibility,
}: CreateWorldLayersOptions): (Layer | false)[] {
  return [
    new SolidPolygonLayer<LngLat[]>({
      id: 'world-ocean',
      data: OCEAN,
      getPolygon: (polygon) => polygon,
      getFillColor: palette.ocean,
      parameters: { cullMode: 'back' },
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
        bounds: WORLD_BOUNDS,
        image: nightTexture(darkness, palette.night),
        // Linear filtering is the entire point: it is what turns a sampled field
        // into a smooth gradient instead of the staircase 5-degree flat-shaded
        // cells produced. Clamped rather than repeated, so the poles do not
        // sample across to the opposite pole.
        textureParameters: {
          minFilter: 'linear',
          magFilter: 'linear',
          addressModeU: 'clamp-to-edge',
          addressModeV: 'clamp-to-edge',
        },
        parameters: { cullMode: 'back' },
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
