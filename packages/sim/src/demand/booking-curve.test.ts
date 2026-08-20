import { describe, expect, it } from 'vitest';

import type { DemandSegment } from '@tailfin/shared';

import {
  accrualFraction,
  BOOKING_HORIZON_DAYS,
  bandMix,
  type BookingCurveConfig,
  bookingSlice,
  curveTotals,
  DEFAULT_BOOKING_CURVE,
  emptyCurve,
  recordDay,
} from './booking-curve';
import { computeShares } from './logit';
import { DEMAND_SEGMENTS } from './modulation';

/**
 * The booking curve (M3-08, App. A.15, A.7).
 *
 * A.15 exists to reconcile two things that looked incompatible: A.7's rule that
 * demand resolves once, and §14's booking-curve chart. Its answer is that
 * demand accrues daily and each booking is priced at the fare in force *then*.
 *
 * So the sharpest test here is not a number from the curve — it is that a fare
 * change cannot reach a seat that has already sold.
 */

/** A.2's leisure-heavy holiday route: 20% business, 60% leisure, 20% VFR. */
const POOLS: Record<DemandSegment, number> = { business: 240, leisure: 720, vfr: 240 };

const EARLY = DEFAULT_BOOKING_CURVE.bands[0]!;
const LATE = DEFAULT_BOOKING_CURVE.bands[2]!;

describe('the horizon', () => {
  it('is fourteen days, counting down to the day before departure', () => {
    expect(BOOKING_HORIZON_DAYS).toBe(14);
    // Departure day itself carries no slice, which is how a booking close works
    // and is also what makes "the final 48 h" exactly two days rather than three.
    expect(() => accrualFraction(0, 'leisure')).toThrow(/daysOut must be 1 to 14/);
    expect(() => accrualFraction(15, 'leisure')).toThrow(/daysOut must be 1 to 14/);
  });

  it('uses A.15’s published band shares', () => {
    expect(DEFAULT_BOOKING_CURVE.bands.map((b) => b.share)).toEqual([0.15, 0.45, 0.4]);
    expect([EARLY.fromDaysOut, EARLY.toDaysOut]).toEqual([14, 8]);
    expect([LATE.fromDaysOut, LATE.toDaysOut]).toEqual([2, 1]);
  });

  it('gives every segment a horizon that sums to exactly one', () => {
    // What makes the horizon reconstitute the day's demand rather than
    // approximately reconstitute it. A band gap would quietly delete a day's
    // worth — the hardest bug to see, because the total merely comes out low.
    for (const segment of DEMAND_SEGMENTS) {
      let total = 0;
      for (let daysOut = 1; daysOut <= BOOKING_HORIZON_DAYS; daysOut += 1) {
        total += accrualFraction(daysOut, segment);
      }
      expect(total, segment).toBeCloseTo(1, 12);
    }
  });

  it('books the whole pool across the horizon and no more', () => {
    const booked = { business: 0, leisure: 0, vfr: 0 } as Record<DemandSegment, number>;
    for (let daysOut = 1; daysOut <= BOOKING_HORIZON_DAYS; daysOut += 1) {
      const slice = bookingSlice(daysOut, POOLS);
      for (const segment of DEMAND_SEGMENTS) booked[segment] += slice[segment];
    }

    for (const segment of DEMAND_SEGMENTS) {
      expect(booked[segment], segment).toBeCloseTo(POOLS[segment], 9);
    }
  });

  it('refuses a config that leaves a day uncovered', () => {
    const gap: BookingCurveConfig = {
      bands: [
        { ...EARLY, fromDaysOut: 14, toDaysOut: 9, share: 0.15 },
        DEFAULT_BOOKING_CURVE.bands[1]!,
        LATE,
      ],
    };
    expect(() => accrualFraction(8, 'leisure', gap)).toThrow(/Day 8 of the horizon is in no band/);
  });

  it('refuses bands that overlap or do not sum to one', () => {
    const overlap: BookingCurveConfig = {
      bands: [{ ...EARLY, toDaysOut: 7 }, DEFAULT_BOOKING_CURVE.bands[1]!, LATE],
    };
    expect(() => accrualFraction(5, 'leisure', overlap)).toThrow(/two bands/);

    const short: BookingCurveConfig = {
      bands: [{ ...EARLY, share: 0.1 }, DEFAULT_BOOKING_CURVE.bands[1]!, LATE],
    };
    expect(() => accrualFraction(5, 'leisure', short)).toThrow(/sum to/);
  });
});

