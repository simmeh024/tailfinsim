import { describe, expect, it } from 'vitest';

import { rollDisruption } from '../flight/disruption';
import { deriveRng } from '../random';

import {
  dateKey,
  DEFAULT_WEATHER,
  deIcingRequired,
  forecastFor,
  forecastRun,
  landingChallenge,
  monthOf,
  type Weather,
  weatherFor,
  weatherSeverity,
  type WeatherStation,
} from './weather';

/**
 * The weather itself (M2-09, §8.4, §9.3, §10.2).
 *
 * The three acceptance criteria, in order of how easy they are to get wrong:
 *
 *   1. **Northern European winters produce more low-visibility and de-icing
 *      events than summers.** The first attempt at this failed — winter was
 *      modelled as windy *and* foggy, and a strict calm requirement cancelled
 *      almost every winter fog. See the note in `drawWeather`.
 *   2. Weather is deterministic given the world seed and game date.
 *   3. Forecast accuracy degrades with horizon.
 */

const AMS: WeatherStation = { icaoCode: 'EHAM', latitude: 52.3086, longitude: 4.76389 };
const OSL: WeatherStation = { icaoCode: 'ENGM', latitude: 60.1939, longitude: 11.1004 };
const SIN: WeatherStation = { icaoCode: 'WSSS', latitude: 1.3644, longitude: 103.9915 };
const SYD: WeatherStation = { icaoCode: 'YSSY', latitude: -33.9461, longitude: 151.1772 };

const SEED = 'world-seed-1';

function day(year: number, month: number, date: number): Date {
  return new Date(Date.UTC(year, month - 1, date));
}

/** Every day of one month at one station. */
function month(station: WeatherStation, year: number, m: number, seed = SEED): Weather[] {
  const days: Weather[] = [];
  for (let d = 1; d <= 28; d += 1) days.push(weatherFor(seed, station, day(year, m, d)));
  return days;
}

/** Several years of one month, so a claim rests on more than 28 draws. */
function season(station: WeatherStation, m: number, years = 6): Weather[] {
  const days: Weather[] = [];
  for (let y = 0; y < years; y += 1) days.push(...month(station, 2025 + y, m));
  return days;
}

const lowVisibility = (w: Weather) => w.visibilityM < DEFAULT_WEATHER.lowVisibilityM;

describe('dateKey', () => {
  it('is the UTC calendar day', () => {
    expect(dateKey(new Date('2026-08-17T23:59:00.000Z'))).toBe('2026-08-17');
  });

  it('refuses a date that is not one', () => {
    expect(() => dateKey(new Date('nonsense'))).toThrow(/real date/);
  });
});

describe('monthOf', () => {
  it('counts from one, the way a date is read', () => {
    expect(monthOf(new Date('2026-01-15T00:00:00.000Z'))).toBe(1);
    expect(monthOf(new Date('2026-12-15T00:00:00.000Z'))).toBe(12);
  });
});

