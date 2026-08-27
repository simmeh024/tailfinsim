import { describe, expect, it } from 'vitest';

import type { DemandSegment } from '@tailfin/shared';

import {
  computeShares,
  decomposeAgainst,
  DEFAULT_LOGIT,
  type LogitConfig,
  marketFare,
  type Operator,
  type ShareResult,
  totalUtility,
  utilityTerms,
} from './logit';
import { DEMAND_SEGMENTS } from './modulation';

/**
 * The segmented multinomial logit (M3-03, App. A.3–A.4, A.8–A.9).
 *
 * A.8 is a fully worked example — three operators, two segments, every
 * intermediate figure printed — which makes it a rare thing in this codebase: a
 * published set of expected outputs that were not invented here. The arithmetic
 * was checked independently before any of this was written, and it holds to
 * three decimal places throughout.
 *
 * That matters because a share model is easy to get *plausibly* wrong. M2-05's
 * fuel curve and M3-01's gravity curve both satisfied their single calibration
 * point while being wrong everywhere else. A.8 pins three operators across two
 * segments at once, so a coefficient applied to the wrong term cannot pass.
 */

/** A.8: AMS–BCN, pool 1,200/day, mix 20% business / 60% leisure / 20% VFR. */
const YOU: Operator = {
  id: 'you',
  fareMinor: 9_500,
  frequency: 3,
  productScore: 0.62,
  reputation: 0.55,
};
const RIVAL_A: Operator = {
  id: 'a',
  fareMinor: 6_900,
  frequency: 5,
  productScore: 0.38,
  reputation: 0.45,
};
const RIVAL_B: Operator = {
  id: 'b',
  fareMinor: 14_000,
  frequency: 4,
  productScore: 0.78,
  reputation: 0.72,
};

const A8_OPERATORS = [YOU, RIVAL_A, RIVAL_B];
const A8_POOLS: Record<DemandSegment, number> = { business: 240, leisure: 720, vfr: 240 };

/**
 * A.8's *totals* line says "VFR modelled on leisure betas", which is not what
 * A.3's coefficient table gives VFR. Both are reproduced below; this config is
 * the one A.8's totals were computed with.
 */
const VFR_AS_LEISURE: LogitConfig = {
  beta: { ...DEFAULT_LOGIT.beta, vfr: DEFAULT_LOGIT.beta.leisure },
};

function shareOf(result: ShareResult, segment: DemandSegment, id: string): number {
  const row = result.bySegment[segment].operators.find((o) => o.operatorId === id);
  if (!row) throw new Error(`no ${id}`);
  return row.share;
}

function paxOf(result: ShareResult, segment: DemandSegment, id: string): number {
  const row = result.bySegment[segment].operators.find((o) => o.operatorId === id);
  if (!row) throw new Error(`no ${id}`);
  return row.passengers;
}

