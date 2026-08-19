/**
 * The weather on a given day at a given airport (M2-09, §8.4, §9.3, §10.2, §24).
 *
 * M2-08 left two holes — `weatherOrigin` and `weatherDestination` on
 * `DisruptionRisk` — and said a world with no weather model should have no
 * weather disruption rather than a made-up amount of it. This fills them.
 *
 * ## Deterministic, and derived per station-day
 *
 * The same stream discipline M2-08 established, for the same reason: a day's
 * weather is keyed on `(worldSeed, 'weather', icao, date)`, so it does not
 * depend on which airports were asked about first, how many, or in what order.
 * Asking for Schiphol on 3 November gives the same answer whether it is the
 * first question of the world or the millionth, and whether one worker asked or
 * two.
 *
 * That is what makes M2-09's second acceptance criterion true — *"weather is
 * deterministic given the world seed and game date"* — and it is also what makes
 * a forecast possible at all: **the future is already decided**, and forecasting
 * is the business of looking at it through progressively worse glass.
 *
 * ## The forecast is a degraded view of a known truth
 *
 * The obvious implementation is to draw a forecast independently and hope it
 * lands near the eventual weather. That would be wrong in a way players notice:
 * forecasts would sometimes contradict what happened by more than the stated
 * confidence, and the band would be decoration.
 *
 * Instead {@link forecastFor} computes the *actual* weather and blends it toward
 * climatology by an amount that grows with the horizon, plus a seeded error of
 * matching size. A three-day forecast is genuinely worse than a one-day
 * forecast, the confidence figure describes how much worse, and the two cannot
 * drift apart because they are computed from the same number.
 */

import { deriveRng, gaussian, type Rng } from '../random';

import {
  type Climate,
  type ClimateConfig,
  climateFor,
  DEFAULT_CLIMATE,
  type Month,
} from './climate';

/** What is falling out of the sky, if anything. */
export type Precipitation = 'none' | 'rain' | 'snow';

/** Where the weather is. Enough of an airport to place it on the planet. */
export interface WeatherStation {
  icaoCode: string;
  latitude: number;
  longitude: number;
}

export interface Weather {
  icaoCode: string;
  /** The game date this describes, `YYYY-MM-DD`. */
  date: string;
  temperatureC: number;
  /** Mean surface wind, knots. */
  windKt: number;
  /**
   * Prevailing visibility in metres.
   *
   * Metres rather than kilometres because that is the unit an aerodrome report
   * uses and the unit the numbers that matter are quoted in: Cat I minima are
   * 550 m, Cat IIIb is 75 m, and a model working in kilometres would round both
   * of them to zero.
   */
  visibilityM: number;
  precipitation: Precipitation;
}

/**
 * Balance numbers (invariant 3).
 *
 * The two thresholds are not invented. **3°C with visible moisture** is the
 * standard trigger for de-icing — airframe ice forms at skin temperatures below
 * the air temperature, so the rule sits above freezing on purpose. **550 m** is
 * Cat I minima, below which an ordinary approach is not permitted and the
 * question becomes what the crew and aircraft are certified for (App. C.3's Cat
 * IIIb, §10.3's all-weather doctrine).
 */
export interface WeatherConfig {
  /** Visibility on a clear day, metres. */
  clearVisibilityM: number;
  /** Visibility in fog: drawn between these, metres. */
  fogVisibilityM: readonly [number, number];
  /** At or below this, precipitation falls as snow rather than rain. */
  snowTemperatureC: number;
  /** At or below this, with moisture present, the aircraft needs de-icing. */
  deIcingTemperatureC: number;
  /** Cat I minima. Below this, an ordinary approach is not available. */
  lowVisibilityM: number;
  /** Wind at which an operation starts to suffer, knots. */
  strongWindKt: number;
  /** Visibility at which an approach starts to suffer, metres. */
  reducedVisibilityM: number;
  /** Wind at which a landing starts to be *interesting* for a crew, knots (§10.2). */
  challengingWindKt: number;
  /** How many game days ahead a forecast is offered. */
  forecastHorizonDays: number;
  /** Confidence lost per day of horizon. */
  forecastConfidenceDecay: number;
  climate: ClimateConfig;
}