describe('weatherFor', () => {
  describe('determinism — M2-09’s second acceptance criterion', () => {
    it('gives the same station-day the same weather every time', () => {
      expect(weatherFor(SEED, AMS, day(2026, 1, 15))).toEqual(
        weatherFor(SEED, AMS, day(2026, 1, 15)),
      );
    });

    it('is unaffected by how many other stations were asked about first', () => {
      // The stream discipline M2-08 established. Asking about Schiphol gives the
      // same answer whether it is the first question of the world or the
      // millionth, and whether one worker asked or two.
      const alone = weatherFor(SEED, AMS, day(2026, 1, 15));

      for (let i = 0; i < 200; i += 1) {
        weatherFor(SEED, { ...AMS, icaoCode: `X${String(i)}` }, day(2026, 1, 15));
        weatherFor(SEED, AMS, day(2026, 2, (i % 28) + 1));
      }

      expect(weatherFor(SEED, AMS, day(2026, 1, 15))).toEqual(alone);
    });

    it('gives two worlds different weather on the same day', () => {
      const a = month(AMS, 2026, 1, 'world-a');
      const b = month(AMS, 2026, 1, 'world-b');

      expect(a).not.toEqual(b);
    });

    it('gives neighbouring days unrelated weather, not a drifting sequence', () => {
      // Each day is drawn independently from the month's norms. A model that
      // walked from yesterday would need state, and state is what makes replay
      // depend on where you started reading.
      const days = month(AMS, 2026, 1).map((w) => w.temperatureC);
      const unique = new Set(days);

      expect(unique.size).toBeGreaterThan(20);
    });
  });

  describe('northern European winters — M2-09’s first acceptance criterion', () => {
    const winter = [...season(AMS, 1), ...season(OSL, 1)];
    const summer = [...season(AMS, 7), ...season(OSL, 7)];

    it('needs de-icing far more often in January than in July', () => {
      const winterDeIcing = winter.filter((w) => deIcingRequired(w)).length;
      const summerDeIcing = summer.filter((w) => deIcingRequired(w)).length;

      expect(winterDeIcing).toBeGreaterThan(summerDeIcing * 10);
      // And often enough to be an operational fact rather than a curiosity.
      expect(winterDeIcing / winter.length).toBeGreaterThan(0.2);
    });

    it('drops below Cat I minima more often in January than in July', () => {
      const winterFog = winter.filter(lowVisibility).length;
      const summerFog = summer.filter(lowVisibility).length;

      expect(winterFog).toBeGreaterThan(summerFog);
      expect(winterFog).toBeGreaterThan(10);
    });

    it('snows in January and not in July', () => {
      expect(winter.filter((w) => w.precipitation === 'snow').length).toBeGreaterThan(20);
      expect(summer.filter((w) => w.precipitation === 'snow').length).toBe(0);
    });

    it('is a harder place to operate in January, taken as a whole', () => {
      const mean = (days: Weather[]) =>
        days.reduce((sum, w) => sum + weatherSeverity(w), 0) / days.length;

      expect(mean(winter)).toBeGreaterThan(mean(summer) * 2);
    });
  });

  describe('the rest of the planet', () => {
    it('never needs de-icing in Singapore', () => {
      const year = [1, 4, 7, 10].flatMap((m) => season(SIN, m, 3));

      expect(year.filter((w) => deIcingRequired(w))).toHaveLength(0);
      expect(year.filter((w) => w.precipitation === 'snow')).toHaveLength(0);
    });

    it('gives Sydney its winter in July, not January', () => {
      const meanTemp = (days: Weather[]) =>
        days.reduce((sum, w) => sum + w.temperatureC, 0) / days.length;

      expect(meanTemp(season(SYD, 7))).toBeLessThan(meanTemp(season(SYD, 1)));
    });
  });

  it('stays inside physically sensible bounds', () => {
    for (const station of [AMS, OSL, SIN, SYD]) {
      for (const m of [1, 4, 7, 10]) {
        for (const w of month(station, 2026, m)) {
          expect(w.windKt).toBeGreaterThanOrEqual(0);
          expect(w.visibilityM).toBeGreaterThan(0);
          expect(w.visibilityM).toBeLessThanOrEqual(DEFAULT_WEATHER.clearVisibilityM);
          expect(w.temperatureC).toBeGreaterThan(-60);
          expect(w.temperatureC).toBeLessThan(60);
        }
      }
    }
  });
});

