import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  compositeOver,
  contrastRatio,
  parseHexColor,
  readWorldPalette,
  type RgbaColor,
} from './palette';

/**
 * The world palette (App. H.7).
 *
 * H.7 asks for *"WCAG AA contrast throughout"*, and the world is nothing but
 * graphical objects sitting on each other: land on ocean, a coastline on its own
 * land, a route across the sea it crosses. AA's bar for a meaningful graphic is
 * **3:1**.
 *
 * The original palette missed it by a distance — land against ocean measured
 * **1.49:1** in the dark theme and 1.41:1 in the light one, and a coastline
 * against its land 2.48:1. The map was a very dark object with a
 * slightly-less-dark object drawn on it, which is why it read as unlit even in
 * daylight. These tests measure every pairing rather than trusting a hex value to
 * look about right.
 */

const tokensPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'theme', 'tokens.css');
const tokensCss = readFileSync(tokensPath, 'utf8');

/**
 * The world tokens for one theme, read from the stylesheet.
 *
 * jsdom does not apply `tokens.css`, so `readWorldPalette` falls back to its own
 * constants — which means a test using it alone would be testing the fallback
 * rather than the theme. Both are covered: the ratios run against both themes in
 * the file, and the fallback is separately asserted to equal the dark one.
 */
function worldTokens(theme: 'dark' | 'light'): Record<string, [number, number, number]> {
  // Brace-matched from the theme's own selector. Splitting on lines that look like
  // selectors does not work: comments and nested blocks inside `[data-theme]` cut
  // the block in half, and the half without `--world-night` looks like a theme
  // that simply does not define it.
  const marker = `[data-theme='${theme}'] {`;
  const start = tokensCss.indexOf(marker);
  if (start < 0) throw new Error(`No ${theme} theme block in tokens.css`);

  let depth = 0;
  let end = start + marker.length - 1;
  for (let i = start + marker.length - 1; i < tokensCss.length; i += 1) {
    if (tokensCss[i] === '{') depth += 1;
    else if (tokensCss[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const block = tokensCss.slice(start, end);

  const found: Record<string, [number, number, number]> = {};
  for (const match of block.matchAll(/--world-([a-z-]+):\s*(#[\da-f]{6})/gi)) {
    const rgba = parseHexColor(String(match[2]), [0, 0, 0, 255]);
    found[String(match[1])] = [rgba[0], rgba[1], rgba[2]];
  }
  if (found.ocean === undefined) throw new Error(`No world tokens in the ${theme} theme`);
  return found;
}

const NIGHT_ALPHA = readWorldPalette().night[3];

describe('token parsing', () => {
  it('turns a theme token into deck.gl channels', () => {
    expect(parseHexColor('#5eb8ff', [0, 0, 0, 0], 230)).toEqual([94, 184, 255, 230]);
  });

  it('uses the semantic fallback when a CSS token is absent or invalid', () => {
    expect(parseHexColor('', [1, 2, 3, 4])).toEqual([1, 2, 3, 4]);
    expect(parseHexColor('rgb(1 2 3)', [4, 5, 6, 7])).toEqual([4, 5, 6, 7]);
  });
});

describe('the fallback palette', () => {
  it('does not drift from the dark theme in tokens.css', () => {
    const tokens = worldTokens('dark');
    const fallback = readWorldPalette();
    const rgb = (colour: RgbaColor): [number, number, number] => [colour[0], colour[1], colour[2]];

    // Two copies of the same colours is a drift hole; this is the guard on it.
    expect(rgb(fallback.ocean)).toEqual(tokens.ocean);
    expect(rgb(fallback.land)).toEqual(tokens.land);
    expect(rgb(fallback.landLine)).toEqual(tokens['land-line']);
    expect(rgb(fallback.grid)).toEqual(tokens.grid);
    expect(rgb(fallback.night)).toEqual(tokens.night);
    expect(rgb(fallback.route)).toEqual(tokens.route);
  });
});

describe.each(['dark', 'light'] as const)('the %s world meets WCAG AA', (theme) => {
  const tokens = worldTokens(theme);
  const plain = (name: string): [number, number, number] => {
    const colour = tokens[name];
    if (colour === undefined) throw new Error(`No --world-${name} in the ${theme} theme`);
    return colour;
  };
  const opaque = (name: string): RgbaColor => [...plain(name), 255];
  const night: RgbaColor = [...plain('night'), NIGHT_ALPHA];
  /** What a colour becomes on the night side of the terminator. */
  const atNight = (name: string) => compositeOver(night, opaque(name));

  it('separates land from ocean in daylight', () => {
    expect(contrastRatio(plain('land'), plain('ocean'))).toBeGreaterThanOrEqual(3);
  });

  it('separates land from ocean on the night side', () => {
    // The pairing that failed hardest: at the old colours and alpha this was
    // 1.19:1, which is two blacks.
    expect(contrastRatio(atNight('land'), atNight('ocean'))).toBeGreaterThanOrEqual(3);
  });

  it('keeps a coastline visible against its own land, day and night', () => {
    expect(contrastRatio(plain('land-line'), plain('land'))).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(atNight('land-line'), atNight('land'))).toBeGreaterThanOrEqual(3);
  });

  it('keeps a route visible over the sea it crosses, day and night', () => {
    expect(contrastRatio(plain('route'), plain('ocean'))).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(atNight('route'), atNight('ocean'))).toBeGreaterThanOrEqual(3);
  });

  it('still makes night look like night', () => {
    // Shading nobody can see is not shading, and shading that swallows the map is
    // the failure this palette was retuned to fix. Night lives between the two.
    const dimming = contrastRatio(plain('land'), atNight('land'));
    expect(dimming).toBeGreaterThan(1.25);
    expect(dimming).toBeLessThan(3);
  });

  it('gives the globe a silhouette against space', () => {
    // The globe does not fill the frame, and once the sea became a legible navy the
    // surround could no longer be the same colour — a planet whose limb has no
    // contrast against its background is not a planet.
    //
    // The bar is deliberately modest. A navy sea against *pure black* only reaches
    // 1.28:1, so luminance alone cannot carry a globe edge in a dark theme; the
    // atmosphere ring does that. What this asserts is that the two are not the same
    // colour and that space is the darker of them.
    expect(contrastRatio(plain('space'), plain('ocean'))).toBeGreaterThanOrEqual(1.2);
  });

  it('leaves the day side exactly as authored', () => {
    const untouched = compositeOver([...plain('night'), 0], opaque('land'));
    expect(untouched).toEqual(plain('land'));
  });
});
