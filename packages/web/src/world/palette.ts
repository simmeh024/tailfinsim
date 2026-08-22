export type RgbaColor = [red: number, green: number, blue: number, alpha: number];

/**
 * Layer alphas, which the theme tokens do not carry.
 *
 * `tokens.css` holds six-digit hex, so opacity is decided here. `NIGHT_ALPHA` is
 * the one worth a note.
 *
 * It was `215` — 84% of a near-black night colour, which does not dim the night
 * side, it erases it. Now `90`, chosen with the rest of the world palette so that
 * **every meaningful pairing clears WCAG AA's 3:1 in both themes, in daylight and
 * under full night**: land against ocean, a coastline against its own land, and a
 * route against the sea it crosses.
 *
 * That is App. H.7's bar — *"WCAG AA contrast throughout"* — and the world palette
 * missed it badly before: land against ocean measured 1.49:1 in the dark theme.
 * §1's promise is that a player *"comes back the next morning to see where their
 * aircraft ended up"*, and roughly half of any moment is night, so night has to
 * read as dusk rather than as an absence.
 *
 * `palette.test.ts` measures all of it rather than trusting the numbers to look
 * about right, and `tokens.css` is the only place the colours live.
 */
const NIGHT_ALPHA = 90;
const LAND_LINE_ALPHA = 180;
/**
 * The graticule is faint on purpose, and unavoidably fainter over land.
 *
 * One flat overlay at 31% cannot contrast strongly with both a dark sea and a
 * light landmass; the colour chosen favours the ocean, where most of a meridian
 * runs. It is a reference grid, it is toggleable, and it is not a meaningful
 * graphic in WCAG's sense — so it is the one world layer the contrast tests do
 * not gate.
 */
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

/**
 * The dark theme's world colours, for when the tokens cannot be read.
 *
 * A duplicate of `tokens.css`, which is a drift hole — so `palette.test.ts` parses
 * that file and asserts these match it. Without that, a retune in one place and
 * not the other is invisible until someone renders the world in an environment
 * where `getComputedStyle` returns nothing.
 */
const FALLBACK_PALETTE: WorldPalette = {
  ocean: [13, 32, 56, 255],
  land: [119, 153, 176, 255],
  landLine: [15, 30, 46, LAND_LINE_ALPHA],
  grid: [220, 236, 247, GRID_ALPHA],
  night: [11, 26, 46, NIGHT_ALPHA],
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