describe('App. A.8 worked example — the acceptance criterion', () => {
  const result = computeShares({ operators: A8_OPERATORS, segmentPools: A8_POOLS });

  it('computes the market average fare as A.8 does', () => {
    // €95, €69, €140 → €101.33. A plain mean, not weighted by frequency: A.8
    // fixes this and every PriceRel below follows from it.
    expect(result.marketFareMinor).toBeCloseTo(10_133.33, 2);
  });

  it('reproduces A.8’s PriceRel figures', () => {
    // A.8 prints 0.938 / 0.681 / 1.382. The exact value for `you` is 0.9375 —
    // 28,500 ÷ 30,400 — which the doc rounds half-up to 0.938. Asserting the
    // exact figure rather than the printed one, because a tolerance wide enough
    // to accept 0.938 is wide enough to hide a real error.
    const leisure = result.bySegment.leisure.operators;
    expect(leisure[0]?.priceRel).toBeCloseTo(0.9375, 9);
    expect(leisure[1]?.priceRel).toBeCloseTo(0.6809211, 6);
    expect(leisure[2]?.priceRel).toBeCloseTo(1.3815789, 6);
  });

  describe('leisure segment', () => {
    it('reproduces the printed utilities', () => {
      const rows = result.bySegment.leisure.operators;
      expect(rows[0]?.utility).toBeCloseTo(-1.053, 3);
      expect(rows[1]?.utility).toBeCloseTo(-0.065, 3);
      expect(rows[2]?.utility).toBeCloseTo(-1.913, 3);
    });

    it('reproduces shares 24.3 / 65.4 / 10.3 exactly', () => {
      expect(shareOf(result, 'leisure', 'you') * 100).toBeCloseTo(24.3, 1);
      expect(shareOf(result, 'leisure', 'a') * 100).toBeCloseTo(65.4, 1);
      expect(shareOf(result, 'leisure', 'b') * 100).toBeCloseTo(10.3, 1);
    });

    it('reproduces passengers 175 / 471 / 74', () => {
      expect(Math.round(paxOf(result, 'leisure', 'you'))).toBe(175);
      expect(Math.round(paxOf(result, 'leisure', 'a'))).toBe(471);
      expect(Math.round(paxOf(result, 'leisure', 'b'))).toBe(74);
    });
  });

  describe('business segment', () => {
    it('reproduces the printed utilities', () => {
      const rows = result.bySegment.business.operators;
      expect(rows[0]?.utility).toBeCloseTo(2.861, 3);
      expect(rows[1]?.utility).toBeCloseTo(3.292, 3);
      expect(rows[2]?.utility).toBeCloseTo(3.422, 3);
    });

    it('reproduces shares 23.3 / 35.9 / 40.8 exactly', () => {
      expect(shareOf(result, 'business', 'you') * 100).toBeCloseTo(23.3, 1);
      expect(shareOf(result, 'business', 'a') * 100).toBeCloseTo(35.9, 1);
      expect(shareOf(result, 'business', 'b') * 100).toBeCloseTo(40.8, 1);
    });

    it('reproduces passengers 56 / 86 / 98', () => {
      expect(Math.round(paxOf(result, 'business', 'you'))).toBe(56);
      expect(Math.round(paxOf(result, 'business', 'a'))).toBe(86);
      expect(Math.round(paxOf(result, 'business', 'b'))).toBe(98);
    });
  });

  it('produces almost opposite outcomes in the two segments — A.8’s point', () => {
    // "The LCC takes 65% of leisure and the legacy carrier takes 41% of
    // business *at double the fare*. Nobody wins everywhere." This is A.1's
    // third requirement, and it is the reason the segments exist at all.
    const leisureWinner = 'a';
    const businessWinner = 'b';

    expect(shareOf(result, 'leisure', leisureWinner)).toBeGreaterThan(
      shareOf(result, 'leisure', businessWinner),
    );
    expect(shareOf(result, 'business', businessWinner)).toBeGreaterThan(
      shareOf(result, 'business', leisureWinner),
    );
  });

  it('reproduces A.8’s totals of 289 / 714 / 197', () => {
    // A.8 models VFR on the leisure betas for this line and says so. It also
    // rounds each segment before summing — 175+56+58 is 289, while the exact
    // total is 289.6 — so this asserts the doc's own arithmetic rather than a
    // rounding of the exact figure.
    const asLeisure = computeShares(
      { operators: A8_OPERATORS, segmentPools: A8_POOLS },
      VFR_AS_LEISURE,
    );

    const totalFor = (id: string) =>
      DEMAND_SEGMENTS.reduce((sum, s) => sum + Math.round(paxOf(asLeisure, s, id)), 0);

    expect(totalFor('you')).toBe(289);
    expect(totalFor('a')).toBe(714);
    expect(totalFor('b')).toBe(197);
  });

  it('gives VFR a different answer under A.3’s own VFR betas', () => {
    // Worth pinning rather than hiding: A.3's table gives VFR its own column
    // (price 2.4, product 0.6, freq 0.8, rep 0.7) and A.8's totals line does
    // not use it. The default config follows A.3, so VFR is not a copy of
    // leisure — and the difference is the config, not the engine.
    const withOwnBetas = computeShares({ operators: A8_OPERATORS, segmentPools: A8_POOLS });
    const asLeisure = computeShares(
      { operators: A8_OPERATORS, segmentPools: A8_POOLS },
      VFR_AS_LEISURE,
    );

    expect(shareOf(withOwnBetas, 'vfr', 'you')).not.toBeCloseTo(
      shareOf(asLeisure, 'vfr', 'you'),
      4,
    );
    // VFR is less price-sensitive than leisure (2.4 vs 3.0), so the expensive
    // legacy carrier does better with it than it does in leisure.
    expect(shareOf(withOwnBetas, 'vfr', 'b')).toBeGreaterThan(
      shareOf(withOwnBetas, 'leisure', 'b'),
    );
  });
});

