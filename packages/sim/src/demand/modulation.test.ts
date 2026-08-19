import { describe, expect, it } from 'vitest';

import {
  dayOfWeekFactor,
  DEFAULT_MODULATION,
  DEMAND_SEGMENTS,
  inducedDemand,
  modulateDemand,
  type ModulationInputs,
  seasonFactor,
} from './modulation';

import type { SegmentShares } from './gravity';
import type { Weekday } from '../schedule/rotation';
import type { Month } from '../weather/climate';

/**
 * Live demand modulation (M3-02, App. A.2).
 *
 * Three acceptance criteria, and the first two are the ones that would be easy
 * to get subtly wrong and never notice:
 *
 *   1. **Cheap fares grow the pool, not redistribute it.** A.2: *"an LCC
 *      entering a sleepy route doesn't purely steal — it partly creates."*
 *   2. **Summer leisure peaks north and inverts south.**
 *   3. All coefficients read from config.
 */

const AMS_PMI = { originLatitude: 52.3086, destinationLatitude: 39.5517 };
const SYD_MEL = { originLatitude: -33.9461, destinationLatitude: -37.6733 };
/** Amsterdam–Sydney: one end is always in summer. */
const AMS_SYD = { originLatitude: 52.3086, destinationLatitude: -33.9461 };

const EVEN: SegmentShares = { business: 0.2, leisure: 0.6, vfr: 0.2 };

const WEDNESDAY = 3 as Weekday;
const JANUARY = 1 as Month;
const APRIL = 4 as Month;
const JULY = 7 as Month;
const DECEMBER = 12 as Month;

function demand(overrides: Partial<ModulationInputs> = {}) {
  return modulateDemand({
    dailyPassengers: 1_000,
    shares: EVEN,
    month: APRIL,
    weekday: WEDNESDAY,
    route: AMS_PMI,
    ...overrides,
  });
}

describe('seasonFactor', () => {
  describe('summer is a hemisphere — M3-02’s second acceptance criterion', () => {
    it('peaks leisure in July north of the equator', () => {
      expect(seasonFactor('leisure', JULY, AMS_PMI)).toBeGreaterThan(
        seasonFactor('leisure', JANUARY, AMS_PMI),
      );
    });

    it('inverts it south of the equator', () => {
      // The criterion in one assertion. A model that took the month without the
      // latitude would pass the test above and fail this one.
      expect(seasonFactor('leisure', JANUARY, SYD_MEL)).toBeGreaterThan(
        seasonFactor('leisure', JULY, SYD_MEL),
      );
    });

    it('flattens a route that crosses the equator, rather than picking a side', () => {
      // Amsterdam–Sydney has demand all year *because* one end is always in
      // summer. Taking one end's season would give it a strong peak, which is
      // wrong in an interesting way.
      const swing = Math.abs(
        seasonFactor('leisure', JULY, AMS_SYD) - seasonFactor('leisure', JANUARY, AMS_SYD),
      );
      const northern = Math.abs(
        seasonFactor('leisure', JULY, AMS_PMI) - seasonFactor('leisure', JANUARY, AMS_PMI),
      );

      expect(swing).toBeLessThan(northern / 10);
    });
  });

  describe('Christmas is a calendar', () => {
    it('lifts VFR in December in both hemispheres', () => {
      // The asymmetry worth encoding: Sydney celebrates Christmas in December,
      // in the heat. A holiday term that flipped with the hemisphere would put
      // it in June.
      expect(seasonFactor('vfr', DECEMBER, AMS_PMI)).toBeGreaterThan(
        seasonFactor('vfr', APRIL, AMS_PMI),
      );
      expect(seasonFactor('vfr', DECEMBER, SYD_MEL)).toBeGreaterThan(
        seasonFactor('vfr', APRIL, SYD_MEL),
      );
    });

    it('takes business down over the same weeks', () => {
      expect(seasonFactor('business', DECEMBER, AMS_PMI)).toBeLessThan(
        seasonFactor('business', APRIL, AMS_PMI),
      );
    });
  });

  it('moves business against leisure, which is what makes the mix shift', () => {
    const summerLeisure = seasonFactor('leisure', JULY, AMS_PMI);
    const summerBusiness = seasonFactor('business', JULY, AMS_PMI);

    expect(summerLeisure).toBeGreaterThan(1);
    expect(summerBusiness).toBeLessThan(1);
  });

  it('never goes negative, however a curve is retuned', () => {
    // A segment can go quiet; a month cannot produce negative passengers.
    const absurd = {
      ...DEFAULT_MODULATION,
      season: {
        ...DEFAULT_MODULATION.season,
        leisure: { summerAmplitude: -5, holidayBoost: 0 },
      },
    };

    // July, where the phase is at its most positive, so an absurd *negative*
    // amplitude drives the product hardest below zero. December would not
    // trigger it — a negative amplitude times a negative phase is positive,
    // which is the trap the first version of this test fell into.
    expect(seasonFactor('leisure', JULY, AMS_PMI, absurd)).toBe(0);
  });
});

