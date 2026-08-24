import { describe, expect, it } from 'vitest';

import { DEFAULT_CREW } from './complement';
import {
  attritionRate,
  driftMorale,
  moraleTarget,
  NEUTRAL_STABILITY,
  rosterStability,
  serviceExecution,
  sicknessRate,
  type MoraleInputs,
} from './morale';

/**
 * Crew morale (§9.2, M5-03).
 *
 * The headline is §9.2's sentence — *"cost-cutting on crew is a viable strategy
 * with a delayed, visible bill"* — and its three words are three separate
 * claims, each of which can be broken independently. There is a test for each.
 */

const M = DEFAULT_CREW.morale;

const HAPPY: MoraleInputs = {
  payBand: 'generous',
  hotelTier: 'premium',
  rosterStability: 1,
  restRatio: 1,
};

const GRIM: MoraleInputs = {
  payBand: 'lean',
  hotelTier: 'budget',
  rosterStability: 0,
  restRatio: 0,
};

describe('the target, and why it is itemised', () => {
  it('adds up to exactly the score it explains', () => {
    /*
     * The breakdown is not commentary alongside the number — it *is* the number.
     * A summary that could disagree with its own total is the thing that makes a
     * player conclude the game is being unfair to them.
     */
    const target = moraleTarget({ ...HAPPY, payBand: 'market', restRatio: 0.8 }, M);
    const summed = target.contributions.reduce((total, entry) => total + entry.weighted, 0);
    expect(summed).toBeCloseTo(target.score, 10);
  });

  it('names all four of §9.2’s inputs, with a sentence each', () => {
    const target = moraleTarget(GRIM, M);
    expect(target.contributions.map((entry) => entry.factor)).toEqual([
      'pay',
      'rosterStability',
      'hotel',
      'rest',
    ]);
    // Acceptance criterion two asks for the factors *itemised*, which means a
    // player can read what each one is, not only how much it scored.
    for (const entry of target.contributions) {
      expect(entry.detail.length).toBeGreaterThan(0);
    }
    expect(target.contributions[0]?.detail).toContain('Lean');
    expect(target.contributions[2]?.detail).toContain('Budget');
  });

  it('normalises the weights, so retuning one cannot move every base', () => {
    const doubled = {
      ...M,
      weights: { pay: 0.8, rosterStability: 0.4, hotel: 0.3, rest: 0.5 },
    };
    // Every weight doubled is the same set of weights.
    expect(moraleTarget(GRIM, doubled).score).toBeCloseTo(moraleTarget(GRIM, M).score, 10);
    expect(moraleTarget(HAPPY, doubled).score).toBeCloseTo(moraleTarget(HAPPY, M).score, 10);
  });

  it('has no opinion when every weight is zero, rather than dividing by it', () => {
    const none = { ...M, weights: { pay: 0, rosterStability: 0, hotel: 0, rest: 0 } };
    const target = moraleTarget(HAPPY, none);
    expect(target.score).toBe(0);
    expect(Number.isNaN(target.score)).toBe(false);
  });

  it('is bounded, whatever nonsense it is handed', () => {
    expect(moraleTarget({ ...HAPPY, restRatio: 9 }, M).score).toBeLessThanOrEqual(1);
    expect(moraleTarget({ ...GRIM, rosterStability: -4 }, M).score).toBeGreaterThanOrEqual(0);
    expect(moraleTarget({ ...HAPPY, restRatio: Number.NaN }, M).score).not.toBeNaN();
  });
});

