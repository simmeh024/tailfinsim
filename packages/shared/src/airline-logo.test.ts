import { describe, expect, it } from 'vitest';

import {
  AirlineLogo,
  AirlineLogoCustomDesign,
  airlineLogoEquals,
  ComposedAirlineLogo,
  CUSTOM_GRID_SIZE,
  defaultAirlineLogo,
  defaultCustomDesign,
  isComposedLogo,
  legacyToComposed,
  newLayer,
  type LegacyAirlineLogo,
} from './airline-logo';

/**
 * The brand logo spec (§15/§16).
 *
 * It is stored and compared as a value across two shapes — a **legacy** emblem
 * (#789: frame + single mark + three colours) and a **composed** one (the studio:
 * frame + palette + a stack of layers). The two things that must hold are that the
 * schema refuses malformed emblems of either shape, and that `airlineLogoEquals`
 * decides change correctly — that equality is what the paid-rebrand dirty check
 * turns on.
 */

const LEGACY: LegacyAirlineLogo = {
  shape: 'roundel',
  mark: { kind: 'monogram', text: 'TF' },
  background: '#0b3d91',
  foreground: '#ffffff',
  accent: '#e6b800',
};

describe('the legacy logo schema (still readable)', () => {
  it('accepts a well-formed monogram and symbol emblem', () => {
    expect(AirlineLogo.safeParse(LEGACY).success).toBe(true);
    expect(
      AirlineLogo.safeParse({ ...LEGACY, mark: { kind: 'symbol', symbol: 'wings' } }).success,
    ).toBe(true);
  });

  it('refuses a bad colour, an over-long monogram and an unknown symbol', () => {
    expect(AirlineLogo.safeParse({ ...LEGACY, background: 'blue' }).success).toBe(false);
    expect(
      AirlineLogo.safeParse({ ...LEGACY, mark: { kind: 'monogram', text: 'TOOLONG' } }).success,
    ).toBe(false);
    expect(
      AirlineLogo.safeParse({ ...LEGACY, mark: { kind: 'symbol', symbol: 'rocket' } }).success,
    ).toBe(false);
  });

  it('rejects unknown keys — the emblem is a closed shape', () => {
    expect(AirlineLogo.safeParse({ ...LEGACY, extra: true }).success).toBe(false);
  });
});

describe('the composed logo schema', () => {
  const COMPOSED = defaultAirlineLogo('TF');

  it('accepts the default composed emblem, in the union and on its own', () => {
    expect(ComposedAirlineLogo.safeParse(COMPOSED).success).toBe(true);
    expect(AirlineLogo.safeParse(COMPOSED).success).toBe(true);
    expect(isComposedLogo(COMPOSED)).toBe(true);
  });

  it('rejects an empty and an over-full layer stack', () => {
    expect(ComposedAirlineLogo.safeParse({ ...COMPOSED, layers: [] }).success).toBe(false);
    const many = Array.from({ length: 25 }, () => newLayer('circle'));
    expect(ComposedAirlineLogo.safeParse({ ...COMPOSED, layers: many }).success).toBe(false);
  });

  it('rejects an out-of-range opacity and an unknown palette slot as a paint', () => {
    const bad = { ...COMPOSED, layers: [{ ...COMPOSED.layers[0], opacity: 2 }] };
    expect(ComposedAirlineLogo.safeParse(bad).success).toBe(false);
    const badPaint = { ...COMPOSED, layers: [{ ...COMPOSED.layers[0], fill: 'gold' }] };
    expect(ComposedAirlineLogo.safeParse(badPaint).success).toBe(false);
  });

  it('rejects a bad palette colour and unknown keys', () => {
    expect(
      ComposedAirlineLogo.safeParse({
        ...COMPOSED,
        palette: { ...COMPOSED.palette, mark: 'white' },
      }).success,
    ).toBe(false);
    expect(ComposedAirlineLogo.safeParse({ ...COMPOSED, extra: true }).success).toBe(false);
  });

  it('accepts every layer content type from newLayer', () => {
    for (const type of ['circle', 'rect', 'triangle', 'line', 'text', 'symbol', 'path'] as const) {
      const logo = { ...COMPOSED, layers: [newLayer(type)] };
      expect(ComposedAirlineLogo.safeParse(logo).success).toBe(true);
    }
  });
});

describe('defaultAirlineLogo', () => {
  it('returns a composed emblem whose initials layer carries the clamped code', () => {
    const logo = defaultAirlineLogo('tf');
    expect(logo.v).toBe(2);
    const first = logo.layers[0]!.content;
    expect(first.type === 'text' && first.text).toBe('TF');
    expect(AirlineLogo.safeParse(logo).success).toBe(true);
  });

  it('falls back to a valid monogram when the code has nothing usable', () => {
    const first = defaultAirlineLogo('--').layers[0]!.content;
    expect(first.type === 'text' && first.text).toBe('AIR');
  });
});