describe('forecastFor', () => {
  it('reports today exactly, because today is observed rather than predicted', () => {
    const truth = weatherFor(SEED, AMS, day(2026, 1, 15));
    const forecast = forecastFor(SEED, AMS, day(2026, 1, 15), 0);

    expect(forecast.confidence).toBe(1);
    expect(forecast.temperatureC).toBe(truth.temperatureC);
    expect(forecast.visibilityM).toBe(truth.visibilityM);
    expect(forecast.precipitation).toBe(truth.precipitation);
  });

  it('loses confidence with every day of horizon', () => {
    const confidence = [0, 1, 2, 3].map(
      (h) => forecastFor(SEED, AMS, day(2026, 1, 15), h).confidence,
    );

    expect(confidence).toEqual([1, 0.75, 0.5, 0.25]);
  });

  it('degrades in accuracy with horizon — M2-09’s third acceptance criterion', () => {
    // Measured across a season rather than asserted on one day: a single
    // three-day forecast can be luckier than a one-day forecast, and only the
    // average is a property of the model.
    const error = (horizon: number): number => {
      let total = 0;
      let n = 0;
      for (const station of [AMS, OSL, SIN]) {
        for (let d = 1; d <= 28; d += 1) {
          const date = day(2026, 1, d);
          const truth = weatherFor(SEED, station, date);
          const forecast = forecastFor(SEED, station, date, horizon);
          total += Math.abs(forecast.temperatureC - truth.temperatureC);
          n += 1;
        }
      }
      return total / n;
    };

    const [one, two, three] = [error(1), error(2), error(3)];

    expect(one).toBeLessThan(two);
    expect(two).toBeLessThan(three);
    // And a one-day forecast should be genuinely useful, not merely better.
    expect(one).toBeLessThan(3);
  });

  it('is deterministic, so the same forecast is never given twice differently', () => {
    expect(forecastFor(SEED, AMS, day(2026, 1, 15), 2)).toEqual(
      forecastFor(SEED, AMS, day(2026, 1, 15), 2),
    );
  });

  it('makes a different guess at two days out than at one', () => {
    // Otherwise the forecast would not be improving as the day approaches, it
    // would just be repeating itself with a smaller error bar.
    const one = forecastFor(SEED, AMS, day(2026, 1, 15), 1);
    const two = forecastFor(SEED, AMS, day(2026, 1, 15), 2);

    expect(one.temperatureC).not.toBe(two.temperatureC);
  });

  it('refuses a horizon beyond what it offers', () => {
    expect(() => forecastFor(SEED, AMS, day(2026, 1, 15), 4)).toThrow(/3 days ahead/);
    expect(() => forecastFor(SEED, AMS, day(2026, 1, 15), -1)).toThrow(/whole number/);
  });

  it('runs today plus the horizon, which is what a planning screen shows', () => {
    const run = forecastRun(SEED, AMS, day(2026, 1, 15));

    expect(run).toHaveLength(4);
    expect(run.map((f) => f.horizonDays)).toEqual([0, 1, 2, 3]);
    expect(run.map((f) => f.date)).toEqual([
      '2026-01-15',
      '2026-01-16',
      '2026-01-17',
      '2026-01-18',
    ]);
  });
});