describe('§9.2’s three words', () => {
  it('viable: lean pay alone does not wreck a well-run base', () => {
    /*
     * *"Cost-cutting on crew is a viable strategy."* Viable means a competent
     * player might choose it on purpose. A pay band that floored morale by
     * itself would make the other three inputs decorative and the choice
     * obvious, and an obvious choice is not a decision.
     */
    const leanButDecent = moraleTarget(
      { payBand: 'lean', hotelTier: 'standard', rosterStability: 0.9, restRatio: 1 },
      M,
    );
    expect(leanButDecent.score).toBeGreaterThan(0.5);
    // And it still costs something, or it would not be a trade at all.
    expect(leanButDecent.score).toBeLessThan(
      moraleTarget(
        { payBand: 'market', hotelTier: 'standard', rosterStability: 0.9, restRatio: 1 },
        M,
      ).score,
    );
  });

  it('viable: paying lean actually saves money', () => {
    // Not a trap with a warning sign. The saving has to be real.
    expect(M.payBands.lean.costMultiplier).toBeLessThan(1);
    expect(M.payBands.generous.costMultiplier).toBeGreaterThan(1);
    expect(M.hotelTiers.budget.costMultiplier).toBeLessThan(1);
  });

  it('delayed: the bill does not arrive the week the pay is cut', () => {
    const before = moraleTarget(
      { payBand: 'market', hotelTier: 'standard', rosterStability: 0.9, restRatio: 1 },
      M,
    ).score;
    const after = moraleTarget(
      { payBand: 'lean', hotelTier: 'budget', rosterStability: 0.9, restRatio: 1 },
      M,
    ).score;
    expect(after).toBeLessThan(before);

    // One week later morale has barely moved: the saving is banked and the cost
    // is nowhere in sight. That gap is the whole mechanic.
    const oneWeek = driftMorale(before, after, 1, M);
    expect(before - oneWeek).toBeLessThan((before - after) * 0.25);

    // A quarter later it has substantially arrived.
    const thirteenWeeks = driftMorale(before, after, 13, M);
    expect(before - thirteenWeeks).toBeGreaterThan((before - after) * 0.7);
  });

  it('delayed: and it is a slope, not a cliff', () => {
    let previous = 0.9;
    for (let week = 1; week <= 20; week += 1) {
      const now = driftMorale(0.9, 0.2, week, M);
      // Monotonic and never overshooting the target it is heading for.
      expect(now).toBeLessThanOrEqual(previous);
      expect(now).toBeGreaterThanOrEqual(0.2);
      previous = now;
    }
  });

  it('visible: the bill is attrition and sickness, and both scale with morale', () => {
    expect(attritionRate(0, M)).toBeGreaterThan(attritionRate(1, M));
    expect(sicknessRate(0, M)).toBeGreaterThan(sicknessRate(1, M));
    // A happy base still loses the occasional crew member. Nobody keeps everyone.
    expect(attritionRate(1, M)).toBeGreaterThan(0);
  });
});

describe('drift', () => {
  it('treats two half weeks as one week', () => {
    // Compounding, not `rate × weeks`. A tick that ran twice as often would
    // otherwise sour a base twice as fast, which is a bug wearing a clock.
    const once = driftMorale(1, 0, 1, M);
    const twice = driftMorale(driftMorale(1, 0, 0.5, M), 0, 0.5, M);
    expect(twice).toBeCloseTo(once, 10);
  });

  it('does nothing across no time at all', () => {
    expect(driftMorale(0.8, 0.2, 0, M)).toBe(0.8);
    expect(driftMorale(0.8, 0.2, -3, M)).toBe(0.8);
  });

  it('rises as readily as it falls', () => {
    // Morale is a dial, not a decay. An airline that starts paying properly gets
    // its crew back.
    expect(driftMorale(0.2, 0.9, 6, M)).toBeGreaterThan(0.2);
    expect(driftMorale(0.2, 0.9, 6, M)).toBeLessThan(0.9);
  });

  it('stands still when the dial is turned off', () => {
    expect(driftMorale(0.8, 0.1, 50, { ...M, driftPerWeek: 0 })).toBe(0.8);
  });
});

describe('roster stability', () => {
  it('is neutral, not zero, when there is nothing to judge', () => {
    // No duty periods is no evidence. Scoring it zero would punish every base on
    // the day it opens, for a roster it has not run yet.
    expect(rosterStability([])).toBe(NEUTRAL_STABILITY);
    expect(rosterStability([360])).toBe(NEUTRAL_STABILITY);
  });

  it('rewards a base that signs on at the same time every day', () => {
    const steady = rosterStability([360, 360, 365, 355, 360]);
    const scattered = rosterStability([60, 420, 780, 1140, 240]);
    expect(steady).toBeGreaterThan(0.9);
    expect(scattered).toBeLessThan(0.4);
    expect(steady).toBeGreaterThan(scattered);
  });

  it('knows that 23:00 and 01:00 are two hours apart, not twenty-two', () => {
    /*
     * A circular mean, because report times live on a clock. Treated as plain
     * numbers the average of 23:00 and 01:00 lands at noon, and the steadiest
     * possible night operation would score as the least stable thing in the
     * game.
     */
    const nightShift = rosterStability([1380, 1410, 30, 60, 1440 - 30]);
    expect(nightShift).toBeGreaterThan(0.85);
  });
});

describe('service execution', () => {
  it('is exposed for M8-04 and consumed by nobody here', () => {
    expect(serviceExecution(1, M)).toBe(M.serviceExecutionAtFull);
    expect(serviceExecution(0, M)).toBe(M.serviceExecutionAtZero);
  });

  it('never jumps a band, which is App. D.1’s rule', () => {
    /*
     * *"Execution never jumps a band — it only decides whether you're getting
     * full value from the money you're already spending."* So even a mutinous
     * crew delivers most of what was paid for; morale is a discount on the tier,
     * never a demotion out of it.
     */
    expect(serviceExecution(0, M)).toBeGreaterThan(0.5);
    expect(serviceExecution(0, M)).toBeLessThan(serviceExecution(1, M));
  });
});
