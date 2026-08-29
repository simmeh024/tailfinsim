import { BitmapLayer, GeoJsonLayer, PathLayer, ScatterplotLayer } from '@deck.gl/layers';

import { altitudeProfile, greatCirclePath } from './flight';
import { WEB_MERCATOR_MAX_LATITUDE } from './terminator';
import { terrainImage } from './terrain';

import type { BorderGeometry, LandGeometry } from './land';
import type { WorldHub } from './map-api';
import type { WorldPalette } from './palette';
import type { WorldProjection } from './projection';
import type { DarknessField, LngLat } from './terminator';
import type { Layer, UpdateParameters } from '@deck.gl/core';

export type RendererQuality = 'full' | 'reduced';

export interface WorldLayerVisibility {
  graticule: boolean;
  routes: boolean;
  terminator: boolean;
  borders: boolean;
  /** The terrain basemap over the land (App. H.2). */
  terrain: boolean;
  /** Every served airport/city, as dots on the map. */
  airports: boolean;
}

export interface WorldRoute {
  id: string;
  source: LngLat;
  target: LngLat;
}

/** One airport/city a player could serve, as a dot on the world map. */
export interface WorldAirport {
  /** `[longitude, latitude]`. */
  position: LngLat;
  name: string;
  /** ICAO ident — the key a click uses to find a route through this airport. */
  icao: string;
  /** App. B.3 tier — flagship, large, medium, small, regional — sets the dot's size. */
  tier: string;
}

/** Dot radius in pixels by tier — a flagship hub reads larger than a regional field. */
function airportRadius(tier: string): number {
  switch (tier) {
    case 'flagship':
      return 8;
    case 'large':
      return 6.5;
    case 'medium':
      return 5.5;
    case 'small':
      return 4.5;
    default:
      return 4;
  }
}

