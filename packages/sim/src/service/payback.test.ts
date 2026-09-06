import { describe, expect, it } from 'vitest';

import { ECONOMY_CONFIG_V1 } from '@tailfin/shared';

import { DEFAULT_LOGIT } from '../demand/logit';

import { servicePayback, weightedNetPerPaxMinor } from './payback';

/**
 * App. D.4's worked example, which is M8-05's first acceptance criterion:
 *
 * > a €12.40 package at +0.18 product yields leisure −€7.54, VFR −€7.84,
 * > business +€24.08
 *
 * ## A note on the €101
 *
 * The appendix states the route's average fare as **€101** and its table does
 * not quite follow from that: at exactly 101 the business net comes to €23.96
 * against the stated €24.08, twelve cents out.
 *
 * The table is internally consistent, though — at an average fare of **€101⅓**
 * all three rows reproduce to the cent, and VFR's €4.56 and business's €36.48
 * come out exact. So "€101" is the appendix rounding its *input* for the prose,
 * not its outputs being approximate. Both are asserted below: the exact table at
 * the fare it implies, and the stated €101 landing within about a cent on the
 * two segments where the arithmetic is not amplified by a low price coefficient.
 *
 * Worth writing down because the alternative reading — that the formula is
 * slightly wrong — is the one somebody will reach for the next time these
 * numbers are checked.
 */

/** The appendix's package: €12.40 a head, +0.18 product, no ancillary revenue. */
const PACKAGE = { productDelta: 0.18, costPerPaxMinor: 1_240, revenuePerPaxMinor: 0 };

/** The average fare App. D.4's own table implies, in minor units: €101⅓. */
const IMPLIED_FARE_MINOR = (101 + 1 / 3) * 100;

function rowsAt(averageFareMinor: number) {
  const rows = servicePayback({ ...PACKAGE, averageFareMinor });
  return Object.fromEntries(rows.map((row) => [row.segment, row]));
}

describe('App. D.4’s payback table', () => {
  it('reproduces the worked example to the cent at the fare it implies', () => {
    const rows = rowsAt(IMPLIED_FARE_MINOR);

    // Utility gain: β_product(s) × 0.18, straight off A.3's coefficient table.
    expect(rows.leisure!.utilityGain).toBeCloseTo(0.144, 10);
    expect(rows.vfr!.utilityGain).toBeCloseTo(0.108, 10);
    expect(rows.business!.utilityGain).toBeCloseTo(0.396, 10);

    // The premium each supports — €4.86 / €4.56 / €36.48.
    expect(rows.leisure!.farePremiumSupportedMinor).toBe(486);
    expect(rows.vfr!.farePremiumSupportedMinor).toBe(456);
    expect(rows.business!.farePremiumSupportedMinor).toBe(3_648);

    // And the net: −€7.54 / −€7.84 / +€24.08.
    expect(rows.leisure!.netPerPaxMinor).toBe(-754);
    expect(rows.vfr!.netPerPaxMinor).toBe(-784);
    expect(rows.business!.netPerPaxMinor).toBe(2_408);
  });

  it('is within a cent or so at the €101 the appendix states', () => {
    const rows = rowsAt(101_00);
    // Leisure and VFR divide by a large price coefficient, so the rounded input
    // barely shows. Business divides by 1.1 and amplifies it to twelve cents.
    expect(rows.leisure!.netPerPaxMinor).toBeCloseTo(-754, -1);
    expect(rows.vfr!.netPerPaxMinor).toBeCloseTo(-784, -1);
    expect(rows.business!.netPerPaxMinor).toBe(2_396);
  });

  it('makes the same package a loss on leisure and a win on business', () => {
    // The appendix's whole point: "not because the service is better or worse,
    // but because of who is sitting in the seat."
    const rows = rowsAt(IMPLIED_FARE_MINOR);
    expect(rows.leisure!.netPerPaxMinor).toBeLessThan(0);
    expect(rows.vfr!.netPerPaxMinor).toBeLessThan(0);
    expect(rows.business!.netPerPaxMinor).toBeGreaterThan(0);
    // Seven and a half times the premium, from the coefficients alone.
    expect(
      rows.business!.farePremiumSupportedMinor / rows.leisure!.farePremiumSupportedMinor,
    ).toBeCloseTo(7.5, 1);
  });
});

