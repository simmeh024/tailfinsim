/**
 * What the weather is normally like here, at this time of year (M2-09, §24).
 *
 * §24's gap table lists weather with *"no source, granularity, forecast horizon
 * or seasonality defined"*. M2-09 supplies granularity (per airport, per game
 * day) and horizon (three days); this file supplies the seasonality, and it is a
 * decision rather than data.
 *
 * ## Climatology, not a forecast service
 *
 * The issue is explicit: *"driven by climatological norms per lat/lon and month
 * plus seeded variation — not a live weather API"*. That is the right call for
 * reasons beyond not wanting a dependency. A world runs at 2× and starts in
 * October 2024; real weather for a game date that has not happened yet does not
 * exist, and for one that has, it would be identical in every world — which
 * would make the shared world less varied rather than more real.
 *
 * So: a parametric model. Two numbers describe the temperature of anywhere on
 * Earth surprisingly well — the annual mean falls off with the square of
 * latitude, and the size of the seasonal swing grows with it — and everything
 * else is hung off how far through that swing the month is.
 *
 * ## What it gets right, and what it cannot
 *
 * Checked against published monthly norms:
 *
 * | station    | model Jan / Jul | actual Jan / Jul |
 * | ---------- | --------------- | ---------------- |
 * | Amsterdam  | 2.8 / 18.4      | 3.4 / 18.0       |
 * | Oslo       | −3.2 / 14.2     | −3.0 / 17.5      |
 * | Singapore  | 25.3 / 28.6     | 26.6 / 27.4      |
 * | Sydney     | 25.7 / 14.5     | 23.0 / 12.5      |
 *
 * And two it gets wrong, both for the same reason: **latitude alone cannot know
 * about oceans**. Reykjavík comes out 7°C too cold in January because the model
 * has never heard of the Gulf Stream, and Dubai 8°C too cool in July because it
 * has never heard of a desert. Both are maritime-versus-continental effects that
 * need a climate-zone lookup rather than a formula.
 *
 * That is a real limitation and it is worth stating plainly rather than
 * discovering later: this model is good in the temperate maritime latitudes
 * where the MVP's network lives, and progressively less good the further you get
 * from them. If a station's weather ever needs to be right rather than
 * plausible, the fix is a Köppen zone on the airport row, not a better curve.
 */

import type { Month } from '@tailfin/shared';

/**
 * Months are 1–12, matching how a date is read rather than how JavaScript counts.
 *
 * Defined in `@tailfin/shared` and re-exported here so that the sim's `Month`
 * and the one `economy_config` validates `holidayMonths` against are the same
 * type rather than two that happen to agree.
 */
export type { Month };

/**
 * The normals for one place in one month. Everything a day is drawn around.
 *
 * Chances are per day, so 0.22 means roughly one day in five.
 */
export interface Climate {
  /** Mean daily temperature, °C. */
  meanTempC: number;
  /** Day-to-day standard deviation, °C. Bigger in winter, and at higher latitudes. */
  tempVariationC: number;
  /** Chance of measurable precipitation. Whether it falls as snow depends on the day. */
  precipitationChance: number;
  /** Chance of a visibility-reducing fog event. */
  fogChance: number;
  /** Mean surface wind, knots. */
  meanWindKt: number;
  /**
   * How far through the cold half of the year this month is, 0–1.
   *
   * 1 at midwinter and 0 at midsummer, hemisphere-aware. Exposed because it is
   * the term everything else is built from, and because a caller asking *"is it
   * winter here"* should not have to re-derive it from the temperature.
   */
  winterness: number;
}

/**
 * Balance numbers (invariant 3). Every one of them is a curve fitted by eye to
 * published norms rather than a physical constant — see the table above for what
 * that buys and what it does not.
 */
