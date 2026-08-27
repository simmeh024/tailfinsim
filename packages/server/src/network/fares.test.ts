import { describe, expect, it } from 'vitest';

import type { DemandSegment, FareTable } from '@tailfin/shared';
import { ECONOMY_CONFIG_V1 } from '@tailfin/shared';
import type { ClassOperator } from '@tailfin/sim';
import { DEFAULT_FUEL_MARKET } from '@tailfin/sim';

import { REFERENCE_AIRFRAME, REFERENCE_FEES, REFERENCE_SELF, REFERENCE_STATION } from './economics';
import { floorFor, previewFares, type RouteEconomics, type RouteRow, violationsFor } from './fares';

/**
 * Fares and the preview (M3-09, App. A.10, §8.3).
 *
 * Both acceptance criteria are about *where* a number comes from rather than
 * what it is, so these tests check provenance:
 *
 *   - a refusal carries the floor it was refused against;
 *   - the preview moves when the sim would move, because it is the sim.
 *
 * No database here — `setFares` is the only function that writes, and the
 * decisions all happen before it. The write path is covered by the route tests.
 */

/**
 * Deliberately smaller than the aircraft (174 seats).
 *
 * With a 1,200-passenger pool the reference narrowbody fills either way and
 * `projectedPassengers` is pinned at 174 whatever the fare — which is correct
 * behaviour and useless as a test of price sensitivity. This pair is capacity-
 * comfortable, so price is the binding constraint.
 */
const POOLS: Record<DemandSegment, number> = { business: 20, leisure: 70, vfr: 20 };

const ROUTE: RouteRow = {
  id: 'route-1',
  worldId: 'world-1',
  airlineId: 'airline-1',
  originIcao: 'EHAM',
  destinationIcao: 'LEBL',
  greatCircleNm: 700,
  fares: { business: 30_000, economy: 12_000 },
};

function economics(over: Partial<RouteEconomics> = {}): RouteEconomics {
  return {
    aircraft: REFERENCE_AIRFRAME,
    market: DEFAULT_FUEL_MARKET,
    originStation: REFERENCE_STATION,
    originFees: REFERENCE_FEES,
    destinationFees: REFERENCE_FEES,
    segmentPools: POOLS,
    competitors: [],
    self: REFERENCE_SELF,
    // The shipped economy, exactly as a world pinned to v1 would supply it.
    // Named rather than defaulted, because these tests assert money.
    settlement: ECONOMY_CONFIG_V1.costs.settlement,
    fareFloorRatio: ECONOMY_CONFIG_V1.pricing.fareFloorRatio,
    ...over,
  };
}

/** A rival selling the same pair, for the market-average and share tests. */
const RIVAL: ClassOperator = {
  id: 'rival',
  frequency: 3,
  productScore: 0.55,
  reputation: 0.5,
  cabins: {
    business: { seats: 12, fareMinor: 26_000 },
    economy: { seats: 162, fareMinor: 10_000 },
  },
};

describe('the floor refusal explains itself — the first acceptance criterion', () => {
  it('names the floor, the shortfall and the cost it came from', () => {
    const violations = violationsFor({ economy: 1 }, economics(), ROUTE.greatCircleNm);

    expect(violations).toHaveLength(1);
    const [v] = violations;
    expect(v?.cabin).toBe('economy');
    expect(v?.fareMinor).toBe(1);
    expect(v?.floorMinor).toBeGreaterThan(1);
    expect(v?.shortfallMinor).toBe((v?.floorMinor ?? 0) - 1);
    // The cost the floor is 60% of — without it the player cannot tell whether
    // the limit is reasonable, only that it exists.
    expect(v?.variableCostPerSeatMinor).toBeGreaterThan(v?.floorMinor ?? 0);
    expect(v?.ratio).toBe(0.6);
  });

  it('reports every offending cabin, not just the first', () => {
    // A player who set four fares too low should be told about four, or they
    // fix one and get refused again — the kind of interaction that teaches
    // people the console is lying to them.
    const violations = violationsFor({ business: 1, economy: 2 }, economics(), ROUTE.greatCircleNm);

    expect(violations.map((v) => v.cabin).sort()).toEqual(['business', 'economy']);
  });

  it('says nothing about a fare table that clears', () => {
    expect(violationsFor(ROUTE.fares, economics(), ROUTE.greatCircleNm)).toEqual([]);
  });

  it('ignores a cabin the player did not price', () => {
    // Partial by design: an all-economy aircraft has no business fare and must
    // not be refused for failing to invent one.
    expect(violationsFor({ economy: 12_000 }, economics(), ROUTE.greatCircleNm)).toEqual([]);
  });

  it('draws one floor for the route, not one per cabin', () => {
    // A.10's rule is about *route* variable cost. A business seat costs the
    // same to fly as an economy seat and takes more floor space; charging the
    // premium cabin a higher floor would be inventing a rule the doc has not
    // got.
    const floor = floorFor(economics(), ROUTE.greatCircleNm);
    const both = violationsFor({ business: 1, economy: 1 }, economics(), ROUTE.greatCircleNm);

    expect(both[0]?.floorMinor).toBe(floor.floorMinor);
    expect(both[1]?.floorMinor).toBe(floor.floorMinor);
  });

  it('moves the floor when the route gets longer', () => {
    const near = floorFor(economics(), 200);
    const far = floorFor(economics(), 1_400);

    expect(far.floorMinor).toBeGreaterThan(near.floorMinor);
  });
});