describe('the fourth frequency — A.8’s lesson, and the second acceptance criterion', () => {
  const before = computeShares({ operators: A8_OPERATORS, segmentPools: A8_POOLS }, VFR_AS_LEISURE);
  const after = computeShares(
    { operators: [{ ...YOU, frequency: 4 }, RIVAL_A, RIVAL_B], segmentPools: A8_POOLS },
    VFR_AS_LEISURE,
  );

  it('moves leisure share from 24.3% to 29.4%', () => {
    expect(shareOf(before, 'leisure', 'you') * 100).toBeCloseTo(24.3, 1);
    expect(shareOf(after, 'leisure', 'you') * 100).toBeCloseTo(29.4, 1);
  });

  it('moves business share from 23.3% to 32.5%', () => {
    expect(shareOf(before, 'business', 'you') * 100).toBeCloseTo(23.3, 1);
    expect(shareOf(after, 'business', 'you') * 100).toBeCloseTo(32.5, 1);
  });

  it('takes total demand from 289 to 361', () => {
    const totalFor = (r: ShareResult) =>
      DEMAND_SEGMENTS.reduce((sum, s) => sum + Math.round(paxOf(r, s, 'you')), 0);

    expect(totalFor(before)).toBe(289);
    expect(totalFor(after)).toBe(361);
  });

  it('more passengers, worse economics — the trade the game is about', () => {
    // 289 ÷ 3 = 96 pax/flight; 361 ÷ 4 = 90. Frequency buys share and costs a
    // whole rotation, and this is the number that teaches it.
    const perFlightBefore =
      DEMAND_SEGMENTS.reduce((sum, s) => sum + Math.round(paxOf(before, s, 'you')), 0) / 3;
    const perFlightAfter =
      DEMAND_SEGMENTS.reduce((sum, s) => sum + Math.round(paxOf(after, s, 'you')), 0) / 4;

    expect(Math.round(perFlightBefore)).toBe(96);
    expect(Math.round(perFlightAfter)).toBe(90);
    expect(perFlightAfter).toBeLessThan(perFlightBefore);
  });

  it('gives diminishing returns — the fifth frequency buys less than the fourth', () => {
    // The `ln` is what produces this, and A.10 lists it as the guard against
    // infinite frequency spam.
    const at = (frequency: number) =>
      shareOf(
        computeShares({
          operators: [{ ...YOU, frequency }, RIVAL_A, RIVAL_B],
          segmentPools: A8_POOLS,
        }),
        'leisure',
        'you',
      );

    const fourth = at(4) - at(3);
    const fifth = at(5) - at(4);

    expect(fourth).toBeGreaterThan(0);
    expect(fifth).toBeGreaterThan(0);
    expect(fifth).toBeLessThan(fourth);
  });
});

