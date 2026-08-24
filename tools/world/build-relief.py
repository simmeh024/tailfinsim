"""Build the world relief overlay from Natural Earth's shaded relief.

Output is an RGBA overlay, not a picture of the world: transparent over the sea,
black where a slope is in shadow and white where it catches the light. It is
drawn *over* whatever colour the palette gives the land, so it works in both
themes and cannot fight them.

Two things this has to get right.

**The sea has to be masked, and luminance cannot do it.** Natural Earth's SR
raster renders the ocean at 206 and flat desert at 199 -- indistinguishable. So
the mask comes from the same Natural Earth land polygons the app already bundles
and draws, which also means the relief can never bleed past the coastline on
screen.

**The projection has to be baked in.** `BitmapLayer` interpolates texture
coordinates linearly in whatever the viewport uses, and `_imageCoordinateSystem:
'lnglat'` is deck.gl's answer to that -- one this codebase already tried and
reverted, because on a world-sized quad it wedges the flat map and blocks the
globe. The terminator solves it by generating its rows to match the projection;
this does the same, offline: an equirectangular image for the globe and a
mercator-warped one for the flat map.
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

# Where the hillshade is considered "flat". Natural Earth's SR sits a little
# under 206 over level ground; anything darker is a shadowed slope and anything
# lighter is a lit one.
NEUTRAL = 200.0
SHADOW_STRENGTH = 0.62
HIGHLIGHT_STRENGTH = 0.30


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


def land_mask(polys, width, height, lat_of_row):
    """1 over land, 0 over sea, at this projection's row spacing."""
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
        return (x, float(lo))

    for rings in polys:
        for index, ring in enumerate(rings):
            if len(ring) < 3:
                continue
            pts = [to_px(lon, lat) for lon, lat in ring]
            # Ring 0 is the outer boundary; the rest are holes (inland seas).
            draw.polygon(pts, fill=255 if index == 0 else 0)
    return mask


def sample_rows(source, width, height, lat_of_row):
    """Resample the equirectangular source onto this projection's rows."""
    # Longitude is linear in both projections, so only the rows move: scale to
    # the target width once, then pick each output row from the source.
    scaled = source.resize((width, source.height), Image.LANCZOS)
    src = scaled.load()
    out = Image.new('L', (width, height))
    dst = out.load()
    sh = source.height
    for y in range(height):
        sy = min(sh - 1, max(0, int((90.0 - lat_of_row(y)) / 180.0 * sh)))
        for x in range(width):
            dst[x, y] = src[x, sy]
    return out


def overlay(shade, mask, width, height):
    """Hillshade -> RGBA overlay. Transparent sea, black shadow, white light."""
    out = Image.new('RGBA', (width, height))
    s, m, o = shade.load(), mask.load(), out.load()
    for y in range(height):
        for x in range(width):
            if m[x, y] == 0:
                o[x, y] = (0, 0, 0, 0)
                continue
            d = s[x, y] - NEUTRAL
            if d < 0:
                a = min(255, int(-d / NEUTRAL * 255 * SHADOW_STRENGTH))
                o[x, y] = (0, 0, 0, a)
            else:
                a = min(255, int(d / (255 - NEUTRAL) * 255 * HIGHLIGHT_STRENGTH))
                o[x, y] = (255, 255, 255, a)
    return out


def mercator_lat(y, height):
    """Row -> latitude, equal mercator units per row, clamped at the usable pole."""
    top = math.log(math.tan(math.pi / 4 + math.radians(MAX_MERCATOR_LAT) / 2))
    t = top - (2 * top) * ((y + 0.5) / height)
    return math.degrees(2 * math.atan(math.exp(t)) - math.pi / 2)


def equirect_lat(y, height):
    return 90.0 - 180.0 * ((y + 0.5) / height)


def main():
    SRC, LAND, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
    WIDTH = int(sys.argv[4]) if len(sys.argv) > 4 else 2048
    HEIGHT = HEIGHT_OF(WIDTH)
    os.makedirs(OUT, exist_ok=True)
    print(f'reading {os.path.basename(SRC)} ...')
    source = Image.open(SRC).convert('L')
    print(f'  {source.size[0]}x{source.size[1]}')

    print('decoding land polygons ...')
    polys = decode_topology(LAND)
    print(f'  {len(polys)} polygons')

    for name, lat_of_row in (
        ('equirect', lambda y: equirect_lat(y, HEIGHT)),
        ('mercator', lambda y: mercator_lat(y, HEIGHT)),
    ):
        print(f'{name}: sampling ...')
        shade = sample_rows(source, WIDTH, HEIGHT, lat_of_row)
        print(f'{name}: masking ...')
        mask = land_mask(polys, WIDTH, HEIGHT, lat_of_row)
        print(f'{name}: compositing ...')
        rgba = overlay(shade, mask, WIDTH, HEIGHT)
        path = os.path.join(OUT, f'relief-{name}-{WIDTH}.webp')
        rgba.save(path, 'WEBP', quality=80, method=6)
        print(f'  -> {path}  {os.path.getsize(path)/1024:.0f} KB')


if __name__ == '__main__':
    main()
