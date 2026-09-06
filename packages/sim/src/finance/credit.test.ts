import { describe, expect, it } from 'vitest';

import { CREDIT_TIERS, type CreditTier } from '@tailfin/shared';

import {
  annualInterestMinor,
  applyRatingReview,
  borrowingCapacity,
  checkDraw,
  DEFAULT_CREDIT,
  debtServiceCoverage,
  earnedCreditTier,
  instrumentRateBps,
  type CreditStanding,
} from './credit';

/**
 * §13's rule, and M8-06's four acceptance criteria.
 *
 * > **Loans support, they never carry.**
 *
 * The criteria are testable almost verbatim, and the third and fourth are the
 * interesting ones: the founder facility has to work on an airline with nothing
 * to its name, and a rating has to be harder to regain than to lose.
 */

/** A healthy trading record, to vary one field at a time from. */
const HEALTHY: CreditStanding = {
  trailingOperatingProfitMinor: 58_000_000,
  trailingEbitdaMinor: 80_000_000,
  trailingRevenueMinor: 1_000_000_000,
  tangibleAssetValueMinor: 5_000_000_000,
  profitableMonths: 12,
  routes: 10,
  hubs: 2,
};

/** Nothing at all — a brand-new airline on day one. */
const NEW_AIRLINE: CreditStanding = {
  trailingOperatingProfitMinor: 0,
  trailingEbitdaMinor: 0,
  trailingRevenueMinor: 0,
  tangibleAssetValueMinor: 0,
  profitableMonths: 0,
  routes: 0,
  hubs: 0,
};

describe('§13.1 — a loss-making airline cannot borrow at all', () => {
  it('gives an airline losing money no capacity, on any earned tier', () => {
    const losing: CreditStanding = {
      ...HEALTHY,
      trailingOperatingProfitMinor: -20_000_000,
      trailingEbitdaMinor: -5_000_000,
    };
    for (const tier of CREDIT_TIERS.filter((entry) => entry !== 'startup')) {
      const capacity = borrowingCapacity(tier, losing);
      expect(capacity.maxTotalDebtMinor).toBe(0);
      expect(capacity.bindingConstraint).toBe('profit_multiple');
    }
  });

  it('needs no special case to do it — the multiple of a negative is the whole answer', () => {
    const capacity = borrowingCapacity('C', {
      ...HEALTHY,
      trailingOperatingProfitMinor: -1,
    });
    expect(capacity.profitMultipleMinor).toBe(0);
    expect(capacity.maxTotalDebtMinor).toBe(0);
  });

  it('gives a break-even airline nothing either, which is the same rule', () => {
    expect(
      borrowingCapacity('D', { ...HEALTHY, trailingOperatingProfitMinor: 0 }).maxTotalDebtMinor,
    ).toBe(0);
  });
});