export interface CreateWorldLayersOptions {
  palette: WorldPalette;
  quality: RendererQuality;
  routes: readonly WorldRoute[];
  airports: readonly WorldAirport[];
  hubs: readonly WorldHub[];
  /**
   * ICAOs of the airports the player's fleet can reach from a hub, for the map's
   * highlight. When given, an out-of-range airport is drawn dimmer, so the ones a
   * plane could actually fly to stand out. Undefined leaves every airport at full
   * strength (the pre-fleet map, and the tests).
   */
  reachableIcaos?: ReadonlySet<string>;
  /** Called when a served airport is clicked, so the page can open its route panel. */
  onAirportClick?: (airport: WorldAirport) => void;
  darkness: DarknessField;
  /**
   * The coastline outline to draw.
   *
   * Passed in rather than imported, because which tier is in hand depends on how
   * far the camera has zoomed and whether the finer chunk has arrived — see
   * `land.ts`. The layer list has no opinion about it.
   */
  land: LandGeometry;
  /**
   * The country borders, sharing the coastline's arcs.
   *
   * A separate geometry from `land` and not a styling of it: the borders are the
   * arcs *between* two countries, which is a different set of lines from the
   * outline of the landmass. `land.ts` explains how the two are cut from one file.
   */
  borders: BorderGeometry;
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
   * `resolution` — absent on `MapView`, so a flat two-triangle quad; a fixed number
   * of degrees on `GlobeView`, so a mesh that follows the sphere. Hand both views
   * one frozen constant and the quad built for the flat map survives the switch:
   * two triangles cutting straight through the planet, ending up inside it and
   * occluded by `GlobeView`'s own opaque backdrop.
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
 * West, south, east, north — the whole sphere, one array per mesh shape.
 *
 * Several arrays with identical values, deliberately. `BitmapLayer` rebuilds its
 * mesh only when `bounds` changes by **reference**, and the mesh it builds depends
 * on the viewport's `resolution`: absent on `MapView`, so a flat two-triangle
 * quad; a fixed number of degrees on `GlobeView`, so a sphere-following grid.
 *
 * So the key is everything that changes the tessellation — the projection **and**
 * the quality tier, because a drop to reduced quality coarsens the globe's
 * resolution. Keyed on projection alone, a full-to-reduced switch left the fine
 * mesh in place and the coarsening silently did nothing.
 */
const WORLD_BOUNDS = new Map<string, [number, number, number, number]>();

/**
 * The rectangle the world-sized bitmaps cover, per projection.
 *
 * Two different rectangles, and that is the fix for the day/night wedge. Web
 * Mercator runs to infinity at the poles, so a flat-map quad cannot be given
 * `±90` — the sheet stops at {@link WEB_MERCATOR_MAX_LATITUDE}, and so does the
 * bitmap that covers it. The globe has no such limit and uses the whole sphere.
 *
 * The darkness field is generated to match: `createDarknessField`'s `spacing`
 * decides both the row distribution and the `northLatitude` these bounds have to
 * agree with. Change one without the other and the terminator lands at the wrong
 * latitude again.
 */
function worldBounds(projection: WorldProjection, quality: RendererQuality) {
  const key = `${projection}:${quality}`;
  let bounds = WORLD_BOUNDS.get(key);
  if (bounds === undefined) {
    const north = projection === 'globe' ? 90 : WEB_MERCATOR_MAX_LATITUDE;
    bounds = [-180, -north, 180, north];
    WORLD_BOUNDS.set(key, bounds);
  }
  return bounds;
}

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
 * Depth bias that keeps the day/night wash in front of the land it shades.
 *
 * **This is the fix for the angular patches of undimmed land.** The terminator is
 * a quad tessellated to the sphere, so it sits essentially *on* the surface. The
 * land is a `GeoJsonLayer` fill, and `SolidPolygonLayer` does not subdivide for
 * the globe: earcut joins distant coastline vertices, so a single triangle can
 * span nearly three degrees and its flat interior chords **below** the sphere by
 * up to about two kilometres, while the small triangles near a coastline hug it.
 *
 * Land therefore crosses the terminator's depth in patches — in front of it near
 * the coast, behind it inland — and the shading was being depth-rejected exactly
 * where the land happened to be nearer. What that draws is straight-edged
 * facets of *undimmed* land, following the triangulation rather than any
 * geography, appearing only once zoomed in far enough for a couple of kilometres
 * of chord sag to matter. Measured across one such patch: a clean alpha ramp
 * either side, and a flat zero across the facet.
 *
 * deck.gl's default offset is `-layerIndex * 100`, which gives the terminator
 * only a few hundred units over the land and is not enough. This is deliberately
 * far larger than the gap needs, because the sag depends on the coastline's
 * triangulation and nothing bounds it usefully.
 *
 * It is safe against the far side of the globe: the offset is uniform, so the
 * near and far halves keep their order and the far half stays hidden. Turning the
 * depth test off instead also clears the patches, and is **wrong** — both halves
 * then composite, and the day side comes out darkened by its own antipode.
 */
const TERMINATOR_POLYGON_OFFSET = (): [number, number] => [0, -20000];

/**
 * Depth bias that lifts the route/airport/hub overlay in front of the surface it
 * sits on.
 *
 * **This is why the markers vanished at the whole-globe zoom.** An airport dot and
 * a hub sit *on* the sphere, at the same depth as the ocean fill and the terrain
 * that cover it. Coincident depth is a coin toss the surface wins, and it wins most
 * at the far-out zoom where the depth buffer's precision near the surface is
 * coarsest — so the dots were being depth-rejected there while the same dots showed
 * once the camera came close. The grid and borders survived because deck.gl's
 * default per-layer offset was just enough for thin lines and not for a disk.
 *
 * The fix is the terminator's: a uniform negative offset pulls the whole overlay a
 * hair towards the camera, clearing the surface at every zoom. Uniform, so the near
 * and far hemispheres keep their order and the far side stays hidden behind the
 * globe rather than showing through it — the reason this is an offset and not
 * `depthTest: false`.
 */
const OVERLAY_POLYGON_OFFSET = (): [number, number] => [0, -60000];

/**
 * A `BitmapLayer` that rebuilds its mesh when the viewport that draws it changes.
 *
 * **This is what keeps the globe from going black after a projection switch.**
 *
 * `BitmapLayer.updateState` builds its mesh only when `props.bounds` changes by
 * reference, and `createMesh(bounds, viewport.resolution)` reads the resolution
 * from whatever viewport is in context *at that moment*. On a projection switch
 * the view and the layers change in the same React render, and deck.gl updates
 * layers **before** it activates the new viewport — so the mesh for the globe was
 * being built against the flat map's viewport, which has no `resolution` at all.
 *
 * The result is the two-triangle quad a flat map wants. On a sphere those two
 * triangles are a chord straight through the planet, occluded by `GlobeView`'s own
 * backdrop, and the ocean and the day/night shading both render black. Measured on
 * the deployed build after switching flat to globe: viewport `resolution: 2`,
 * correct `bounds`, and a mesh of **six indices**.
 *
 * A fresh page load never hit it, because there the globe viewport is in context
 * from the first update — which is exactly why it survived being looked at.
 *
 * Giving each projection its own `bounds` instance is still necessary and is not
 * sufficient: it makes the base class rebuild, but on the frame where the viewport
 * is still the old one. So the resolution the mesh was actually built at is
 * recorded, and any update that finds the viewport disagreeing forces the base
 * class down the same rebuilding branch by presenting it with a changed `bounds`.
 * `shouldUpdateState` opts in to viewport changes, which a `BitmapLayer` otherwise
 * ignores.
 */
class WorldBitmapLayer extends BitmapLayer {
  static override layerName = 'WorldBitmapLayer';