describe('A.9 decomposition — the waterfall *is* the result', () => {
  const result = computeShares({ operators: A8_OPERATORS, segmentPools: A8_POOLS });
  const gap = decomposeAgainst(result, 'leisure', 'you', 'a');

  it('reproduces A.9’s table exactly', () => {
    const by = (factor: string) => gap.factors.find((f) => f.factor === factor)?.delta ?? 0;

    expect(by('price')).toBeCloseTo(-0.7697368, 6);
    expect(by('frequency')).toBeCloseTo(-0.4597431, 6);
    expect(by('product')).toBeCloseTo(0.192, 9);
    expect(by('reputation')).toBeCloseTo(0.05, 9);

    // A.9 prints a net of −0.988, which is the sum of its own *rounded* rows:
    // −0.770 − 0.460 + 0.192 + 0.050. The exact sum is −0.98748. The rows match
    // the doc to the digit and the net is the doc's rounding, not a divergence
    // — worth pinning explicitly so nobody later "fixes" the model to hit
    // −0.988 and breaks the exact decomposition doing it.
    expect(gap.netDelta).toBeCloseTo(-0.9874799, 6);
    expect(Number(gap.netDelta.toFixed(2))).toBe(-0.99);
  });

  it('orders factors by how much of the gap they explain', () => {
    // "Your €26 premium is most of the gap" — the waterfall has to read that
    // way round or the player draws the wrong conclusion from it.
    expect(gap.factors[0]?.factor).toBe('price');
    expect(gap.factors[1]?.factor).toBe('frequency');
  });

  it('decomposes with no residual — the sum of the factors is the utility gap', () => {
    const you = result.bySegment.leisure.operators.find((o) => o.operatorId === 'you');
    const a = result.bySegment.leisure.operators.find((o) => o.operatorId === 'a');

    expect(gap.netDelta).toBeCloseTo((you?.utility ?? 0) - (a?.utility ?? 0), 12);
  });

  it('reproduces the share ratio from the gap alone', () => {
    // A.9's closing claim, and the reason the model was chosen: exp(of the
    // gap) is the ratio of the shares. The doc prints 0.372, which is
    // exp(−0.988) — the exponential of its own rounded net. The exact value is
    // 0.37251, and the assertion that matters is the second one: it equals the
    // share ratio to twelve places, with no residual anywhere.
    expect(gap.shareRatio).toBeCloseTo(0.3725143, 6);
    expect(gap.shareRatio).toBeCloseTo(
      shareOf(result, 'leisure', 'you') / shareOf(result, 'leisure', 'a'),
      12,
    );
  });

  it('omits factors that are identical, so the chart has no empty rows', () => {
    // Neither operator has an alliance or a connection penalty, and a waterfall
    // row reading "alliance: 0.000" teaches nothing.
    expect(gap.factors.map((f) => f.factor)).not.toContain('alliance');
    expect(gap.factors.map((f) => f.factor)).not.toContain('connectionPenalty');
  });

  it('is antisymmetric — losing by X is the rival winning by X', () => {
    const reverse = decomposeAgainst(result, 'leisure', 'a', 'you');
    expect(reverse.netDelta).toBeCloseTo(-gap.netDelta, 12);
    expect(reverse.shareRatio).toBeCloseTo(1 / gap.shareRatio, 10);
  });

  it('refuses to decompose against an operator who is not in the market', () => {
    expect(() => decomposeAgainst(result, 'leisure', 'you', 'nobody')).toThrow(/nobody/);
  });
});

