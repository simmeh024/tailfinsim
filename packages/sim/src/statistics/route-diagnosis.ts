import {
  breakevenLoadFactor,
  cask,
  loadFactor,
  passengerYield,
  type TrafficTotals,
} from './unit-economics';

/**
 * §14.4's drill-down: **why** a route is below the line (M8-11).
 *
 * > **Profit by route, ranked, with a breakeven line.** It's the chart that
 * > turns a confused player into an airline manager. Loss-making routes sit
 * > below the line in red and the drill-down tells you whether it's yield, cost,
 * > load factor or a competitor — and therefore whether to **reprice**,
 * > **re-gauge**, **re-time**, or **kill it**.
 *
 * Four causes and four actions, and the pairing is the whole value of the chart.
 * A breakdown that showed a player their revenue, their cost and their load
 * factor would leave them exactly where they started: three numbers and no
 * decision. So this returns **one** cause and **one** action.
 *
 * ## Why it is not a ranking of gaps against an average
 *
 * The obvious implementation compares each figure to the airline's own median
 * and names whichever is furthest below. It gives an answer for every route,
 * including routes where the answer is wrong: a route with a below-average load
 * factor and a cost base that *no* load factor could cover is diagnosed
 * "re-time", and re-timing it cannot help.
 *
 * So the diagnosis is a decision tree over the **breakeven load factor**, which
 * is the one figure that says whether a route is fixable by filling it:
 *
 * ```
 * contribution >= 0            → nothing to fix
 * BELF > 1                     → no load factor saves it   → cost or yield
 * BELF <= 1 and LF < BELF      → it is under-filled        → competitor or timing
 * ```
 *
 * `BELF > 1` means every extra passenger loses money, which is why
 * {@link breakevenLoadFactor} deliberately does not clamp to 1. That unclamped
 * value is what makes this tree possible.
 *
 * The peer medians still appear, as the **quantified gaps** the response carries
 * — they are how a player sees the working (§14.1) and how the tree chooses
 * between cost and yield. They are just not the classifier.
 *
 * ## No balance literals
 *
 * Every threshold is a parameter. The share at which a rival counts as owning
 * the market is a judgement about the game, so the caller supplies it.
 */

/** §14.4's four causes, plus the answer for a route that is fine. */
export type RouteCause = 'none' | 'yield' | 'cost' | 'load_factor' | 'competitor';

/** §14.4's four actions, paired one-to-one with the causes. */
export type RouteAction = 'keep' | 'reprice' | 're-gauge' | 're-time' | 'cut';

const ACTION_OF: Record<RouteCause, RouteAction> = {
  none: 'keep',
  yield: 'reprice',
  cost: 're-gauge',
  load_factor: 're-time',
  competitor: 'cut',
};

/** What the airline's other routes look like, as the benchmark for the gaps. */
export interface PeerBenchmark {
  /** Median revenue per RPK across the airline's routes, or null with too few. */
  yieldMinor: number | null;
  /** Median cost per ASK. */
  caskMinor: number | null;
  /** Median load factor, 0–1. */
  loadFactor: number | null;
  /** How many routes the medians were taken over. */
  routes: number;
}

export interface DiagnosisInput {
  /** The route's own settled traffic over the window. */
  totals: TrafficTotals;
  /** The airline's own median route, for the quantified gaps. */
  peers: PeerBenchmark;
  /**
   * Share of this market held by everyone except the airline, 0–1.
   *
   * Null when competition is unknown — the tree then cannot distinguish a rival
   * taking the traffic from a schedule nobody wants, and says `load_factor`,
   * which is the answer that costs least if it is wrong: re-timing a route a
   * rival owns wastes a week, cutting a route that only needed re-timing throws
   * a market away.
   */
  rivalShare: number | null;
  /** Above this rival share, a thin route is a market somebody else owns. */
  rivalShareThreshold: number;
}

/** One quantified lever: what closing the gap to the peer median would be worth. */
export interface RouteGap {
  /** Minor units of contribution this lever would recover. Never negative. */
  worthMinor: number;
  /** The route's own figure, and the benchmark it is measured against. */
  own: number | null;
  peer: number | null;
}

export interface RouteDiagnosis {
  cause: RouteCause;
  action: RouteAction;
  contributionMinor: number;
  loadFactor: number | null;
  breakevenLoadFactor: number | null;
  /**
   * True when no load factor could make this route pay.
   *
   * The distinction §14.4's chart exists to draw: a route below the line that
   * needs filling is a different problem from one whose cost base is wrong, and
   * only one of them is worth re-timing.
   */
  unfillable: boolean;
  gaps: { yield: RouteGap; cost: RouteGap; load: RouteGap };
  rivalShare: number | null;
}

/** A gap's worth, floored at zero — a route ahead of its peers has nothing to recover. */
function gap(worth: number, own: number | null, peer: number | null): RouteGap {
  return { worthMinor: Math.max(0, Math.round(worth)), own, peer };
}