describe('A.15’s published band shares', () => {
  /** Total booked in a band, as a share of the whole pool. */
  function bandShares(pools: Record<DemandSegment, number>): number[] {
    const total = DEMAND_SEGMENTS.reduce((a, s) => a + pools[s], 0);
    return DEFAULT_BOOKING_CURVE.bands.map((band) => {
      let sum = 0;
      for (let daysOut = band.toDaysOut; daysOut <= band.fromDaysOut; daysOut += 1) {
        const slice = bookingSlice(daysOut, pools);
        sum += DEMAND_SEGMENTS.reduce((a, s) => a + slice[s], 0);
      }
      return sum / total;
    });
  }

  it('reproduces 15 / 45 / 40 on a route with no segment bias', () => {
    // The calibration. A.15's figures are aggregates, and the tilts are set so
    // that a route with no bias in either direction lands on them.
    const [early, mid, late] = bandShares({ business: 400, leisure: 400, vfr: 400 });

    expect(early).toBeCloseTo(0.15, 2);
    expect(mid).toBeCloseTo(0.45, 2);
    expect(late).toBeCloseTo(0.4, 2);
  });

  it('lets a route’s own mix move the aggregate, which is the mechanic', () => {
    // Not drift. A leisure-heavy route genuinely books earlier and a
    // business-heavy one genuinely books later, because the segments accrue on
    // different schedules — that is the whole of A.15's "the segment mix shifts
    // across the curve". A model that pinned the aggregate at 15/45/40 for
    // every route would have deleted it.
    const holiday = bandShares({ business: 240, leisure: 720, vfr: 240 });
    const city = bandShares({ business: 420, leisure: 480, vfr: 300 });

    expect(holiday[0]!).toBeGreaterThan(city[0]!);
    expect(city[2]!).toBeGreaterThan(holiday[2]!);
  });
});

describe('late-window bookings skew business — the third acceptance criterion', () => {
  const early = bandMix(EARLY, POOLS);
  const late = bandMix(LATE, POOLS);

  it('makes business a far bigger share of the final 48 hours than of the whole pool', () => {
    const inPool = POOLS.business / (POOLS.business + POOLS.leisure + POOLS.vfr);

    expect(inPool).toBeCloseTo(0.2, 9);
    expect(late.business).toBeGreaterThan(inPool * 1.5);
    expect(early.business).toBeLessThan(inPool / 2);
  });

  it('inverts leisure over the same window', () => {
    // A.15's "early leisure, price-led ... late business, price-tolerant" is one
    // statement about two segments, and both halves have to hold.
    expect(early.leisure).toBeGreaterThan(late.leisure);
    expect(late.business).toBeGreaterThan(early.business * 5);
  });

  it('books most business demand in the final band', () => {
    let late48 = 0;
    for (let daysOut = LATE.toDaysOut; daysOut <= LATE.fromDaysOut; daysOut += 1) {
      late48 += accrualFraction(daysOut, 'business');
    }
    expect(late48).toBeGreaterThan(0.5);

    let leisureLate = 0;
    for (let daysOut = LATE.toDaysOut; daysOut <= LATE.fromDaysOut; daysOut += 1) {
      leisureLate += accrualFraction(daysOut, 'leisure');
    }
    // Leisure has largely finished booking by then, which is the contrast.
    expect(leisureLate).toBeLessThan(late48 / 2);
  });

  it('gives revenue management something real to manage', () => {
    // A.15's stated purpose for the shift. If the late window's mix matched the
    // pool's, holding seats back would be pointless and the mechanic absent.
    const shift = Math.abs(late.business - early.business);
    expect(shift).toBeGreaterThan(0.25);
  });
});