  /** `undefined` on `MapView`, the degrees-per-vertex figure on `_GlobeView`. */
  private get meshResolution(): number {
    return (this.context.viewport as { resolution?: number }).resolution ?? 0;
  }

  override shouldUpdateState(params: UpdateParameters<this>): boolean {
    return super.shouldUpdateState(params) || params.changeFlags.viewportChanged;
  }

  override updateState(params: UpdateParameters<this>): void {
    const resolution = this.meshResolution;
    if (resolution !== (this.state as { meshResolution?: number }).meshResolution) {
      // The base class rebuilds when `props.bounds !== oldProps.bounds`, so this
      // is the public surface for saying "the mesh you have is for another view".
      (params as { oldProps: unknown }).oldProps = { ...params.oldProps, bounds: undefined };
      this.setState({ meshResolution: resolution });
    }
    super.updateState(params);
  }
}

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
  land,
  borders,
  projection,
  routes,
  airports,
  hubs,
  reachableIcaos,
  onAirportClick,
  visibility,
}: CreateWorldLayersOptions): (Layer | false)[] {
  const bounds = worldBounds(projection, quality);
  // An out-of-range airport keeps its colour but fades back, so the field the fleet
  // can actually reach reads as the foreground. Full strength when no reach set is
  // given (before an airline exists, and in the layer tests).
  const dimmed = palette.airport.map((c, i) => (i === 3 ? Math.round(c * 0.55) : c)) as [
    number,
    number,
    number,
    number,
  ];
  const airportFill = (airport: WorldAirport): [number, number, number, number] =>
    reachableIcaos === undefined || reachableIcaos.has(airport.icao) ? palette.airport : dimmed;

  // A FlightRadar-style altitude wash for the route line: warm and low near the
  // airports, cool and high across the cruise. Interpolated between two existing
  // palette tokens — the amber airport colour for the ground, the route blue for
  // altitude — so it stays theme-aware with no colour literal here. The ramp is by
  // fraction along the leg, identical for every route, so it is built once and the
  // path layer hands the same per-vertex array to each line.
  const routeSegments = quality === 'full' ? 64 : 32;
  const lowAltitude = palette.airport;
  const highAltitude = palette.route;
  const routeColors: [number, number, number, number][] = [];
  for (let i = 0; i <= routeSegments; i += 1) {
    const climb = altitudeProfile(i / routeSegments);
    routeColors.push([
      Math.round(lowAltitude[0] + (highAltitude[0] - lowAltitude[0]) * climb),
      Math.round(lowAltitude[1] + (highAltitude[1] - lowAltitude[1]) * climb),
      Math.round(lowAltitude[2] + (highAltitude[2] - lowAltitude[2]) * climb),
      255,
    ]);
  }
  return [
    new WorldBitmapLayer({
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
      data: land,
      /*
       * **Not filled while the terrain is on, and this is what removes the pale
       * halo around every coastline.**
       *
       * The fill is a vector polygon, tessellated and drawn by the GPU at screen
       * resolution. The terrain is a raster whose alpha edge is a texel wide. So
       * the polygon's edge sits *outside* the point where the image becomes
       * opaque, by up to one texel — and at any zoom past a texel-per-pixel that
       * sliver is several screen pixels of `--world-land`, which in the dark
       * theme is a pale blue. It reads as a deliberate coastal shelf. Small
       * islands, where the raster carries only partial alpha, came out as pale
       * blobs entirely.
       *
       * Painting nothing there instead lets the image's own alpha ramp blend
       * into the ocean, which is what antialiasing a coastline is supposed to
       * look like. Nothing is lost: the basemap is opaque across the land it
       * covers, so the fill was only ever visible in the sliver where it did
       * not.
       *
       * The stroke stays either way — it is the coastline, and it is what still
       * outlines an island the raster is too coarse to resolve.
       */
      filled: !visibility.terrain,
      stroked: true,
      getFillColor: palette.land,
      getLineColor: palette.landLine,
      lineWidthMinPixels: 0.5,
      parameters: { cullMode: 'back' },
    }),
    visibility.terrain &&
      new WorldBitmapLayer({
        id: 'world-terrain',
        // The same world-sized quad the ocean and terminator use.
        bounds,
        /*
         * Above the land fill and below the borders.
         *
         * Over the fill because it *replaces* it: the basemap is opaque across
         * every land texel, so the land layer beneath is reduced to the thing
         * that draws the coastline and the thing that shows through at whatever
         * opacity the theme asks for. Under the borders because a country line
         * has to stay crisp over a busy image — putting the terrain on top would
         * bury the one line on the map that carries information.
         */
        image: terrainImage(projection),
        /*
         * **No `textureParameters` here, and that is the opposite of what the
         * ocean and the terminator need.**
         *
         * Those two are data textures built from typed arrays: one mip level and
         * no chain, so `DATA_TEXTURE_SAMPLER` has to turn mipmap filtering off or
         * the driver treats them as incomplete and samples them as opaque black.
         * See the note on that constant — it cost a black sea to find.
         *
         * This one is a URL. deck.gl allocates `getMipLevelCount(width, height)`
         * levels for an image source and calls `generateMipmapsWebGL`, and its
         * default sampler is trilinear, so the layer gets a full mip chain for
         * free. That is what makes a 4096-wide basemap safe: the whole-globe view
         * minifies it by a factor of eight, and without the chain that is not a
         * soft image but a shimmering one. Copying the data-texture sampler onto
         * this layer would silently take that away.
         */
        /*
         * Tint and opacity, from the theme rather than from the asset.
         *
         * One image serves both themes, which is only possible because the
         * palette gets to pull it towards its own ground: `tintColor` multiplies
         * the texels and `opacity` blends what is left over the land fill. The
         * light theme needs that badly — untinted, this raster is *lighter than
         * that theme's ocean*, and the coastline disappears. See
         * `--world-terrain` in `tokens.css`.
         */
        tintColor: [palette.terrain[0], palette.terrain[1], palette.terrain[2]],
        opacity: palette.terrain[3] / 255,
        /*
         * No `_imageCoordinateSystem`, for the reason the terminator gives at
         * length below: it is deck.gl's own answer to exactly this and it does
         * not survive a quad this size. The warp is baked into the asset instead
         * — one image per projection, each matching the bounds its projection is
         * given.
         */
        // See the ocean layer: a full-sphere quad must not be back-face culled.
        parameters: { cullMode: 'none' },
      }),
    /*
     * Country borders, over the land fill and under everything else.
     *
     * A `GeoJsonLayer` rather than a `PathLayer`, because `mesh` hands back one
     * `MultiLineString` and `GeoJsonLayer` is the layer that knows how to walk a
     * GeoJSON geometry into paths. It draws nothing but lines here — the geometry
     * has no rings, so `filled` never applies.
     *
     * Thinner than the coastline on purpose. A border and a coastline at the same
     * weight makes a continent read as a mesh of equal cells, and the coastline is
     * the one that says where the land stops.
     */
    visibility.borders &&
      new GeoJsonLayer({
        id: 'world-borders',
        data: borders,
        stroked: true,
        filled: false,
        getLineColor: palette.border,
        lineWidthMinPixels: 0.5,
        lineWidthMaxPixels: 1,
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
      new WorldBitmapLayer({
        id: 'world-terminator',
        // The whole sphere, once. `BitmapLayer` maps the image's top edge to the
        // northern bound, which is why `createDarknessField` puts +90° in row 0.
        bounds,
        image: nightTexture(darkness, palette.night),
        textureParameters: DATA_TEXTURE_SAMPLER,
        /*
         * No `_imageCoordinateSystem`, deliberately.
         *
         * `BitmapLayer` interpolates texture coordinates linearly in whatever the
         * viewport uses — lng/lat on the globe, **Web Mercator** on the flat map,
         * which stretches towards the poles. So the field is generated the same
         * way for each: `createDarknessField`'s `spacing` puts equal degrees per
         * row for the globe and equal mercator units per row for the flat map, and
         * `worldBounds` gives each the matching northern edge. The mapping is then
         * exactly linear in both, and there is nothing to convert.
         *
         * `_imageCoordinateSystem: 'lnglat'` is deck.gl's own answer to this and it
         * was here until it was looked at on a real deploy: on the flat map, with a
         * world-sized quad, it squashed the whole field into a tapering horizontal
         * wedge across the equator, and on the globe it left hard-edged blocks of
         * full night across land that was in daylight. Its shader path is not built
         * for a quad this size.
         */
        // See the ocean layer: a full-sphere quad must not be back-face culled.
        parameters: { cullMode: 'none' },
        getPolygonOffset: TERMINATOR_POLYGON_OFFSET,
      }),
    visibility.routes &&
      new PathLayer<WorldRoute>({
        id: 'world-routes',
        data: routes,
        // A flat great-circle line on the surface, not an `ArcLayer` rainbow lifted
        // into 3D: this is the FlightRadar look — a route that bends north or south
        // the way a real track does while staying on the ground. The plane rides the
        // same curve, since both come from `greatCirclePath`/`interpolateGreatCircle`.
        getPath: ({ source, target }) => greatCirclePath(source, target, routeSegments),
        // Per-vertex colour: the altitude wash, one colour per point of the path.
        // The array matches the path's `routeSegments + 1` points and is the same
        // for every route, so PathLayer gradients each line without a per-route cost.
        getColor: () => routeColors,
        // The player's own routes, so drawn boldly — thicker than the airport rings,
        // and with a floor so a line never thins to nothing on the globe.
        getWidth: 3,
        widthUnits: 'pixels',
        widthMinPixels: 2.5,
        widthMaxPixels: 7,
        capRounded: true,
        jointRounded: true,
        parameters: { cullMode: 'none' },
        getPolygonOffset: OVERLAY_POLYGON_OFFSET,
      }),
    visibility.airports &&
      new ScatterplotLayer<WorldAirport>({
        id: 'world-airports',
        data: airports,
        getPosition: ({ position }) => position,
        getRadius: ({ tier }) => airportRadius(tier),
        radiusUnits: 'pixels',
        // A firm floor so the dots stay findable even at the whole-globe zoom, where
        // a tier-scaled radius would otherwise shrink them to nothing.
        radiusMinPixels: 5,
        radiusMaxPixels: 18,
        // A plain array while nothing is highlighted (the pre-fleet map and the
        // tests); a per-airport accessor once a reachable set fades the rest back.
        getFillColor: reachableIcaos === undefined ? palette.airport : airportFill,
        // Re-evaluate the fill when the reachable set changes (a new plane, a new hub).
        updateTriggers: { getFillColor: reachableIcaos },
        // Billboarded so each dot faces the camera at a steady pixel size on the
        // globe, and lifted off the surface so it is not depth-rejected by the
        // terrain at the far-out zoom (see OVERLAY_POLYGON_OFFSET).
        billboard: true,
        getPolygonOffset: OVERLAY_POLYGON_OFFSET,
        // A dark ring so a bright dot still reads where it sits on pale terrain, not
        // just against the ocean. One draw call for the whole field.
        stroked: true,
        getLineColor: palette.night,
        lineWidthUnits: 'pixels',
        getLineWidth: 1.25,
        lineWidthMinPixels: 1,
        lineWidthMaxPixels: 2.5,
        // Clickable so the page can open a route panel; a fatter pick radius makes
        // the small dots easy to hit without changing how they look.
        pickable: onAirportClick !== undefined,
        radiusScale: 1,
        onClick: onAirportClick
          ? (info) => {
              if (info.object) onAirportClick(info.object as WorldAirport);
              return true;
            }
          : undefined,
        parameters: { cullMode: 'none' },
      }),
    // The player's hubs, on top of the airport field: larger, and ringed so a base
    // reads differently from a city it merely serves.
    hubs.length > 0 &&
      new ScatterplotLayer<WorldHub>({
        id: 'world-hubs',
        data: hubs,
        getPosition: ({ position }) => position,
        getRadius: 11,
        radiusUnits: 'pixels',
        radiusMinPixels: 8,
        radiusMaxPixels: 22,
        getFillColor: palette.airport,
        stroked: true,
        getLineColor: palette.route,
        lineWidthUnits: 'pixels',
        getLineWidth: 2.5,
        lineWidthMinPixels: 2,
        // Same as the airports: face the camera and clear the surface depth so a hub
        // is never swallowed by the terrain at the whole-globe zoom.
        billboard: true,
        getPolygonOffset: OVERLAY_POLYGON_OFFSET,
        parameters: { cullMode: 'none' },
      }),
  ];
}
