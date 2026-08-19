import { describe, expect, it } from 'vitest';

import {
  climateFor,
  DEFAULT_CLIMATE,
  type Month,
  seasonalPhase,
  seasonalStrength,
} from './climate';

/**
 * Climatological norms (M2-09, §24).
 *
 * §24 says weather has no source or seasonality defined, so this is a decision.
 * What the tests pin down is that the decision behaves like the planet:
 *
 *   1. **The hemispheres are opposite.** July is Amsterdam's summer and Sydney's
 *      winter, and a model that forgot would give Sydney a snowy Christmas.
 *   2. The temperate maritime latitudes — where the MVP's network lives — land
 *      close to published norms.
 *   3. The tropics barely have a season at all.
 */

const AMSTERDAM = { lat: 52.3086, lon: 4.76389 };
const SYDNEY = { lat: -33.8688, lon: 151.2093 };
const SINGAPORE = { lat: 1.3644, lon: 103.9915 };

describe('seasonalPhase', () => {
  it('peaks in July north of the equator and in January south of it', () => {
    expect(seasonalPhase(AMSTERDAM.lat, 7)).toBeCloseTo(1, 10);
    expect(seasonalPhase(AMSTERDAM.lat, 1)).toBeCloseTo(-1, 10);

    expect(seasonalPhase(SYDNEY.lat, 1)).toBeCloseTo(1, 10);
    expect(seasonalPhase(SYDNEY.lat, 7)).toBeCloseTo(-1, 10);
  });

  it('refuses a latitude off the planet', () => {
    expect(() => seasonalPhase(120, 1)).toThrow(/[Ll]atitude/);
  });
});

describe('seasonalStrength', () => {
  it('is full at temperate latitudes and slight at the equator', () => {
    expect(seasonalStrength(52)).toBe(1);
    expect(seasonalStrength(1.4)).toBeLessThan(0.05);
  });

  it('does not care which hemisphere', () => {
    expect(seasonalStrength(-52)).toBe(seasonalStrength(52));
  });
});

describe('climateFor', () => {
  /**
   * Against published monthly norms, with a wide tolerance.
   *
   * 3°C, because this is a two-parameter model fitted to latitude and the point
   * is that a January in Amsterdam is cold and a July is not — not that it
   * reproduces a specific year.
   */
  const NORMS: readonly [string, { lat: number; lon: number }, Month, number][] = [
    ['Amsterdam January', AMSTERDAM, 1, 3.4],
    ['Amsterdam July', AMSTERDAM, 7, 18.0],
    ['Singapore January', SINGAPORE, 1, 26.6],
    ['Sydney July', SYDNEY, 7, 12.5],
  ];

  it.each(NORMS)('puts %s within 3°C of the published norm', (_label, place, month, actual) => {
    const climate = climateFor(place.lat, place.lon, month);

    expect(Math.abs(climate.meanTempC - actual)).toBeLessThan(3);
  });

  it('gives the tropics almost no seasonal swing', () => {
    const january = climateFor(SINGAPORE.lat, SINGAPORE.lon, 1).meanTempC;
    const july = climateFor(SINGAPORE.lat, SINGAPORE.lon, 7).meanTempC;

    expect(Math.abs(july - january)).toBeLessThan(5);
  });

  it('gives a temperate latitude a large one', () => {
    const january = climateFor(AMSTERDAM.lat, AMSTERDAM.lon, 1).meanTempC;
    const july = climateFor(AMSTERDAM.lat, AMSTERDAM.lon, 7).meanTempC;

    expect(july - january).toBeGreaterThan(12);
  });

  describe('winterness', () => {
    it('is 1 at midwinter and 0 at midsummer', () => {
      expect(climateFor(AMSTERDAM.lat, AMSTERDAM.lon, 1).winterness).toBeCloseTo(1, 10);
      expect(climateFor(AMSTERDAM.lat, AMSTERDAM.lon, 7).winterness).toBeCloseTo(0, 10);
    });

    it('flips with the hemisphere', () => {
      expect(climateFor(SYDNEY.lat, SYDNEY.lon, 7).winterness).toBeGreaterThan(
        climateFor(SYDNEY.lat, SYDNEY.lon, 1).winterness,
      );
    });

    it('barely moves in the tropics', () => {
      expect(climateFor(SINGAPORE.lat, SINGAPORE.lon, 1).winterness).toBeLessThan(0.05);
    });
  });

  describe('what winter brings', () => {
    it('is foggier, wetter and windier than summer at a temperate latitude', () => {
      const winter = climateFor(AMSTERDAM.lat, AMSTERDAM.lon, 1);
      const summer = climateFor(AMSTERDAM.lat, AMSTERDAM.lon, 7);

      expect(winter.fogChance).toBeGreaterThan(summer.fogChance * 5);
      expect(winter.precipitationChance).toBeGreaterThan(summer.precipitationChance);
      expect(winter.meanWindKt).toBeGreaterThan(summer.meanWindKt);
    });

    it('is more variable day to day than summer', () => {
      // A settled summer week is a real thing; a settled January is not.
      expect(climateFor(AMSTERDAM.lat, AMSTERDAM.lon, 1).tempVariationC).toBeGreaterThan(
        climateFor(AMSTERDAM.lat, AMSTERDAM.lon, 7).tempVariationC,
      );
    });

    it('brings almost no fog to the tropics whatever the month', () => {
      for (const month of [1, 4, 7, 10] as Month[]) {
        expect(climateFor(SINGAPORE.lat, SINGAPORE.lon, month).fogChance).toBeLessThan(0.02);
      }
    });
  });

  it('is a pure function of latitude, month and config', () => {
    expect(climateFor(AMSTERDAM.lat, AMSTERDAM.lon, 3)).toEqual(
      climateFor(AMSTERDAM.lat, AMSTERDAM.lon, 3),
    );
  });

  it('is retunable — the curves are config, not constants', () => {
    const colder = climateFor(AMSTERDAM.lat, AMSTERDAM.lon, 1, {
      ...DEFAULT_CLIMATE,
      equatorialMeanC: 20,
    });

    expect(colder.meanTempC).toBeLessThan(climateFor(AMSTERDAM.lat, AMSTERDAM.lon, 1).meanTempC);
  });
});
