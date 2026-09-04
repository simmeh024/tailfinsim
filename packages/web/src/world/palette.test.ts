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
import { TERRAIN_MEAN_LAND } from './terrain';

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
function worldTokens(theme: 'dark' | 'light'): Record<string, RgbaColor> {
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

  const found: Record<string, RgbaColor> = {};
  // Six or eight digits: the alpha is part of the token now, and reading it is the
  // point — the two themes deliberately wash to night at different strengths.
  for (const match of block.matchAll(/--world-([a-z-]+):\s*(#[\da-f]{6}(?:[\da-f]{2})?)/gi)) {
    found[String(match[1])] = parseHexColor(String(match[2]), [0, 0, 0, 255]);
  }
  if (found.ocean === undefined) throw new Error(`No world tokens in the ${theme} theme`);
  return found;
}

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
    // Two copies of the same colours is a drift hole; this is the guard on it.
    // Alphas included, now that the tokens carry them.
    expect(fallback.ocean).toEqual(tokens.ocean);
    expect(fallback.land).toEqual(tokens.land);
    expect(fallback.landLine).toEqual(tokens['land-line']);
    expect(fallback.border).toEqual(tokens.border);
    expect(fallback.grid).toEqual(tokens.grid);
    expect(fallback.night).toEqual(tokens.night);
    expect(fallback.route).toEqual(tokens.route);
    expect(fallback.altGround).toEqual(tokens['alt-ground']);
    expect(fallback.altLow).toEqual(tokens['alt-low']);
    expect(fallback.altMid).toEqual(tokens['alt-mid']);
    expect(fallback.altHigh).toEqual(tokens['alt-high']);
    expect(fallback.airport).toEqual(tokens.airport);
    expect(fallback.terrain).toEqual(tokens.terrain);
  });
});

/** The terrain basemap under a theme's tint: the rgb multiplies the image. */
function tintedTerrain(tint: RgbaColor): [number, number, number] {
  return [0, 1, 2].map((channel) =>
    Math.round(((TERRAIN_MEAN_LAND[channel] ?? 0) * (tint[channel] ?? 0)) / 255),
  ) as [number, number, number];
}