describe('dayOfWeekFactor', () => {
  it('peaks business in the working week and empties it on Saturday', () => {
    expect(dayOfWeekFactor('business', 1)).toBeGreaterThan(1);
    expect(dayOfWeekFactor('business', 6)).toBeLessThan(0.5);
  });

  it('does the opposite for leisure', () => {
    expect(dayOfWeekFactor('leisure', 6)).toBeGreaterThan(dayOfWeekFactor('leisure', 2));
  });

  it('has a factor for every day and every segment', () => {
    for (const segment of DEMAND_SEGMENTS) {
      for (let day = 1; day <= 7; day += 1) {
        expect(dayOfWeekFactor(segment, day as Weekday)).toBeGreaterThan(0);
      }
    }
  });
});

describe('inducedDemand', () => {
  it('is exactly 1 at the reference fare', () => {
    for (const segment of DEMAND_SEGMENTS) {
      expect(inducedDemand(segment, DEFAULT_MODULATION.referenceFareMinor)).toBeCloseTo(1, 12);
    }
  });

  it('grows the market below the reference and shrinks it above', () => {
    expect(inducedDemand('leisure', 3_750)).toBeGreaterThan(1);
    expect(inducedDemand('leisure', 15_000)).toBeLessThan(1);
  });

  it('uses A.2’s elasticities verbatim', () => {
    expect(DEFAULT_MODULATION.elasticity).toEqual({ business: 0.35, leisure: 0.9, vfr: 0.7 });
  });

  it('moves leisure far more than business, which is the whole mechanic', () => {
    // Leisure is nearly three times as price-sensitive. That ordering is why an
    // LCC on a business route wins less than one on a holiday route.
    const half = DEFAULT_MODULATION.referenceFareMinor / 2;

    expect(inducedDemand('leisure', half)).toBeGreaterThan(inducedDemand('vfr', half));
    expect(inducedDemand('vfr', half)).toBeGreaterThan(inducedDemand('business', half));
  });

  it('refuses a fare that is not a price', () => {
    expect(() => inducedDemand('leisure', 0)).toThrow(/[Ff]are/);
    expect(() => inducedDemand('leisure', -100)).toThrow(/[Ff]are/);
  });
});