describe('the model’s structural properties', () => {
  const result = computeShares({ operators: A8_OPERATORS, segmentPools: A8_POOLS });

  it('is pure — the same market on the same day always splits the same way', () => {
    // A.1's second requirement, verbatim: "players must be able to plan."
    expect(computeShares({ operators: A8_OPERATORS, segmentPools: A8_POOLS })).toEqual(result);
  });

  it('gives shares that sum to 1 in every segment', () => {
    for (const segment of DEMAND_SEGMENTS) {
      const total = result.bySegment[segment].operators.reduce((sum, o) => sum + o.share, 0);
      expect(total, segment).toBeCloseTo(1, 12);
    }
  });

  it('allocates the whole pool and no more', () => {
    for (const segment of DEMAND_SEGMENTS) {
      const total = result.bySegment[segment].operators.reduce((sum, o) => sum + o.passengers, 0);
      expect(total, segment).toBeCloseTo(A8_POOLS[segment], 9);
    }
  });

  it('carries every term that produced each utility (§14.1)', () => {
    for (const segment of DEMAND_SEGMENTS) {
      for (const row of result.bySegment[segment].operators) {
        expect(totalUtility(row.terms), `${segment}/${row.operatorId}`).toBeCloseTo(
          row.utility,
          12,
        );
      }
    }
  });

  it('reconciles per-segment passengers to the reported totals', () => {
    for (const id of ['you', 'a', 'b']) {
      const summed = DEMAND_SEGMENTS.reduce((sum, s) => sum + paxOf(result, s, id), 0);
      expect(result.totalPassengers[id], id).toBeCloseTo(summed, 9);
    }
  });

  it('gives a monopolist the whole market whatever it charges', () => {
    const alone = computeShares({ operators: [YOU], segmentPools: A8_POOLS });

    expect(shareOf(alone, 'leisure', 'you')).toBe(1);
    expect(alone.bySegment.leisure.operators[0]?.priceRel).toBe(1);
    expect(paxOf(alone, 'leisure', 'you')).toBe(720);
  });

  it('does nothing at all with an empty market', () => {
    const dead = computeShares({
      operators: A8_OPERATORS,
      segmentPools: { business: 0, leisure: 0, vfr: 0 },
    });

    for (const segment of DEMAND_SEGMENTS) {
      for (const row of dead.bySegment[segment].operators) {
        expect(row.passengers).toBe(0);
        // Share is still meaningful even when nobody is travelling — it is what
        // the operator *would* take, and M3-10 needs it to explain an empty route.
        expect(row.share).toBeGreaterThan(0);
      }
    }
  });
});

describe('numerical behaviour', () => {
  it('does not overflow on utilities that would blow up exp()', () => {
    // exp(1000) is Infinity, and Infinity/Infinity is NaN — which would flow
    // straight into a settled flight's passenger count. Subtracting the maximum
    // utility before exponentiating makes that unreachable, and a retune is
    // exactly how such a utility would arrive.
    const absurd: LogitConfig = {
      beta: {
        ...DEFAULT_LOGIT.beta,
        leisure: { ...DEFAULT_LOGIT.beta.leisure, product: 5_000, reputation: 5_000 },
      },
    };

    const result = computeShares({ operators: A8_OPERATORS, segmentPools: A8_POOLS }, absurd);
    const shares = result.bySegment.leisure.operators.map((o) => o.share);

    for (const share of shares) {
      expect(Number.isFinite(share)).toBe(true);
    }
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    // Rival B has the best product and reputation, so at these coefficients it
    // takes essentially everything — the right answer, not a NaN.
    expect(shares[2]).toBeCloseTo(1, 6);
  });

  it('does not produce NaN for any operator in any segment', () => {
    const result = computeShares({ operators: A8_OPERATORS, segmentPools: A8_POOLS });

    for (const segment of DEMAND_SEGMENTS) {
      for (const row of result.bySegment[segment].operators) {
        expect(Number.isFinite(row.utility), `${segment}/${row.operatorId}`).toBe(true);
        expect(Number.isFinite(row.share)).toBe(true);
        expect(Number.isFinite(row.passengers)).toBe(true);
      }
    }
  });

  it('handles a market where every operator is identical', () => {
    const clones = [
      { ...YOU, id: 'x' },
      { ...YOU, id: 'y' },
      { ...YOU, id: 'z' },
    ];
    const result = computeShares({ operators: clones, segmentPools: A8_POOLS });

    for (const row of result.bySegment.leisure.operators) {
      expect(row.share).toBeCloseTo(1 / 3, 12);
    }
  });
});

