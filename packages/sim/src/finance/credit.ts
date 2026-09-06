import {
  CREDIT_TIERS,
  creditTierRank,
  ECONOMY_CONFIG_V1,
  type BorrowingConstraint,
  type CreditTier,
  type EconomyConfig,
  type LoanInstrument,
} from '@tailfin/shared';

/**
 * What an airline may borrow (M8-06, §13.1–§13.3).
 *
 * > **Loans support, they never carry.**
 *
 * The entire subsystem is that sentence made arithmetic. There is no "is this
 * airline in trouble?" check anywhere here, and there must not be one, because
 * §13.1 is explicit that the formula already does it:
 *
 * > If you're losing money, `3.0 × operating profit` is zero or negative. **You
 * > cannot borrow at all.** No special-case rule needed — the formula does it.
 *
 * A special case would also be a second place the rule lived, and the two would
 * eventually disagree about an airline sitting exactly on the line.
 *
 * ## No balance literal
 *
 * The multiple, the advance rate, the DSCR floor, every tier's cap, rate and
 * term, and the instrument spreads all come from the world's pinned
 * `EconomyConfig.credit`. This file is comparisons and arithmetic.
 */

/** The shipped credit balance. A slice of the seed, like every other `DEFAULT_*`. */
export const DEFAULT_CREDIT: EconomyConfig['credit'] = ECONOMY_CONFIG_V1.credit;

/** What an airline's trading says about it, as the tests and the server both see it. */
export interface CreditStanding {
  /** Trailing twelve months, minor units. Negative for a loss-making airline. */
  trailingOperatingProfitMinor: number;
  /** Trailing twelve months' EBITDA, minor units — the DSCR numerator. */
  trailingEbitdaMinor: number;
  /** Trailing twelve months' revenue, for the margin the tiers ask about. */
  trailingRevenueMinor: number;
  /** What the airline owns outright and a lender could take, minor units. */
  tangibleAssetValueMinor: number;
  /** Consecutive profitable months, most recent first. */
  profitableMonths: number;
  routes: number;
  hubs: number;
}

/** §13.1's three limits, and which of them actually bites. */
export interface BorrowingCapacity {
  tierCapMinor: number;
  profitMultipleMinor: number;
  assetAdvanceMinor: number;
  maxTotalDebtMinor: number;
  bindingConstraint: BorrowingConstraint;
}

/** Never below zero: an airline cannot have negative capacity, it simply has none. */
function floor0(value: number): number {
  return Math.max(0, Math.round(value));
}

/**
 * §13.1's `MaxTotalDebt`.
 *
 * The **founder facility is the one exemption**, and it is an exemption from the
 * *profit test* alone — not from the tier cap. §13.2 gives `startup` a $250K
 * ceiling precisely so that the exemption cannot become a way to borrow real
 * money without trading: a brand-new airline may draw a small, dear, personally
 * guaranteed facility and nothing more.
 *
 * The asset limit still applies to it, and that is deliberate rather than an
 * oversight of the design doc: an airline with no aeroplanes has nothing to
 * advance against, and the founder facility is the one line that should still be
 * available to it. So `startup` skips *both* trading limits — see the guard
 * below — while every earned tier faces all three.
 */
export function borrowingCapacity(
  tier: CreditTier,
  standing: CreditStanding,
  balance: EconomyConfig['credit'] = DEFAULT_CREDIT,
): BorrowingCapacity {
  const tierCapMinor = balance.tiers[tier].maxDebtMinor;
  const profitMultipleMinor = floor0(
    standing.trailingOperatingProfitMinor * balance.profitMultiple,
  );
  const assetAdvanceMinor = floor0(standing.tangibleAssetValueMinor * balance.assetAdvanceRate);

  if (tier === 'startup') {
    // The founder facility: the tier cap is the only limit, because the airline
    // it is for has by definition demonstrated nothing yet. §13.2 keeps it
    // honest by making that cap small and the rate 14%.
    return {
      tierCapMinor,
      profitMultipleMinor,
      assetAdvanceMinor,
      maxTotalDebtMinor: tierCapMinor,
      bindingConstraint: 'tier_cap',
    };
  }

  const limits: { constraint: BorrowingConstraint; value: number }[] = [
    { constraint: 'tier_cap', value: tierCapMinor },
    { constraint: 'profit_multiple', value: profitMultipleMinor },
    { constraint: 'asset_advance', value: assetAdvanceMinor },
  ];
  // The smallest wins, and ties go to the earlier one — tier cap, then profit,
  // then assets — so a UI naming "what is holding me back" names the structural
  // limit before the incidental one.
  const binding = limits.reduce((low, entry) => (entry.value < low.value ? entry : low));

  return {
    tierCapMinor,
    profitMultipleMinor,
    assetAdvanceMinor,
    maxTotalDebtMinor: floor0(binding.value),
    bindingConstraint: binding.constraint,
  };
}

/**
 * §13.1's coverage test: trailing EBITDA over annual debt service.
 *
 * Null when nothing is owed. An airline with no debt has no coverage *ratio* —
 * the question does not apply — and returning `Infinity` would invite a caller
 * to format it, while returning 0 would read as the worst possible answer for
 * the airline in the strongest position.
 */
export function debtServiceCoverage(
  trailingEbitdaMinor: number,
  annualDebtServiceMinor: number,
): number | null {
  if (annualDebtServiceMinor <= 0) return null;
  return trailingEbitdaMinor / annualDebtServiceMinor;
}

/** Annual interest on a principal at a basis-point rate, minor units. */
export function annualInterestMinor(principalMinor: number, annualRateBps: number): number {
  return Math.round((principalMinor * annualRateBps) / 10_000);
}

