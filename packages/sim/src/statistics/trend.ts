/**
 * §14.2's middle horizon: direction and rate of change (M8-09).
 *
 * > **Trend** — 7 / 30 / 90 in-game days — direction and rate of change
 *
 * And §14.6's rule about what a headline metric must carry:
 *
 * > Absolute value **and** rate of change on every headline metric — a falling
 * > profit that's falling more slowly is a different story from one that isn't.
 *
 * So a trend here is always three things: the window's value, the value of the
 * window immediately before it, and the movement between them. A change alone
 * would lose the level; a level alone is the dead-end number §14.1 forbids.
 */

/** Which way a metric moved, without asking whether that is good. */
export type TrendDirection = 'up' | 'down' | 'flat' | 'unknown';

export interface Trend {
  /** The window this trend covers, in game days. */
  days: number;
  /** The window's own value. Null when nothing in it was measurable. */
  value: number | null;
  /** The same measure over the window immediately before it. */
  previousValue: number | null;
  /** Change as a fraction of the previous value; null when there is nothing to divide by. */
  changePct: number | null;
  /** Absolute change, which survives a previous value of zero. */
  changeAbsolute: number | null;
  direction: TrendDirection;
}

/**
 * Movement is direction *and* rate, and neither implies good or bad.
 *
 * A rising CASK is bad and a rising load factor is good; deciding that here
 * would put a judgement in a module that cannot see the metric. The caller pairs
 * `direction` with its own polarity.
 *
 * `changePct` is null when the previous window was zero or unmeasured — there is
 * no percentage change from nothing, and reporting `Infinity` invites a UI to
 * format it. `changeAbsolute` still answers in that case, which is why both are
 * carried.
 */
export function trendOf(days: number, value: number | null, previousValue: number | null): Trend {
  if (value === null || previousValue === null) {
    return {
      days,
      value,
      previousValue,
      changePct: null,
      changeAbsolute: value === null || previousValue === null ? null : value - previousValue,
      direction: 'unknown',
    };
  }

  const changeAbsolute = value - previousValue;
  const changePct = previousValue === 0 ? null : changeAbsolute / Math.abs(previousValue);
  const direction: TrendDirection =
    changeAbsolute > 0 ? 'up' : changeAbsolute < 0 ? 'down' : 'flat';

  return { days, value, previousValue, changePct, changeAbsolute, direction };
}
