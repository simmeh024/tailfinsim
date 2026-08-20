import { describe, expect, it } from 'vitest';

import type { DemandSegment } from '@tailfin/shared';

import { MINUTES_PER_DAY } from '../schedule/rotation';

import { computeShares, type Operator } from './logit';
import { DEMAND_SEGMENTS } from './modulation';
import {
  approximateUtcOffsetMinutes,
  CURVE_HOURS,
  curveProfile,
  DEFAULT_SCHED_FIT,
  departureFit,
  localMinuteOfDay,
  MAX_UTC_OFFSET_MINUTES,
  MIN_UTC_OFFSET_MINUTES,
  type SchedFitConfig,
  schedFit,
  schedFitBySegment,
} from './sched-fit';

/**
 * SchedFit (M3-04, App. A.3, §8.2).
 *
 * The first model in M3 with **no published anchor**. A.8 pinned the logit to
 * the digit and A.2 gave the elasticities verbatim; A.3 gives SchedFit one line
 * of prose and a β of 1.0 for business. So these tests cannot check the curves
 * against a source — there isn't one. What they can do is check the three
 * things the issue actually asks for, and then pin the structural properties
 * the design has to hold whatever the numbers get retuned to.
 */

const AT = (hour: number, minute = 0) => hour * 60 + minute;

const SEVEN_AM = AT(7);
const ONE_PM = AT(13);

describe('the acceptance criterion: 07:00 against 13:00', () => {
  it('scores materially higher for business', () => {
    const morning = departureFit(SEVEN_AM, 'business');
    const afternoon = departureFit(ONE_PM, 'business');

    expect(morning).toBeCloseTo(1.0, 6);
    expect(afternoon).toBeCloseTo(0.3, 6);
    expect(morning - afternoon).toBeGreaterThan(0.5);
    // Better than three times as good, not merely better.
    expect(morning / afternoon).toBeGreaterThan(3);
  });

  it('scores about the same for leisure', () => {
    const morning = departureFit(SEVEN_AM, 'leisure');
    const afternoon = departureFit(ONE_PM, 'leisure');

    expect(Math.abs(morning - afternoon)).toBeLessThan(0.15);
    // A.3: "leisure doesn't care." A 07:00 holiday departure is normal, and
    // often the cheap one — so the early morning is only mildly worse, not bad.
    expect(morning).toBeGreaterThan(0.8);
  });

  it('separates the two segments by an order of magnitude', () => {
    // The comparison that matters is not either gap on its own but the ratio
    // between them: this is the mechanic, and a retune that flattened business
    // would pass both tests above while deleting it.
    const businessGap = Math.abs(
      departureFit(SEVEN_AM, 'business') - departureFit(ONE_PM, 'business'),
    );
    const leisureGap = Math.abs(
      departureFit(SEVEN_AM, 'leisure') - departureFit(ONE_PM, 'leisure'),
    );

    expect(businessGap).toBeGreaterThan(leisureGap * 5);
  });
});

