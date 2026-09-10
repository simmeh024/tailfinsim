import { describe, expect, it } from 'vitest';

import { cargoLane, DEFAULT_CARGO, type CargoLaneEndpoint } from './index';

/**
 * §12.2's claims, tested rather than asserted.
 *
 * The one that matters most is the last: *"Cargo route profitability must be
 * evaluated as a round trip, never per leg — this is the single most common
 * real-world mistake and it should be a real trap in the game."* A trap only
 * works if the two legs genuinely differ, so that is what these check.
 */

/** A manufacturing end: high output, lower wealth. Hong Kong-shaped. */
const FACTORY: CargoLaneEndpoint = {
  catchmentPopulation: 7_000_000,
  businessIndex: 1.9,
  wealthIndex: 1.1,
};

/** A consuming end: high wealth, ordinary output. Amsterdam-shaped. */
const MARKET: CargoLaneEndpoint = {
  catchmentPopulation: 3_000_000,
  businessIndex: 1.4,
  wealthIndex: 1.5,
};

/** The reference pair the shipped `offeredTonnesK` is calibrated against. */
const REFERENCE: CargoLaneEndpoint = {
  catchmentPopulation: 2_000_000,
  businessIndex: 1,
  wealthIndex: 1,
};

/** A thin regional field with a real but small market. */
const THIN: CargoLaneEndpoint = {
  catchmentPopulation: 200_000,
  businessIndex: 0.8,
  wealthIndex: 0.8,
};

/** An airport with no scheduled service, so M1-03 sized nothing. */
const UNCLASSIFIED: CargoLaneEndpoint = {
  catchmentPopulation: null,
  businessIndex: null,
  wealthIndex: null,
};

