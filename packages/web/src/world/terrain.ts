import equirectTerrain from './assets/terrain-equirect-2048.webp';
import mercatorTerrain from './assets/terrain-mercator-2048.webp';

import type { WorldProjection } from './projection';

/**
 * The terrain basemap for the world map (App. H.2).
 *
 * ## A colour basemap now, not a neutral overlay
 *
 * This replaced a greyscale hillshade — transparent over the sea, black in
 * shadow and white in the light, drawn over whatever colour the palette gave
 * the land. That was theme-proof and it was also, as a map, almost nothing: a
 * flat plain and a rainforest and a desert all shaded to alpha 0 and came out
 * as one identical blue-grey continent.
 *
 * The image is **cross-blended hypsometric tints with the shaded relief already
 * composited in**, so it carries elevation *and* climate: green in wet
 * lowlands, tan in dry ones, brown and then bare rock and ice with altitude.
 * That blend is the reason it reads as terrain rather than as a coloured height
 * ramp, and it is why this is a raster rather than a gradient over a DEM.
 *
 * ## Still transparent over the sea, and that is deliberate
 *
 * The source raster draws its own ocean. It is masked out, because **the
 * palette owns the sea**: the day/night wash is measured against
 * `--world-ocean`, and so is every contrast pairing in `palette.test.ts`. A
 * basemap that painted its own ocean would silently invalidate all of it and
 * fight both themes at once.
 *
 * Inland water is left as the raster drew it. A lake is inside the land
 * polygon, and a terrain map that paints over the Caspian is the worse map.
 *
 * ## Two images, because the projection is baked in
 *
 * `BitmapLayer` interpolates texture coordinates linearly in whatever the
 * viewport uses — lng/lat on the globe, Web Mercator on the flat map, which
 * stretches towards the poles. `_imageCoordinateSystem: 'lnglat'` is deck.gl's
 * own answer and **this codebase already tried it and reverted it**: on a
 * world-sized quad it wedged the terminator across the equator on the flat map
 * and left hard-edged blocks on the globe.
 *
 * So the warp is done offline, once, exactly as `createDarknessField` does it at
 * runtime for the terminator: one image with equal degrees per row for the
 * globe, one with equal mercator units per row for the flat map, each matching
 * the northern edge `worldBounds` gives its projection.
 *
 * ## Still no tile service
 *
 * `land.ts` records the standing decision that the renderer contacts no basemap
 * or tile service at runtime, so the world draws without an API key or a third
 * party being up. This keeps it: the images are bundled assets from this origin,
 * generated offline by `tools/world/build-terrain.py` from Natural Earth's
 * public-domain raster, masked by the same land polygons the map already draws —
 * so the terrain can never bleed past the coastline on screen.
 *
 * The ceiling that buys is resolution: 2048 x 1024 is about 20 km per pixel at
 * the equator, which is honest at world and continent zoom and visibly soft if
 * you go looking at a city. Tiles are the answer to that, and they are the
 * answer this project has deliberately not taken yet.
 *
 * Only the projection in use is ever fetched. These are URLs at module scope,
 * not image data — the bytes arrive when a layer first asks for them.
 */

/** The terrain basemap for this projection, as a URL `BitmapLayer` can load. */
export function terrainImage(projection: WorldProjection): string {
  return projection === 'globe' ? equirectTerrain : mercatorTerrain;
}

/**
 * The shape both images share.
 *
 * Exported so a test can assert the generator, the layer and the bounds have not
 * drifted apart — three places that have to agree about one grid.
 */
export const TERRAIN_SIZE = { width: 2048, height: 1024 } as const;

/**
 * The mean colour of the land in the shipped asset, measured rather than chosen.
 *
 * `tools/world/build-terrain.py` prints this when it generates the images; it is
 * the alpha-weighted mean over every land texel, which for this raster comes out
 * a pale grey-green. Equirectangular rows are not equal-area, so the poles — and
 * therefore the ice — are over-weighted in it.
 *
 * It exists so the palette can be *tested* rather than eyeballed. The terrain
 * covers the land fill completely when it is on, so `--world-land` stops
 * describing what a reader actually sees, and with it every contrast guarantee
 * that pairs land against the sea. This is the stand-in that lets those
 * guarantees keep being measured: `palette.test.ts` tints it per theme and
 * checks it still separates from the ocean.
 *
 * It is a mean, so it says nothing about the Sahara or the Greenland ice. It is
 * a guard against a retune that sinks the whole basemap into the sea, not a
 * claim about any one pixel.
 */
export const TERRAIN_MEAN_LAND: readonly [number, number, number] = [179, 190, 185];
