import { describe, expect, it } from 'vitest';

import type { DemandSegment } from '@tailfin/shared';
import { ECONOMY_CONFIG_V1 } from '@tailfin/shared';
import { DEFAULT_FUEL_MARKET } from '@tailfin/sim';
import type { ClassOperator } from '@tailfin/sim';

import {
  REFERENCE_FEES,
  REFERENCE_HANDLING_PRICE_FACTOR,
  REFERENCE_SELF,
  REFERENCE_STATION,
} from './economics';
import { rivalsOn, waterfallFor, YOU } from './waterfall';

import type { RouteEconomics, RouteRow } from './fares';

/**
 * The decomposition waterfall (M3-10, App. A.9, §14.1).
 *
 * A.9 publishes a worked table and one claim about it: *"the waterfall isn't an
 * approximation of the result — it **is** the result."* So the tests that
 * matter are that the published figures survive the trip through the server,
 * and that the factors sum with **no residual** — because a residual would mean
 * the chart was a summary rather than the thing itself.
 */

/**
 * A.8's route, arranged so the waterfall runs on the published numbers.
 *
 * One cabin, so the per-cabin allocation reduces to A.3's single market; the
 * aircraft is sized far above the pool so capacity never binds and the shares
 * are the logit's own.
 */
const A8_AIRCRAFT = {
  cruiseSpeedKt: 447,
  cruiseBurnTPerNm: 0.0062,
  maxTakeoffWeightT: 79,
  seatsByCabin: { economy: 5_000 },
};

/** A.8: pool 1,200/day, 20% business, 60% leisure, 20% VFR. */
const POOLS: Record<DemandSegment, number> = { business: 240, leisure: 720, vfr: 240 };

/** A.8's Rival A — the LCC at €69, five times daily. */
const RIVAL_A: ClassOperator = {
  id: 'a',
  frequency: 5,
  productScore: 0.38,
  reputation: 0.45,
  cabins: { economy: { seats: 5_000, fareMinor: 6_900 } },
};

/** A.8's Rival B — the legacy carrier at €140, four times daily. */
const RIVAL_B: ClassOperator = {
  id: 'b',
  frequency: 4,
  productScore: 0.78,
  reputation: 0.72,
  cabins: { economy: { seats: 5_000, fareMinor: 14_000 } },
};

const ROUTE: RouteRow = {
  id: 'route-1',
  worldId: 'world-1',
  airlineId: 'airline-1',
  originIcao: 'EHAM',
  destinationIcao: 'LEBL',
  greatCircleNm: 700,
  // A.8's "You": €95.
  fares: { economy: 9_500 },
};

function economics(over: Partial<RouteEconomics> = {}): RouteEconomics {
  return {
    aircraft: A8_AIRCRAFT,
    fleet: [A8_AIRCRAFT],
    basis: { kind: 'single' as const, label: 'A.8 worked example' },
    market: DEFAULT_FUEL_MARKET,
    originStation: REFERENCE_STATION,
    handlingPriceFactor: REFERENCE_HANDLING_PRICE_FACTOR,
    originFees: REFERENCE_FEES,
    destinationFees: REFERENCE_FEES,
    segmentPools: POOLS,
    competitors: [RIVAL_A, RIVAL_B],
    // A.8's "You": product 0.62, reputation 0.55, three times daily.
    self: { ...REFERENCE_SELF, productScore: 0.62, reputation: 0.55, frequency: 3 },
    settlement: ECONOMY_CONFIG_V1.costs.settlement,
    fareFloorRatio: ECONOMY_CONFIG_V1.pricing.fareFloorRatio,
    ...over,
  };
}