export const DEFAULT_WEATHER: WeatherConfig = {
  clearVisibilityM: 10_000,
  fogVisibilityM: [50, 2_000],
  snowTemperatureC: 1,
  deIcingTemperatureC: 3,
  lowVisibilityM: 550,
  strongWindKt: 30,
  reducedVisibilityM: 3_000,
  challengingWindKt: 10,
  forecastHorizonDays: 3,
  forecastConfidenceDecay: 0.25,
  climate: DEFAULT_CLIMATE,
};

/** Version tag. A disruption blamed on weather has to stay explicable (invariant 4). */
export const WEATHER_CONFIG_VERSION = 'v1' as const;

/**
 * `YYYY-MM-DD` in UTC — the key a day's weather is drawn against.
 *
 * UTC deliberately, and it is not a detail. A world's game clock is UTC, and
 * keying on anything local would give an airport two different weathers on the
 * same game day depending on which side of midnight the question arrived from.
 * The cost is that a station's "day" is not its local day, which for a daily
 * granularity model is a rounding error rather than a flaw.
 */
export function dateKey(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new Error('Weather needs a real date');
  return date.toISOString().slice(0, 10);
}

/** The month a date falls in, 1–12. */
export function monthOf(date: Date): Month {
  return (date.getUTCMonth() + 1) as Month;
}

function drawWeather(
  rng: Rng,
  station: WeatherStation,
  date: string,
  climate: Climate,
  config: WeatherConfig,
): Weather {
  const temperatureC = gaussian(rng, climate.meanTempC, climate.tempVariationC);

  // Wind is not symmetric — there is no such thing as negative wind, and calm
  // days are commoner than the mean suggests while gales are rarer. A half-normal
  // folded about the mean would be wrong in the other direction, so the draw is
  // scaled by a positive factor instead.
  const windKt = Math.max(0, gaussian(rng, climate.meanWindKt, climate.meanWindKt * 0.45));

  const wet = rng() < climate.precipitationChance;
  const precipitation: Precipitation = !wet
    ? 'none'
    : temperatureC <= config.snowTemperatureC
      ? 'snow'
      : 'rain';

  // Fog dislikes wind: a gale mixes the boundary layer and the fog is gone. But
  // the coupling is deliberately weak, and the first attempt at this got it
  // badly wrong. Winter is windy *and* foggy in the model's own terms, so a
  // strict `1 - wind/15` suppressor cancelled almost every winter fog and left
  // northern Europe with one low-visibility day a season — the opposite of what
  // M2-09 asks for.
  //
  // The physical reason it was wrong: this is a *daily* model, and a day with a
  // 15-knot mean can still have a foggy dawn, which is when the approaches
  // happen. Only a genuine gale clears the whole day, hence the floor.
  const calm = Math.max(0.3, 1 - windKt / 30);
  const foggy = rng() < climate.fogChance * calm;

  const [fogLow, fogHigh] = config.fogVisibilityM;
  // Squared, so the distribution leans towards the dense end. Fog that closes an
  // airport is not the average fog — a uniform draw would make most events
  // 1,000 m-ish murk that nobody diverts for, and the interesting ones vanish.
  const fogDepth = rng() ** 2;
  const visibilityM = foggy
    ? Math.round(fogLow + fogDepth * (fogHigh - fogLow))
    : // Rain takes the edge off a clear day without ever making it an approach
      // problem on its own.
      Math.round(config.clearVisibilityM * (precipitation === 'none' ? 1 : 0.6));

  return {
    icaoCode: station.icaoCode,
    date,
    temperatureC: Math.round(temperatureC * 10) / 10,
    windKt: Math.round(windKt * 10) / 10,
    visibilityM,
    precipitation,
  };
}

/**
 * The weather at one airport on one game day.
 *
 * Pure and total: the same world seed, airport and date always give the same
 * answer, for ever. That is M2-09's second acceptance criterion, and it is what
 * lets a disruption be re-derived months later when a player asks why their
 * flight was cancelled.
 */
