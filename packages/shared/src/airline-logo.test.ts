import { describe, expect, it } from 'vitest';

import {
  AirlineLogo,
  AirlineLogoCustomDesign,
  airlineLogoEquals,
  CUSTOM_GRID_SIZE,
  defaultAirlineLogo,
  defaultCustomDesign,
} from './airline-logo';

/**
 * The brand logo spec (§15/§16).
 *
 * It is stored and compared as a value, so the two things that must hold are that
 * the schema refuses malformed emblems (a client cannot persist a bad colour or a
 * four-character monogram) and that `airlineLogoEquals` decides change correctly —
 * that equality is what the paid-rebrand dirty check turns on.
 */

const BASE: AirlineLogo = {
  shape: 'roundel',
  mark: { kind: 'monogram', text: 'TF' },
  background: '#0b3d91',
  foreground: '#ffffff',
  accent: '#e6b800',
};

describe('the airline logo schema', () => {
  it('accepts a well-formed monogram and symbol emblem', () => {
    expect(AirlineLogo.safeParse(BASE).success).toBe(true);
    expect(
      AirlineLogo.safeParse({ ...BASE, mark: { kind: 'symbol', symbol: 'wings' } }).success,
    ).toBe(true);
  });

  it('refuses a bad colour, an over-long monogram and an unknown symbol', () => {
    expect(AirlineLogo.safeParse({ ...BASE, background: 'blue' }).success).toBe(false);
    expect(
      AirlineLogo.safeParse({ ...BASE, mark: { kind: 'monogram', text: 'TOOLONG' } }).success,
    ).toBe(false);
    expect(
      AirlineLogo.safeParse({ ...BASE, mark: { kind: 'symbol', symbol: 'rocket' } }).success,
    ).toBe(false);
  });

  it('rejects unknown keys — the emblem is a closed shape', () => {
    expect(AirlineLogo.safeParse({ ...BASE, extra: true }).success).toBe(false);
  });
});

describe('defaultAirlineLogo', () => {
  it('uses the code as its monogram, upper-cased and clamped to three characters', () => {
    const logo = defaultAirlineLogo('tf');
    expect(logo.mark).toEqual({ kind: 'monogram', text: 'TF' });
    expect(AirlineLogo.safeParse(logo).success).toBe(true);
  });

  it('falls back to a valid monogram when the code has nothing usable', () => {
    expect(defaultAirlineLogo('--').mark).toEqual({ kind: 'monogram', text: 'AIR' });
  });
});

describe('airlineLogoEquals', () => {
  it('treats two absent logos as equal, and one present as different', () => {
    expect(airlineLogoEquals(null, null)).toBe(true);
    expect(airlineLogoEquals(BASE, null)).toBe(false);
    expect(airlineLogoEquals(null, BASE)).toBe(false);
  });

  it('compares by value across shape, colours and the mark', () => {
    expect(airlineLogoEquals(BASE, { ...BASE })).toBe(true);
    expect(airlineLogoEquals(BASE, { ...BASE, shape: 'shield' })).toBe(false);
    expect(airlineLogoEquals(BASE, { ...BASE, accent: '#000000' })).toBe(false);
    expect(airlineLogoEquals(BASE, { ...BASE, mark: { kind: 'monogram', text: 'XX' } })).toBe(
      false,
    );
    expect(
      airlineLogoEquals(
        { ...BASE, mark: { kind: 'symbol', symbol: 'star' } },
        { ...BASE, mark: { kind: 'symbol', symbol: 'star' } },
      ),
    ).toBe(true);
    expect(airlineLogoEquals(BASE, { ...BASE, mark: { kind: 'symbol', symbol: 'star' } })).toBe(
      false,
    );
  });
});

describe('the custom symbol design', () => {
  const grid = '1'.repeat(CUSTOM_GRID_SIZE * CUSTOM_GRID_SIZE);

  it('accepts a valid grid, shapes and path, inside AirlineLogo', () => {
    const base = {
      shape: 'roundel',
      background: '#111111',
      foreground: '#ffffff',
      accent: '#e6b800',
    };
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
      expect(AirlineLogo.safeParse({ ...base, mark: { kind: 'custom', custom } }).success).toBe(
        true,
      );
    }
  });

  it('refuses a wrong-length grid, an empty or over-full shape stack, and a one-point path', () => {
    expect(
      AirlineLogoCustomDesign.safeParse({ design: 'grid', cells: grid.slice(1) }).success,
    ).toBe(false);
    expect(AirlineLogoCustomDesign.safeParse({ design: 'shapes', shapes: [] }).success).toBe(false);
    expect(
      AirlineLogoCustomDesign.safeParse({
        design: 'shapes',
        shapes: Array.from({ length: 25 }, () => ({ type: 'circle', cx: 0.5, cy: 0.5, r: 0.2 })),
      }).success,
    ).toBe(false);
    expect(
      AirlineLogoCustomDesign.safeParse({ design: 'path', points: [{ x: 0, y: 0 }], closed: true })
        .success,
    ).toBe(false);
  });

  it('has a valid default for each tool', () => {
    for (const design of ['grid', 'shapes', 'path'] as const) {
      expect(AirlineLogoCustomDesign.safeParse(defaultCustomDesign(design)).success).toBe(true);
      expect(defaultCustomDesign(design).design).toBe(design);
    }
  });

  it('compares custom marks by value, independent of key order', () => {
    const base = {
      shape: 'square' as const,
      background: '#111111',
      foreground: '#ffffff',
      accent: '#000000',
    };
    const a = {
      ...base,
      mark: {
        kind: 'custom' as const,
        custom: {
          design: 'shapes' as const,
          shapes: [{ type: 'rect' as const, cx: 0.5, cy: 0.5, w: 0.3, h: 0.3, rot: 0 }],
        },
      },
    };
    // Same value, object keys built in a different order — jsonb round-trips do this.
    const b = {
      ...base,
      mark: {
        kind: 'custom' as const,
        custom: {
          shapes: [{ h: 0.3, rot: 0, w: 0.3, cy: 0.5, cx: 0.5, type: 'rect' as const }],
          design: 'shapes' as const,
        },
      },
    };
    expect(airlineLogoEquals(a, b)).toBe(true);
    const c = {
      ...base,
      mark: { kind: 'custom' as const, custom: { design: 'grid' as const, cells: grid } },
    };
    expect(airlineLogoEquals(a, c)).toBe(false);
  });
});
