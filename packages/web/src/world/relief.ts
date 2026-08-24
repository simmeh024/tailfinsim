import equirectRelief from './assets/relief-equirect-2048.webp';
import mercatorRelief from './assets/relief-mercator-2048.webp';

import type { WorldProjection } from './projection';

/**
 * Shaded relief for the world map (App. H.2).
 *
 * ## An overlay, not a basemap
 *
 * The image is **transparent over the sea**, black where a slope is in shadow
 * and white where it catches the light. It is drawn over whatever colour the
 * palette gives the land, so one asset serves both themes and neither can be
 * fought by it — a coloured basemap would have to be authored twice and would
 * still argue with the route arcs on top.
 *
 * Flat ground shades to alpha 0, which composites to exactly the land colour.
 * That is worth knowing before anyone tries to recover a land mask from this
 * file's alpha channel: level desert and open ocean are both fully transparent,
 * and only the polygons say which is which.
 *
 * ## Still no tile service
 *
 * `land.ts` records the standing decision that the renderer contacts no basemap
 * or tile service at runtime, so the world draws without an API key or a third
 * party being up. This keeps it. The relief is a bundled asset from this origin,
 * generated offline by `tools/world/build-relief.py` from Natural Earth's public
 * domain shaded relief, masked by the same land polygons the map already draws —
 * so the shading can never bleed past the coastline on screen.
 *
 * The ceiling that buys is resolution: 2048 x 1024 is about 20 km per pixel at
 * the equator, which is honest at world and continent zoom and visibly soft if
 * you go looking at a city. Tiles are the answer to that, and they are the
 * answer this project has deliberately not taken yet.
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
 * Only the projection in use is ever fetched. These are URLs at module scope,
 * not image data — the bytes arrive when a layer first asks for them.
 */

/** The relief for this projection, as a URL `BitmapLayer` can load. */
export function reliefImage(projection: WorldProjection): string {
  return projection === 'globe' ? equirectRelief : mercatorRelief;
}

/**
 * The shape both images share.
 *
 * Exported so a test can assert the generator, the layer and the bounds have not
 * drifted apart — three places that have to agree about one grid.
 */
export const RELIEF_SIZE = { width: 2048, height: 1024 } as const;