describe.each(['dark', 'light'] as const)('the %s world meets WCAG AA', (theme) => {
  const tokens = worldTokens(theme);
  const token = (name: string): RgbaColor => {
    const colour = tokens[name];
    if (colour === undefined) throw new Error(`No --world-${name} in the ${theme} theme`);
    return colour;
  };
  const plain = (name: string): [number, number, number] => {
    const c = token(name);
    return [c[0], c[1], c[2]];
  };
  const opaque = (name: string): RgbaColor => [...plain(name), 255];
  /** What a colour becomes on the night side of the terminator. */
  const atNight = (name: string) => compositeOver(token('night'), opaque(name));

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

  it('keeps a country border visible on the land it divides, day and night', () => {
    // A border carries information, so H.7's 3:1 for a meaningful graphic applies
    // to it exactly as it does to a coastline.
    expect(contrastRatio(plain('border'), plain('land'))).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(atNight('border'), atNight('land'))).toBeGreaterThanOrEqual(3);
  });

  it('keeps the border subordinate to the coastline', () => {
    // Equal weight makes a continent read as a mesh of equal cells, and the
    // coastline is the line that says where the land stops. Contrast is the half
    // of that which can be measured; width is the other half, in `layers.ts`.
    expect(contrastRatio(plain('border'), plain('land'))).toBeLessThan(
      contrastRatio(plain('land-line'), plain('land')),
    );
  });

  it('keeps a route visible over the sea it crosses, day and night', () => {
    expect(contrastRatio(plain('route'), plain('ocean'))).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(atNight('route'), atNight('ocean'))).toBeGreaterThanOrEqual(3);
  });

  it('keeps every altitude stop visible over the land it is drawn on', () => {
    /*
     * The route test above measures the sea, because that is what a cruising leg
     * crosses. The altitude ramp has to answer for the **land**, because the low end
     * of it is at an airport and an airport is on land.
     *
     * That was the bug this ramp replaced: the ends of a line were washed to the
     * amber the airport dots use over pale terrain, so they arrived at the colour of
     * the thing they were drawn on and the end of a route could not be seen at all.
     */
    for (const stop of ['alt-ground', 'alt-low', 'alt-mid', 'alt-high']) {
      expect(contrastRatio(plain(stop), plain('land')), stop).toBeGreaterThanOrEqual(3);
    }
  });

  it('separates the ends of a route line from its cruise', () => {
    // The reading only works if the two ends of the ramp are told apart, and this is
    // the part an operator actually looks for: where does this line stop.
    expect(contrastRatio(plain('alt-ground'), plain('route'))).toBeGreaterThanOrEqual(3);
  });

  it('makes the terminator visible over land', () => {
    const dimming = contrastRatio(plain('land'), atNight('land'));
    expect(dimming).toBeGreaterThan(1.2);
    expect(dimming).toBeLessThan(3.4);
  });

  it('makes the terminator visible over the sea', () => {
    /*
     * The pairing this palette was missing, and the reason a working terminator
     * looked like no terminator at all.
     *
     * Every other check here compares two *things* — land against sea, a coastline
     * against its land. None of them asks whether night is distinguishable from day
     * on the same surface, and the sea is most of the globe. Measured on the
     * deployed build, a scanline across the terminator read `13,32,56` in daylight
     * and `12,30,52` at night: a ratio of 1.02, two units per channel, invisible.
     * Land was fine at 1.83, which is why it looked like a shading bug rather than
     * a palette one.
     */
    const dimming = contrastRatio(plain('ocean'), atNight('ocean'));
    expect(dimming).toBeGreaterThan(1.35);
  });

  it('separates the terrain basemap from the ocean in daylight', () => {
    /*
     * The pairing the terrain layer created, and the one it can silently break.
     *
     * With terrain on, the basemap covers every land texel — so `--world-land`
     * stops describing what a reader sees, and the land-against-ocean guarantee
     * above stops applying to the screen. This is that guarantee, restated
     * against what is actually drawn.
     *
     * It is the light theme this catches. That theme's ocean is nearly white and
     * the raster is a pale sage; untinted, the land comes out *lighter than the
     * sea*, the polarity of the whole palette inverts and the coastline stops
     * existing. `--world-terrain` multiplies it down, and this measures that it
     * multiplied it down far enough. Measured: 5.11 dark, 3.68 light.
     *
     * `TERRAIN_MEAN_LAND` is a mean over the shipped image, so this is a floor
     * rather than a claim about the Sahara or the Greenland ice.
     */
    expect(contrastRatio(tintedTerrain(token('terrain')), plain('ocean'))).toBeGreaterThanOrEqual(
      3,
    );
  });

  it('makes the terminator visible over the terrain', () => {
    // The same window this file already applies to the flat fill, on the surface
    // that replaced it: night has to be a visible step, and not so deep that the
    // basemap goes black and takes the map with it.
    const dimming = contrastRatio(
      tintedTerrain(token('terrain')),
      compositeOver(token('night'), [...tintedTerrain(token('terrain')), 255]),
    );
    expect(dimming).toBeGreaterThan(1.2);
    expect(dimming).toBeLessThan(3.4);
  });

  it('keeps the coastline and the borders legible over the terrain in daylight', () => {
    /*
     * The lines carry the information, and the basemap is a far busier surface
     * than the flat fill they were tuned against — so the pairings measured
     * above against `--world-land` are re-measured against what is now actually
     * underneath them. Measured: coastline 8.23 dark and 3.53 light, border 5.61
     * and 3.22.
     *
     * **Daylight only, and that is a shortfall rather than an oversight.** Under
     * full night none of these reaches 3:1 over the terrain — the border gets to
     * 2.65 dark and 2.56 light, against 3.19 and 3.20 over the fill — and no
     * choice of `--world-terrain` fixes it: even an untinted basemap only
     * reaches 2.83. The cost is the mean image being darker than a token picked
     * to maximise this exact ratio, and the fix is retuning `--world-border` and
     * `--world-night`, which is a decision about every border on the map and not
     * one the terrain layer should make on its way past.
     *
     * The light theme's tint is pinned by the daylight border figure: one step
     * lighter takes it to 2.88.
     */
    const terrain = tintedTerrain(token('terrain'));
    expect(contrastRatio(plain('land-line'), terrain)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(plain('border'), terrain)).toBeGreaterThanOrEqual(3);
  });

  it('leaves a route no less visible than the flat fill did', () => {
    /*
     * **This one documents a weakness rather than a guarantee, and the weakness
     * predates the terrain.**
     *
     * A route over open sea is fine and is asserted above. A route over *land*
     * never was, and measured against the fill it is 1.01:1 in the dark theme —
     * a pale cyan arc on a pale blue continent, which is not a low ratio so much
     * as no ratio at all. The basemap does not cause that and slightly improves
     * it, to 1.26.
     *
     * So the bar here is non-regression, and it is written down rather than
     * quietly left out: fixing it means retuning `--world-route`, which is a
     * palette decision about every route on the map and not something the
     * terrain layer should make on its way past.
     */
    expect(contrastRatio(plain('route'), tintedTerrain(token('terrain')))).toBeGreaterThanOrEqual(
      contrastRatio(plain('route'), plain('land')),
    );
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