describe('the terms that later milestones will supply', () => {
  it('accepts SchedFit per segment and applies A.3’s coefficient (M3-04)', () => {
    const withFit = computeShares({
      operators: [{ ...YOU, schedFit: { business: 1 } }, RIVAL_A, RIVAL_B],
      segmentPools: A8_POOLS,
    });
    const without = computeShares({ operators: A8_OPERATORS, segmentPools: A8_POOLS });

    // β_sched is 1.0 for business, so a perfect fit is worth a full point of
    // utility — and nothing at all in leisure, where it was not supplied.
    const fitTerm = withFit.bySegment.business.operators[0]?.terms.schedule;
    expect(fitTerm).toBeCloseTo(1.0, 12);
    expect(shareOf(withFit, 'business', 'you')).toBeGreaterThan(
      shareOf(without, 'business', 'you'),
    );
    expect(shareOf(withFit, 'leisure', 'you')).toBeCloseTo(shareOf(without, 'leisure', 'you'), 12);
  });

  it('subtracts a connection penalty directly, not through a beta (M3-07)', () => {
    // A.3 writes ConnectionPenalty outside the coefficients because the segment
    // difference lives in the penalty itself — business heavily, leisure mildly.
    const connecting = computeShares({
      operators: [{ ...YOU, connectionPenalty: { business: 1.5, leisure: 0.3 } }, RIVAL_A, RIVAL_B],
      segmentPools: A8_POOLS,
    });

    expect(connecting.bySegment.business.operators[0]?.terms.connectionPenalty).toBeCloseTo(
      -1.5,
      12,
    );
    expect(connecting.bySegment.leisure.operators[0]?.terms.connectionPenalty).toBeCloseTo(
      -0.3,
      12,
    );
  });

  it('adds an alliance bonus directly (post-MVP)', () => {
    const allied = computeShares({
      operators: [{ ...YOU, alliance: { business: 0.5 } }, RIVAL_A, RIVAL_B],
      segmentPools: A8_POOLS,
    });

    expect(allied.bySegment.business.operators[0]?.terms.alliance).toBeCloseTo(0.5, 12);
  });

  it('adds a social media attractiveness bonus directly, across every segment', () => {
    // §9.1's specialist edge enters utility like the alliance bonus — a flat
    // additive term, not a factor of an existing attribute — and being flat, it
    // shows up identically in business and leisure rather than differing by beta.
    const promoted = computeShares({
      operators: [{ ...YOU, attractiveness: 0.2 }, RIVAL_A, RIVAL_B],
      segmentPools: A8_POOLS,
    });
    const plain = computeShares({ operators: [YOU, RIVAL_A, RIVAL_B], segmentPools: A8_POOLS });

    expect(promoted.bySegment.business.operators[0]?.terms.attractiveness).toBeCloseTo(0.2, 12);
    expect(promoted.bySegment.leisure.operators[0]?.terms.attractiveness).toBeCloseTo(0.2, 12);

    // A positive bonus can only help: the promoted airline wins at least as much
    // of every segment as it did without it.
    expect(shareOf(promoted, 'leisure', 'you')).toBeGreaterThan(shareOf(plain, 'leisure', 'you'));
    expect(shareOf(promoted, 'business', 'you')).toBeGreaterThan(shareOf(plain, 'business', 'you'));
  });

  it('leaves loyalty at zero until it has a coefficient (App. E.5)', () => {
    const loyal = computeShares({
      operators: [{ ...YOU, loyalty: 1 }, RIVAL_A, RIVAL_B],
      segmentPools: A8_POOLS,
    });

    // β_loyal is 0 in the shipped config, so supplying loyalty changes nothing
    // yet — turning it on is a config change, not a code change.
    expect(loyal.bySegment.business.operators[0]?.terms.loyalty).toBe(0);
  });
});

