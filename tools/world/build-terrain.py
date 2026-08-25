"""Build the world terrain basemap from Natural Earth's cross-blended hypso raster.

Output is a **colour basemap for the land**, not the neutral hillshade overlay
this file replaced. Cross-blended hypsometric tints carry elevation *and*
climate -- green in wet lowlands, tan in dry ones, brown and then bare rock with
altitude -- which is the difference between a terrain map and an elevation ramp,
and the reason a raster is worth its bytes when a colour ramp over a DEM is not.

`HYP_50M_SR_W` already has the shaded relief composited into it, so the separate
greyscale hillshade the renderer used to draw is redundant; there is one image
where there were two.

Three things this has to get right.

**The sea has to be masked, and the raster's own water cannot do it.** The
palette owns the ocean -- the day/night wash is measured against it and so is
every contrast test in `palette.test.ts` -- so the basemap stops at the
coastline. The mask comes from the same Natural Earth land polygons the app
bundles and draws, which also means the terrain can never bleed past the
coastline on screen. Inland water is left as the raster drew it: a lake is part
of the land polygon, and a terrain map that paints over the Caspian is worse.

**The mask is supersampled and the colour is area-averaged.** A hard 1-bit mask
puts a stair-step on every coast, and picking one source row per output row
aliases a 10800 px raster into speckle. So the mask is rasterised at 4x and
boxed down, each vertex lands at a *fractional* row rather than snapping to a
scanline, and each output row averages the source rows it actually spans.

**The projection has to be baked in.** `BitmapLayer` interpolates texture
coordinates linearly in whatever the viewport uses, and
`_imageCoordinateSystem: 'lnglat'` is deck.gl's answer to that -- one this
codebase already tried and reverted, because on a world-sized quad it wedges the
flat map and blocks the globe. The terminator solves it by generating its rows
to match the projection; this does the same, offline: an equirectangular image
for the globe and a mercator-warped one for the flat map.

Usage:

    python tools/world/build-terrain.py SOURCE.tif LAND.json OUTDIR [width]

The source raster is public domain, fetched at build time from
https://naciscdn.org/naturalearth/50m/raster/HYP_50M_SR_W.zip and never
committed; only the two derived images are.
"""

import json
import math
import os
import sys

from PIL import Image, ImageDraw

Image.MAX_IMAGE_PIXELS = None

HEIGHT_OF = lambda w: w // 2
# Web Mercator's usable limit, and the value `worldBounds` already uses.
MAX_MERCATOR_LAT = 85.051129

# The mask is rasterised at this multiple of the output and boxed down, so a
# coastline arrives as a soft alpha edge rather than a stair-step.
#
# **4x rather than 2x, because 2x is not enough and it shows.** A 2x2 box can
# only produce five alpha levels -- 0, 63, 127, 191, 255 -- so a coastline
# running at a shallow angle still lands as a visible staircase with a slightly
# soft nose on each step. 4x4 gives seventeen levels, which is the difference
# between an edge that reads as a line and one that reads as pixels. Measured on
# the western Mediterranean: 506 partially-transparent texels at 2x against
# roughly four times that at 4x, spread over the same coastline.
MASK_SUPERSAMPLE = 4

# WebP settings. The alpha channel is the coastline, so it is kept near-lossless
# while the colour is allowed to compress: a smeared coast is visible at a glance
# and a smeared hillshade is not.
WEBP_QUALITY = 82
WEBP_ALPHA_QUALITY = 100


def decode_topology(path):
    """TopoJSON arcs -> lon/lat rings. Quantised deltas, undone."""
    topo = json.load(open(path, encoding='utf-8'))
    tr = topo.get('transform')
    sx, sy = (tr['scale'] if tr else (1, 1))
    tx, ty = (tr['translate'] if tr else (0, 0))

    arcs = []
    for arc in topo['arcs']:
        x = y = 0
        points = []
        for dx, dy in arc:
            x += dx
            y += dy
            points.append((x * sx + tx, y * sy + ty) if tr else (x, y))
        arcs.append(points)

    def ring(indices):
        out = []
        for i in indices:
            a = arcs[~i][::-1] if i < 0 else arcs[i]
            out.extend(a[1:] if out else a)
        return out

    def polygons(geom):
        kind = geom['type']
        if kind == 'Polygon':
            yield [ring(r) for r in geom['arcs']]
        elif kind == 'MultiPolygon':
            for poly in geom['arcs']:
                yield [ring(r) for r in poly]
        elif kind == 'GeometryCollection':
            for child in geom['geometries']:
                yield from polygons(child)

    obj = topo['objects'].get('land') or next(iter(topo['objects'].values()))
    return list(polygons(obj))