describe('the shape of the curve', () => {
  it('sells faster as departure approaches', () => {
    const perDay = (daysOut: number) =>
      DEMAND_SEGMENTS.reduce((sum, s) => sum + bookingSlice(daysOut, POOLS)[s], 0);

    expect(perDay(2)).toBeGreaterThan(perDay(5));
    expect(perDay(5)).toBeGreaterThan(perDay(12));
  });

  it('is flat inside a band, which is the model A.15 specifies', () => {
    // Band totals rather than a smooth curve. The steps between bands are what
    // the design doc asks for; a fitted curve would invent precision it has not
    // got, and would make the published band shares unverifiable.
    for (let daysOut = EARLY.toDaysOut; daysOut < EARLY.fromDaysOut; daysOut += 1) {
      expect(accrualFraction(daysOut, 'leisure')).toBeCloseTo(
        accrualFraction(daysOut + 1, 'leisure'),
        12,
      );
    }
  });

  it('reads every coefficient from config', () => {
    const flat: BookingCurveConfig = {
      bands: DEFAULT_BOOKING_CURVE.bands.map((b) => ({
        ...b,
        tilt: { business: 1, leisure: 1, vfr: 1 },
      })),
    };

    // With no tilt, every segment follows the same shape and the late window's
    // mix is exactly the pool's — the mechanic switched off from data alone.
    const late = bandMix(LATE, POOLS, flat);
    expect(late.business).toBeCloseTo(0.2, 9);
  });
});

describe('a fare change reaches only bookings not yet taken — the first acceptance criterion', () => {
  /** Sell one departure across the horizon, changing the fare partway. */
  function sell(fareByDay: (daysOut: number) => number) {
    let curve = emptyCurve('flight-1');

    for (let daysOut = BOOKING_HORIZON_DAYS; daysOut >= 1; daysOut -= 1) {
      const slice = bookingSlice(daysOut, POOLS);
      const fareMinor = fareByDay(daysOut);

      // A.15: the logit runs once per in-game day per departure, on that day's
      // slice, at *current* fares.
      const shares = computeShares({
        operators: [
          { id: 'you', fareMinor, frequency: 2, productScore: 0.6, reputation: 0.5 },
          { id: 'rival', fareMinor: 10_000, frequency: 3, productScore: 0.6, reputation: 0.5 },
        ],
        segmentPools: slice,
      });

      const bySegment = {} as Record<DemandSegment, number>;
      for (const segment of DEMAND_SEGMENTS) {
        bySegment[segment] =
          shares.bySegment[segment].operators.find((o) => o.operatorId === 'you')?.passengers ?? 0;
      }
      const passengers = DEMAND_SEGMENTS.reduce((sum, s) => sum + bySegment[s], 0);

      curve = recordDay(curve, {
        daysOut,
        bySegment,
        passengers,
        fareMinor,
        revenueMinor: passengers * fareMinor,
      });
    }

    return curve;
  }

  it('leaves already-sold seats at the price they sold for', () => {
    // The anti-exploit property A.7 was protecting, preserved exactly.
    const steady = sell(() => 10_000);
    // Same fare until three days out, then doubled.
    const hiked = sell((daysOut) => (daysOut > 3 ? 10_000 : 20_000));

    const untouched = steady.days.filter((d) => d.daysOut > 3);
    const alsoUntouched = hiked.days.filter((d) => d.daysOut > 3);

    expect(alsoUntouched).toEqual(untouched);
  });

  it('changes what happens from the day of the change onward', () => {
    const steady = sell(() => 10_000);
    const hiked = sell((daysOut) => (daysOut > 3 ? 10_000 : 20_000));

    const after = (c: ReturnType<typeof sell>) =>
      c.days.filter((d) => d.daysOut <= 3).reduce((sum, d) => sum + d.passengers, 0);

    // Doubling the fare in the last three days sells fewer seats.
    expect(after(hiked)).toBeLessThan(after(steady));
  });

  it('blends the fares actually achieved rather than reporting the last one', () => {
    const hiked = sell((daysOut) => (daysOut > 3 ? 10_000 : 20_000));
    const totals = curveTotals(hiked);

    // The whole point of the curve: this departure's seats sold at two prices,
    // and neither one is the honest answer on its own.
    expect(totals.averageFareMinor).toBeGreaterThan(10_000);
    expect(totals.averageFareMinor).toBeLessThan(20_000);
  });

  it('cannot re-run a day, which is what going back in time would look like', () => {
    const curve = recordDay(emptyCurve('f'), {
      daysOut: 5,
      bySegment: { business: 1, leisure: 1, vfr: 1 },
      passengers: 3,
      fareMinor: 9_000,
      revenueMinor: 27_000,
    });

    expect(() =>
      recordDay(curve, {
        daysOut: 5,
        bySegment: { business: 1, leisure: 1, vfr: 1 },
        passengers: 3,
        fareMinor: 20_000,
        revenueMinor: 60_000,
      }),
    ).toThrow(/cannot be re-run/);

    expect(() =>
      recordDay(curve, {
        daysOut: 9,
        bySegment: { business: 1, leisure: 1, vfr: 1 },
        passengers: 3,
        fareMinor: 9_000,
        revenueMinor: 27_000,
      }),
    ).toThrow(/after selling closer in/);
  });
});

