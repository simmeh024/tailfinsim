import { describe, expect, it } from 'vitest';

import { EFFICIENCY_CEILINGS, type EfficiencyBoost, stackEfficiencyBoosts } from './boosts';

/**
 * §10.4's boost ladder (M2-04, M2-05).
 *
 * The module exists so that turnaround, block time and fuel burn share one
 * stacking rule instead of three that happen to agree today. So the tests worth
 * having are about the **rule** and the **table**, not about any one consumer:
 *
 *   1. Stacking is multiplicative — diminishing returns before the cap.
 *   2. The cap is hard, and reports that it bit.
 *   3. The six ceilings are the six §10.4 prints. A silent edit to one of these
 *      is the most expensive change anyone could make to this file, because it
 *      is invisible in every downstream test that only asserts a ratio.
 */

function boost(fraction: number, id = `b-${String(fraction)}`): EfficiencyBoost {
  return { id, fraction };
}

describe('EFFICIENCY_CEILINGS', () => {
  it('is §10.4’s table, verbatim', () => {
    // Transcribed from the design doc's own rows. If a designer changes the
    // table, this is the line that has to change with it — deliberately, and in
    // a diff a reviewer can see.
    expect(EFFICIENCY_CEILINGS).toEqual({
      fuelBurn: 0.08,
      turnaroundTime: 0.2,
      blockTime: 0.04,
      maintenanceCost: 0.12,
      incidentRate: 0.3,
      serviceCost: 0.15,
    });
  });

  it('never lets any single ceiling reach the −40% §10.4 calls a moat', () => {
    // "−40% would be a moat, and moats kill persistent multiplayer games."
    for (const [name, ceiling] of Object.entries(EFFICIENCY_CEILINGS)) {
      expect(ceiling, name).toBeLessThan(0.4);
      expect(ceiling, name).toBeGreaterThan(0);
    }
  });
});

describe('stackEfficiencyBoosts', () => {
  it('removes nothing when there are no boosts', () => {
    expect(stackEfficiencyBoosts([], 0.2)).toEqual({ fraction: 0, capped: false });
  });

  it('takes a lone boost at its face value', () => {
    // The property that makes a player's first node in a branch feel worth
    // taking. An asymptotic curve would charge this one hardest.
    expect(stackEfficiencyBoosts([boost(0.1)], 0.2).fraction).toBeCloseTo(0.1, 10);
  });

  it('stacks multiplicatively — two tens make nineteen, not twenty', () => {
    expect(stackEfficiencyBoosts([boost(0.1), boost(0.1)], 0.5).fraction).toBeCloseTo(0.19, 10);
  });

  it('keeps diminishing as more are held', () => {
    const three = stackEfficiencyBoosts([boost(0.1), boost(0.1), boost(0.1)], 0.5).fraction;

    expect(three).toBeCloseTo(0.271, 10);
    // Each successive boost buys less than the one before it.
    expect(three - 0.19).toBeLessThan(0.19 - 0.1);
  });

  it('is order-independent, so a research path cannot be gamed by sequencing', () => {
    const a = stackEfficiencyBoosts([boost(0.05), boost(0.12), boost(0.03)], 0.5).fraction;
    const b = stackEfficiencyBoosts([boost(0.03), boost(0.05), boost(0.12)], 0.5).fraction;

    expect(a).toBeCloseTo(b, 12);
  });

  describe('the cap', () => {
    it('clamps to the ceiling and says that it bit', () => {
      const many = Array.from({ length: 10 }, (_, i) => boost(0.05, `r-${String(i)}`));

      expect(stackEfficiencyBoosts(many, EFFICIENCY_CEILINGS.fuelBurn)).toEqual({
        fraction: 0.08,
        capped: true,
      });
    });

    it('reports uncapped when the total lands on the ceiling', () => {
      // Strictly greater, not greater-or-equal: a player sitting exactly on the
      // ceiling has lost nothing to it, and telling them a further boost buys
      // nothing would be wrong by one boost.
      //
      // `toBeCloseTo` rather than `toBe` because `1 - (1 - 0.08)` is
      // 0.07999999999999996 in binary floating point, so a lone boost sized to
      // the ceiling lands a whisker under it and the clamp is not reached. That
      // is the harmless direction to be wrong in — the other would report a cap
      // that had not bitten — but it does mean "exactly on the ceiling" is not a
      // state this can actually be asserted into.
      const result = stackEfficiencyBoosts([boost(0.08)], 0.08);

      expect(result.fraction).toBeCloseTo(0.08, 10);
      expect(result.capped).toBe(false);
    });

    it('makes a further boost worth nothing once capped, which is the point', () => {
      const at = stackEfficiencyBoosts([boost(0.05), boost(0.05)], 0.04);
      const more = stackEfficiencyBoosts([boost(0.05), boost(0.05), boost(0.05)], 0.04);

      expect(more.fraction).toBe(at.fraction);
      expect(more.capped).toBe(true);
    });

    it('honours a ceiling of zero — a world with the ladder switched off', () => {
      expect(stackEfficiencyBoosts([boost(0.1)], 0)).toEqual({ fraction: 0, capped: true });
    });
  });

  describe('rejects inputs that cannot mean anything', () => {
    it('refuses a boost of 100% or more, naming it', () => {
      expect(() => stackEfficiencyBoosts([boost(1, 'perpetual-motion')], 0.5)).toThrow(
        /perpetual-motion/,
      );
    });

    it('refuses a negative boost, naming it', () => {
      expect(() => stackEfficiencyBoosts([boost(-0.1, 'backwards')], 0.5)).toThrow(/backwards/);
    });

    it('refuses a non-finite boost, naming it', () => {
      expect(() => stackEfficiencyBoosts([boost(Number.NaN, 'undefined-node')], 0.5)).toThrow(
        /undefined-node/,
      );
    });

    it('refuses a negative ceiling', () => {
      expect(() => stackEfficiencyBoosts([], -0.1)).toThrow(/[Cc]eiling/);
    });
  });

  it('is a pure function — the same ladder always gives the same reduction', () => {
    const ladder = [boost(0.04), boost(0.03)];

    expect(stackEfficiencyBoosts(ladder, 0.2)).toEqual(stackEfficiencyBoosts(ladder, 0.2));
  });
});
