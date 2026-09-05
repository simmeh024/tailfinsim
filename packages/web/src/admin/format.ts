import { formatMinorUnitsUsd, formatMinorUnitsUsdSigned } from '@tailfin/shared';

/**
 * How the admin console renders money and instants (UX-01, UX-02).
 *
 * One module because there were **thirteen** of these: four money formatters,
 * three of which disagreed, and nine copies of `formatAt` at two different
 * precisions. The same balance rendered with and without a currency symbol on
 * adjacent pages, and the same instant rendered three ways.
 *
 * ## Money is USD here, and that is a decision rather than an omission
 *
 * The game client converts to the player's chosen display currency at the
 * render boundary (M8-02, `currency/display.ts`). The console must not: AIR-06's
 * ledger is USD integer minor units, and an operator reconciling a balance
 * against `cash_movement` needs the figure that is *stored*, not one converted
 * through a rate that refreshes daily. A support conversation about a €-denominated
 * balance that no table contains would be unresolvable.
 *
 * So these are deliberately USD, and they say so by showing `$`. The four
 * formatters they replace each carried a comment saying the currency was
 * "M8-02's decision"; M8-02 decided, and the answer for this surface is USD.
 *
 * ## Instants are UTC, and now say so
 *
 * Every timestamp the admin API sends is UTC. Nothing on screen said it, on a
 * console that can change a world's speed, archive a world and **reset** one —
 * and ADR-0005 is explicit that a reset has no undo. An operator reading
 * `2026-09-05 14:03` beside a "last backup" figure has no reason not to read it
 * as local, and the two differ by up to a day at the boundary.
 *
 * Four characters a cell against that is an easy trade. The cost is real noise
 * in a dense table and it is worth paying.
 *
 * ## Why the locale is pinned
 *
 * `en-US`, matching `currency/display.ts`, so grouping and separators are
 * deterministic across browsers and in CI. A console whose figures change shape
 * with the reader's locale is one where two people comparing screenshots
 * disagree about the number.
 */

/**
 * A ledger figure, in USD.
 *
 * Delegates to `@tailfin/shared`, which is where it has to live: the server
 * writes money into the NPC decision log's prose, and this page renders that
 * prose beside a cash column. Two formatters is how they came to disagree.
 *
 * Always two decimals, because a cash balance with a variable number of them
 * does not line up in a column — `PlayersPage`'s old formatter used
 * `maximumFractionDigits` alone and produced exactly that.
 */
export function adminMoney(minor: number): string {
  return formatMinorUnitsUsd(minor);
}

/**
 * A cash movement, signed.
 *
 * The `+` is the point: a ledger column of unsigned figures cannot be read as a
 * running account. Negative amounts already carry their own sign.
 */
export function adminMovement(minor: number): string {
  return formatMinorUnitsUsdSigned(minor);
}

/**
 * A compact figure for a headline.
 *
 * `$1.2M`. For a card where a balance to the cent is precision nobody asked for
 * and pushes the layout around as the number grows.
 */
export function adminCompactMoney(minor: number): string {
  return formatMinorUnitsUsd(minor, { compact: true });
}

/**
 * `2026-09-05 14:03 UTC` — an instant, to the minute.
 *
 * The default, and what most of the console wants: a created-at, a launch date,
 * a last-seen. Sliced from the ISO string rather than parsed into a `Date`,
 * which is what makes it UTC without a timezone library — the API sends UTC and
 * this reads the characters it sent.
 *
 * A malformed or absent value comes back as a dash rather than as `Invalid Date`
 * or a slice of nonsense. A console that renders garbage for a null is one whose
 * other figures stop being trusted.
 */
export function adminAt(iso: string | null | undefined): string {
  if (typeof iso !== 'string' || iso.length < 16) return '—';
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/**
 * `2026-09-05 14:03:07 UTC` — the same, to the second.
 *
 * Kept as its own function rather than folded into {@link adminAt}, because the
 * seconds are load-bearing exactly twice: the audit log and the world health
 * page both list entries that can share a minute, and an order nobody can see is
 * an order nobody can check. Everywhere else they are noise.
 */
export function adminAtSeconds(iso: string | null | undefined): string {
  if (typeof iso !== 'string' || iso.length < 19) return '—';
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

/**
 * `2026-09-05` — a date with no time of day.
 *
 * For a column where the time is genuinely uninteresting: an in-game calendar
 * date, an import date. No `UTC` suffix, because a date is not an instant and
 * labelling one invites the reader to wonder which midnight.
 */
export function adminDate(iso: string | null | undefined): string {
  if (typeof iso !== 'string' || iso.length < 10) return '—';
  return iso.slice(0, 10);
}