/**
 * Name the one cause, and the one thing to do about it.
 *
 * The gaps are always computed and always returned, whichever cause wins: a
 * player told "reprice this" will immediately want to know what repricing is
 * worth, and §14.1 says every figure must be interrogable.
 */
export function diagnoseRoute(input: DiagnosisInput): RouteDiagnosis {
  const { totals, peers } = input;
  const contributionMinor = totals.revenueMinor - totals.costMinor;
  const lf = loadFactor(totals);
  const belf = breakevenLoadFactor(totals);
  const ownYield = passengerYield(totals);
  const ownCask = cask(totals);

  /*
   * What each lever is worth, in contribution.
   *
   * Yield and load both act on revenue and are deliberately measured
   * separately: `yield × RPK` is what the seats you already sold would earn at
   * the benchmark price, and `(peerLF − LF) × ASK × yield` is what the seats you
   * did not sell would earn at your own price. Adding them would double-count
   * the seats in both.
   */
  const yieldWorth =
    ownYield !== null && peers.yieldMinor !== null
      ? (peers.yieldMinor - ownYield) * totals.rpkKm
      : 0;
  const costWorth =
    ownCask !== null && peers.caskMinor !== null ? (ownCask - peers.caskMinor) * totals.askKm : 0;
  const loadWorth =
    lf !== null && peers.loadFactor !== null && ownYield !== null
      ? (peers.loadFactor - lf) * totals.askKm * ownYield
      : 0;

  const gaps = {
    yield: gap(yieldWorth, ownYield, peers.yieldMinor),
    cost: gap(costWorth, ownCask, peers.caskMinor),
    load: gap(loadWorth, lf, peers.loadFactor),
  };

  const result = (cause: RouteCause, unfillable: boolean): RouteDiagnosis => ({
    cause,
    action: ACTION_OF[cause],
    contributionMinor,
    loadFactor: lf,
    breakevenLoadFactor: belf,
    unfillable,
    gaps,
    rivalShare: input.rivalShare,
  });

  // Above the line. §14.4's chart ranks these too, and the honest drill-down for
  // one of them is that there is nothing to fix — not the weakest of its levers
  // dressed up as a problem.
  if (contributionMinor >= 0) return result('none', false);

  /*
   * Nothing sold. `breakevenLoadFactor` is null because a yield of zero has no
   * ratio, so the tree cannot reach its cost-or-yield question — and the answer
   * is not in doubt anyway: an aeroplane that flew and carried nobody has a
   * demand problem, whatever its cost base.
   */
  if (belf === null) return result('load_factor', false);

  /*
   * No load factor saves it. Every extra passenger loses money, so filling the
   * aeroplane is the one thing that cannot work — which is why the unclamped
   * breakeven load factor is load-bearing rather than a curiosity.
   *
   * Between the two remaining levers, take the bigger gap. With no peers to
   * compare against, `cask > yield` *is* the diagnosis: the seats cost more to
   * offer than the sold ones earn, which is an aeroplane too large or too
   * expensive for the sector rather than a price that is too low.
   */
  if (belf > 1) {
    if (gaps.cost.worthMinor === 0 && gaps.yield.worthMinor === 0) {
      return result((ownCask ?? 0) > (ownYield ?? 0) ? 'cost' : 'yield', true);
    }
    return result(gaps.cost.worthMinor >= gaps.yield.worthMinor ? 'cost' : 'yield', true);
  }

  /*
   * It could pay if it were fuller. Whether that is a timing problem or a
   * competitor problem is the one question the route's own numbers cannot
   * answer, so it is the one place this reads the market.
   */
  if (lf !== null && lf < belf) {
    if (input.rivalShare !== null && input.rivalShare >= input.rivalShareThreshold) {
      return result('competitor', false);
    }
    return result('load_factor', false);
  }

  /*
   * Full enough to clear its own breakeven and still losing money, which means
   * the breakeven was computed over a window whose mix has since moved — a
   * route flying at a loss on today's numbers. The largest gap is the honest
   * answer, and cost first on a tie because it is the lever that does not
   * depend on anyone else's behaviour.
   */
  const largest = Math.max(gaps.cost.worthMinor, gaps.yield.worthMinor, gaps.load.worthMinor);
  if (largest === 0) return result('cost', false);
  if (gaps.cost.worthMinor === largest) return result('cost', false);
  if (gaps.yield.worthMinor === largest) return result('yield', false);
  return result('load_factor', false);
}

/** The median of a set of measurements, ignoring the ones that are not there. */
export function medianOf(values: readonly (number | null)[]): number | null {
  const present = values.filter(
    (value): value is number => value !== null && Number.isFinite(value),
  );
  if (present.length === 0) return null;
  const sorted = [...present].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  // An even count averages the two middles, which keeps the benchmark from
  // jumping when one route is added to an even network.
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? null);
}
