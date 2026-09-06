import {
  DEFAULT_STAGES,
  defaultStageRank,
  isRestricted,
  type DefaultStage,
  type EconomyConfig,
} from '@tailfin/shared';

import { DEFAULT_CREDIT } from './credit';

/**
 * Interest accrual and §13.5's default ladder (M8-07).
 *
 * ## Interest is a live drain
 *
 * > Interest accrues **per in-game day** and appears in the daily P&L as its own
 * > line. It is never hidden in a summary. Players should watch it eat the
 * > margin in real time.
 *
 * Per *game* day, so a world at 4× drains four times as fast in real time — the
 * same rule every in-world span follows since ADR-0026. {@link dailyInterestMinor}
 * is the whole charge, and it is charged against the **outstanding** balance
 * rather than the original principal, so a loan being repaid costs less as it
 * shrinks.
 *
 * ## The ladder is recoverable by construction
 *
 * > **Recoverable, not run-ending.** Losing your airline outright to a bad loan
 * > would push players away from the entire system.
 *
 * Two things follow, and they are the reason this is a state machine rather than
 * a series of checks. **Clearing the arrears clears the stage, from anywhere** —
 * an airline that pays what it owes while in administration is out of
 * administration, because a ladder you can only descend is a run-ending one with
 * extra steps. And `administration` is terminal *as a stage*, never as an
 * airline: it does not escalate to deletion, and there is nothing below it.
 */

/** What one game day of a loan costs, minor units. */
export function dailyInterestMinor(
  outstandingMinor: number,
  annualRateBps: number,
  daysPerYear: number,
): number {
  if (outstandingMinor <= 0 || annualRateBps <= 0 || daysPerYear <= 0) return 0;
  return Math.round((outstandingMinor * annualRateBps) / 10_000 / daysPerYear);
}

/** Whole game days between two instants, never negative. */
export function wholeGameDays(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.floor(ms / 86_400_000);
}

/** Where an airline stands on the ladder, and when its patience runs out. */
export interface DefaultState {
  stage: DefaultStage;
  /** Game time the current stage began, or null in good standing. */
  stageEnteredAt: Date | null;
  /** Game time the arrears must be cleared by, or null when nothing is owed. */
  cureByAt: Date | null;
}

/** What a review of the ladder decided. */
export interface LadderReview {
  next: DefaultState;
  /** True when the stage moved down a rung this review. */
  escalated: boolean;
  /** True when the airline cleared its arrears and left the ladder entirely. */
  cured: boolean;
}

/**
 * Advance, hold or clear the ladder for one airline.
 *
 * The order of the three branches is the design:
 *
 * 1. **Nothing owed clears everything.** Checked first and unconditionally, so
 *    an airline that pays what it owes leaves the ladder from *any* stage
 *    including administration. This is §13.5's "recoverable" made structural
 *    rather than promised.
 * 2. **Newly in arrears starts at `warning`** with §13.5's cure window — "7
 *    in-game days to cure".
 * 3. **Still in arrears past the window** drops one rung, and gets a fresh
 *    window to cure at the new stage. One rung per review, never several: the
 *    ladder is meant to be felt, and an airline that skipped from warning to
 *    repossession in one sweep would have had no chance to act.
 *
 * `administration` does not escalate. It is the bottom, and the airline stays
 * there — restricted and wrecked — until it pays.
 */
export function reviewDefaultLadder(
  current: DefaultState,
  args: { arrearsMinor: number; gameNow: Date },
  balance: EconomyConfig['credit'] = DEFAULT_CREDIT,
): LadderReview {
  if (args.arrearsMinor <= 0) {
    const wasOnLadder = current.stage !== 'none';
    return {
      next: { stage: 'none', stageEnteredAt: null, cureByAt: null },
      escalated: false,
      cured: wasOnLadder,
    };
  }

  const windowDays = balance.defaultLadder.cureDays;
  const cureBy = (from: Date): Date => new Date(from.getTime() + windowDays * 86_400_000);

  if (current.stage === 'none') {
    return {
      next: { stage: 'warning', stageEnteredAt: args.gameNow, cureByAt: cureBy(args.gameNow) },
      escalated: true,
      cured: false,
    };
  }

  // The window has not run out, or there is none recorded — hold.
  if (current.cureByAt !== null && args.gameNow.getTime() < current.cureByAt.getTime()) {
    return { next: current, escalated: false, cured: false };
  }

  const rank = defaultStageRank(current.stage);
  const bottom = DEFAULT_STAGES.length - 1;
  if (rank >= bottom) {
    // Administration is the bottom. Nothing below it, and nothing that ends the
    // run — the airline sits here until the arrears are cleared.
    return { next: current, escalated: false, cured: false };
  }

  const next = DEFAULT_STAGES[rank + 1] ?? current.stage;
  return {
    next: { stage: next, stageEnteredAt: args.gameNow, cureByAt: cureBy(args.gameNow) },
    escalated: true,
    cured: false,
  };
}

/** Whether this stage forbids new routes, aircraft and dividends (§13.5). */
export { isRestricted };

/**
 * Whether the lender may seize secured aircraft at this stage.
 *
 * §13.5's fourth rung, and not before it: an airline at `forced_disposal` is
 * being told to sell, and taking the aeroplane while it is trying to would make
 * the rung above meaningless.
 */
export function allowsRepossession(stage: DefaultStage): boolean {
  return defaultStageRank(stage) >= defaultStageRank('repossession');
}
