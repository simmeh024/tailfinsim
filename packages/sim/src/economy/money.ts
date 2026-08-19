/**
 * Money, and the one place it is allowed to stop being an integer (M2-06).
 *
 * Everything financial in Tailfin is an integer count of the currency's minor
 * unit — `airline.cash_minor`, `MinorUnits` in `packages/shared`, every figure on
 * a `flight_result`. The reason is in the schema and worth repeating here,
 * because this module is where it would be easiest to break: currency arithmetic
 * in binary floating point loses money in ways that are painful to reconcile,
 * and a balance that is out by a cent is a bug report nobody can close.
 *
 * ## Why this module exists at all
 *
 * Because two things in the model are *rates*, not amounts, and rates are not
 * integers. A fuel price is dollars per tonne against a burn of 0.6355 t; a crew
 * cost is dollars per block hour against 1.26 hours. Multiplying those gives a
 * fractional amount, and something has to decide where the fraction goes.
 *
 * The rule is: **fractions are permitted inside one line item and never between
 * them.** Each line rounds once, on the way out, and every total is the sum of
 * already-rounded lines. That is what makes a `flight_result` reconcile exactly
 * rather than to within a cent — see `settlement.ts`, where the totals are
 * *computed by summing the lines* rather than by rounding a running float.
 */

/** Cents in a dollar, pence in a pound. The design doc has not chosen a currency (§24, M8-02). */
export const MINOR_UNITS_PER_MAJOR = 100;

/**
 * Round a fractional minor-unit amount to a whole one.
 *
 * **Half away from zero**, which is the convention an accountant expects and the
 * one a player checking the arithmetic by hand will use. Deliberately not
 * `Math.round`, whose half-up rule is asymmetric about zero: it sends −0.5 to −0
 * and +0.5 to +1, so a refund and a charge of the same size would round by
 * different amounts and a reversal would not cancel the thing it reverses.
 */
export function roundMinor(amount: number): number {
  if (!Number.isFinite(amount)) {
    throw new Error(`Money must be a finite amount, got ${String(amount)}`);
  }
  const rounded = Math.sign(amount) * Math.round(Math.abs(amount));
  // `Math.sign(0) * …` is 0, but `-0` leaks through for small negatives and
  // compares equal to 0 while serialising as "-0" in JSON. Normalise it away.
  return rounded === 0 ? 0 : rounded;
}

/**
 * Convert a major-unit amount — dollars — into minor units.
 *
 * The boundary between the two systems in the codebase. `economy/fuel-price.ts`
 * works in major units because a fuel price is quoted per tonne in dollars and
 * writing $1,000/t as 100000 would make the calibration against §13.4
 * unreadable. Settlement works in minor units because it produces money that
 * lands in `airline.cash_minor`. This is the conversion, in one place, so there
 * is exactly one line to check when a figure looks a hundred times wrong.
 */
export function minorFromMajor(major: number): number {
  return roundMinor(major * MINOR_UNITS_PER_MAJOR);
}

/** Minor units back to major, for display only. Returns a fraction; never store it. */
export function majorFromMinor(minor: number): number {
  return minor / MINOR_UNITS_PER_MAJOR;
}

/**
 * Add up minor-unit amounts.
 *
 * Trivial, and worth having a name because of what it refuses to do: it takes
 * integers and returns an integer, so a caller cannot accidentally sum a list of
 * un-rounded fractions and round at the end. That ordering is the difference
 * between a breakdown that reconciles and one that is out by a cent for reasons
 * nobody can find later.
 */
export function sumMinor(amounts: readonly number[]): number {
  let total = 0;
  for (const amount of amounts) {
    if (!Number.isInteger(amount)) {
      throw new Error(
        `Money must already be whole minor units before summing, got ${String(amount)}`,
      );
    }
    total += amount;
  }
  return total;
}