describe('the curve shapes', () => {
  it('gives business two peaks with a hole between them', () => {
    // Bimodal on a *single direction*, because the logit resolves one direction
    // at a time and the evening bank is somebody else's journey home. A
    // unimodal morning curve would price an 18:00 departure as worthless when
    // it is the second-best slot of the day.
    const midday = departureFit(AT(12), 'business');

    expect(departureFit(AT(7), 'business')).toBeGreaterThan(midday * 3);
    expect(departureFit(AT(18), 'business')).toBeGreaterThan(midday * 3);
    // And the hole is genuinely between them, not an artefact of the endpoints.
    expect(midday).toBeLessThan(departureFit(AT(9), 'business'));
    expect(midday).toBeLessThan(departureFit(AT(16), 'business'));
  });

  it('makes an overnight business departure worth almost nothing', () => {
    // Not merely low. A 03:00 departure is not a business proposition at any
    // price, and the trough says so.
    expect(departureFit(AT(3), 'business')).toBeLessThan(0.05);
  });

  it('keeps leisure broad across the middle of the day', () => {
    for (let hour = 9; hour <= 17; hour += 1) {
      expect(departureFit(AT(hour), 'leisure'), `${String(hour)}:00`).toBeGreaterThan(0.85);
    }
  });

  it('makes VFR the flattest segment and business the steepest', () => {
    // "VFR is near-flat" — someone flying home to see family takes what is
    // going. The gap between this spread and business's *is* the mechanic.
    const business = curveProfile('business').spread;
    const leisure = curveProfile('leisure').spread;
    const vfr = curveProfile('vfr').spread;

    expect(vfr).toBeLessThan(leisure);
    expect(leisure).toBeLessThan(business);
    expect(vfr).toBeLessThan(0.5);
    expect(business).toBeGreaterThan(0.9);
  });

  it('peaks business in the morning and the others around midday', () => {
    expect(curveProfile('business').bestHour).toBe(7);
    expect(curveProfile('leisure').bestHour).toBeGreaterThanOrEqual(10);
    expect(curveProfile('vfr').bestHour).toBeGreaterThanOrEqual(10);
  });

  it('stays within 0..1 for every segment at every minute', () => {
    for (const segment of DEMAND_SEGMENTS) {
      for (let minute = 0; minute < MINUTES_PER_DAY; minute += 7) {
        const fit = departureFit(minute, segment);
        expect(fit, `${segment} @ ${String(minute)}`).toBeGreaterThanOrEqual(0);
        expect(fit).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('interpolation', () => {
  it('has no cliff at an hour boundary', () => {
    // The reason this is interpolated rather than bucketed. Under buckets,
    // 06:59 → 07:00 would jump the full 0.15 between the anchors, and a player
    // who found that would move departures by one minute for a step change in
    // share. Nobody should be rewarded for that.
    const before = departureFit(AT(6, 59), 'business');
    const after = departureFit(AT(7, 0), 'business');

    expect(Math.abs(after - before)).toBeLessThan(0.01);
  });

  it('lands exactly on the anchors on the hour', () => {
    const curve = DEFAULT_SCHED_FIT.curve.business;
    for (let hour = 0; hour < CURVE_HOURS; hour += 1) {
      expect(departureFit(AT(hour), 'business'), `${String(hour)}:00`).toBeCloseTo(
        curve[hour] ?? 0,
        12,
      );
    }
  });

  it('sits halfway between two anchors at half past', () => {
    const curve = DEFAULT_SCHED_FIT.curve.business;
    const expected = ((curve[7] ?? 0) + (curve[8] ?? 0)) / 2;

    expect(departureFit(AT(7, 30), 'business')).toBeCloseTo(expected, 12);
  });

  it('wraps around midnight rather than falling off the end', () => {
    // 23:30 blends into 00:00, so the clock is circular and there is no seam.
    const curve = DEFAULT_SCHED_FIT.curve.business;
    const expected = ((curve[23] ?? 0) + (curve[0] ?? 0)) / 2;

    expect(departureFit(AT(23, 30), 'business')).toBeCloseTo(expected, 12);
  });

  it('treats a minute past midnight as a clock reading, not an error', () => {
    // A rotation that runs past midnight legitimately produces a departure
    // minute above 1,440, and 25:00 is 01:00.
    expect(departureFit(AT(25), 'business')).toBeCloseTo(departureFit(AT(1), 'business'), 12);
    expect(departureFit(-60, 'business')).toBeCloseTo(departureFit(AT(23), 'business'), 12);
  });
});

describe('combining a bank of departures', () => {
  it('returns the departure’s own fit when there is only one', () => {
    // What makes the single-departure behaviour read straight off the curve.
    for (const segment of DEMAND_SEGMENTS) {
      expect(schedFit([SEVEN_AM], segment)).toBeCloseTo(departureFit(SEVEN_AM, segment), 12);
    }
  });

  it('never scores an operator worse for adding a departure', () => {
    // The property that ruled out the mean. Under a mean, a badly-timed fourth
    // departure lowers SchedFit and the operator is punished for offering more
    // choice — which is wrong on its own terms and double-counts frequency,
    // already priced by A.3's ln(Frequency) term.
    const base = [AT(7)];
    for (const segment of DEMAND_SEGMENTS) {
      let previous = schedFit(base, segment);
      for (const extra of [AT(3), AT(13), AT(23), AT(2)]) {
        base.push(extra);
        const now = schedFit(base, segment);
        expect(now, `${segment} after adding ${String(extra)}`).toBeGreaterThanOrEqual(
          previous - 1e-12,
        );
        previous = now;
      }
      base.length = 1;
    }
  });

  it('rewards a well-spread bank over a clustered one, for business', () => {
    const spread = schedFit([AT(7), AT(18)], 'business');
    const clustered = schedFit([AT(12), AT(14)], 'business');

    expect(spread).toBeGreaterThan(0.9);
    expect(clustered).toBeLessThan(0.6);
  });

  it('barely distinguishes the same two banks for VFR', () => {
    // Near-flat means near-indifferent, and that is what makes a VFR-heavy
    // route a different planning problem from a business-heavy one.
    const spread = schedFit([AT(7), AT(18)], 'vfr');
    const clustered = schedFit([AT(12), AT(14)], 'vfr');

    expect(Math.abs(spread - clustered)).toBeLessThan(0.02);
  });

  it('saturates at high frequency, deliberately', () => {
    // Stated rather than hidden: an operator flying six times across the day
    // has a flight when you want one, so SchedFit stops differentiating. That
    // is intended — scheduling skill matters most where choices are scarce.
    const often = schedFit([AT(6), AT(8), AT(11), AT(14), AT(17), AT(19)], 'business');
    expect(often).toBeGreaterThan(0.99);
  });

  it('still separates a badly-timed high-frequency bank', () => {
    // Saturation must not mean "any six flights score 1". Six departures all in
    // the dead middle of the afternoon should remain visibly worse.
    const bad = schedFit([AT(12), AT(12, 30), AT(13), AT(13, 30), AT(14), AT(14, 30)], 'business');
    const good = schedFit([AT(6), AT(8), AT(11), AT(14), AT(17), AT(19)], 'business');

    expect(bad).toBeLessThan(good);
    expect(good - bad).toBeGreaterThan(0.1);
  });

  it('shapes a result for every segment at once', () => {
    const fit = schedFitBySegment([AT(7), AT(18)]);

    expect(Object.keys(fit).sort()).toEqual(['business', 'leisure', 'vfr']);
    for (const segment of DEMAND_SEGMENTS) {
      expect(fit[segment]).toBeCloseTo(schedFit([AT(7), AT(18)], segment), 12);
    }
  });

  it('refuses an operator with no departures', () => {
    expect(() => schedFit([], 'business')).toThrow(/no departures/);
  });
});

describe('local time from a UTC offset', () => {
  it('converts a UTC instant to the local clock', () => {
    expect(localMinuteOfDay(new Date('2026-06-01T12:00:00Z'), 60)).toBe(AT(13));
    expect(localMinuteOfDay(new Date('2026-06-01T12:00:00Z'), -60)).toBe(AT(11));
    expect(localMinuteOfDay(new Date('2026-06-01T12:00:00Z'), 0)).toBe(AT(12));
  });

  it('handles the offsets no longitude band could express', () => {
    // Kolkata +5:30 and Kathmandu +5:45 — the cases that made M3-04a worth
    // doing. Under longitude ÷ 15 these were unreachable by construction.
    expect(localMinuteOfDay(new Date('2026-06-01T06:00:00Z'), 330)).toBe(AT(11, 30));
    expect(localMinuteOfDay(new Date('2026-06-01T06:00:00Z'), 345)).toBe(AT(11, 45));
  });

  it('wraps across midnight in both directions', () => {
    expect(localMinuteOfDay(new Date('2026-06-01T23:30:00Z'), 60)).toBe(AT(0, 30));
    expect(localMinuteOfDay(new Date('2026-06-01T00:30:00Z'), -60)).toBe(AT(23, 30));
  });

  it('accepts the whole real range and nothing beyond it', () => {
    // Kiritimati is +14 and Baker Island −12. Anything outside is a bug in
    // whatever produced the offset, and this is the last place to notice.
    expect(localMinuteOfDay(new Date('2026-06-01T12:00:00Z'), MAX_UTC_OFFSET_MINUTES)).toBe(AT(2));
    expect(localMinuteOfDay(new Date('2026-06-01T12:00:00Z'), MIN_UTC_OFFSET_MINUTES)).toBe(AT(0));
    expect(() => localMinuteOfDay(new Date('2026-06-01T12:00:00Z'), 900)).toThrow(/UTC offset/);
    expect(() => localMinuteOfDay(new Date('2026-06-01T12:00:00Z'), Number.NaN)).toThrow(
      /UTC offset/,
    );
  });
});

describe('the longitude fallback', () => {
  it('is UTC at Greenwich and one hour per fifteen degrees', () => {
    expect(approximateUtcOffsetMinutes(0)).toBe(0);
    expect(approximateUtcOffsetMinutes(15)).toBe(60);
    expect(approximateUtcOffsetMinutes(-15)).toBe(-60);
    expect(approximateUtcOffsetMinutes(180)).toBe(720);
    expect(approximateUtcOffsetMinutes(-180)).toBe(-720);
  });

  it('is still wrong for Amsterdam, which is why it is only a fallback', () => {
    // AMS at 4.76°E resolves to UTC+19min against a real UTC+1. M3-04a did not
    // fix this function — it stopped the model depending on it. The server now
    // records `timezone_basis = 'longitude'` wherever this was used, so a wrong
    // figure can be traced here rather than mistaken for a real one.
    expect(approximateUtcOffsetMinutes(4.7639)).toBe(19);
  });

  it('refuses a longitude that is not one', () => {
    expect(() => approximateUtcOffsetMinutes(181)).toThrow(/[Ll]ongitude/);
    expect(() => approximateUtcOffsetMinutes(Number.NaN)).toThrow(/[Ll]ongitude/);
  });
});

describe('configuration — the second acceptance criterion', () => {
  it('reads every value from config', () => {
    // "Curves are config data." Editing them live is M3-11's (#41) job; what
    // this issue owes is that nothing is hard-coded in the model.
    const flat: SchedFitConfig = {
      ...DEFAULT_SCHED_FIT,
      curve: {
        ...DEFAULT_SCHED_FIT.curve,
        business: Array.from({ length: CURVE_HOURS }, () => 0.5),
      },
    };

    expect(departureFit(SEVEN_AM, 'business', flat)).toBeCloseTo(0.5, 12);
    expect(departureFit(ONE_PM, 'business', flat)).toBeCloseTo(0.5, 12);
    // With a flat curve, timing stops mattering entirely — which is the
    // clearest demonstration that the mechanic lives in the data.
    expect(schedFit([AT(3)], 'business', flat)).toBeCloseTo(0.5, 12);
  });

  it('has twenty-four values for every segment', () => {
    for (const segment of DEMAND_SEGMENTS) {
      expect(DEFAULT_SCHED_FIT.curve[segment], segment).toHaveLength(CURVE_HOURS);
    }
  });

  it('rejects a curve that is not a full day', () => {
    const short: SchedFitConfig = {
      ...DEFAULT_SCHED_FIT,
      curve: { ...DEFAULT_SCHED_FIT.curve, business: [0.5, 0.5] },
    };

    expect(() => departureFit(SEVEN_AM, 'business', short)).toThrow(/hourly values/);
  });

  it('reads the bank exponent from config, and rejects a nonsensical one', () => {
    const clustered = [AT(12), AT(14)];
    const plain: SchedFitConfig = { ...DEFAULT_SCHED_FIT, bankExponent: 1 };

    // The measurement that put the exponent there: at 1, a badly-timed bank
    // scores materially higher, because frequency buys its way out of bad
    // timing. This is the regression guard on that decision.
    expect(schedFit(clustered, 'business', plain)).toBeGreaterThan(
      schedFit(clustered, 'business') + 0.05,
    );

    expect(() =>
      schedFit(clustered, 'business', { ...DEFAULT_SCHED_FIT, bankExponent: 0 }),
    ).toThrow(/[Bb]ank exponent/);
  });

  it('returns a single departure’s own fit at any exponent', () => {
    // The root undoes the discount, so the property that makes the curve
    // readable survives retuning.
    for (const bankExponent of [1, 1.5, 2, 3, 5]) {
      expect(
        schedFit([SEVEN_AM], 'business', { ...DEFAULT_SCHED_FIT, bankExponent }),
        `exponent ${String(bankExponent)}`,
      ).toBeCloseTo(departureFit(SEVEN_AM, 'business'), 9);
    }
  });

  it('is pure — the same bank always scores the same', () => {
    const bank = [AT(7), AT(18)];
    expect(schedFitBySegment(bank)).toEqual(schedFitBySegment(bank));
  });
});

describe('in the logit — the third acceptance criterion', () => {
  const base = { fareMinor: 10_000, frequency: 2, productScore: 0.6, reputation: 0.5 };

  /** Identical airlines; the *only* difference is when they fly. */
  const wellTimed: Operator = {
    ...base,
    id: 'morning-and-evening',
    schedFit: schedFitBySegment([AT(7), AT(18)]),
  };
  const badlyTimed: Operator = {
    ...base,
    id: 'middle-of-the-afternoon',
    schedFit: schedFitBySegment([AT(12), AT(14)]),
  };

  const pools: Record<DemandSegment, number> = { business: 240, leisure: 720, vfr: 240 };
  const result = computeShares({ operators: [wellTimed, badlyTimed], segmentPools: pools });

  const share = (segment: DemandSegment, id: string) =>
    result.bySegment[segment].operators.find((o) => o.operatorId === id)?.share ?? 0;

  it('hands the business market to the operator that flies when business flies', () => {
    // Same fare, same cabin, same reputation, same frequency. The entire
    // difference is a departure board.
    expect(share('business', 'morning-and-evening')).toBeGreaterThan(0.55);
    expect(
      share('business', 'morning-and-evening') - share('business', 'middle-of-the-afternoon'),
    ).toBeGreaterThan(0.2);
  });

  it('splits leisure almost evenly between them', () => {
    // A.3: "leisure doesn't care." A near-even split on the same inputs that
    // decided business is the clearest evidence the segmentation works.
    expect(
      Math.abs(
        share('leisure', 'morning-and-evening') - share('leisure', 'middle-of-the-afternoon'),
      ),
    ).toBeLessThan(0.02);
  });

  it('carries the schedule term into the decomposition', () => {
    // §14.1: a player who loses on timing must be able to see that is why.
    const row = result.bySegment.business.operators.find(
      (o) => o.operatorId === 'middle-of-the-afternoon',
    );
    const rival = result.bySegment.business.operators.find(
      (o) => o.operatorId === 'morning-and-evening',
    );

    // β_sched is 1.0 for business, so the term is the fit itself.
    expect(row?.terms.schedule).toBeCloseTo(schedFit([AT(12), AT(14)], 'business'), 9);
    expect(rival?.terms.schedule).toBeCloseTo(schedFit([AT(7), AT(18)], 'business'), 9);
    expect((rival?.terms.schedule ?? 0) - (row?.terms.schedule ?? 0)).toBeGreaterThan(0.2);
  });

  it('changes nothing when neither operator supplies a schedule', () => {
    // The default stays zero, so M3-03's existing behaviour is untouched for
    // any caller that has not adopted this yet.
    const without = computeShares({
      operators: [
        { ...base, id: 'morning-and-evening' },
        { ...base, id: 'middle-of-the-afternoon' },
      ],
      segmentPools: pools,
    });

    for (const segment of DEMAND_SEGMENTS) {
      for (const row of without.bySegment[segment].operators) {
        expect(row.terms.schedule, `${segment}/${row.operatorId}`).toBe(0);
        expect(row.share).toBeCloseTo(0.5, 12);
      }
    }
  });
});
