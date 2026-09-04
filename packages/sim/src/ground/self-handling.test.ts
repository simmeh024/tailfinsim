import { describe, expect, it } from 'vitest';

import { ECONOMY_CONFIG_V1 } from '@tailfin/shared';

import {
  committedDepartures,
  DEFAULT_GROUND_HANDLING,
  elapsedTermFraction,
  groundVendorRisk,
  handlerProfile,
  handlingPriceFactor,
  handlingProfile,
  selfHandlingProfile,
  type HandlingArrangement,
} from './vendor';

/**
 * Self-handling, the price of a grade, and the arithmetic a term is judged on
 * (M5-06, §9.3).
 *
 * These are the three things the milestone's last PR added, and each closes a
 * hole that made a §9.3 mechanic inert:
 *
 *   1. **A grade had no price.** `speedFactor` and `reliability` were wired and
 *      `priceIndex` was carried and read by nothing, so the budget handler was
 *      slower and clumsier for exactly the same money and no player would ever
 *      have signed one. `handlingPriceFactor` is the multiplier that makes the
 *      trade a trade.
 *   2. **There was no alternative to a vendor.** `selfHandlingProfile` is §9.3's
 *      *"self-handling ... requiring a station and headcount"*, and the headcount
 *      is what makes it a decision rather than an upgrade.
 *   3. **A term had two ends and nothing measured between them.**
 *      `elapsedTermFraction` is the one piece of arithmetic the early-exit penalty
 *      and the volume commitment share.
 */

const MONEY = {
  walkUpPriceIndex: ECONOMY_CONFIG_V1.ground.walkUpPriceIndex,
  selfHandlingTurnPriceIndex: ECONOMY_CONFIG_V1.ground.selfHandling.turnPriceIndex,
};

describe('selfHandlingProfile', () => {
  const required = 28;

  it('reaches just short of a premium contractor when fully staffed', () => {
    // Deliberately short of it: a specialist handler runs ramps for a living and
    // the player does not, so the reason to self-handle is the cost curve, never
    // a better number than money can buy.
    const mine = selfHandlingProfile(required, required);
    const premium = handlerProfile('premium');
    expect(mine.staffing).toBe(1);
    expect(mine.reliability).toBeLessThan(premium.reliability);
    expect(mine.reliability).toBeGreaterThan(handlerProfile('standard').reliability);
    expect(mine.speedFactor).toBeGreaterThan(premium.speedFactor);
  });

  it('is worse than the cheapest vendor when nobody is staffing it', () => {
    const empty = selfHandlingProfile(0, required);
    const budget = handlerProfile('budget');
    expect(empty.staffing).toBe(0);
    expect(empty.reliability).toBeLessThan(budget.reliability);
    // A higher speed factor is slower.
    expect(empty.speedFactor).toBeGreaterThan(budget.speedFactor);
    expect(empty.quality).toBeLessThan(budget.quality);
  });

  it('improves monotonically with every head hired, up to the requirement', () => {
    // §9.2's cost-cutting trade, on the ramp: cutting heads saves money and the
    // handling gets measurably worse, on a scale a player can read.
    let previous = selfHandlingProfile(0, required);
    for (let heads = 1; heads <= required; heads += 1) {
      const next = selfHandlingProfile(heads, required);
      expect(next.reliability).toBeGreaterThan(previous.reliability);
      expect(next.speedFactor).toBeLessThan(previous.speedFactor);
      expect(next.quality).toBeGreaterThan(previous.quality);
      previous = next;
    }
  });

  it('buys nothing beyond a full station', () => {
    // No moat: §10.4's rule that an edge must be one a smarter plan can beat
    // applies here too, so a player cannot hire twice the heads and out-run a
    // premium contractor.
    const staffed = selfHandlingProfile(required, required);
    const overstaffed = selfHandlingProfile(required * 4, required);
    expect(overstaffed.staffing).toBe(1);
    expect(overstaffed).toEqual(staffed);
  });

  it('treats a station that needs nobody as fully staffed rather than dividing by zero', () => {
    expect(selfHandlingProfile(0, 0).staffing).toBe(1);
    expect(selfHandlingProfile(0, -5).staffing).toBe(1);
  });

  it('feeds the disruption roll like any other handler', () => {
    // One risk input, three sources: the whole reason `handlingProfile` exists.
    const understaffed = selfHandlingProfile(4, required);
    expect(groundVendorRisk(understaffed)).toBeGreaterThan(
      groundVendorRisk(handlerProfile('budget')),
    );
    expect(groundVendorRisk(selfHandlingProfile(required, required))).toBeLessThan(
      groundVendorRisk(handlerProfile('standard')),
    );
  });
});