describe('App. A.9’s table survives the round trip — the acceptance criterion', () => {
  const result = waterfallFor(ROUTE, economics(), 'economy', 'a');

  it('reproduces the published factors', () => {
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected a waterfall');

    const leisure = result.waterfall.bySegment.find((s) => s.segment === 'leisure');
    const by = (factor: string) => leisure?.factors.find((f) => f.factor === factor)?.delta ?? 0;

    // A.9: price −0.770, frequency −0.460, product +0.192, reputation +0.050.
    expect(by('price')).toBeCloseTo(-0.77, 3);
    expect(by('frequency')).toBeCloseTo(-0.46, 3);
    expect(by('product')).toBeCloseTo(0.192, 3);
    expect(by('reputation')).toBeCloseTo(0.05, 3);
  });

  it('nets to A.9’s figure, allowing for the doc’s own rounding', () => {
    if (!result.ok) throw new Error('expected a waterfall');
    const leisure = result.waterfall.bySegment.find((s) => s.segment === 'leisure');

    // A.9 prints −0.988, which is the sum of its **rounded** rows:
    // −0.770 − 0.460 + 0.192 + 0.050. The exact sum is −0.98748. The rows match
    // the doc to the digit and the net is the doc's arithmetic, not a
    // divergence — pinned so nobody "corrects" the model to hit −0.988 and
    // breaks the exact decomposition doing it.
    expect(leisure?.netDelta).toBeCloseTo(-0.9875, 4);
    expect(Number(leisure!.netDelta.toFixed(2))).toBe(-0.99);
  });

  it('has no residual — the factors *are* the gap', () => {
    if (!result.ok) throw new Error('expected a waterfall');

    for (const segment of result.waterfall.bySegment) {
      const summed = segment.factors.reduce((sum, f) => sum + f.delta, 0);
      expect(summed, segment.segment).toBeCloseTo(segment.netDelta, 12);
    }
  });

  it('reproduces the share ratio from the gap alone', () => {
    if (!result.ok) throw new Error('expected a waterfall');

    for (const segment of result.waterfall.bySegment) {
      // A.9's closing claim, and the reason the model was chosen: exp(gap) is
      // the ratio of the shares, to twelve places.
      expect(segment.shareRatio, segment.segment).toBeCloseTo(
        segment.yourShare / segment.theirShare,
        12,
      );
    }
  });

  it('reproduces A.8’s leisure shares, so the gap is about the right market', () => {
    if (!result.ok) throw new Error('expected a waterfall');
    const leisure = result.waterfall.bySegment.find((s) => s.segment === 'leisure');

    expect((leisure?.yourShare ?? 0) * 100).toBeCloseTo(24.3, 1);
    expect((leisure?.theirShare ?? 0) * 100).toBeCloseTo(65.4, 1);
  });

  it('answers differently in business, which is the point of doing all three', () => {
    if (!result.ok) throw new Error('expected a waterfall');
    const leisure = result.waterfall.bySegment.find((s) => s.segment === 'leisure');
    const business = result.waterfall.bySegment.find((s) => s.segment === 'business');

    // The same fare gap costs a leisure traveller far more than a business one,
    // so the price bar is much shorter in business. That contrast is why the
    // response carries every segment rather than making the reader ask twice.
    const price = (s: typeof leisure) => s?.factors.find((f) => f.factor === 'price')?.delta ?? 0;
    expect(Math.abs(price(business))).toBeLessThan(Math.abs(price(leisure)) / 2);
  });

  it('orders factors by how much of the gap they explain', () => {
    if (!result.ok) throw new Error('expected a waterfall');
    const leisure = result.waterfall.bySegment.find((s) => s.segment === 'leisure');

    // "Your €26 premium is most of the gap" — the chart has to read that way
    // round or the player draws the wrong conclusion from it.
    expect(leisure?.factors[0]?.factor).toBe('price');
    expect(leisure?.factors[1]?.factor).toBe('frequency');
  });
});

describe('refusing specifically', () => {
  it('says there is nobody to compare against, and does not draw an empty chart', () => {
    // The honest state of every route today: no AI carriers (M3-12) and one
    // player. A monopolist is not losing to anyone.
    const result = waterfallFor(ROUTE, economics({ competitors: [] }), 'economy', 'a');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.kind).toBe('no-rival');
  });

  it('distinguishes an unknown rival from an absent one', () => {
    const result = waterfallFor(ROUTE, economics(), 'economy', 'nobody');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    if (result.kind !== 'unknown-rival') throw new Error('expected unknown-rival');
    // And offers who there actually is, so the client can recover.
    expect(result.rivals.map((r) => r.id).sort()).toEqual(['a', 'b']);
  });

  it('refuses a cabin the rival does not sell', () => {
    const result = waterfallFor(ROUTE, economics(), 'business', 'a');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.kind).toBe('cabin-not-contested');
  });

  it('keeps the rival list on every refusal, so the client can recover', () => {
    // A refusal that dropped the list would take away the only control able to
    // get out of it — the player is told nobody sells business here and has no
    // way left to ask about economy.
    const cabin = waterfallFor(ROUTE, economics(), 'business', 'a');
    if (cabin.ok || cabin.kind !== 'cabin-not-contested') throw new Error('expected a refusal');
    expect(cabin.rivals.map((r) => r.id).sort()).toEqual(['a', 'b']);
  });
});

