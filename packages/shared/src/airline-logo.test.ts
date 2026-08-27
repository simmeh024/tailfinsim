import { describe, expect, it } from 'vitest';

import { AirlineLogo, airlineLogoEquals, defaultAirlineLogo } from './airline-logo';

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
