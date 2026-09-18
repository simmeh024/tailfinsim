import { describe, expect, it } from 'vitest';

import {
  commonUseTurnFee,
  DEFAULT_GATE_COST,
  leaseBreakevenTurnsPerMonth,
  standAnnualFee,
  standMonthlyFee,
  standsMonthlyFee,
} from './gate-cost';

/**
 * What a stand costs (M7-06, App. B.6).
 *
 * The appendix states its cost column relatively and puts exactly two absolute
 * figures on the table, both in the worked example. Those two are what these
 * tests hold: if a retune moves them, the one example a player can check the game
 * against stops matching the game.
 */

/** App. B.6's Amsterdam hub is a flagship. */
const FLAGSHIP = 'flagship' as const;

/** Minor units are 100 to the unit, so a month of $18,000 is 1,800,000. */
const MONTHLY_18K = 1_800_000;

describe("App. B.6's worked example, priced", () => {
  it('charges $18,000 a month for a preferentially leased contact gate', () => {
    expect(standMonthlyFee('contact_gate', 'preferential', FLAGSHIP)).toBe(MONTHLY_18K);
  });

  it('charges about $2,200 a month for an overnight parking position', () => {
    const monthly = standMonthlyFee('overnight_parking', 'preferential', FLAGSHIP);
    // The doc says $2,200; the shipped factor lands at $2,196, which is why it is
    // 0.122 rather than a rounder number that would have moved the example.
    expect(monthly).toBeGreaterThan(218_000);
    expect(monthly).toBeLessThan(221_000);
  });
});

describe("App. B.6's relative cost column", () => {
  it('puts a remote stand at about 35% of a contact gate', () => {
    const contact = standAnnualFee('contact_gate', 'preferential', FLAGSHIP);
    const remote = standAnnualFee('remote_stand', 'preferential', FLAGSHIP);
    expect(remote / contact).toBeCloseTo(0.35, 2);
  });

  it('orders the five stands as the doc does', () => {
    const fee = (kind: Parameters<typeof standAnnualFee>[0]): number =>
      standAnnualFee(kind, 'preferential', FLAGSHIP);
    // Contact highest, cargo medium, maintenance below it, remote ~35%, overnight
    // cheapest.
    expect(fee('contact_gate')).toBeGreaterThan(fee('cargo_stand'));
    expect(fee('cargo_stand')).toBeGreaterThan(fee('maintenance_stand'));
    expect(fee('maintenance_stand')).toBeGreaterThan(fee('remote_stand'));
    expect(fee('remote_stand')).toBeGreaterThan(fee('overnight_parking'));
  });

  it('charges an exclusive lease about 2.5× a preferential one', () => {
    const preferential = standAnnualFee('contact_gate', 'preferential', FLAGSHIP);
    const exclusive = standAnnualFee('contact_gate', 'exclusive', FLAGSHIP);
    expect(exclusive / preferential).toBeCloseTo(2.5, 2);
  });

  it('gets cheaper with the airport', () => {
    const tiers = ['flagship', 'large', 'medium', 'small', 'regional'] as const;
    const fees = tiers.map((tier) => standAnnualFee('contact_gate', 'preferential', tier));
    for (let i = 1; i < fees.length; i += 1) {
      expect(fees[i] ?? 0).toBeLessThan(fees[i - 1] ?? 0);
    }
  });
});

describe('common use — the alternative to a lease', () => {
  it('costs nothing a year, because it is not a lease', () => {
    // The mechanic, not an omission: an airline flying through twice a week
    // should not be holding a lease, and pricing the walk-up annually would have
    // hidden that.
    expect(standAnnualFee('contact_gate', 'common_use', FLAGSHIP)).toBe(0);
  });

  it('charges about $252 for a flagship contact turn', () => {
    expect(commonUseTurnFee('contact_gate', FLAGSHIP)).toBe(25_200);
  });

  it('charges less for a remote turn, for the reason the lease is cheaper', () => {
    expect(commonUseTurnFee('remote_stand', FLAGSHIP)).toBeLessThan(
      commonUseTurnFee('contact_gate', FLAGSHIP),
    );
  });

  it('puts the crossover where the worked example sits', () => {
    // App. B.6's first hub flies three turns a day — about 91 a month — and is
    // shown holding a preferential lease. That has to be the right side of the
    // line, and only just, or the first hub's 12% gate is not a decision.
    const breakeven = leaseBreakevenTurnsPerMonth('contact_gate', 'preferential', FLAGSHIP);
    expect(breakeven).toBeGreaterThan(60);
    expect(breakeven).toBeLessThan(91);
  });

  it('reports an infinite breakeven when a walk-up is free', () => {
    const free = { ...DEFAULT_GATE_COST, commonUseTurnFeeFraction: 0 };
    expect(leaseBreakevenTurnsPerMonth('contact_gate', 'preferential', FLAGSHIP, free)).toBe(
      Number.POSITIVE_INFINITY,
    );
  });
});

describe('a whole airport', () => {
  it('sums each stand rather than multiplying a count', () => {
    // The worked example holds a contact gate and an overnight position at
    // prices an order of magnitude apart; a count times an average reports
    // neither.
    const total = standsMonthlyFee(
      [
        { kind: 'contact_gate', contract: 'preferential' },
        { kind: 'overnight_parking', contract: 'preferential' },
      ],
      FLAGSHIP,
    );
    expect(total).toBe(
      standMonthlyFee('contact_gate', 'preferential', FLAGSHIP) +
        standMonthlyFee('overnight_parking', 'preferential', FLAGSHIP),
    );
  });

  it('bills nothing for an airline holding nothing', () => {
    expect(standsMonthlyFee([], FLAGSHIP)).toBe(0);
  });
});