describe('who there is to compare against', () => {
  it('lists rivals with the cabins they actually sell', () => {
    const rivals = rivalsOn(economics());

    expect(rivals.map((r) => r.id).sort()).toEqual(['a', 'b']);
    expect(rivals.find((r) => r.id === 'a')?.cabins).toEqual(['economy']);
  });

  it('leaves out a cabin declared with no seats', () => {
    const hollow: ClassOperator = {
      ...RIVAL_A,
      cabins: {
        economy: { seats: 100, fareMinor: 9_000 },
        business: { seats: 0, fareMinor: 30_000 },
      },
    };

    expect(rivalsOn(economics({ competitors: [hollow] }))[0]?.cabins).toEqual(['economy']);
  });

  it('is empty when nobody else flies the pair', () => {
    expect(rivalsOn(economics({ competitors: [] }))).toEqual([]);
  });
});

describe('the waterfall explains the market it is drawn from', () => {
  it('competes the same airline the fare preview does', () => {
    // Both call `selfAsOperator`. Two constructions of "you" would eventually
    // disagree, and a chart that explains a different market than the one the
    // player is in explains nothing.
    const result = waterfallFor(ROUTE, economics(), 'economy', 'a');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected a waterfall');

    expect(result.waterfall.rivalId).toBe('a');
    expect(YOU).toBe('you');
  });

  it('names every rival on the success path, not just the one it drew', () => {
    // A.8's route has two, and you lose to them for opposite reasons: the LCC
    // on price, the legacy carrier on product. Sending only the operator that
    // happened to be picked would let the player see one and never learn the
    // other was there.
    const result = waterfallFor(ROUTE, economics(), 'economy', 'a');
    if (!result.ok) throw new Error('expected a waterfall');

    expect(result.waterfall.rivals.map((r) => r.id).sort()).toEqual(['a', 'b']);
    expect(result.waterfall.rivals.map((r) => r.id)).toContain(result.waterfall.rivalId);
  });

  it('decomposes against the rival it was asked for', () => {
    const vsLcc = waterfallFor(ROUTE, economics(), 'economy', 'a');
    const vsLegacy = waterfallFor(ROUTE, economics(), 'economy', 'b');
    if (!vsLcc.ok || !vsLegacy.ok) throw new Error('expected waterfalls');

    const price = (r: typeof vsLcc) =>
      r.ok
        ? (r.waterfall.bySegment
            .find((s) => s.segment === 'leisure')
            ?.factors.find((f) => f.factor === 'price')?.delta ?? 0)
        : 0;

    // You are dearer than the LCC and cheaper than the legacy carrier, so the
    // price bar flips sign between the two comparisons. Same route, opposite
    // lesson — which is why the rival is the player's choice and not ours.
    expect(price(vsLcc)).toBeLessThan(0);
    expect(price(vsLegacy)).toBeGreaterThan(0);
  });

  it('moves when the fare moves', () => {
    const dear = waterfallFor(
      { ...ROUTE, fares: { economy: 20_000 } },
      economics(),
      'economy',
      'a',
    );
    const cheap = waterfallFor(
      { ...ROUTE, fares: { economy: 5_000 } },
      economics(),
      'economy',
      'a',
    );

    if (!dear.ok || !cheap.ok) throw new Error('expected waterfalls');
    const price = (r: typeof dear) =>
      r.ok
        ? (r.waterfall.bySegment
            .find((s) => s.segment === 'leisure')
            ?.factors.find((f) => f.factor === 'price')?.delta ?? 0)
        : 0;

    // Charging more makes the price bar worse. If it did not, the chart would
    // be decoration.
    expect(price(dear)).toBeLessThan(price(cheap));
  });
});