describe('legacyToComposed', () => {
  it('lifts a monogram legacy logo into a composed one that parses', () => {
    const composed = legacyToComposed(LEGACY);
    expect(isComposedLogo(composed)).toBe(true);
    expect(ComposedAirlineLogo.safeParse(composed).success).toBe(true);
    // Colours map onto the palette: mark = the old foreground, ring = the old accent.
    expect(composed.palette.mark).toBe(LEGACY.foreground);
    expect(composed.palette.ring).toBe(LEGACY.accent);
    const first = composed.layers[0]!.content;
    expect(first.type === 'text' && first.text).toBe('TF');
  });

  it('lifts a custom-shapes legacy logo, one layer per primitive', () => {
    const legacy: LegacyAirlineLogo = {
      ...LEGACY,
      mark: {
        kind: 'custom',
        custom: {
          design: 'shapes',
          shapes: [
            { type: 'circle', cx: 0.5, cy: 0.5, r: 0.3 },
            { type: 'rect', cx: 0.4, cy: 0.4, w: 0.2, h: 0.2, rot: 10 },
          ],
        },
      },
    };
    const composed = legacyToComposed(legacy);
    expect(composed.layers).toHaveLength(2);
    expect(ComposedAirlineLogo.safeParse(composed).success).toBe(true);
  });

  it('gives a legacy grid a valid fallback layer rather than an empty stack', () => {
    const grid = '1'.repeat(CUSTOM_GRID_SIZE * CUSTOM_GRID_SIZE);
    const legacy: LegacyAirlineLogo = {
      ...LEGACY,
      mark: { kind: 'custom', custom: { design: 'grid', cells: grid } },
    };
    const composed = legacyToComposed(legacy);
    expect(composed.layers.length).toBeGreaterThanOrEqual(1);
    expect(ComposedAirlineLogo.safeParse(composed).success).toBe(true);
  });
});

describe('airlineLogoEquals', () => {
  const COMPOSED = defaultAirlineLogo('TF');

  it('treats two absent logos as equal, and one present as different', () => {
    expect(airlineLogoEquals(null, null)).toBe(true);
    expect(airlineLogoEquals(COMPOSED, null)).toBe(false);
    expect(airlineLogoEquals(null, COMPOSED)).toBe(false);
  });

  it('compares composed logos by value, independent of key order', () => {
    expect(
      airlineLogoEquals(COMPOSED, JSON.parse(JSON.stringify(COMPOSED)) as ComposedAirlineLogo),
    ).toBe(true);
    expect(airlineLogoEquals(COMPOSED, { ...COMPOSED, shape: 'shield' })).toBe(false);
    expect(
      airlineLogoEquals(COMPOSED, {
        ...COMPOSED,
        palette: { ...COMPOSED.palette, accent: '#000000' },
      }),
    ).toBe(false);
    // Same value, layer object keys built in a different order — jsonb does this.
    const reordered: ComposedAirlineLogo = {
      layers: COMPOSED.layers,
      palette: COMPOSED.palette,
      frameStroke: COMPOSED.frameStroke,
      frameFill: COMPOSED.frameFill,
      shape: COMPOSED.shape,
      v: 2,
    };
    expect(airlineLogoEquals(COMPOSED, reordered)).toBe(true);
  });

  it('never equates a legacy logo with a composed one', () => {
    expect(airlineLogoEquals(LEGACY, COMPOSED)).toBe(false);
  });
});

describe('the legacy custom symbol design (unchanged)', () => {
  const grid = '1'.repeat(CUSTOM_GRID_SIZE * CUSTOM_GRID_SIZE);

  it('accepts a valid grid, shapes and path inside a legacy logo', () => {
    for (const custom of [
      { design: 'grid', cells: grid },
      { design: 'shapes', shapes: [{ type: 'circle', cx: 0.5, cy: 0.5, r: 0.3 }] },
      {
        design: 'path',
        points: [
          { x: 0.1, y: 0.1 },
          { x: 0.9, y: 0.9 },
        ],
        closed: false,
      },
    ]) {
      expect(AirlineLogo.safeParse({ ...LEGACY, mark: { kind: 'custom', custom } }).success).toBe(
        true,
      );
    }
  });

  it('has a valid default for each tool', () => {
    for (const design of ['grid', 'shapes', 'path'] as const) {
      expect(AirlineLogoCustomDesign.safeParse(defaultCustomDesign(design)).success).toBe(true);
      expect(defaultCustomDesign(design).design).toBe(design);
    }
  });
});
