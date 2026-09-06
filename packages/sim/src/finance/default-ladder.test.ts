import { describe, expect, it } from 'vitest';

import { DEFAULT_STAGES, isRestricted, type DefaultStage } from '@tailfin/shared';

import { DEFAULT_CREDIT } from './credit';
import {
  allowsRepossession,
  dailyInterestMinor,
  reviewDefaultLadder,
  wholeGameDays,
  type DefaultState,
} from './default-ladder';

/**
 * §13.4's drain and §13.5's ladder, and M8-07's acceptance criteria.
 *
 * The one the design doc cares most about is the last: *"Recoverable, not
 * run-ending."* So the interesting tests here are the ones that prove an airline
 * can climb back out, from every rung including the bottom.
 */

const CURE_DAYS = DEFAULT_CREDIT.defaultLadder.cureDays;
const DAY_MS = 86_400_000;

/** A world instant, plus n game days. */
function at(days: number): Date {
  return new Date(Date.UTC(2000, 0, 1) + days * DAY_MS);
}

const CLEAR: DefaultState = { stage: 'none', stageEnteredAt: null, cureByAt: null };

describe('daily interest', () => {
  it('charges a year of days as a year of interest', () => {
    const principal = 25_000_000;
    const rateBps = 1_400;
    const perDay = dailyInterestMinor(principal, rateBps, DEFAULT_CREDIT.defaultLadder.daysPerYear);
    const year = perDay * DEFAULT_CREDIT.defaultLadder.daysPerYear;
    // Rounding to the minor unit each day, so within a day's charge of the annual.
    expect(Math.abs(year - (principal * rateBps) / 10_000)).toBeLessThanOrEqual(perDay);
  });

  it('charges the outstanding balance, so repaying costs less', () => {
    const full = dailyInterestMinor(25_000_000, 1_400, 360);
    const half = dailyInterestMinor(12_500_000, 1_400, 360);
    expect(half).toBeLessThan(full);
    expect(half * 2).toBeCloseTo(full, -1);
  });

  it('charges nothing on a repaid, free or undated loan', () => {
    expect(dailyInterestMinor(0, 1_400, 360)).toBe(0);
    expect(dailyInterestMinor(-5, 1_400, 360)).toBe(0);
    expect(dailyInterestMinor(25_000_000, 0, 360)).toBe(0);
    expect(dailyInterestMinor(25_000_000, 1_400, 0)).toBe(0);
  });
});

describe('whole game days', () => {
  it('counts only days that have completed', () => {
    expect(wholeGameDays(at(0), at(0))).toBe(0);
    expect(wholeGameDays(at(0), new Date(at(0).getTime() + DAY_MS - 1))).toBe(0);
    expect(wholeGameDays(at(0), at(3))).toBe(3);
  });

  it('never counts backwards, so a clock correction cannot refund interest', () => {
    expect(wholeGameDays(at(5), at(1))).toBe(0);
  });
});

describe('the default ladder', () => {
  it('opens at warning with §13.5’s cure window', () => {
    const review = reviewDefaultLadder(CLEAR, { arrearsMinor: 100_000, gameNow: at(0) });
    expect(review.next.stage).toBe('warning');
    expect(review.escalated).toBe(true);
    expect(review.next.cureByAt?.getTime()).toBe(at(CURE_DAYS).getTime());
  });

  it('holds while the window is open', () => {
    const warned = reviewDefaultLadder(CLEAR, { arrearsMinor: 100_000, gameNow: at(0) }).next;
    const held = reviewDefaultLadder(warned, {
      arrearsMinor: 100_000,
      gameNow: at(CURE_DAYS - 1),
    });
    expect(held.next.stage).toBe('warning');
    expect(held.escalated).toBe(false);
  });

  it('drops one rung per review, never several', () => {
    let state = reviewDefaultLadder(CLEAR, { arrearsMinor: 100_000, gameNow: at(0) }).next;
    const seen: DefaultStage[] = [state.stage];
    // Ten cure windows in one jump: an airline that skipped from warning to
    // repossession in a single sweep would have had no chance to act.
    for (let i = 1; i <= 4; i += 1) {
      const review = reviewDefaultLadder(state, {
        arrearsMinor: 100_000,
        gameNow: at(CURE_DAYS * 10 * i),
      });
      state = review.next;
      seen.push(state.stage);
    }
    expect(seen).toEqual([
      'warning',
      'restriction',
      'forced_disposal',
      'repossession',
      'administration',
    ]);
  });

  it('stops at administration rather than ending the run', () => {
    const bottom: DefaultState = {
      stage: 'administration',
      stageEnteredAt: at(0),
      cureByAt: at(CURE_DAYS),
    };
    const review = reviewDefaultLadder(bottom, { arrearsMinor: 100_000, gameNow: at(1_000) });
    expect(review.next.stage).toBe('administration');
    expect(review.escalated).toBe(false);
  });

  it('clears the ladder from every stage once the arrears are paid', () => {
    for (const stage of DEFAULT_STAGES) {
      const state: DefaultState = { stage, stageEnteredAt: at(0), cureByAt: at(CURE_DAYS) };
      const review = reviewDefaultLadder(state, { arrearsMinor: 0, gameNow: at(1_000) });
      expect(review.next).toEqual(CLEAR);
      expect(review.cured).toBe(stage !== 'none');
    }
  });

  it('leaves a clear airline clear, and does not report a cure it did not perform', () => {
    const review = reviewDefaultLadder(CLEAR, { arrearsMinor: 0, gameNow: at(1) });
    expect(review.next).toEqual(CLEAR);
    expect(review.cured).toBe(false);
    expect(review.escalated).toBe(false);
  });
});

describe('what a stage permits', () => {
  it('restricts from the second rung, and not before it', () => {
    expect(isRestricted('none')).toBe(false);
    // A warning is a warning: §13.5 gives the airline the window to act in.
    expect(isRestricted('warning')).toBe(false);
    expect(isRestricted('restriction')).toBe(true);
    expect(isRestricted('administration')).toBe(true);
  });

  it('allows repossession only from §13.5’s fourth rung', () => {
    expect(allowsRepossession('forced_disposal')).toBe(false);
    expect(allowsRepossession('repossession')).toBe(true);
    expect(allowsRepossession('administration')).toBe(true);
  });
});
