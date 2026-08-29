export type RgbaColor = [red: number, green: number, blue: number, alpha: number];

/**
 * Every world colour carries its own alpha, in `tokens.css`, per theme.
 *
 * It used to be split: the colour in the stylesheet, the opacity as a constant
 * here. That split is what hid the last bug in this palette. The dark theme wants
 * a strong night wash and the light theme a much weaker one — a single shared
 * `NIGHT_ALPHA` cannot be both, and because the alpha was nowhere near the theme
 * it was never obvious that it had to vary with it.
 *
 * So the tokens are eight-digit hex where the alpha is not 255, and this file
 * decides nothing about colour at all.
 */
export interface WorldPalette {
  ocean: RgbaColor;
  land: RgbaColor;
  landLine: RgbaColor;
  border: RgbaColor;
  grid: RgbaColor;
  night: RgbaColor;
  route: RgbaColor;
  /** The dot colour for a served airport/city on the map. */
  airport: RgbaColor;
  /**
   * How hard the terrain basemap asserts itself, per theme.
   *
   * The rgb is a `tintColor` — a multiplier over the image — and the alpha is the
   * layer's opacity over the land fill beneath it. Not a colour the terrain *is*:
   * a colour the terrain is *pulled towards*.
   *
   * It has to differ between the themes for the same reason the night wash does,
   * and the reason is figure/ground rather than taste. The dark theme puts pale
   * land on a navy sea; the light theme puts dark land on a pale one. A basemap at
   * one fixed brightness keeps the polarity of exactly one of them and dissolves
   * the other's coastline into its ocean, so each theme tints towards its own side.
   */
  terrain: RgbaColor;
}

/**
 * The dark theme's world colours, for when the tokens cannot be read.
 *
 * A duplicate of `tokens.css`, which is a drift hole — so `palette.test.ts` parses
 * that file and asserts these match it. Without that, a retune in one place and
 * not the other is invisible until someone renders the world in an environment
 * where `getComputedStyle` returns nothing.
 */
const FALLBACK_PALETTE: WorldPalette = {
  ocean: [22, 64, 102, 255],
  land: [179, 207, 223, 255],
  landLine: [12, 28, 43, 180],
  border: [31, 58, 82, 160],
  grid: [220, 236, 247, 80],
  night: [2, 5, 9, 120],
  route: [127, 212, 255, 230],
  airport: [255, 210, 127, 255],
  terrain: [240, 246, 250, 255],
};
/**
 * Read a theme token as deck.gl channels.
 *
 * Accepts `#rrggbb` and `#rrggbbaa`. When the token carries its own alpha that
 * wins, because the token is the source of truth; `alpha` is only the default for
 * a six-digit token, and `fallback` covers a token that is missing or malformed.
 */
export function parseHexColor(value: string, fallback: RgbaColor, alpha = fallback[3]): RgbaColor {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})([\da-f]{2})?$/i.exec(value.trim());
  if (!match) return [...fallback];
  return [
    Number.parseInt(match[1]!, 16),
    Number.parseInt(match[2]!, 16),
    Number.parseInt(match[3]!, 16),
    match[4] === undefined ? alpha : Number.parseInt(match[4], 16),
  ];
}

export function readWorldPalette(): WorldPalette {
  const styles = globalThis.getComputedStyle?.(document.documentElement);
  const read = (property: string, fallback: RgbaColor) =>
    parseHexColor(styles?.getPropertyValue(property) ?? '', fallback);

  return {
    ocean: read('--world-ocean', FALLBACK_PALETTE.ocean),
    land: read('--world-land', FALLBACK_PALETTE.land),
    landLine: read('--world-land-line', FALLBACK_PALETTE.landLine),
    border: read('--world-border', FALLBACK_PALETTE.border),
    grid: read('--world-grid', FALLBACK_PALETTE.grid),
    night: read('--world-night', FALLBACK_PALETTE.night),
    route: read('--world-route', FALLBACK_PALETTE.route),
    airport: read('--world-airport', FALLBACK_PALETTE.airport),
    terrain: read('--world-terrain', FALLBACK_PALETTE.terrain),
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

/** WCAG relative luminance. */
function relativeLuminance(colour: readonly [number, number, number]): number {
  const channel = (value: number): number => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(colour[0]) + 0.7152 * channel(colour[1]) + 0.0722 * channel(colour[2]);
}

/**
 * WCAG contrast ratio, 1:1 to 21:1.
 *
 * The measure App. H.7 names, rather than a Euclidean distance that happens to
 * correlate with it. AA wants 3:1 for a meaningful graphical object against what
 * it sits on, and the world palette is nothing but graphical objects sitting on
 * each other.
 */
export function contrastRatio(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return ((lighter ?? 0) + 0.05) / ((darker ?? 0) + 0.05);
}