describe('modulateDemand', () => {
  describe('cheap fares grow the pool — M3-02’s first acceptance criterion', () => {
    it('makes the whole market bigger, not just a different shape', () => {
      const atReference = demand().dailyPassengers;
      const halfPrice = demand({
        marketFareMinor: DEFAULT_MODULATION.referenceFareMinor / 2,
      }).dailyPassengers;

      expect(halfPrice).toBeGreaterThan(atReference * 1.4);
    });

    it('grows every segment, so it cannot be one stealing from another', () => {
      // The distinction A.2 draws — "doesn't purely steal, it partly creates" —
      // and the one this criterion is really testing. If cheap fares only moved
      // the mix, some segment would have to shrink.
      const atReference = demand();
      const halfPrice = demand({ marketFareMinor: DEFAULT_MODULATION.referenceFareMinor / 2 });

      for (const segment of DEMAND_SEGMENTS) {
        expect(halfPrice.bySegment[segment].passengers, segment).toBeGreaterThan(
          atReference.bySegment[segment].passengers,
        );
      }
    });

    it('shrinks the market when the whole market charges more', () => {
      // "A whole market of high-fare operators is a smaller market."
      expect(
        demand({ marketFareMinor: DEFAULT_MODULATION.referenceFareMinor * 2 }).dailyPassengers,
      ).toBeLessThan(demand().dailyPassengers);
    });
  });

  describe('the segment mix moves', () => {
    it('turns a route into a leisure route in the summer', () => {
      const summer = demand({ month: JULY });
      const winter = demand({ month: JANUARY });

      expect(summer.shares.leisure).toBeGreaterThan(winter.shares.leisure);
      expect(summer.shares.business).toBeLessThan(winter.shares.business);
    });

    it('and back into a business route on a Monday', () => {
      const monday = demand({ weekday: 1 });
      const saturday = demand({ weekday: 6 });

      expect(monday.shares.business).toBeGreaterThan(saturday.shares.business * 2);
    });

    it('reports shares that still sum to one after all of it', () => {
      for (const month of [JANUARY, APRIL, JULY, DECEMBER]) {
        for (let day = 1; day <= 7; day += 1) {
          const result = demand({ month, weekday: day as Weekday });
          const total = result.shares.business + result.shares.leisure + result.shares.vfr;
          expect(total, `month ${String(month)} day ${String(day)}`).toBeCloseTo(1, 10);
        }
      }
    });
  });

  describe('the world economy', () => {
    it('scales everything equally', () => {
      // A.2 makes this one scalar. Whether business travel is more
      // recession-proof than leisure is a real question A.2 does not answer, and
      // this does not invent an answer.
      const normal = demand();
      const recession = demand({ economy: 0.8 });

      expect(recession.dailyPassengers).toBeCloseTo(normal.dailyPassengers * 0.8, 6);
      expect(recession.shares).toEqual(normal.shares);
    });

    it('can take a market to nothing without producing nonsense', () => {
      const dead = demand({ economy: 0 });

      expect(dead.dailyPassengers).toBe(0);
      expect(dead.shares).toEqual({ business: 0, leisure: 0, vfr: 0 });
    });
  });

  it('carries every factor that produced the number (§14.1)', () => {
    const result = demand({ month: JULY, weekday: 5, economy: 1.1, marketFareMinor: 5_000 });

    for (const segment of DEMAND_SEGMENTS) {
      const f = result.bySegment[segment];
      // And the product reconciles to the reported figure, so the breakdown is
      // an explanation rather than a decoration.
      expect(f.base * f.season * f.dayOfWeek * f.economy * f.induced).toBeCloseTo(f.passengers, 6);
    }

    const summed = DEMAND_SEGMENTS.reduce((total, s) => total + result.bySegment[s].passengers, 0);
    expect(summed).toBeCloseTo(result.dailyPassengers, 6);
  });

  it('keeps every coefficient in config — M3-02’s third acceptance criterion', () => {
    const doubled = modulateDemand(
      { dailyPassengers: 1_000, shares: EVEN, month: APRIL, weekday: WEDNESDAY, route: AMS_PMI },
      {
        ...DEFAULT_MODULATION,
        dayOfWeek: {
          business: [2, 2, 2, 2, 2, 2, 2],
          leisure: [2, 2, 2, 2, 2, 2, 2],
          vfr: [2, 2, 2, 2, 2, 2, 2],
        },
      },
    );

    expect(doubled.bySegment.leisure.dayOfWeek).toBe(2);
  });

  it('does nothing at all to a route with no market', () => {
    expect(demand({ dailyPassengers: 0 }).dailyPassengers).toBe(0);
  });

  it('refuses inputs that cannot mean anything', () => {
    expect(() => demand({ dailyPassengers: -1 })).toThrow(/[Bb]ase pool/);
    expect(() => demand({ economy: -1 })).toThrow(/[Ee]conomy/);
  });

  it('is a pure function — the same route on the same day is always worth the same', () => {
    expect(demand({ month: JULY, weekday: 5 })).toEqual(demand({ month: JULY, weekday: 5 }));
  });
});
