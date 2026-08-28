import { describe, expect, it } from 'vitest';

import {
  aggregateExecutiveBoosts,
  EXECUTIVE_BOOST_LEVERS,
  EXECUTIVE_CANDIDATES,
  EXECUTIVE_FLOOR_REVENUE_GATE_MINOR,
  EXECUTIVE_FLOOR_UNLOCK_COST_MINOR,
  EXECUTIVE_OFFICE_COSTS_MINOR,
  EXECUTIVE_OFFICE_COUNT,
  executiveCandidate,
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

describe('the C-Suite roster', () => {
  it('holds more candidates than offices, so a "no free office" state is reachable', () => {
    expect(EXECUTIVE_CANDIDATES.length).toBeGreaterThan(EXECUTIVE_OFFICE_COUNT);
  });

  it('has unique ids and only the three C-Suite tiers', () => {
    const ids = new Set(EXECUTIVE_CANDIDATES.map((c) => c.id));
    expect(ids.size).toBe(EXECUTIVE_CANDIDATES.length);
    for (const c of EXECUTIVE_CANDIDATES) {
      expect(['Director', 'VP', 'President']).toContain(c.tier);
    }
  });

  it('prices every candidate between $150k and $1M a month', () => {
    for (const c of EXECUTIVE_CANDIDATES) {
      expect(c.monthlySalaryMinor).toBeGreaterThanOrEqual(15_000_000);
      expect(c.monthlySalaryMinor).toBeLessThanOrEqual(100_000_000);
    }
  });

  it('resolves a candidate by id, and refuses an unknown one', () => {
    const first = EXECUTIVE_CANDIDATES[0]!;
    expect(executiveCandidate(first.id)).toEqual(first);
    expect(executiveCandidate('not-a-real-id')).toBeUndefined();
  });

  it('gives every executive a role and a boost on a known lever', () => {
    for (const c of EXECUTIVE_CANDIDATES) {
      expect(c.role.length).toBeGreaterThan(0);
      expect(c.boost.label.length).toBeGreaterThan(0);
      expect(c.boost.description.length).toBeGreaterThan(0);
      expect(Object.keys(EXECUTIVE_BOOST_LEVERS)).toContain(c.boost.lever);
      // A cost/duration lever improves by going down; everything else by going up.
      const meta = EXECUTIVE_BOOST_LEVERS[c.boost.lever];
      expect(meta.lowerIsBetter ? c.boost.magnitude < 0 : c.boost.magnitude > 0).toBe(true);
    }
  });

  it('makes each executive’s boost unique by its badge label', () => {
    const labels = new Set(EXECUTIVE_CANDIDATES.map((c) => c.boost.label));
    expect(labels.size).toBe(EXECUTIVE_CANDIDATES.length);
  });
});

describe('aggregateExecutiveBoosts', () => {
  it('sums employed executives by lever, in lever order, ignoring unknown ids', () => {
    // Two fare-yield executives (a VP and a President) collapse into one lever.
    const fareYield = EXECUTIVE_CANDIDATES.filter((c) => c.boost.lever === 'fare-yield');
    expect(fareYield.length).toBeGreaterThanOrEqual(2);
    const ids = [...fareYield.map((c) => c.id), 'not-a-real-id'];
    const agg = aggregateExecutiveBoosts(ids);
    const yieldRow = agg.find((row) => row.lever === 'fare-yield');
    expect(yieldRow?.totalMagnitude).toBeCloseTo(
      fareYield.reduce((sum, c) => sum + c.boost.magnitude, 0),
    );
  });

  it('returns nothing for an empty or all-unknown set', () => {
    expect(aggregateExecutiveBoosts([])).toEqual([]);
    expect(aggregateExecutiveBoosts(['nope', 'also-nope'])).toEqual([]);
  });
});