describe('configuration and validation', () => {
  it('keeps every coefficient in config — A.3’s explicit requirement', () => {
    // "These belong in a config file that can be tuned live, never hard-coded."
    // Which is also CONTRIBUTING invariant 3.
    const priceBlind: LogitConfig = {
      beta: { ...DEFAULT_LOGIT.beta, leisure: { ...DEFAULT_LOGIT.beta.leisure, price: 0 } },
    };

    const result = computeShares({ operators: A8_OPERATORS, segmentPools: A8_POOLS }, priceBlind);

    // `toBeCloseTo`, not `toBe`: `-0 * 0.9375` is negative zero, which is
    // numerically zero but fails an `Object.is` comparison against `+0`.
    expect(result.bySegment.leisure.operators[0]?.terms.price).toBeCloseTo(0, 12);
    // With price ignored, Rival B's superior product and reputation win leisure
    // outright — the opposite of A.8's outcome, from one number.
    expect(shareOf(result, 'leisure', 'b')).toBeGreaterThan(shareOf(result, 'leisure', 'a'));
  });

  it('uses A.3’s starting coefficients verbatim', () => {
    expect(DEFAULT_LOGIT.beta.business).toMatchObject({
      price: 1.1,
      product: 2.2,
      frequency: 1.6,
      schedule: 1.0,
      reputation: 1.4,
    });
    expect(DEFAULT_LOGIT.beta.leisure).toMatchObject({
      price: 3.0,
      product: 0.8,
      frequency: 0.9,
      schedule: 0.4,
      reputation: 0.5,
    });
    expect(DEFAULT_LOGIT.beta.vfr).toMatchObject({
      price: 2.4,
      product: 0.6,
      frequency: 0.8,
      schedule: 0.4,
      reputation: 0.7,
    });
  });

  it('refuses a market with no operators', () => {
    expect(() => computeShares({ operators: [], segmentPools: A8_POOLS })).toThrow(/at least one/);
    expect(() => marketFare([])).toThrow(/at least one/);
  });

  it('refuses the same operator twice', () => {
    expect(() => computeShares({ operators: [YOU, { ...YOU }], segmentPools: A8_POOLS })).toThrow(
      /[Dd]uplicate/,
    );
  });

  it('refuses an operator that does not fly', () => {
    // ln(0) is -Infinity, which would give a zero share rather than an error —
    // a silently wrong answer instead of a loud one.
    expect(() =>
      computeShares({ operators: [{ ...YOU, frequency: 0 }, RIVAL_A], segmentPools: A8_POOLS }),
    ).toThrow(/at least once/);
  });

  it('refuses inputs that cannot mean anything', () => {
    const bad = (o: Partial<Operator>) =>
      computeShares({ operators: [{ ...YOU, ...o }, RIVAL_A], segmentPools: A8_POOLS });

    expect(() => bad({ fareMinor: 0 })).toThrow(/positive fare/);
    expect(() => bad({ fareMinor: -100 })).toThrow(/positive fare/);
    expect(() => bad({ productScore: 1.4 })).toThrow(/product score/);
    expect(() => bad({ reputation: -0.1 })).toThrow(/reputation/);
    expect(() =>
      computeShares({ operators: A8_OPERATORS, segmentPools: { ...A8_POOLS, leisure: -1 } }),
    ).toThrow(/pool/);
  });

  it('exposes the utility terms for a single operator without running a market', () => {
    // M3-10's waterfall and any "what if" tool need this, and it should not
    // require constructing a whole market to ask.
    const terms = utilityTerms(YOU, 'leisure', 0.9375);

    expect(terms.price).toBeCloseTo(-2.8125, 12);
    expect(terms.product).toBeCloseTo(0.496, 12);
    expect(terms.frequency).toBeCloseTo(0.9 * Math.log(3), 12);
    expect(terms.reputation).toBeCloseTo(0.275, 12);
    expect(totalUtility(terms)).toBeCloseTo(-1.053, 3);
  });
});