export function weatherFor(
  worldSeed: string,
  station: WeatherStation,
  date: Date,
  config: WeatherConfig = DEFAULT_WEATHER,
): Weather {
  const key = dateKey(date);
  const climate = climateFor(station.latitude, station.longitude, monthOf(date), config.climate);
  const rng = deriveRng(worldSeed, 'weather', station.icaoCode, key);
  return drawWeather(rng, station, key, climate, config);
}

export interface Forecast extends Weather {
  /** Game days ahead this was made. 0 is an observation rather than a forecast. */
  horizonDays: number;
  /**
   * How much to trust it, 0–1.
   *
   * 1 at horizon 0, falling by {@link WeatherConfig.forecastConfidenceDecay} a
   * day. Not decoration: it is the same number used to blend the truth toward
   * climatology, so a confidence of 0.25 really does mean three-quarters of this
   * is the seasonal average rather than the day.
   */
  confidence: number;
}

/**
 * What the forecast said, `horizonDays` before the day it describes.
 *
 * Accuracy degrades because confidence shrinks, and confidence shrinks because
 * the horizon grows — one number, used twice, so the stated uncertainty and the
 * actual error cannot disagree.
 */
export function forecastFor(
  worldSeed: string,
  station: WeatherStation,
  date: Date,
  horizonDays: number,
  config: WeatherConfig = DEFAULT_WEATHER,
): Forecast {
  if (!Number.isInteger(horizonDays) || horizonDays < 0) {
    throw new Error(`Forecast horizon must be a whole number of days, got ${String(horizonDays)}`);
  }
  if (horizonDays > config.forecastHorizonDays) {
    throw new Error(
      `Forecasts run ${String(config.forecastHorizonDays)} days ahead, not ${String(horizonDays)}`,
    );
  }

  const truth = weatherFor(worldSeed, station, date, config);
  const confidence = Math.max(0, 1 - config.forecastConfidenceDecay * horizonDays);

  // Today's weather is observed, not predicted.
  if (horizonDays === 0) return { ...truth, horizonDays, confidence: 1 };

  const climate = climateFor(station.latitude, station.longitude, monthOf(date), config.climate);
  // Keyed on the horizon as well, so a two-day forecast and a one-day forecast
  // for the same day are different guesses rather than the same one twice.
  const rng = deriveRng(
    worldSeed,
    'forecast',
    station.icaoCode,
    dateKey(date),
    String(horizonDays),
  );

  const uncertainty = 1 - confidence;
  const blend = (actual: number, normal: number, spread: number): number =>
    actual * confidence + normal * uncertainty + gaussian(rng, 0, spread * uncertainty);

  const temperatureC = blend(truth.temperatureC, climate.meanTempC, climate.tempVariationC);
  const windKt = Math.max(0, blend(truth.windKt, climate.meanWindKt, climate.meanWindKt * 0.45));
  const visibilityM = Math.max(
    50,
    blend(truth.visibilityM, config.clearVisibilityM, config.clearVisibilityM * 0.3),
  );

  // Precipitation is categorical, so it cannot be blended — it is either kept or
  // replaced by what the season would suggest, at the confidence odds. Which is
  // exactly what a forecaster does: past a few days they stop describing the day
  // and start describing the month.
  const precipitation: Precipitation =
    rng() < confidence
      ? truth.precipitation
      : rng() < climate.precipitationChance
        ? temperatureC <= config.snowTemperatureC
          ? 'snow'
          : 'rain'
        : 'none';

  return {
    icaoCode: station.icaoCode,
    date: truth.date,
    temperatureC: Math.round(temperatureC * 10) / 10,
    windKt: Math.round(windKt * 10) / 10,
    visibilityM: Math.round(visibilityM),
    precipitation,
    horizonDays,
    confidence,
  };
}

/** The whole forecast, today through the horizon. What a planning screen shows. */
export function forecastRun(
  worldSeed: string,
  station: WeatherStation,
  from: Date,
  config: WeatherConfig = DEFAULT_WEATHER,
): Forecast[] {
  const days: Forecast[] = [];
  for (let horizon = 0; horizon <= config.forecastHorizonDays; horizon += 1) {
    const date = new Date(from.getTime() + horizon * 86_400_000);
    days.push(forecastFor(worldSeed, station, date, horizon, config));
  }
  return days;
}