def unwrap_ring(ring):
    """Undo the antimeridian jumps in one ring, then put it back in range.

    The same correction `land.ts` applies to the geometry the app draws, and it
    is needed here for the same reason: both tiers store longitudes in
    [-180, 180], so a ring crossing the antimeridian has two consecutive
    vertices like 179.99 and -180. Neighbours on a sphere, 360 degrees apart in
    the pixel space this rasterises into -- so `draw.polygon` runs an edge the
    entire way across the image.

    Left uncorrected that is not a hairline. Chukotka jumps twice, at 65N and
    69N, and fills a **full-width band of alpha across the Arctic**; Fiji does
    the same at 17S. Both were plainly visible in the first generated asset, as
    a pale strip lying over open ocean where the mask had no business being.

    The carry is then recentred by whole worlds -- exactly as `land.ts` does,
    and for the same reason: the offset starts at zero on the ring's *first*
    vertex, so Afro-Eurasia, whose outline begins just west of the antimeridian,
    otherwise ends up a whole world to the west. A ring that legitimately
    straddles the seam has a midpoint of about 180 and must stay where it is,
    which is why only a midpoint outside the range moves.
    """
    offset = 0.0
    out = []
    for index, (lon, lat) in enumerate(ring):
        if index > 0:
            delta = lon + offset - out[index - 1][0]
            if delta > 180:
                offset -= 360
            elif delta < -180:
                offset += 360
        out.append((lon + offset, lat))

    lons = [lon for lon, _ in out]
    midpoint = (min(lons) + max(lons)) / 2.0
    if midpoint > 180:
        shift = -360 * math.ceil((midpoint - 180) / 360)
    elif midpoint < -180:
        shift = 360 * math.ceil((-180 - midpoint) / 360)
    else:
        shift = 0
    return [(lon + shift, lat) for lon, lat in out] if shift else out


def land_mask(polys, width, height, lat_of_row):
    """255 over land, 0 over sea, at this projection's row spacing."""
    mask = Image.new('L', (width, height), 0)
    draw = ImageDraw.Draw(mask)

    # A row -> latitude table, inverted once into latitude -> row so the polygon
    # fill can stay a simple pixel-space operation.
    lats = [lat_of_row(y) for y in range(height)]

    def to_px(lon, lat):
        x = (lon + 180.0) / 360.0 * width
        # Binary search the row table: it is monotonically decreasing.
        lo, hi = 0, height - 1
        while lo < hi:
            mid = (lo + hi) // 2
            if lats[mid] > lat:
                lo = mid + 1
            else:
                hi = mid
        # **Interpolated between the two rows, not snapped to one.** Returning
        # the row index alone quantises every vertex's latitude to a whole
        # scanline *before* the supersampled grid gets to smooth anything, so
        # the polygon being rasterised is already a staircase and no amount of
        # supersampling recovers the coastline that was thrown away. Longitude
        # never had this problem, which is why the artefact reads as horizontal
        # steps rather than as general roughness.
        if lo == 0:
            return (x, 0.0)
        upper, lower = lats[lo - 1], lats[lo]
        span = upper - lower
        return (x, (lo - 1) + (0.0 if span <= 0 else (upper - lat) / span))

    for rings in polys:
        for index, ring in enumerate(rings):
            if len(ring) < 3:
                continue
            pts = [to_px(lon, lat) for lon, lat in unwrap_ring(ring)]
            # Ring 0 is the outer boundary; the rest are holes (inland seas).
            fill = 255 if index == 0 else 0
            # An unwrapped ring may legitimately run past the seam -- 179.99 to
            # 180.01 rather than back to -179.99 -- so the part beyond the edge
            # is painted by the neighbouring world copy. The image is periodic
            # in x; PIL clips whatever falls outside it.
            for dx in (-width, 0, width):
                draw.polygon([(x + dx, y) for x, y in pts], fill=fill)
    return mask


def antialiased_land_mask(polys, width, height, lat_edge):
    """The land mask, rasterised large and boxed down to a soft alpha edge."""
    scale = MASK_SUPERSAMPLE
    tall = height * scale

    # Row centres at the supersampled height, from the same edge function, so the
    # fine mask describes exactly the rows the coarse one will.
    def centre(y):
        return (lat_edge(y, tall) + lat_edge(y + 1, tall)) / 2.0

    fine = land_mask(polys, width * scale, tall, centre)
    return fine.resize((width, height), Image.BOX)