describe('§13.4’s one-aircraft Amsterdam airline', () => {
  /*
   * The worked example: $48,328 operating profit a month, which §13.4 annualises
   * to "$580K annual operating profit" and multiplies by 3.0 for a **$1.74M
   * maximum debt**. Its own arithmetic rounds — 48,328 × 12 is 579,936 — so the
   * assertion is against the airline the doc describes rather than against its
   * rounded prose.
   */
  const MONTHLY_OPERATING_PROFIT_MINOR = 4_832_800;
  const oneAircraft: CreditStanding = {
    trailingOperatingProfitMinor: MONTHLY_OPERATING_PROFIT_MINOR * 12,
    trailingEbitdaMinor: MONTHLY_OPERATING_PROFIT_MINOR * 12,
    trailingRevenueMinor: 85_680_000 * 12,
    // A leased ATR: nothing owned, so nothing to advance against. The profit
    // limit is what binds, which is the point §13.4 is making.
    tangibleAssetValueMinor: 0,
    profitableMonths: 12,
    routes: 2,
    hubs: 1,
  };

  it('caps at about $1.74M total debt', () => {
    // Tier D: earned on twelve profitable months, and its $1M cap would bind
    // first — so the profit limit is read directly, which is the number §13.4
    // quotes.
    const capacity = borrowingCapacity('C', oneAircraft);
    // Exactly 3 × 12 × $48,328 = $1,739,808. §13.4 writes that as "$1.74M",
    // having already rounded $579,936 of annual profit to "$580K" — so the
    // assertion is on the airline's own arithmetic, with the doc's rounding
    // checked separately rather than treated as the target.
    expect(capacity.profitMultipleMinor).toBe(173_980_800);
    expect(Math.round(capacity.profitMultipleMinor / 100 / 10_000) / 100).toBe(1.74);
  });

  it('cannot borrow its way to a $2M second hub', () => {
    // §13.4: "A one-aircraft airline cannot borrow its way to a $2M second hub —
    // it has to earn most of it first."
    const capacity = borrowingCapacity('C', oneAircraft);
    const refusal = checkDraw({
      principalMinor: 200_000_000,
      maxTotalDebtMinor: capacity.maxTotalDebtMinor,
      outstandingDebtMinor: 0,
      dscr: null,
    });
    expect(refusal?.code).toBe('over_capacity');
  });

  it('reproduces §13.4’s interest table', () => {
    // "$250K at 14% = $2,917/month, 6% of profit" and the two rows under it.
    const rows = [
      { principal: 25_000_000, bps: 1_400, monthly: 291_700, share: 0.06 },
      { principal: 100_000_000, bps: 1_200, monthly: 1_000_000, share: 0.21 },
      { principal: 300_000_000, bps: 1_000, monthly: 2_500_000, share: 0.52 },
    ];
    for (const row of rows) {
      const monthly = annualInterestMinor(row.principal, row.bps) / 12;
      expect(monthly).toBeCloseTo(row.monthly, -3);
      expect(monthly / MONTHLY_OPERATING_PROFIT_MINOR).toBeCloseTo(row.share, 2);
    }
  });
});

describe('the founder facility', () => {
  it('is drawable on day one despite zero trailing profit', () => {
    const capacity = borrowingCapacity('startup', NEW_AIRLINE);
    // §13.2's $250K, in minor units.
    expect(capacity.maxTotalDebtMinor).toBe(25_000_000);
    expect(
      checkDraw({
        principalMinor: 25_000_000,
        maxTotalDebtMinor: capacity.maxTotalDebtMinor,
        outstandingDebtMinor: 0,
        dscr: null,
      }),
    ).toBeNull();
  });

  it('is exempt from the profit test and nothing else', () => {
    const capacity = borrowingCapacity('startup', NEW_AIRLINE);
    // The trading limits are still *reported* — a UI should be able to show that
    // they are zero — they simply do not bind this tier.
    expect(capacity.profitMultipleMinor).toBe(0);
    expect(capacity.bindingConstraint).toBe('tier_cap');
  });

  it('does not become a way to borrow real money without trading', () => {
    const capacity = borrowingCapacity('startup', NEW_AIRLINE);
    expect(
      checkDraw({
        principalMinor: 25_000_001,
        maxTotalDebtMinor: capacity.maxTotalDebtMinor,
        outstandingDebtMinor: 0,
        dscr: null,
      })?.code,
    ).toBe('over_capacity');
  });

  it('is the dearest money in the table, which is what keeps it honest', () => {
    for (const tier of CREDIT_TIERS.filter((entry) => entry !== 'startup')) {
      expect(DEFAULT_CREDIT.tiers.startup.annualRateBps).toBeGreaterThan(
        DEFAULT_CREDIT.tiers[tier].annualRateBps,
      );
    }
  });

  it('is what a brand-new airline earns, and only that', () => {
    expect(earnedCreditTier(NEW_AIRLINE)).toBe('startup');
  });
});