describe('handlingProfile', () => {
  it('reads a contracted grade straight off the config', () => {
    expect(handlingProfile({ kind: 'vendor', grade: 'premium' })).toBe(handlerProfile('premium'));
  });

  it('treats nothing arranged as budget-grade', () => {
    // Not a shortcut: `disruption.ts` has said since M5-06's first PR that an
    // airline with no contract scrambles the bags itself at budget reliability.
    // What is new is that one function says so rather than each caller.
    expect(handlingProfile({ kind: 'walk_up' })).toBe(handlerProfile('budget'));
  });

  it('reads the airline’s own operation at the staffing it is paying for', () => {
    const arrangement: HandlingArrangement = {
      kind: 'self',
      headcount: 14,
      requiredHeadcount: 28,
    };
    expect(handlingProfile(arrangement)).toEqual(selfHandlingProfile(14, 28));
  });
});

describe('handlingPriceFactor', () => {
  it('is the grade’s own price index for a vendor', () => {
    for (const grade of ['budget', 'standard', 'premium'] as const) {
      expect(handlingPriceFactor({ kind: 'vendor', grade }, MONEY)).toBe(
        handlerProfile(grade).priceIndex,
      );
    }
  });

  it('makes the cheap handler actually cheap, which is the whole trade', () => {
    // The hole this closed. Before it, budget was slower and less reliable at
    // standard price — strictly worse, and nobody would have signed one.
    const budget = handlingPriceFactor({ kind: 'vendor', grade: 'budget' }, MONEY);
    const standard = handlingPriceFactor({ kind: 'vendor', grade: 'standard' }, MONEY);
    const premium = handlingPriceFactor({ kind: 'vendor', grade: 'premium' }, MONEY);
    expect(budget).toBeLessThan(standard);
    expect(standard).toBeLessThan(premium);
  });

  it('charges more for handling bought on the day than on a term', () => {
    // Which is why signing *anything* is worth doing, including the budget
    // handler that walk-up otherwise matches on reliability.
    const walkUp = handlingPriceFactor({ kind: 'walk_up' }, MONEY);
    expect(walkUp).toBeGreaterThan(
      handlingPriceFactor({ kind: 'vendor', grade: 'standard' }, MONEY),
    );
    expect(walkUp).toBeGreaterThan(handlingPriceFactor({ kind: 'vendor', grade: 'budget' }, MONEY));
  });

  it('charges a self-handled turn only what a turn still costs', () => {
    // Not zero — equipment, consumables and the airport's own charges do not go
    // away because the people are yours — but far below a vendor, because the
    // labour has already been paid on the monthly payroll.
    const self = handlingPriceFactor({ kind: 'self', headcount: 28, requiredHeadcount: 28 }, MONEY);
    expect(self).toBeGreaterThan(0);
    expect(self).toBeLessThan(handlingPriceFactor({ kind: 'vendor', grade: 'budget' }, MONEY));
  });

  it('does not vary with how well the operation is staffed', () => {
    // Understaffing saves money on the *payroll*, not on the turn. Folding it in
    // here would pay a player twice for the same cut.
    const staffed = handlingPriceFactor(
      { kind: 'self', headcount: 28, requiredHeadcount: 28 },
      MONEY,
    );
    const thin = handlingPriceFactor({ kind: 'self', headcount: 2, requiredHeadcount: 28 }, MONEY);
    expect(thin).toBe(staffed);
  });

  it('takes its money from the config it is handed', () => {
    expect(
      handlingPriceFactor(
        { kind: 'walk_up' },
        { walkUpPriceIndex: 9, selfHandlingTurnPriceIndex: 0.5 },
      ),
    ).toBe(9);
  });
});