export interface ClimateConfig {
  /** Mean temperature at the equator, °C. */
  equatorialMeanC: number;
  /** How fast the annual mean falls with the square of latitude. */
  latitudeCoolingC: number;
  /** How fast the seasonal swing grows with latitude. */
  seasonalGrowthC: number;
  /** The seasonal swing even at the equator — small, but not zero. */
  minimumSeasonalC: number;
  /** Day-to-day temperature variability at midsummer and at midwinter. */
  summerVariationC: number;
  winterVariationC: number;
  /** Precipitation chance at midsummer, and how much winter adds. */
  basePrecipitationChance: number;
  winterPrecipitationChance: number;
  /** Fog chance at midsummer, and how much winter adds. */
  baseFogChance: number;
  winterFogChance: number;
  /** Mean wind at midsummer, and how much winter adds. */
  baseWindKt: number;
  winterWindKt: number;
  /**
   * The latitude at which seasonal effects reach full strength.
   *
   * Below it, winter counts for proportionally less: the tropics have a wet
   * season rather than a cold one, and Singapore's January is not Amsterdam's.
   */
  seasonalLatitude: number;
}

export const DEFAULT_CLIMATE: ClimateConfig = {
  equatorialMeanC: 27,
  latitudeCoolingC: 0.006,
  seasonalGrowthC: 0.12,
  minimumSeasonalC: 1.5,
  summerVariationC: 3,
  winterVariationC: 5.5,
  basePrecipitationChance: 0.28,
  winterPrecipitationChance: 0.18,
  baseFogChance: 0.02,
  winterFogChance: 0.45,
  baseWindKt: 8,
  winterWindKt: 7,
  seasonalLatitude: 45,
};

/** Version tag, like every other config here. Weather has to stay explicable. */
export const CLIMATE_CONFIG_VERSION = 'v1' as const;

function assertLatitude(latitude: number): void {
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new Error(`Latitude must be between -90 and 90, got ${String(latitude)}`);
  }
}

/**
 * How far through the year's warm half a month is: +1 at midsummer, −1 at midwinter.
 *
 * Hemisphere-aware, which is the whole reason this is a function. July is the
 * top of the curve north of the equator and the bottom of it south, and a model
 * that forgot would give Sydney a snowy Christmas.
 */
export function seasonalPhase(latitude: number, month: Month): number {
  assertLatitude(latitude);
  // Peak warmth lags the solstice by about a month — the ocean and ground are
  // still catching up — which is why July and January are the extremes rather
  // than June and December.
  const peakMonth = latitude >= 0 ? 7 : 1;
  return Math.cos((2 * Math.PI * (month - peakMonth)) / 12);
}

/** How strongly the seasons are felt here, 0–1. The tropics barely have them. */
export function seasonalStrength(
  latitude: number,
  config: ClimateConfig = DEFAULT_CLIMATE,
): number {
  assertLatitude(latitude);
  return Math.min(1, Math.abs(latitude) / config.seasonalLatitude);
}

/**
 * The normals for one place in one month.
 *
 * `longitude` is taken and deliberately unused: it is what a continentality term
 * would key off, and the signature should not have to change when one arrives.
 * Naming it rather than omitting it is the honest way to record that the model
 * knows the gap is there.
 */
export function climateFor(
  latitude: number,
  _longitude: number,
  month: Month,
  config: ClimateConfig = DEFAULT_CLIMATE,
): Climate {
  assertLatitude(latitude);

  const phase = seasonalPhase(latitude, month);
  // 1 at midwinter, 0 at midsummer.
  const winterness = ((1 - phase) / 2) * seasonalStrength(latitude, config);

  const annualMean = config.equatorialMeanC - config.latitudeCoolingC * latitude * latitude;
  const amplitude = config.seasonalGrowthC * Math.abs(latitude) + config.minimumSeasonalC;

  return {
    meanTempC: annualMean + amplitude * phase,
    tempVariationC:
      config.summerVariationC + (config.winterVariationC - config.summerVariationC) * winterness,
    precipitationChance:
      config.basePrecipitationChance + config.winterPrecipitationChance * winterness,
    fogChance:
      (config.baseFogChance + config.winterFogChance * winterness) *
      seasonalStrength(latitude, config),
    meanWindKt: config.baseWindKt + config.winterWindKt * winterness,
    winterness,
  };
}