// ---------------------------------------------------------------------------
// What the weather does — the three systems §24 says depend on it
// ---------------------------------------------------------------------------

/**
 * How much this weather threatens an operation, 0–1.
 *
 * Feeds `DisruptionRisk.weatherOrigin` and `weatherDestination` directly (M2-08).
 * Visibility dominates, because it is the one that stops an aeroplane landing at
 * all; wind and snow degrade an operation rather than halting it.
 */
export function weatherSeverity(weather: Weather, config: WeatherConfig = DEFAULT_WEATHER): number {
  // Measured from the point visibility starts to matter, not from a clear day.
  // The first version scaled from 10 km and squared, which made 600 m — poor but
  // routinely operated in — score 0.88, near-certain disruption. Nothing above
  // about 3 km affects an approach, and the curve should start there.
  const reduced = Math.max(0, config.reducedVisibilityM - weather.visibilityM);
  const span = Math.max(1, config.reducedVisibilityM - config.fogVisibilityM[0]);
  const visibility = Math.min(1, reduced / span) ** 2;

  // A step at minima, because the effect is genuinely discontinuous: above it an
  // ordinary approach is legal, below it the question becomes what the crew and
  // aircraft are certified for.
  const belowMinima = weather.visibilityM < config.lowVisibilityM ? 0.25 : 0;

  // Airliners work in 38 knots routinely — typical crosswind limits are around
  // there — so this starts where it becomes a real constraint, not where it
  // becomes noticeable.
  const wind = Math.min(1, Math.max(0, weather.windKt - config.strongWindKt) / 30);
  const snow =
    weather.precipitation === 'snow' ? 0.25 : weather.precipitation === 'rain' ? 0.05 : 0;

  return Math.min(1, visibility + belowMinima + wind + snow);
}

/**
 * Whether the aircraft has to be de-iced before it goes (§9.3).
 *
 * **3°C with visible moisture**, which is the industry rule rather than a game
 * one: ice forms on a wing whose skin is colder than the air around it, so the
 * trigger sits above freezing. Frost on a clear cold morning counts too, which
 * is why the check is not simply "is it snowing".
 */
export function deIcingRequired(
  weather: Weather,
  config: WeatherConfig = DEFAULT_WEATHER,
): boolean {
  if (weather.temperatureC > config.deIcingTemperatureC) return false;
  // Precipitation, or a cold clear night that leaves frost on the wing.
  return weather.precipitation !== 'none' || weather.temperatureC <= 0;
}

/**
 * How hard this was to fly into, 0–1 — §10.2's difficulty multiplier.
 *
 * §10.2 names exactly three weather terms: *"crosswind, low visibility, snow"*.
 * All three are here, and nothing else is, because the section is a list rather
 * than a sketch.
 *
 * Distinct from {@link weatherSeverity} on purpose. Severity asks whether the
 * operation survives; this asks what the crew learned, and the two do not agree
 * — a gale that cancels the flight teaches nobody anything, while a crosswind
 * landing at the limit is the most instructive thing that will happen all month.
 */
export function landingChallenge(
  weather: Weather,
  config: WeatherConfig = DEFAULT_WEATHER,
): number {
  // From the point a wind is worth flying rather than from calm. An eight-knot
  // breeze is not a difficulty multiplier, and treating it as one would hand out
  // XP for a routine day.
  const crosswind = Math.min(1, Math.max(0, weather.windKt - config.challengingWindKt) / 30);
  const visibility = Math.min(
    1,
    Math.max(0, config.reducedVisibilityM - weather.visibilityM) / config.reducedVisibilityM,
  );
  const snow = weather.precipitation === 'snow' ? 0.3 : 0;

  // Wind is weighted above visibility here, which is the opposite of severity's
  // ordering and is the whole reason both exist. Low visibility is flown by the
  // autopilot; a crosswind at the limit is flown by the pilot.
  return Math.min(1, crosswind * 0.6 + visibility * 0.5 + snow);
}