def sample_rows(source, width, height, lat_edge):
    """Resample the equirectangular source onto this projection's rows.

    Longitude is linear in both projections, so the horizontal reduction happens
    once for the whole image. Only the rows move, and each output row is the
    **area average of the source rows it spans** -- which at the equator of the
    mercator warp is about ten of them, and near the usable pole is one.
    """
    scaled = source.resize((width, source.height), Image.LANCZOS)
    out = Image.new('RGB', (width, height))
    rows = source.height

    def row_of(lat):
        return (90.0 - lat) / 180.0 * rows

    for y in range(height):
        top = max(0, min(rows - 1, int(math.floor(row_of(lat_edge(y, height))))))
        bottom = max(top + 1, min(rows, int(math.ceil(row_of(lat_edge(y + 1, height))))))
        strip = scaled.crop((0, top, width, bottom))
        out.paste(strip.resize((width, 1), Image.BOX), (0, y))
    return out


def mean_land_colour(colour, mask):
    """The alpha-weighted mean of the land, for `TERRAIN_MEAN_LAND`.

    The terrain hides the land fill when it is on, so `--world-land` stops
    describing what a reader sees and every contrast pairing measured against it
    stops meaning anything. `palette.test.ts` needs *some* honest stand-in for
    "what colour the land is now", and this is it: measured off the shipped
    image rather than picked to make a test pass.

    Equirectangular rows are not equal-area, so the mean over-weights the poles
    -- which here means the ice. Left as it is, and said out loud, because the
    number is a floor for a contrast guard rather than a colorimetric claim.
    """
    px, mx = colour.load(), mask.load()
    totals = [0, 0, 0]
    weight = 0
    for y in range(colour.height):
        for x in range(colour.width):
            a = mx[x, y]
            if not a:
                continue
            r, g, b = px[x, y]
            totals[0] += r * a
            totals[1] += g * a
            totals[2] += b * a
            weight += a
    if not weight:
        return (0, 0, 0)
    return tuple(round(t / weight) for t in totals)


def mercator_lat_edge(y, height):
    """Row boundary -> latitude, equal mercator units per row."""
    top = math.log(math.tan(math.pi / 4 + math.radians(MAX_MERCATOR_LAT) / 2))
    t = top - (2 * top) * (y / height)
    return math.degrees(2 * math.atan(math.exp(t)) - math.pi / 2)


def equirect_lat_edge(y, height):
    """Row boundary -> latitude, equal degrees per row."""
    return 90.0 - 180.0 * (y / height)


def main():
    src, land, out_dir = sys.argv[1], sys.argv[2], sys.argv[3]
    width = int(sys.argv[4]) if len(sys.argv) > 4 else 4096
    height = HEIGHT_OF(width)
    os.makedirs(out_dir, exist_ok=True)

    print(f'reading {os.path.basename(src)} ...')
    source = Image.open(src).convert('RGB')
    print(f'  {source.size[0]}x{source.size[1]}')

    print('decoding land polygons ...')
    polys = decode_topology(land)
    print(f'  {len(polys)} polygons')

    for name, lat_edge in (
        ('equirect', equirect_lat_edge),
        ('mercator', mercator_lat_edge),
    ):
        print(f'{name}: sampling ...')
        colour = sample_rows(source, width, height, lat_edge)
        print(f'{name}: masking ...')
        mask = antialiased_land_mask(polys, width, height, lat_edge)
        print(f'{name}: compositing ...')
        rgba = colour.convert('RGBA')
        rgba.putalpha(mask)
        path = os.path.join(out_dir, f'terrain-{name}-{width}.webp')
        rgba.save(
            path,
            'WEBP',
            quality=WEBP_QUALITY,
            alpha_quality=WEBP_ALPHA_QUALITY,
            method=6,
        )
        print(f'  -> {path}  {os.path.getsize(path) / 1024:.0f} KB')
        if name == 'equirect':
            # The globe's image is the one measured: its rows are equal degrees,
            # so it is the less distorted of the two. `TERRAIN_MEAN_LAND` in
            # `terrain.ts` carries this value.
            print(f'  TERRAIN_MEAN_LAND = {list(mean_land_colour(colour, mask))}')


if __name__ == '__main__':
    main()
