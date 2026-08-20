import { describe, expect, it } from 'vitest';

import { CABIN_ORDER, type CabinClass, type DemandSegment } from '@tailfin/shared';

import {
  allocateByClass,
  assertMixSums,
  type ClassMixConfig,
  type ClassOperator,
  DEFAULT_CLASS_MIX,
} from './class-allocation';
import { DEMAND_SEGMENTS } from './modulation';

/**
 * Per-class allocation (M3-06, App. A.6).
 *
 * A.6 is three sentences and no worked example, so — as with M3-04 — the
 * propensities are designed rather than sourced. What A.6 *does* give is a
 * sharp claim to test against: *"a 1-2-1 business cabin only pays off where the
 * business segment pool is deep enough to fill it."* That is falsifiable, and
 * the first block below falsifies it in both directions.
 */

/** A holiday route: leisure-heavy, per A.2's "AMS–PMI is leisure-heavy". */
const LEISURE_ROUTE: Record<DemandSegment, number> = { business: 150, leisure: 700, vfr: 150 };
/** A city pair: business-heavy, per A.2's "AMS–LHR is business-heavy". */
const BUSINESS_ROUTE: Record<DemandSegment, number> = { business: 350, leisure: 400, vfr: 250 };

function operator(
  over: Partial<ClassOperator> & Pick<ClassOperator, 'id' | 'cabins'>,
): ClassOperator {
  return { frequency: 3, productScore: 0.6, reputation: 0.5, ...over };
}

/**
 * A sensibly sized two-class aircraft, three times a day: 40 business seats
 * and 350 economy per departure.
 *
 * Sized so neither cabin saturates on either route — a cabin pinned at 100%
 * cannot show a contrast, which is what the first draft of these fixtures got
 * wrong.
 */
const TWO_CLASS: ClassOperator['cabins'] = {
  business: { seats: 120, fareMinor: 30_000 },
  economy: { seats: 1_050, fareMinor: 9_000 },
};

/**
 * The same 1,170 seats, but a hundred business seats per departure.
 *
 * A.6's warning made concrete: *"a 1-2-1 business cabin only pays off where the
 * business segment pool is deep enough to fill it."*
 */
const EGO_CABIN: ClassOperator['cabins'] = {
  business: { seats: 300, fareMinor: 30_000 },
  economy: { seats: 870, fareMinor: 9_000 },
};

/** Total seats, so the cabin comparisons are like for like. */
const TOTAL_SEATS = 1_170;

const cabinOf = (result: ReturnType<typeof allocateByClass>, cabin: CabinClass) =>
  result.byCabin.find((c) => c.cabin === cabin);

describe('the acceptance criterion: a premium cabin on a leisure-heavy route', () => {
  const holiday = allocateByClass({
    operators: [operator({ id: 'you', cabins: TWO_CLASS })],
    segmentPools: LEISURE_ROUTE,
  });
  const city = allocateByClass({
    operators: [operator({ id: 'you', cabins: TWO_CLASS })],
    segmentPools: BUSINESS_ROUTE,
  });

  it('fills poorly', () => {
    const business = cabinOf(holiday, 'business');
    expect(business?.capacity?.operators[0]?.loadFactor).toBeLessThan(0.75);
  });

  it('fills materially better on a business-heavy route with the same cabin', () => {
    // Same aircraft, same fares, same frequency — only the route's segment mix
    // differs. That is A.6's whole claim, and this is the comparison that
    // makes it a mechanic rather than a sentence.
    const holidayFill = cabinOf(holiday, 'business')?.capacity?.operators[0]?.loadFactor ?? 0;
    const cityFill = cabinOf(city, 'business')?.capacity?.operators[0]?.loadFactor ?? 0;

    expect(cityFill).toBeGreaterThan(holidayFill * 1.5);
  });

  it('shows why, segment by segment', () => {
    // The "and the dashboard shows why" half. A bad load factor with no cause
    // is exactly the dead-end number §14.1 forbids.
    const business = cabinOf(holiday, 'business');
    const by = business?.poolBySegment;

    expect(by).toBeDefined();
    // Leisure is 70% of this route and buys business class 1.9% of the time,
    // so it contributes less to the premium cabin than a segment less than a
    // quarter its size.
    expect(by?.business).toBeGreaterThan(by?.leisure ?? 0);
    expect(by?.leisure).toBeGreaterThan(by?.vfr ?? 0);
    // And the whole premium market is a fraction of the economy one.
    expect(business?.pool).toBeLessThan((cabinOf(holiday, 'economy')?.pool ?? 0) / 10);
  });

  it('leaves economy comfortably fuller than the premium cabin', () => {
    const business = cabinOf(holiday, 'business')?.capacity?.operators[0]?.loadFactor ?? 0;
    const economy = cabinOf(holiday, 'economy')?.capacity?.operators[0]?.loadFactor ?? 0;

    expect(economy).toBeGreaterThan(business);
  });

  it('rewards fitting the cabin to the route', () => {
    // A.6: "Fit the cabin to the route, not to your ego." Same 1,170 seats,
    // arranged two ways on the same holiday route. The ego cabin leaves premium
    // seats empty while turning economy passengers away — it carries fewer
    // people with the same aeroplane, which is the lesson the mechanic is for.
    const ego = allocateByClass({
      operators: [operator({ id: 'you', cabins: EGO_CABIN })],
      segmentPools: LEISURE_ROUTE,
    });
    const allEconomy = allocateByClass({
      operators: [
        operator({ id: 'you', cabins: { economy: { seats: TOTAL_SEATS, fareMinor: 9_000 } } }),
      ],
      segmentPools: LEISURE_ROUTE,
    });

    expect(allEconomy.totalBooked).toBeGreaterThan(ego.totalBooked);
    // And it is visible as the two things going wrong at once: empty seats up
    // front, passengers turned away down the back.
    const egoBusiness = ego.byCabin.find((c) => c.cabin === 'business');
    const egoEconomy = ego.byCabin.find((c) => c.cabin === 'economy');
    expect(egoBusiness?.capacity?.operators[0]?.emptySeats).toBeGreaterThan(200);
    expect(egoEconomy?.capacity?.totalSpilled).toBeGreaterThan(0);
  });
});

