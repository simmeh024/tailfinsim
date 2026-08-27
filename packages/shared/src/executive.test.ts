import { describe, expect, it } from 'vitest';

import {
  EXECUTIVE_FLOOR_REVENUE_GATE_MINOR,
  EXECUTIVE_FLOOR_UNLOCK_COST_MINOR,
  EXECUTIVE_OFFICE_COSTS_MINOR,
  EXECUTIVE_OFFICE_COUNT,
  nextExecutiveOffice,
} from './executive';

/**
 * The executive floor's balance and its unlock cascade (§9.1 follow-up).
 *
 * These are money numbers the server charges from, so the sequence is pinned:
 * ten offices, each dearer than the last, and the gate figures are the ones the
 * brief named. `nextExecutiveOffice` is the cascade — an office opens only once
 * the one before it has — so it is checked end to end.
 */
describe('the executive floor costs', () => {
  it('opens the floor at $100M behind a $50M/month revenue gate', () => {
    expect(EXECUTIVE_FLOOR_UNLOCK_COST_MINOR).toBe(10_000_000_000);
    expect(EXECUTIVE_FLOOR_REVENUE_GATE_MINOR).toBe(5_000_000_000);
  });

  it('has ten office costs, the brief’s figures, strictly increasing', () => {
    expect(EXECUTIVE_OFFICE_COSTS_MINOR).toHaveLength(EXECUTIVE_OFFICE_COUNT);
    expect(EXECUTIVE_OFFICE_COSTS_MINOR).toEqual([
      7_500_000_000, // $75M
      10_000_000_000, // $100M
      15_000_000_000, // $150M
      20_000_000_000, // $200M
      40_000_000_000, // $400M
      50_000_000_000, // $500M
      100_000_000_000, // $1B
      150_000_000_000, // $1.5B
      250_000_000_000, // $2.5B
      500_000_000_000, // $5B
    ]);
    for (let i = 1; i < EXECUTIVE_OFFICE_COSTS_MINOR.length; i += 1) {
      expect(EXECUTIVE_OFFICE_COSTS_MINOR[i]!).toBeGreaterThan(
        EXECUTIVE_OFFICE_COSTS_MINOR[i - 1]!,
      );
    }
  });

  it('walks the cascade, then stops at the tenth', () => {
    expect(nextExecutiveOffice(0)).toEqual({ index: 0, costMinor: 7_500_000_000 });
    expect(nextExecutiveOffice(1)).toEqual({ index: 1, costMinor: 10_000_000_000 });
    expect(nextExecutiveOffice(9)).toEqual({ index: 9, costMinor: 500_000_000_000 });
    // All ten open — nothing more to buy.
    expect(nextExecutiveOffice(10)).toBeNull();
    expect(nextExecutiveOffice(11)).toBeNull();
  });
});