describe('the curve is queryable per departure — the second acceptance criterion', () => {
  const curve = [12, 6, 2, 1].reduce(
    (c, daysOut) =>
      recordDay(c, {
        daysOut,
        bySegment: { business: daysOut <= 2 ? 40 : 4, leisure: daysOut <= 2 ? 10 : 30, vfr: 5 },
        passengers: daysOut <= 2 ? 55 : 39,
        fareMinor: daysOut <= 2 ? 15_000 : 9_000,
        revenueMinor: (daysOut <= 2 ? 55 : 39) * (daysOut <= 2 ? 15_000 : 9_000),
      }),
    emptyCurve('flight-2'),
  );

  it('keeps the days, not just a total — the chart §14 wants is the shape', () => {
    expect(curve.days.map((d) => d.daysOut)).toEqual([12, 6, 2, 1]);
    expect(curve.departureId).toBe('flight-2');
  });

  it('totals passengers, revenue and the mix', () => {
    const totals = curveTotals(curve);

    expect(totals.passengers).toBe(39 + 39 + 55 + 55);
    expect(totals.bySegment.business).toBe(4 + 4 + 40 + 40);
    expect(totals.revenueMinor).toBe(2 * 39 * 9_000 + 2 * 55 * 15_000);
  });

  it('reports how much of the selling happened late', () => {
    const totals = curveTotals(curve);
    expect(totals.lateShare).toBeCloseTo(110 / 188, 9);
  });

  it('says nothing rather than dividing by zero on a departure that never sold', () => {
    const totals = curveTotals(emptyCurve('empty'));
    expect(totals.passengers).toBe(0);
    expect(totals.averageFareMinor).toBe(0);
    expect(totals.lateShare).toBe(0);
  });
});

describe('purity', () => {
  it('is deterministic — the same day always slices the same way', () => {
    expect(bookingSlice(7, POOLS)).toEqual(bookingSlice(7, POOLS));
  });

  it('returns a new curve rather than mutating the one it was given', () => {
    const before = emptyCurve('f');
    const after = recordDay(before, {
      daysOut: 3,
      bySegment: { business: 1, leisure: 1, vfr: 1 },
      passengers: 3,
      fareMinor: 1_000,
      revenueMinor: 3_000,
    });

    expect(before.days).toHaveLength(0);
    expect(after.days).toHaveLength(1);
  });

  it('refuses a pool that is not a number of people', () => {
    expect(() => bookingSlice(5, { ...POOLS, leisure: -1 })).toThrow(/pool/);
  });

  it('does nothing to a departure nobody wants', () => {
    const slice = bookingSlice(5, { business: 0, leisure: 0, vfr: 0 });
    for (const segment of DEMAND_SEGMENTS) expect(slice[segment]).toBe(0);
  });
});