describe('the arithmetic around the edges', () => {
  it('supports no premium for a package that changes nothing', () => {
    const rows = rowsAt(IMPLIED_FARE_MINOR).leisure!;
    const flat = servicePayback({ ...PACKAGE, productDelta: 0, averageFareMinor: 10_100 })[0]!;
    expect(flat.utilityGain).toBe(0);
    expect(flat.farePremiumSupportedMinor).toBe(0);
    // Still costs what it costs — that is the point of showing the table.
    expect(flat.netPerPaxMinor).toBe(-1_240);
    expect(rows.farePremiumSupportedMinor).toBeGreaterThan(0);
  });

  it('counts ancillary revenue, so a buy-on-board package is not read as a loss', () => {
    // App. D.3's budget configuration *earns* €18.10 a head. A payback table that
    // only knew about cost would tell that airline its catering lost money.
    const earning = servicePayback({
      productDelta: 0.02,
      costPerPaxMinor: 0,
      revenuePerPaxMinor: 1_810,
      averageFareMinor: 10_100,
    });
    for (const row of earning) expect(row.netPerPaxMinor).toBeGreaterThan(0);
  });

  it('reads a downgrade as the negative premium it is', () => {
    const worse = servicePayback({
      productDelta: -0.18,
      costPerPaxMinor: 0,
      revenuePerPaxMinor: 0,
      averageFareMinor: IMPLIED_FARE_MINOR,
    });
    for (const row of worse) {
      expect(row.farePremiumSupportedMinor).toBeLessThan(0);
      // Stripping service saves nothing here, so the whole loss is the fare it
      // can no longer support.
      expect(row.netPerPaxMinor).toBe(row.farePremiumSupportedMinor);
    }
  });

  it('scales the premium with the market’s fare level', () => {
    // PriceRel is a ratio, so the same utility is worth more money on a dearer
    // route. A long-haul premium cabin is where service spending pays back.
    const cheap = rowsAt(5_000).business!.farePremiumSupportedMinor;
    const dear = rowsAt(50_000).business!.farePremiumSupportedMinor;
    expect(dear).toBeCloseTo(cheap * 10, -1);
  });

  it('uses the world’s own coefficients rather than a copy of them', () => {
    // The third acceptance criterion, as behaviour: retune the logit and the
    // payback table moves with it.
    const doubled = {
      beta: {
        ...DEFAULT_LOGIT.beta,
        business: {
          ...DEFAULT_LOGIT.beta.business,
          product: DEFAULT_LOGIT.beta.business.product * 2,
        },
      },
    };
    const shipped = servicePayback({ ...PACKAGE, averageFareMinor: 10_100 }, DEFAULT_LOGIT);
    const retuned = servicePayback({ ...PACKAGE, averageFareMinor: 10_100 }, doubled);
    const business = (rows: ReturnType<typeof servicePayback>) =>
      rows.find((row) => row.segment === 'business')!;
    expect(business(retuned).utilityGain).toBeCloseTo(business(shipped).utilityGain * 2, 10);
  });

  it('reads the coefficients A.3 actually ships', () => {
    // Guards the example above against a silent retune of the seed: if these
    // move, the appendix's table stops being the thing being reproduced.
    expect(ECONOMY_CONFIG_V1.demand.logit.beta.business.product).toBe(2.2);
    expect(ECONOMY_CONFIG_V1.demand.logit.beta.business.price).toBe(1.1);
    expect(ECONOMY_CONFIG_V1.demand.logit.beta.leisure.product).toBe(0.8);
    expect(ECONOMY_CONFIG_V1.demand.logit.beta.leisure.price).toBe(3.0);
    expect(ECONOMY_CONFIG_V1.demand.logit.beta.vfr.product).toBe(0.6);
    expect(ECONOMY_CONFIG_V1.demand.logit.beta.vfr.price).toBe(2.4);
  });
});

describe('weighting by who is on the route', () => {
  const rows = servicePayback({ ...PACKAGE, averageFareMinor: IMPLIED_FARE_MINOR });

  it('turns the same package into a bad idea and a good one', () => {
    // App. D.4's real claim: "budget or luxury?" has a correct answer *per route*.
    const holiday = weightedNetPerPaxMinor(rows, { business: 0.05, leisure: 0.7, vfr: 0.25 });
    const trunk = weightedNetPerPaxMinor(rows, { business: 0.55, leisure: 0.3, vfr: 0.15 });
    expect(holiday).toBeLessThan(0);
    expect(trunk).toBeGreaterThan(0);
  });

  it('normalises a mix that does not sum to one', () => {
    const whole = weightedNetPerPaxMinor(rows, { business: 0.5, leisure: 0.5 });
    const halved = weightedNetPerPaxMinor(rows, { business: 0.25, leisure: 0.25 });
    expect(halved).toBe(whole);
  });

  it('answers zero for a route with no demand rather than dividing by it', () => {
    expect(weightedNetPerPaxMinor(rows, {})).toBe(0);
    expect(weightedNetPerPaxMinor(rows, { business: 0 })).toBe(0);
  });
});
