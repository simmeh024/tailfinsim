import { ArcLayer, GeoJsonLayer, PathLayer, SolidPolygonLayer } from '@deck.gl/layers';
import { feature } from 'topojson-client';
import landTopologyJson from 'world-atlas/land-110m.json';

import type { WorldPalette } from './palette';
import type { LngLat, TerminatorCell } from './terminator';
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
  terminatorCells: readonly TerminatorCell[];
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

/**
 * One projection-agnostic layer list. MapView and GlobeView consume these exact
 * instances; projection switching never forks route, terminator, or toggle logic.
 */
export function createWorldLayers({
  palette,
  quality,
  routes,
  terminatorCells,
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
      new SolidPolygonLayer<TerminatorCell>({
        id: 'world-terminator',
        data: terminatorCells,
        getPolygon: ({ polygon }) => polygon,
        getFillColor: ({ darkness }) => [
          palette.night[0],
          palette.night[1],
          palette.night[2],
          Math.round(palette.night[3] * darkness),
        ],
        parameters: { cullMode: 'back' },
        updateTriggers: { getFillColor: palette.night },
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