describe('cargo lanes', () => {
  it('finds the headhaul without being told which way it runs (§12.2)', () => {
    const out = cargoLane(FACTORY, MARKET, 5_100);
    const back = cargoLane(MARKET, FACTORY, 5_100);

    expect(out.direction).toBe('headhaul');
    expect(back.direction).toBe('backhaul');
    // The same lane, so the same lopsidedness whichever leg you are looking at.
    expect(back.imbalance).toBeCloseTo(out.imbalance, 10);
    expect(out.imbalance).toBeGreaterThan(1.5);
  });

  it('pays the headhaul more than the backhaul, and by a visible margin', () => {
    const out = cargoLane(FACTORY, MARKET, 5_100);
    const back = cargoLane(MARKET, FACTORY, 5_100);

    expect(out.ratePerTonneMinor).toBeGreaterThan(back.ratePerTonneMinor);
    // A gap a player would act on rather than a rounding artefact: the headhaul
    // is worth a third more a tonne than the way home.
    expect(out.ratePerTonneMinor / back.ratePerTonneMinor).toBeGreaterThan(1.3);
  });

  it('agrees with itself about the other leg, so a rotation can be priced once', () => {
    const out = cargoLane(FACTORY, MARKET, 5_100);
    const back = cargoLane(MARKET, FACTORY, 5_100);

    expect(out.reverseRatePerTonneMinor).toBe(back.ratePerTonneMinor);
    expect(back.reverseRatePerTonneMinor).toBe(out.ratePerTonneMinor);
  });

  it('puts both legs’ rates in the sentence, because that is the trap (§12.2)', () => {
    const out = cargoLane(FACTORY, MARKET, 5_100);

    expect(out.detail).toContain('Headhaul');
    expect(out.detail).toContain('Price the round trip, not the leg');
    expect(cargoLane(MARKET, FACTORY, 5_100).detail).toContain('Backhaul');
  });

  it('offers more freight the heavier the lane, and less the thinner', () => {
    const trunk = cargoLane(FACTORY, MARKET, 5_100);
    const reference = cargoLane(REFERENCE, REFERENCE, 700);
    const thin = cargoLane(THIN, THIN, 300);

    // The calibration anchor `offeredTonnesK` is documented against.
    expect(reference.offeredTonnes).toBeCloseTo(8, 0);
    expect(trunk.offeredTonnes).toBeGreaterThan(reference.offeredTonnes);
    // A thin lane offers about a tonne, which is the half that matters: demand
    // has to be able to bind, or the capacity model is decorative.
    expect(thin.offeredTonnes).toBeLessThan(2);
    expect(thin.offeredTonnes).toBeGreaterThan(0.5);
  });

  it('offers less on the way back, not just a worse rate', () => {
    const out = cargoLane(FACTORY, MARKET, 5_100);
    const back = cargoLane(MARKET, FACTORY, 5_100);

    // §12.2: the backhaul *"runs half-empty at a fraction of the rate"* — both
    // halves, so an empty hold and a poor yield compound.
    expect(back.offeredTonnes).toBeLessThan(out.offeredTonnes);
  });

  it('reads a symmetric pair as balanced, and pays both legs the same', () => {
    const lane = cargoLane(REFERENCE, REFERENCE, 700);

    expect(lane.direction).toBe('balanced');
    expect(lane.imbalance).toBeCloseTo(1, 10);
    expect(lane.ratePerTonneMinor).toBe(lane.reverseRatePerTonneMinor);
    expect(lane.detail).toContain('evenly both ways');
  });

  it('pays the base rate at the reference distance on a balanced lane', () => {
    const lane = cargoLane(REFERENCE, REFERENCE, DEFAULT_CARGO.referenceDistanceNm);
    expect(lane.ratePerTonneMinor).toBe(DEFAULT_CARGO.baseRatePerTonneMinor);
  });

  it('pays more per tonne on a longer sector, but less than proportionally', () => {
    const short = cargoLane(REFERENCE, REFERENCE, 350);
    const long = cargoLane(REFERENCE, REFERENCE, 3_500);

    expect(long.ratePerTonneMinor).toBeGreaterThan(short.ratePerTonneMinor);
    // Ten times the distance for well under ten times the rate: the buyer is
    // comparing against sea freight the whole way.
    expect(long.ratePerTonneMinor).toBeLessThan(short.ratePerTonneMinor * 4);
  });

  it('measures imbalance from character, not size — the populations cancel', () => {
    const bigFactory = { ...FACTORY, catchmentPopulation: 20_000_000 };
    const smallFactory = { ...FACTORY, catchmentPopulation: 150_000 };

    // A small factory town shipping to a wealthy city is exactly as lopsided a
    // lane as a large one. Only the tonnage differs.
    expect(cargoLane(smallFactory, MARKET, 5_100).imbalance).toBeCloseTo(
      cargoLane(bigFactory, MARKET, 5_100).imbalance,
      10,
    );
    expect(cargoLane(smallFactory, MARKET, 5_100).offeredTonnes).toBeLessThan(
      cargoLane(bigFactory, MARKET, 5_100).offeredTonnes,
    );
  });

  it('caps what a freak index is paid for, without hiding it', () => {
    const extreme: CargoLaneEndpoint = {
      catchmentPopulation: 1_000_000,
      businessIndex: 8,
      wealthIndex: 0.2,
    };
    const lane = cargoLane(extreme, MARKET, 4_000);
    const atCap = cargoLane(
      { catchmentPopulation: 1_000_000, businessIndex: DEFAULT_CARGO.imbalanceCap, wealthIndex: 1 },
      { catchmentPopulation: 1_000_000, businessIndex: 1, wealthIndex: 1 },
      4_000,
    );

    // The imbalance is reported honestly — a player should see the real ratio —
    // but the rate stops moving at the cap.
    expect(lane.imbalance).toBeGreaterThan(DEFAULT_CARGO.imbalanceCap);
    expect(lane.ratePerTonneMinor / lane.reverseRatePerTonneMinor).toBeCloseTo(
      atCap.ratePerTonneMinor / atCap.reverseRatePerTonneMinor,
      10,
    );
  });

  it('answers for an unclassified airport instead of throwing', () => {
    // NULL catchment and NULL indices are the normal state of an airport with no
    // scheduled service. A lane touching one is unknown, not broken.
    const lane = cargoLane(UNCLASSIFIED, MARKET, 400);

    expect(Number.isFinite(lane.offeredTonnes)).toBe(true);
    expect(Number.isFinite(lane.ratePerTonneMinor)).toBe(true);
    // Well under a sized pair's, because no catchment row means no market to
    // size — not a median one. It is not near zero either, and should not be:
    // the sub-linear exponent means a large end at the other end of the lane
    // still counts for something, which is the right answer for freight moving
    // from an unserved field into a real market.
    expect(lane.offeredTonnes).toBeLessThan(cargoLane(REFERENCE, MARKET, 400).offeredTonnes / 2);
  });

  it('reads two unclassified ends as a balanced lane at the neutral index', () => {
    const lane = cargoLane(UNCLASSIFIED, UNCLASSIFIED, 400);
    expect(lane.direction).toBe('balanced');
    expect(lane.imbalance).toBe(1);
  });

  it('refuses a sector that is not a distance, and a config that is not one', () => {
    expect(() => cargoLane(MARKET, FACTORY, -1)).toThrow(/Sector distance/);
    expect(() => cargoLane(MARKET, FACTORY, Number.NaN)).toThrow(/Sector distance/);
    expect(() => cargoLane(MARKET, FACTORY, 400, { ...DEFAULT_CARGO, imbalanceCap: 1 })).toThrow(
      /Imbalance cap/,
    );
    expect(() =>
      cargoLane(MARKET, FACTORY, 400, { ...DEFAULT_CARGO, referenceDistanceNm: 0 }),
    ).toThrow(/Reference distance/);
  });

  it('is deterministic: the same lane gives the same answer (invariant 2)', () => {
    expect(cargoLane(FACTORY, MARKET, 5_137)).toEqual(cargoLane(FACTORY, MARKET, 5_137));
  });
});
