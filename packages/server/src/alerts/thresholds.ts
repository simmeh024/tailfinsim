import type { AlertThresholds } from '@tailfin/sim';

import { CRITICAL_DAYS } from '../finance/runway';

/**
 * §14.5's numbers (M8-13).
 *
 * **Not `EconomyConfig`, and that was a decision.** §22.3's payload is *balance*
 * — what things cost, how demand responds, what a lender will advance — and it is
 * immutable, versioned and pinned per world so that a `flight_result` can always
 * be re-derived under the numbers it was billed with. These are none of that.
 * They move when an alert turns out to be too noisy or too quiet, which is a UX
 * judgement, and shipping such a change as a new economy version would force
 * every world to re-pin its balance in order to stop a warning firing a week
 * early.
 *
 * So they live here as named constants with their reasons, which is what M8-08
 * did with `CRITICAL_DAYS` and M8-11 with `RIVAL_SHARE_THRESHOLD`. The rules in
 * `@tailfin/sim` take them as an argument and hold none of their own.
 */

/**
 * §14.5's window: *route loss-making 7 days running*.
 *
 * One game week. Long enough that a single bad day cannot trigger it, short
 * enough that the answer is still actionable.
 */
const ROUTE_LOSS_WINDOW_DAYS = 7;

/**
 * How many flown days the window must hold before a loss is a trend.
 *
 * A route that flew twice and lost money twice is not a losing week; it is a
 * route that has barely started. Three is the smallest number that can show a
 * pattern rather than an incident, and it is also what makes the rule fire
 * correctly on a thrice-weekly route — see `routeLossAlert`.
 */
const ROUTE_LOSS_MIN_DAYS = 3;

/**
 * How far above §13.1's DSCR floor still counts as *approaching* the covenant.
 *
 * Twenty per cent of the floor. Expressed as a fraction of the floor rather than
 * as an absolute margin because the floor itself is balance and can be retuned:
 * a hard `+0.25` would silently become a different warning if §13.1's 1.25 ever
 * moved.
 */
const DSCR_HEADROOM = 0.2;

/** §14.5's horizon: *crew shortfall at base in 5 days*. */
const CREW_SHORTFALL_DAYS = 5;

/**
 * How much of a check interval must be used before it is worth saying.
 *
 * Ninety per cent. §14.5 says *"C-check due"*, and a check that is *due* is
 * already an aeroplane flying on borrowed time — the useful alert arrives while
 * there is still a choice of when. Below this the fleet page's due-timeline is
 * the right surface, because there is nothing to decide yet.
 */
const CHECK_DUE_WARN_FRACTION = 0.9;

/**
 * How near a handling contract's `term_end` is worth saying, in game days.
 *
 * One game month, so the alert arrives with a whole month's trading left to
 * decide in. §9.3's own words are *"before it lapses"* and the value of the
 * warning is entirely in how much notice it gives.
 */
const CONTRACT_EXPIRY_DAYS = 30;

/** Inside a game week, a lapse stops being a plan and becomes a deadline. */
const CONTRACT_EXPIRY_CRITICAL_DAYS = 7;

/**
 * How recently a rival must have started flying to count as having *entered*.
 *
 * Two game weeks. A rival's first settled flight inside this window is news; one
 * older than it is the market the player is already in, and reporting it would
 * make every alert list open with a history lesson.
 */
const COMPETITOR_LOOKBACK_DAYS = 14;

/** §14.5's ceiling: *spill > 15% on a route*. */
const SPILL_RATE_CEILING = 0.15;

/**
 * Settled flights the spill rate needs before it means anything.
 *
 * Spill is only recorded on a full aeroplane (App. A.5), so a route with two
 * flights can read 50% spill from one busy Friday. Five is a week of a
 * five-weekly route.
 */
const SPILL_MIN_FLIGHTS = 5;

/**
 * The window spill and traffic are measured over, in game days.
 *
 * One game month, matching §14.3's dashboards — the alert and the Operations
 * page must not be able to disagree about how much an airline spilled.
 */
export const TRAFFIC_WINDOW_DAYS = 30;

export const ALERT_THRESHOLDS: AlertThresholds = {
  routeLossWindowDays: ROUTE_LOSS_WINDOW_DAYS,
  routeLossMinDays: ROUTE_LOSS_MIN_DAYS,
  // §13.6's own threshold, imported rather than repeated: the status strip, the
  // dashboard tile and this alert must never be able to disagree about what
  // "running out of cash" means.
  runwayCriticalDays: CRITICAL_DAYS,
  dscrHeadroom: DSCR_HEADROOM,
  crewShortfallDays: CREW_SHORTFALL_DAYS,
  checkDueWarnFraction: CHECK_DUE_WARN_FRACTION,
  contractExpiryDays: CONTRACT_EXPIRY_DAYS,
  contractExpiryCriticalDays: CONTRACT_EXPIRY_CRITICAL_DAYS,
  competitorLookbackDays: COMPETITOR_LOOKBACK_DAYS,
  spillRateCeiling: SPILL_RATE_CEILING,
  spillMinFlights: SPILL_MIN_FLIGHTS,
};

/**
 * How often one airline's rules are re-evaluated, in game hours.
 *
 * The rules are cheap to decide and expensive to read — a runway projection and
 * a coverage ratio each walk a year of the ledger. Every tick would spend a
 * world's whole query budget asking whether a seven-day trend had changed since
 * a second ago, and none of §14.5's conditions can move faster than a game hour
 * anyway: the fastest of them is measured in days.
 */
export const SWEEP_INTERVAL_GAME_HOURS = 1;

/**
 * How many airlines one tick will evaluate.
 *
 * The same bound M8-07's `MAX_DAYS_PER_SWEEP` puts on the interest accrual, and
 * for the same reason: a world that has just been seeded with two hundred
 * airlines must not turn its first tick into a minutes-long transaction. The
 * watermark did not move for the ones left over, so they are picked up on the
 * next tick — oldest first, so nothing can be starved.
 */
export const MAX_AIRLINES_PER_SWEEP = 25;

/**
 * The longest period one digest will cover, in game days.
 *
 * §3.2 asks for *"a readable feed"*, and a player away for a game year does not
 * have one. The window is capped at a game month and `DigestWindow.truncated`
 * says so, rather than the digest quietly pretending the earlier part never
 * happened.
 */
export const DIGEST_MAX_WINDOW_DAYS = 30;