/**
 * What an instrument costs, from the tier rate and §13.3's spread.
 *
 * Floored at zero: a large negative spread on an already-cheap tier must not
 * produce a loan the bank pays the airline to hold.
 */
export function instrumentRateBps(
  tier: CreditTier,
  instrument: LoanInstrument,
  balance: EconomyConfig['credit'] = DEFAULT_CREDIT,
): number {
  return Math.max(
    0,
    balance.tiers[tier].annualRateBps + balance.instrumentRateDeltaBps[instrument],
  );
}

/**
 * The highest tier this airline's trading earns, before hysteresis.
 *
 * Every requirement of a tier must be met — profitable months, routes, hubs and
 * margin together — because §13.2 states them as a conjunction ("6 profitable
 * months, **4+ routes**"). Walking down from the top means the answer is the
 * best rung fully satisfied rather than the first one tried.
 *
 * `startup` always qualifies, which is what makes the founder facility available
 * on day one to an airline with no trading at all.
 */
export function earnedCreditTier(
  standing: CreditStanding,
  balance: EconomyConfig['credit'] = DEFAULT_CREDIT,
): CreditTier {
  const margin =
    standing.trailingRevenueMinor <= 0
      ? 0
      : standing.trailingOperatingProfitMinor / standing.trailingRevenueMinor;

  for (const tier of [...CREDIT_TIERS].reverse()) {
    const terms = balance.tiers[tier];
    if (
      standing.profitableMonths >= terms.profitableMonths &&
      standing.routes >= terms.routes &&
      standing.hubs >= terms.hubs &&
      margin >= terms.operatingMargin
    ) {
      return tier;
    }
  }
  return 'startup';
}

/** A rating between reviews: where it sits, and how long it has deserved better. */
export interface RatingState {
  tier: CreditTier;
  /** Consecutive reviews that earned at least the next rung up. */
  goodReviews: number;
}

/**
 * Move a rating after one review — §13.2's asymmetry.
 *
 * > Ratings fall faster than they rise. One bad quarter costs a tier; recovering
 * > it takes two good ones.
 *
 * So a fall is **immediate and to the earned tier**, however far that is, while
 * a rise waits for `risesAfterGoodReviews` consecutive reviews and then climbs
 * at most `maxRisePerReview`. A rating that snapped back the moment one month
 * went well would price nothing, and the whole point of a rating is that it is
 * a claim about the *next* twelve months rather than a readout of the last one.
 *
 * The streak resets on a fall, so an airline that oscillates never accumulates
 * the credit for a rise — which is the "revenue stability" §13.2 lists among the
 * rating's inputs, arriving as a consequence rather than as another term.
 */
export function applyRatingReview(
  current: RatingState,
  earned: CreditTier,
  balance: EconomyConfig['credit'] = DEFAULT_CREDIT,
): RatingState {
  const held = creditTierRank(current.tier);
  /*
   * **The founder facility is a starting position, not a safety net.**
   *
   * §13.2 describes `startup` as "New airline", and it is the one tier exempt
   * from the profit test. An airline that had traded its way up to C and then
   * started losing money would, on a naive fall-to-earned rule, land back on
   * `startup` — and find $250K of exempt credit waiting for it. That is exactly
   * the airline §13.1 exists to stop borrowing: *"loans support, they never
   * carry"*.
   *
   * So a rating that has left `startup` cannot return to it. Its floor is `D`,
   * whose capacity is subject to the profit test like every earned tier, which
   * means a loss-making airline holds a rating and no borrowing capacity at all.
   * A database test caught this; the naive rule handed a failing airline the
   * founder facility a second time.
   */
  const floor = current.tier === 'startup' ? 0 : creditTierRank('D');
  const deserved = Math.max(floor, creditTierRank(earned));

  if (deserved < held) {
    return { tier: CREDIT_TIERS[deserved] ?? earned, goodReviews: 0 };
  }
  if (deserved === held) {
    // Holding station is not progress toward a rise, but it is not a fall either.
    return { tier: current.tier, goodReviews: 0 };
  }

  const goodReviews = current.goodReviews + 1;
  if (goodReviews < balance.risesAfterGoodReviews) {
    return { tier: current.tier, goodReviews };
  }
  const climbed = Math.min(deserved, held + balance.maxRisePerReview);
  return { tier: CREDIT_TIERS[climbed] ?? current.tier, goodReviews: 0 };
}

/** Why a draw was refused, in the order the checks are applied. */
export type BorrowRefusal =
  | { code: 'over_capacity'; headroomMinor: number }
  | { code: 'below_dscr'; dscr: number; minimum: number };

/**
 * Whether a draw of this size is allowed.
 *
 * Two gates, and the order matters for the message: capacity first, because "you
 * may borrow $0" is a more useful thing to be told than "your coverage is thin"
 * when both are true of an airline losing money.
 *
 * The DSCR gate only applies to an airline that already owes something — §13.1
 * calls it a test to *borrow more*, and an airline with no debt has no coverage
 * ratio to fail.
 */
export function checkDraw(
  args: {
    principalMinor: number;
    maxTotalDebtMinor: number;
    outstandingDebtMinor: number;
    dscr: number | null;
  },
  balance: EconomyConfig['credit'] = DEFAULT_CREDIT,
): BorrowRefusal | null {
  const headroomMinor = Math.max(0, args.maxTotalDebtMinor - args.outstandingDebtMinor);
  if (args.principalMinor > headroomMinor) {
    return { code: 'over_capacity', headroomMinor };
  }
  if (args.dscr !== null && args.dscr < balance.minimumDscr) {
    return { code: 'below_dscr', dscr: args.dscr, minimum: balance.minimumDscr };
  }
  return null;
}
