export type RgbaColor = [red: number, green: number, blue: number, alpha: number];

/**
 * Layer alphas, which the theme tokens do not carry.
 *
 * `tokens.css` holds six-digit hex, so opacity is decided here. `NIGHT_ALPHA` is
 * the one worth a note.
 *
 * It was `215` — 84% of `#03070e`, which is very nearly black. At that strength
 * the night side is not shaded, it is erased: land goes to `rgb(8, 14, 22)` and
 * ocean to `rgb(4, 8, 16)`, two colours nobody can tell apart. That was survivable
 * only while the terminator was being drawn at the wrong scale; once it covered
 * the hemisphere it actually describes, half the world went black.
 *
 * §1's promise is that a player *"comes back the next morning to see where their
 * aircraft ended up"*, and roughly half of any given moment is night. So night
 * has to read as dusk rather than as an absence: coastlines, borders and routes
 * must all survive it. `palette.test.ts` asserts they do, so a future retune
 * cannot quietly make the map unreadable again.
 */
const NIGHT_ALPHA = 115;
const LAND_LINE_ALPHA = 180;
const GRID_ALPHA = 80;
const ROUTE_ALPHA = 230;

export interface WorldPalette {
  ocean: RgbaColor;
  land: RgbaColor;
  landLine: RgbaColor;
  grid: RgbaColor;
  night: RgbaColor;
  route: RgbaColor;
}

const FALLBACK_PALETTE: WorldPalette = {
  ocean: [6, 15, 27, 255],
  land: [31, 52, 65, 255],
  landLine: [87, 112, 129, LAND_LINE_ALPHA],
  grid: [110, 139, 157, GRID_ALPHA],
  night: [3, 7, 14, NIGHT_ALPHA],
  route: [94, 184, 255, ROUTE_ALPHA],
};

export function parseHexColor(value: string, fallback: RgbaColor, alpha = fallback[3]): RgbaColor {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(value.trim());
  if (!match) return [...fallback];
  return [
    Number.parseInt(match[1]!, 16),
    Number.parseInt(match[2]!, 16),
    Number.parseInt(match[3]!, 16),
    alpha,
  ];
}

export function readWorldPalette(): WorldPalette {
  const styles = globalThis.getComputedStyle?.(document.documentElement);
  const read = (property: string, fallback: RgbaColor, alpha = fallback[3]) =>
    parseHexColor(styles?.getPropertyValue(property) ?? '', fallback, alpha);

  return {
    ocean: read('--world-ocean', FALLBACK_PALETTE.ocean),
    land: read('--world-land', FALLBACK_PALETTE.land),
    landLine: read('--world-land-line', FALLBACK_PALETTE.landLine, LAND_LINE_ALPHA),
    grid: read('--world-grid', FALLBACK_PALETTE.grid, GRID_ALPHA),
    night: read('--world-night', FALLBACK_PALETTE.night, NIGHT_ALPHA),
    route: read('--world-route', FALLBACK_PALETTE.route, ROUTE_ALPHA),
  };
}

/**
 * Composite a layer colour over a background, straight alpha.
 *
 * The same arithmetic `bitmap-layer-fragment.glsl` performs — exported so a test
 * can ask what the night side actually looks like rather than trusting that an
 * alpha "seems about right".
 */
export function compositeOver(layer: RgbaColor, background: RgbaColor): [number, number, number] {
  const alpha = layer[3] / 255;
  return [0, 1, 2].map((channel) =>
    Math.round((layer[channel] ?? 0) * alpha + (background[channel] ?? 0) * (1 - alpha)),
  ) as [number, number, number];
}

/** Perceptual distance, good enough to ask "can these be told apart?". */
export function colourDistance(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  return Math.hypot((a[0] - b[0]) * 0.299, (a[1] - b[1]) * 0.587, (a[2] - b[2]) * 0.114);
}