describe('what the weather does', () => {
  function fixed(overrides: Partial<Weather>): Weather {
    return {
      icaoCode: 'EHAM',
      date: '2026-01-15',
      temperatureC: 10,
      windKt: 8,
      visibilityM: 10_000,
      precipitation: 'none',
      ...overrides,
    };
  }

  describe('weatherSeverity — feeding M2-08', () => {
    it('is nothing on a clear calm day', () => {
      expect(weatherSeverity(fixed({}))).toBe(0);
    });

    it('stays inside 0–1, which is what DisruptionRisk requires', () => {
      const worst = fixed({ visibilityM: 50, windKt: 70, precipitation: 'snow' });

      expect(weatherSeverity(worst)).toBeLessThanOrEqual(1);
      expect(weatherSeverity(worst)).toBeGreaterThan(0.9);
    });

    it('is nothing at all above about three kilometres', () => {
      // The correction the first version needed: 5 km is fine, and scaling from
      // a clear 10 km made 600 m — poor but routinely operated in — score 0.88.
      expect(weatherSeverity(fixed({ visibilityM: 5_000 }))).toBe(0);
      expect(weatherSeverity(fixed({ visibilityM: 3_000 }))).toBe(0);
      expect(weatherSeverity(fixed({ visibilityM: 1_500 }))).toBeGreaterThan(0.1);
    });

    it('steps as visibility crosses Cat I minima', () => {
      // Compared against an equal span that does *not* cross, because the claim
      // is that the effect is discontinuous — not merely that less is worse.
      const crossing =
        weatherSeverity(fixed({ visibilityM: 400 })) - weatherSeverity(fixed({ visibilityM: 600 }));
      const notCrossing =
        weatherSeverity(fixed({ visibilityM: 800 })) -
        weatherSeverity(fixed({ visibilityM: 1_000 }));

      expect(crossing).toBeGreaterThan(notCrossing * 2);
    });

    it('shrugs at a wind airliners operate in every day', () => {
      // Typical crosswind limits are around 38 knots. Treating that as
      // half-certain disruption would ground a network that flies fine.
      expect(weatherSeverity(fixed({ windKt: 38 }))).toBeLessThan(0.35);
      expect(weatherSeverity(fixed({ windKt: 60 }))).toBeGreaterThan(0.9);
    });

    it('actually disrupts flights when handed to M2-08', () => {
      // The join both milestones exist for. Weather severity is the input
      // M2-08 left open, and a fogbound day should visibly cost flights.
      const fogbound = weatherSeverity(fixed({ visibilityM: 200, windKt: 5 }));
      const clear = weatherSeverity(fixed({}));

      const disrupted = (severity: number) => {
        let n = 0;
        for (let i = 0; i < 300; i += 1) {
          const roll = rollDisruption(deriveRng(SEED, 'flight', String(i)), {
            weatherOrigin: severity,
            weatherDestination: 0,
            atcFlow: 0,
            technical: 0,
            crewTimeout: 0,
            groundVendor: 0,
            airportClosure: 0,
            boosts: [],
          });
          if (roll) n += 1;
        }
        return n;
      };

      expect(disrupted(clear)).toBe(0);
      expect(disrupted(fogbound)).toBeGreaterThan(20);
    });
  });

  describe('deIcingRequired — feeding §9.3', () => {
    it('is the 3°C-with-moisture rule, not a freezing rule', () => {
      // Ice forms on a wing colder than the air around it, so the industry
      // trigger sits above freezing.
      expect(deIcingRequired(fixed({ temperatureC: 2, precipitation: 'rain' }))).toBe(true);
      expect(deIcingRequired(fixed({ temperatureC: 4, precipitation: 'snow' }))).toBe(false);
    });

    it('catches frost on a clear cold night with nothing falling', () => {
      expect(deIcingRequired(fixed({ temperatureC: -3, precipitation: 'none' }))).toBe(true);
    });

    it('leaves a cold dry day above freezing alone', () => {
      expect(deIcingRequired(fixed({ temperatureC: 2, precipitation: 'none' }))).toBe(false);
    });

    it('never fires on a warm day whatever is falling', () => {
      expect(deIcingRequired(fixed({ temperatureC: 20, precipitation: 'rain' }))).toBe(false);
    });
  });

  describe('landingChallenge — feeding §10.2', () => {
    it('uses exactly the three terms §10.2 names', () => {
      // "Crosswind, low visibility, snow." Each has to move it on its own.
      const calm = landingChallenge(fixed({}));

      expect(landingChallenge(fixed({ windKt: 35 }))).toBeGreaterThan(calm);
      expect(landingChallenge(fixed({ visibilityM: 400 }))).toBeGreaterThan(calm);
      expect(landingChallenge(fixed({ precipitation: 'snow' }))).toBeGreaterThan(calm);
    });

    it('stays inside 0–1', () => {
      const worst = fixed({ windKt: 60, visibilityM: 50, precipitation: 'snow' });

      expect(landingChallenge(worst)).toBeLessThanOrEqual(1);
      expect(landingChallenge(fixed({}))).toBe(0);
    });

    it('disagrees with severity, which is the point of having both', () => {
      // A gale that cancels the flight teaches nobody anything; a crosswind
      // landing at the limit is the most instructive thing all month. Severity
      // asks whether the operation survives, this asks what the crew learned.
      const windy = fixed({ windKt: 38, visibilityM: 10_000 });

      expect(landingChallenge(windy)).toBeGreaterThan(weatherSeverity(windy));
    });
  });
});