describe('class-level results roll up exactly — the second acceptance criterion', () => {
  const markets: { name: string; pools: Record<DemandSegment, number>; ops: ClassOperator[] }[] = [
    {
      name: 'one operator, two classes',
      pools: LEISURE_ROUTE,
      ops: [operator({ id: 'a', cabins: TWO_CLASS })],
    },
    {
      name: 'two operators competing across three classes',
      pools: BUSINESS_ROUTE,
      ops: [
        operator({
          id: 'a',
          cabins: {
            business: { seats: 40, fareMinor: 35_000 },
            premium_economy: { seats: 60, fareMinor: 16_000 },
            economy: { seats: 300, fareMinor: 9_500 },
          },
        }),
        operator({
          id: 'b',
          frequency: 5,
          cabins: {
            business: { seats: 20, fareMinor: 28_000 },
            economy: { seats: 600, fareMinor: 7_000 },
          },
        }),
      ],
    },
    {
      name: 'an all-economy market',
      pools: LEISURE_ROUTE,
      ops: [operator({ id: 'a', cabins: { economy: { seats: 400, fareMinor: 8_000 } } })],
    },
  ];

  it('accounts for every passenger in the segment pools', () => {
    for (const { name, pools, ops } of markets) {
      const result = allocateByClass({ operators: ops, segmentPools: pools });
      const inPools = DEMAND_SEGMENTS.reduce((sum, s) => sum + pools[s], 0);

      // Nothing is created and nothing vanishes: the cabin pools are exactly
      // the segment pools redistributed, which is what the propensities summing
      // to 1 buys.
      expect(result.totalPool, name).toBeCloseTo(inPools, 9);
      expect(result.totalBooked + result.totalLost, name).toBeCloseTo(inPools, 9);
    }
  });

  it('sums each operator’s cabins to the totals it was allocated', () => {
    for (const { name, pools, ops } of markets) {
      const result = allocateByClass({ operators: ops, segmentPools: pools });

      const perOperator = Object.values(result.byOperator).reduce(
        (sum, rows) => sum + rows.reduce((s, r) => s + r.passengers, 0),
        0,
      );
      expect(perOperator, name).toBeCloseTo(result.totalBooked, 9);
    }
  });

  it('sums each cabin’s capacity result to the same total', () => {
    for (const { name, pools, ops } of markets) {
      const result = allocateByClass({ operators: ops, segmentPools: pools });
      const perCabin = result.byCabin.reduce((sum, c) => sum + (c.capacity?.totalBooked ?? 0), 0);

      expect(perCabin, name).toBeCloseTo(result.totalBooked, 9);
    }
  });

  it('never books an operator past the seats it offered in a cabin', () => {
    for (const { name, pools, ops } of markets) {
      const result = allocateByClass({ operators: ops, segmentPools: pools });
      for (const [id, rows] of Object.entries(result.byOperator)) {
        for (const row of rows) {
          expect(row.passengers, `${name} ${id}/${row.cabin}`).toBeLessThanOrEqual(row.seats);
          expect(row.loadFactor).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

describe('a cabin nobody sells', () => {
  it('cascades its demand down rather than losing it', () => {
    // An all-economy market must still carry everybody. Losing the premium
    // demand would make it smaller than the same market with one token
    // business seat, which is nonsense.
    const pools = LEISURE_ROUTE;
    const inPools = DEMAND_SEGMENTS.reduce((sum, s) => sum + pools[s], 0);

    const result = allocateByClass({
      operators: [operator({ id: 'a', cabins: { economy: { seats: 5_000, fareMinor: 8_000 } } })],
      segmentPools: pools,
    });

    expect(result.byCabin).toHaveLength(1);
    expect(result.byCabin[0]?.cabin).toBe('economy');
    expect(result.byCabin[0]?.pool).toBeCloseTo(inPools, 9);
    expect(result.totalBooked).toBeCloseTo(inPools, 9);
    expect(result.totalLost).toBe(0);
  });

  it('records how much a cabin inherited', () => {
    // Premium economy is unsold here, so its market lands in economy — and
    // economy says so rather than simply being larger than expected.
    const result = allocateByClass({
      operators: [
        operator({
          id: 'a',
          cabins: {
            business: { seats: 60, fareMinor: 30_000 },
            economy: { seats: 600, fareMinor: 9_000 },
          },
        }),
      ],
      segmentPools: BUSINESS_ROUTE,
    });

    const economy = result.byCabin.find((c) => c.cabin === 'economy');
    const premiumEconomyPool = DEMAND_SEGMENTS.reduce(
      (sum, s) => sum + BUSINESS_ROUTE[s] * DEFAULT_CLASS_MIX.propensity[s].premium_economy,
      0,
    );

    // Exactly premium economy's market, not merely "some" — the cascade must
    // move the whole of an unsold cabin and nothing else.
    expect(economy?.cascadedIn).toBeCloseTo(premiumEconomyPool, 9);
  });

  it('cascades from the top down, one cabin at a time', () => {
    // First is unsold and business is sold, so first's demand joins business —
    // not economy.
    const withBusiness = allocateByClass({
      operators: [operator({ id: 'a', cabins: TWO_CLASS })],
      segmentPools: BUSINESS_ROUTE,
    });
    const firstPropensity = DEMAND_SEGMENTS.reduce(
      (sum, s) => sum + BUSINESS_ROUTE[s] * DEFAULT_CLASS_MIX.propensity[s].first,
      0,
    );

    expect(withBusiness.byCabin.find((c) => c.cabin === 'business')?.cascadedIn).toBeCloseTo(
      firstPropensity,
      9,
    );
  });
});

describe('a cabin that is sold and full', () => {
  it('spills within the cabin rather than downgrading', () => {
    // Deliberate, and different from the cascade above. Moving spilled premium
    // passengers into economy would quietly flatter the cabin that failed and
    // hide the signal A.5 exists to show.
    const result = allocateByClass({
      operators: [
        operator({
          id: 'a',
          cabins: {
            business: { seats: 5, fareMinor: 30_000 },
            economy: { seats: 5_000, fareMinor: 9_000 },
          },
        }),
      ],
      segmentPools: BUSINESS_ROUTE,
    });

    const business = result.byCabin.find((c) => c.cabin === 'business');
    const economy = result.byCabin.find((c) => c.cabin === 'economy');

    expect(business?.capacity?.totalSpilled).toBeGreaterThan(0);
    expect(business?.capacity?.lostDemand).toBeGreaterThan(0);
    // Economy has thousands of empty seats and does not absorb the spill.
    expect(economy?.capacity?.lostDemand).toBe(0);
    expect(result.totalLost).toBeGreaterThan(0);
  });

  it('reports the spill against the operator that turned them away', () => {
    const result = allocateByClass({
      operators: [
        operator({
          id: 'small-cabin',
          cabins: {
            business: { seats: 2, fareMinor: 30_000 },
            economy: { seats: 5_000, fareMinor: 9_000 },
          },
        }),
      ],
      segmentPools: BUSINESS_ROUTE,
    });

    const row = result.byOperator['small-cabin']?.find((r) => r.cabin === 'business');
    expect(row?.spilled).toBeGreaterThan(0);
    expect(row?.loadFactor).toBe(1);
  });
});

describe('each cabin is its own market', () => {
  it('prices against the fares in that cabin, not the route average', () => {
    // The operator undercutting in economy while charging a premium up front
    // should win economy and lose business — which only happens if PriceRel is
    // computed within the cabin.
    const result = allocateByClass({
      operators: [
        operator({
          id: 'cheap-economy',
          cabins: {
            business: { seats: 100, fareMinor: 40_000 },
            economy: { seats: 1_000, fareMinor: 6_000 },
          },
        }),
        operator({
          id: 'cheap-business',
          cabins: {
            business: { seats: 100, fareMinor: 22_000 },
            economy: { seats: 1_000, fareMinor: 12_000 },
          },
        }),
      ],
      segmentPools: BUSINESS_ROUTE,
    });

    const shareIn = (cabin: CabinClass, id: string) =>
      result.byCabin
        .find((c) => c.cabin === cabin)
        ?.capacity?.operators.find((o) => o.operatorId === id)?.booked ?? 0;

    expect(shareIn('economy', 'cheap-economy')).toBeGreaterThan(
      shareIn('economy', 'cheap-business'),
    );
    expect(shareIn('business', 'cheap-business')).toBeGreaterThan(
      shareIn('business', 'cheap-economy'),
    );
  });

  it('lets a cabin-level product score override the operator’s', () => {
    // M6-08's cabin builder and M6-09's seat catalogue produce this; the seam
    // is here so they arrive as an input rather than a rewrite.
    const flat = allocateByClass({
      operators: [
        operator({
          id: 'a',
          productScore: 0.4,
          cabins: {
            business: { seats: 100, fareMinor: 30_000 },
            economy: { seats: 500, fareMinor: 9_000 },
          },
        }),
        operator({
          id: 'b',
          productScore: 0.4,
          cabins: {
            business: { seats: 100, fareMinor: 30_000 },
            economy: { seats: 500, fareMinor: 9_000 },
          },
        }),
      ],
      segmentPools: BUSINESS_ROUTE,
    });
    const better = allocateByClass({
      operators: [
        operator({
          id: 'a',
          productScore: 0.4,
          cabins: {
            business: { seats: 100, fareMinor: 30_000, productScore: 0.95 },
            economy: { seats: 500, fareMinor: 9_000 },
          },
        }),
        operator({
          id: 'b',
          productScore: 0.4,
          cabins: {
            business: { seats: 100, fareMinor: 30_000 },
            economy: { seats: 500, fareMinor: 9_000 },
          },
        }),
      ],
      segmentPools: BUSINESS_ROUTE,
    });

    const businessBooked = (r: typeof flat, id: string) =>
      r.byCabin
        .find((c) => c.cabin === 'business')
        ?.capacity?.operators.find((o) => o.operatorId === id)?.booked ?? 0;

    expect(businessBooked(flat, 'a')).toBeCloseTo(businessBooked(flat, 'b'), 9);
    expect(businessBooked(better, 'a')).toBeGreaterThan(businessBooked(better, 'b'));
    // And only the business cabin moved — the economy product is unchanged.
    const economyBooked = (r: typeof flat, id: string) =>
      r.byCabin
        .find((c) => c.cabin === 'economy')
        ?.capacity?.operators.find((o) => o.operatorId === id)?.booked ?? 0;
    expect(economyBooked(better, 'a')).toBeCloseTo(economyBooked(better, 'b'), 9);
  });

  it('carries the decomposition into each cabin', () => {
    // A.9's waterfall has to work per cabin too, or "why is my business cabin
    // losing" has no answer.
    const result = allocateByClass({
      operators: [
        operator({ id: 'a', cabins: TWO_CLASS }),
        operator({ id: 'b', cabins: TWO_CLASS }),
      ],
      segmentPools: BUSINESS_ROUTE,
    });

    const shares = result.byCabin.find((c) => c.cabin === 'business')?.shares;
    expect(shares).not.toBeNull();
    expect(shares?.bySegment.business.operators).toHaveLength(2);
    expect(shares?.bySegment.business.operators[0]?.terms.price).toBeLessThan(0);
  });
});

describe('the mix table', () => {
  it('has every segment summing to exactly one', () => {
    // A row summing to 0.98 would quietly delete 2% of the market with no
    // symptom beyond demand being slightly low — the hardest bug to notice.
    expect(() => {
      assertMixSums();
    }).not.toThrow();

    for (const segment of DEMAND_SEGMENTS) {
      const row = DEFAULT_CLASS_MIX.propensity[segment];
      expect(
        CABIN_ORDER.reduce((sum, c) => sum + row[c], 0),
        segment,
      ).toBeCloseTo(1, 12);
    }
  });

  it('refuses a table that does not', () => {
    const broken: ClassMixConfig = {
      propensity: {
        ...DEFAULT_CLASS_MIX.propensity,
        leisure: { first: 0.1, business: 0.1, premium_economy: 0.1, economy: 0.1 },
      },
    };

    expect(() => {
      assertMixSums(broken);
    }).toThrow(/sum to/);
    expect(() => allocateByClass({ operators: [], segmentPools: LEISURE_ROUTE }, broken)).toThrow(
      /sum to/,
    );
  });

  it('makes business travellers the ones who buy the front of the aircraft', () => {
    const p = DEFAULT_CLASS_MIX.propensity;
    expect(p.business.business).toBeGreaterThan(p.leisure.business * 5);
    expect(p.business.first).toBeGreaterThan(p.leisure.first);
    // And even they mostly sit in economy, which is the realistic part.
    expect(p.business.economy).toBeGreaterThan(0.5);
  });

  it('reads every propensity from config', () => {
    const premiumWorld: ClassMixConfig = {
      propensity: {
        business: { first: 0, business: 1, premium_economy: 0, economy: 0 },
        leisure: { first: 0, business: 1, premium_economy: 0, economy: 0 },
        vfr: { first: 0, business: 1, premium_economy: 0, economy: 0 },
      },
    };

    const result = allocateByClass(
      {
        operators: [operator({ id: 'a', cabins: TWO_CLASS })],
        segmentPools: LEISURE_ROUTE,
      },
      premiumWorld,
    );

    // Everybody wants business now, so economy's market is whatever business
    // could not seat — nothing, because spill stays in its cabin.
    expect(result.byCabin.find((c) => c.cabin === 'economy')?.pool).toBe(0);
    expect(result.byCabin.find((c) => c.cabin === 'business')?.pool).toBeCloseTo(1_000, 9);
  });
});

describe('edge cases', () => {
  it('is pure — the same route always allocates the same way', () => {
    const inputs = {
      operators: [operator({ id: 'a', cabins: TWO_CLASS })],
      segmentPools: LEISURE_ROUTE,
    };

    expect(allocateByClass(inputs)).toEqual(allocateByClass(inputs));
  });

  it('does nothing with no operators', () => {
    const result = allocateByClass({ operators: [], segmentPools: LEISURE_ROUTE });

    expect(result.byCabin).toHaveLength(0);
    expect(result.totalBooked).toBe(0);
    expect(result.totalPool).toBe(0);
  });

  it('ignores a cabin declared with no seats', () => {
    const result = allocateByClass({
      operators: [
        operator({
          id: 'a',
          cabins: {
            business: { seats: 0, fareMinor: 30_000 },
            economy: { seats: 500, fareMinor: 9_000 },
          },
        }),
      ],
      segmentPools: LEISURE_ROUTE,
    });

    // A zero-seat cabin is not on offer, so its demand cascades rather than
    // being allocated to seats that do not exist.
    expect(result.byCabin.map((c) => c.cabin)).toEqual(['economy']);
    expect(result.byCabin[0]?.cascadedIn).toBeGreaterThan(0);
  });

  it('does nothing to a route with no market', () => {
    const result = allocateByClass({
      operators: [operator({ id: 'a', cabins: TWO_CLASS })],
      segmentPools: { business: 0, leisure: 0, vfr: 0 },
    });

    expect(result.totalPool).toBe(0);
    expect(result.totalBooked).toBe(0);
    for (const rows of Object.values(result.byOperator)) {
      for (const row of rows) expect(row.passengers).toBe(0);
    }
  });

  it('refuses a pool that is not a number of people', () => {
    expect(() =>
      allocateByClass({
        operators: [operator({ id: 'a', cabins: TWO_CLASS })],
        segmentPools: { ...LEISURE_ROUTE, leisure: -1 },
      }),
    ).toThrow(/pool/);
  });

  it('prices revenue from the cabin’s own fare', () => {
    const result = allocateByClass({
      operators: [operator({ id: 'a', cabins: TWO_CLASS })],
      segmentPools: BUSINESS_ROUTE,
    });

    for (const row of result.byOperator.a ?? []) {
      expect(row.revenueMinor).toBeCloseTo(row.passengers * row.fareMinor, 6);
    }
  });
});