describe('§13.1’s three limits', () => {
  it('takes the smallest of the three', () => {
    const capacity = borrowingCapacity('B', HEALTHY);
    expect(capacity.maxTotalDebtMinor).toBe(
      Math.min(capacity.tierCapMinor, capacity.profitMultipleMinor, capacity.assetAdvanceMinor),
    );
  });

  it('names the one that binds, so a player knows what to fix', () => {
    // Assets thin, profit healthy: the advance rate bites.
    expect(
      borrowingCapacity('B', { ...HEALTHY, tangibleAssetValueMinor: 1_000_000 }).bindingConstraint,
    ).toBe('asset_advance');
    // Profit thin, assets deep: the multiple bites.
    expect(
      borrowingCapacity('B', {
        ...HEALTHY,
        trailingOperatingProfitMinor: 100_000,
        tangibleAssetValueMinor: 90_000_000_000,
      }).bindingConstraint,
    ).toBe('profit_multiple');
    // Both enormous: the tier's own ceiling is all that is left.
    expect(
      borrowingCapacity('D', {
        ...HEALTHY,
        trailingOperatingProfitMinor: 90_000_000_000,
        tangibleAssetValueMinor: 90_000_000_000,
      }).bindingConstraint,
    ).toBe('tier_cap');
  });

  it('advances 60% of tangible assets, not all of them', () => {
    const capacity = borrowingCapacity('AA', {
      ...HEALTHY,
      tangibleAssetValueMinor: 1_000_000_000,
    });
    expect(capacity.assetAdvanceMinor).toBe(600_000_000);
  });
});

describe('the coverage test', () => {
  it('does not apply to an airline that owes nothing', () => {
    expect(debtServiceCoverage(80_000_000, 0)).toBeNull();
    expect(
      checkDraw({
        principalMinor: 1_000,
        maxTotalDebtMinor: 100_000_000,
        outstandingDebtMinor: 0,
        dscr: null,
      }),
    ).toBeNull();
  });

  it('refuses more borrowing below the floor', () => {
    const refusal = checkDraw({
      principalMinor: 1_000,
      maxTotalDebtMinor: 100_000_000,
      outstandingDebtMinor: 10_000_000,
      dscr: 1.1,
    });
    expect(refusal).toMatchObject({ code: 'below_dscr', minimum: 1.25 });
  });

  it('allows it at the floor exactly', () => {
    expect(
      checkDraw({
        principalMinor: 1_000,
        maxTotalDebtMinor: 100_000_000,
        outstandingDebtMinor: 10_000_000,
        dscr: 1.25,
      }),
    ).toBeNull();
  });

  it('reports being over capacity before thin coverage, because it is more useful', () => {
    const refusal = checkDraw({
      principalMinor: 999_999_999,
      maxTotalDebtMinor: 0,
      outstandingDebtMinor: 10_000_000,
      dscr: 0.2,
    });
    expect(refusal?.code).toBe('over_capacity');
  });
});

describe('§13.3’s instruments', () => {
  it('prices an unsecured line dear and secured aircraft money cheap', () => {
    const line = instrumentRateBps('C', 'working_capital');
    const aircraft = instrumentRateBps('C', 'aircraft_finance');
    const facility = instrumentRateBps('C', 'facility');
    // Tier C is 10%: +3 and −2 around it.
    expect(line).toBe(1_300);
    expect(aircraft).toBe(800);
    expect(facility).toBe(1_000);
    // Five points between the dearest and the cheapest — the reason to secure.
    expect(line - aircraft).toBe(500);
  });

  it('never prices a loan below zero, however cheap the tier', () => {
    expect(instrumentRateBps('AA', 'aircraft_finance')).toBeGreaterThanOrEqual(0);
  });
});