describe('the preview is the resolution code — the second acceptance criterion', () => {
  it('projects fewer passengers at a higher fare', () => {
    // If this did not move, the preview would be a decoration. It moves because
    // `allocateByClass` moved, which is the same function that will decide the
    // market for real.
    const cheap = previewFares(
      ROUTE,
      { business: 30_000, economy: 8_000 },
      economics({ competitors: [RIVAL] }),
    );
    const dear = previewFares(
      ROUTE,
      { business: 30_000, economy: 24_000 },
      economics({ competitors: [RIVAL] }),
    );

    expect(dear.projectedPassengers).toBeLessThan(cheap.projectedPassengers);
  });

  it('reports what is currently saved alongside what is proposed', () => {
    // A projected number on its own is an absolute nobody can calibrate. The
    // delta is the thing a player can act on.
    const preview = previewFares(
      ROUTE,
      { business: 30_000, economy: 6_000 },
      economics({ competitors: [RIVAL] }),
    );

    expect(preview.currentPassengers).toBeGreaterThan(0);
    expect(preview.projectedPassengers).toBeGreaterThan(preview.currentPassengers);
  });

  it('shows the market average and the player’s position against it', () => {
    const preview = previewFares(ROUTE, { economy: 20_000 }, economics({ competitors: [RIVAL] }));
    const economy = preview.positions.find((p) => p.cabin === 'economy');

    // A.3's PriceRel denominator: a plain mean across the operators selling the
    // cabin, exactly as A.8 computes it. 20,000 and 10,000 average to 15,000.
    expect(economy?.marketAverageMinor).toBe(15_000);
    expect(economy?.priceRel).toBeCloseTo(20_000 / 15_000, 9);
    expect(economy?.yourFareMinor).toBe(20_000);
  });

  it('carries the floor into every cabin’s position', () => {
    const floor = floorFor(economics(), ROUTE.greatCircleNm);
    const preview = previewFares(ROUTE, ROUTE.fares, economics());

    for (const position of preview.positions) {
      expect(position.floorMinor).toBe(floor.floorMinor);
    }
  });

  it('gives a monopolist the whole market, because that is what the sim says', () => {
    // No AI carriers yet, so an empty competitor list is a real state rather
    // than a stub — and the preview should be correct about it.
    const preview = previewFares(ROUTE, ROUTE.fares, economics());
    const economy = preview.positions.find((p) => p.cabin === 'economy');

    expect(economy?.projectedShare).toBeCloseTo(1, 6);
  });

  it('loses share to a cheaper rival', () => {
    const alone = previewFares(ROUTE, ROUTE.fares, economics());
    const contested = previewFares(ROUTE, ROUTE.fares, economics({ competitors: [RIVAL] }));

    expect(contested.projectedPassengers).toBeLessThan(alone.projectedPassengers);
    const economy = contested.positions.find((p) => p.cabin === 'economy');
    expect(economy?.projectedShare).toBeLessThan(1);
  });

  it('wins back share when the attractiveness specialist is on staff (§9.1)', () => {
    // Same fares, same rival — the only difference is the specialist's additive
    // utility flowing through `self`, which is exactly how the economics provider
    // supplies it once the airline flies more than one route.
    const without = previewFares(ROUTE, ROUTE.fares, economics({ competitors: [RIVAL] }));
    const withSpecialist = previewFares(
      ROUTE,
      ROUTE.fares,
      economics({
        competitors: [RIVAL],
        self: { ...REFERENCE_SELF, attractiveness: 0.3 },
      }),
    );

    expect(withSpecialist.projectedPassengers).toBeGreaterThan(without.projectedPassengers);
    const economy = withSpecialist.positions.find((p) => p.cabin === 'economy');
    const economyWithout = without.positions.find((p) => p.cabin === 'economy');
    expect(economy?.projectedShare ?? 0).toBeGreaterThan(economyWithout?.projectedShare ?? 0);
  });

  it('reports a cabin the player does not sell as unpriced rather than as zero', () => {
    // Null and zero are different answers: one means "you do not sell this",
    // the other means "you sell it and nobody buys". §14.1's no-dead-end rule
    // applies to absence too.
    const preview = previewFares(ROUTE, { economy: 12_000 }, economics());
    const first = preview.positions.find((p) => p.cabin === 'first');

    expect(first?.yourFareMinor).toBeNull();
    expect(first?.priceRel).toBeNull();
  });

  it('is deterministic — the same proposal previews the same way', () => {
    const inputs = [ROUTE, { economy: 11_000 }, economics({ competitors: [RIVAL] })] as const;
    expect(previewFares(...inputs)).toEqual(previewFares(...inputs));
  });

  it('survives a pair with no demand at all', () => {
    // M3-01 judged some pairs non-viable, and `poolsFor` returns zeros for
    // them. A preview of a market with nobody in it must be a number, not a
    // crash.
    const empty = previewFares(
      ROUTE,
      ROUTE.fares,
      economics({ segmentPools: { business: 0, leisure: 0, vfr: 0 } }),
    );

    expect(empty.projectedPassengers).toBe(0);
    expect(empty.currentPassengers).toBe(0);
  });
});

describe('the fare table on the wire', () => {
  it('accepts a partial table', () => {
    const partial: FareTable = { economy: 12_000 };
    expect(violationsFor(partial, economics(), ROUTE.greatCircleNm)).toEqual([]);
  });
});