describe('elapsedTermFraction', () => {
  const start = new Date('2026-01-01T00:00:00Z');
  const end = new Date('2026-04-01T00:00:00Z');

  it('is zero at the start and one at the end', () => {
    expect(elapsedTermFraction(start, end, start)).toBe(0);
    expect(elapsedTermFraction(start, end, end)).toBe(1);
  });

  it('is the served share in between', () => {
    const halfway = new Date((start.getTime() + end.getTime()) / 2);
    expect(elapsedTermFraction(start, end, halfway)).toBeCloseTo(0.5, 10);
  });

  it('clamps outside the term', () => {
    expect(elapsedTermFraction(start, end, new Date('2025-01-01T00:00:00Z'))).toBe(0);
    expect(elapsedTermFraction(start, end, new Date('2027-01-01T00:00:00Z'))).toBe(1);
  });

  it('reads a degenerate term as fully served', () => {
    // A broken row then costs nothing to leave, rather than charging a full
    // penalty on arithmetic nobody can check.
    expect(elapsedTermFraction(end, start, start)).toBe(1);
    expect(elapsedTermFraction(start, start, start)).toBe(1);
  });
});

describe('committedDepartures', () => {
  it('scales the per-day commitment by the term’s length', () => {
    expect(committedDepartures(2)).toBe(2 * DEFAULT_GROUND_HANDLING.termDays);
    expect(committedDepartures(0)).toBe(0);
  });

  it('follows a retuned term rather than being fixed to the shipped one', () => {
    // Why the balance is per *day*: retuning `termDays` must move the commitment
    // with it rather than silently changing what a day of it is worth.
    const shorter = { ...DEFAULT_GROUND_HANDLING, termDays: 30 };
    expect(committedDepartures(2, shorter)).toBe(60);
  });

  it('never commits an airline to a negative number of flights', () => {
    expect(committedDepartures(-5)).toBe(0);
  });
});

describe('the shipped ground money', () => {
  it('makes every grade cheaper than handling bought on the day', () => {
    // If walk-up were the cheapest option, the entire contract system would be a
    // menu of ways to spend more money.
    for (const grade of ['budget', 'standard', 'premium'] as const) {
      if (grade === 'premium') continue;
      expect(handlerProfile(grade).priceIndex).toBeLessThan(MONEY.walkUpPriceIndex);
    }
  });

  it('asks a premium handler for real volume and a budget one for none', () => {
    const commitment = ECONOMY_CONFIG_V1.ground.contract.committedDeparturesPerDay;
    expect(commitment.budget).toBe(0);
    expect(commitment.standard).toBeGreaterThan(0);
    expect(commitment.premium).toBeGreaterThan(commitment.standard);
  });

  it('needs more heads at a bigger station', () => {
    const heads = ECONOMY_CONFIG_V1.ground.selfHandling.requiredHeadcountByTier;
    expect(heads.flagship).toBeGreaterThan(heads.large);
    expect(heads.large).toBeGreaterThan(heads.medium);
    expect(heads.medium).toBeGreaterThan(heads.small);
    expect(heads.small).toBeGreaterThan(heads.regional);
  });

  it('keeps the sim’s operational profile and the economy’s money apart', () => {
    // Invariant 3's split, made checkable: what a grade *is* is sim balance, what
    // it *costs* is the world's economy row. `priceIndex` is the one number that
    // crosses, and it crosses as a multiplier rather than as an amount.
    expect(DEFAULT_GROUND_HANDLING.selfHandling.staffed.reliability).toBeGreaterThan(0);
    expect(ECONOMY_CONFIG_V1.ground.selfHandling.salaryPerHeadMinor).toBeGreaterThan(0);
    expect(
      (DEFAULT_GROUND_HANDLING.selfHandling as unknown as Record<string, unknown>)
        .salaryPerHeadMinor,
    ).toBeUndefined();
  });
});