describe('§13.2 — ratings fall faster than they rise', () => {
  const at = (tier: CreditTier, goodReviews = 0) => ({ tier, goodReviews });

  it('falls a whole tier on one bad review', () => {
    expect(applyRatingReview(at('B'), 'C')).toEqual({ tier: 'C', goodReviews: 0 });
  });

  it('falls all the way when the trading collapses, not one rung at a time', () => {
    // A rise is a climb; a fall is a fall. An airline that has lost everything
    // should not be priced at A for two more reviews on its way down — but it
    // floors at D, never back into the exempt founder tier.
    expect(applyRatingReview(at('AA'), 'startup')).toEqual({ tier: 'D', goodReviews: 0 });
  });

  it('never falls back into the founder facility, which is a start not a refuge', () => {
    // Caught by a database test: on a naive fall-to-earned rule, an airline that
    // traded up to C and then started losing money landed on `startup` and found
    // $250K of profit-exempt credit waiting. That is precisely the airline §13.1
    // exists to stop borrowing.
    for (const from of ['D', 'C', 'B', 'A', 'AA'] as CreditTier[]) {
      expect(applyRatingReview(at(from), 'startup').tier).toBe('D');
    }
    // A brand-new airline that has not left it, of course, stays there.
    expect(applyRatingReview(at('startup'), 'startup').tier).toBe('startup');
  });

  it('takes two good reviews to rise one tier', () => {
    const first = applyRatingReview(at('C'), 'B');
    expect(first).toEqual({ tier: 'C', goodReviews: 1 });
    const second = applyRatingReview(first, 'B');
    expect(second).toEqual({ tier: 'B', goodReviews: 0 });
  });

  it('rises one rung at a time even when it has earned several', () => {
    let state = at('startup');
    for (let review = 0; review < 4; review += 1) state = applyRatingReview(state, 'AA');
    // Four reviews at two apiece: two rungs, not five.
    expect(state.tier).toBe('C');
  });

  it('is strictly slower up than down, over the same trading', () => {
    // Climb from startup to B, counting reviews; then lose it in one.
    let state = at('startup');
    let climbs = 0;
    while (state.tier !== 'B' && climbs < 20) {
      state = applyRatingReview(state, 'B');
      climbs += 1;
    }
    expect(state.tier).toBe('B');
    expect(climbs).toBeGreaterThan(1);
    // One review down to the floor, against several to climb back.
    expect(applyRatingReview(state, 'startup').tier).toBe('D');
  });

  it('resets the streak when a rating falls, so oscillation never earns a rise', () => {
    const climbing = applyRatingReview(at('C'), 'B');
    expect(climbing.goodReviews).toBe(1);
    const slipped = applyRatingReview(climbing, 'D');
    expect(slipped).toEqual({ tier: 'D', goodReviews: 0 });
  });

  it('holding station is neither a fall nor progress', () => {
    expect(applyRatingReview(at('C', 1), 'C')).toEqual({ tier: 'C', goodReviews: 0 });
  });
});

describe('what the tiers ask for', () => {
  it('reads §13.2’s stated requirements', () => {
    expect(DEFAULT_CREDIT.tiers.D.profitableMonths).toBe(3);
    expect(DEFAULT_CREDIT.tiers.C.profitableMonths).toBe(6);
    expect(DEFAULT_CREDIT.tiers.C.routes).toBe(4);
    expect(DEFAULT_CREDIT.tiers.B.profitableMonths).toBe(12);
    expect(DEFAULT_CREDIT.tiers.B.hubs).toBe(2);
  });

  it('reads §13.2’s caps, rates and terms', () => {
    expect(DEFAULT_CREDIT.tiers.startup).toMatchObject({
      maxDebtMinor: 25_000_000,
      annualRateBps: 1_400,
      termMonths: 12,
    });
    expect(DEFAULT_CREDIT.tiers.D.maxDebtMinor).toBe(100_000_000);
    expect(DEFAULT_CREDIT.tiers.AA).toMatchObject({ annualRateBps: 450, termMonths: 120 });
  });

  it('gets dearer as it gets weaker, and shorter too', () => {
    for (let i = 1; i < CREDIT_TIERS.length; i += 1) {
      const weaker = DEFAULT_CREDIT.tiers[CREDIT_TIERS[i - 1]!];
      const stronger = DEFAULT_CREDIT.tiers[CREDIT_TIERS[i]!];
      expect(stronger.annualRateBps).toBeLessThan(weaker.annualRateBps);
      expect(stronger.termMonths).toBeGreaterThan(weaker.termMonths);
      expect(stronger.maxDebtMinor).toBeGreaterThan(weaker.maxDebtMinor);
    }
  });

  it('needs every requirement of a tier, not just one', () => {
    // Twelve profitable months and a good margin, but only one hub: B asks for
    // two, so the airline earns C.
    expect(earnedCreditTier({ ...HEALTHY, hubs: 1 })).toBe('C');
    // And with too few routes for C, it drops to D.
    expect(earnedCreditTier({ ...HEALTHY, hubs: 1, routes: 2 })).toBe('D');
  });

  it('earns the best rung fully satisfied rather than the first one tried', () => {
    expect(earnedCreditTier(HEALTHY)).toBe('B');
  });
});
