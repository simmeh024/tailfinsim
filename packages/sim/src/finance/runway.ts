/**
 * §13.6's cash runway: how many in-game days the airline can fund (M8-08).
 *
 * > A profitable airline can still run out of cash — lease deposits, aircraft
 * > down payments, gate leases and academy construction all hit cash long
 * > before they show up in profit. The dashboard shows a **cash runway in
 * > in-game days** at all times, and it is the single most prominent number
 * > when it drops below 30.
 *
 * ## Why this is a walk and not a division
 *
 * `cash / burn` is the obvious implementation and it is the wrong one, because
 * it is exactly the number §13.6 says is misleading. An airline with $3M, a
 * gentle burn and a $2.8M delivery payment due in nine days has about nine days
 * of runway, and the division says months. The whole lesson the section wants
 * taught is that *lumpy commitments arrive on dates*, so the projection walks
 * game days and applies each commitment on the day it falls due.
 *
 * The cost of the walk is one iteration per game day of horizon, which for a
 * year is 365 additions. That is not worth optimising and the shape is worth
 * keeping: it is the only version that can also say **what** tipped the balance,
 * which is §14.1's rule against a figure a player cannot interrogate.
 *
 * ## What this function does not decide
 *
 * It has no opinion about which movements are operating flow, which are
 * commitments, or how far ahead to look. All three are the caller's, because
 * all three need the database and one of them (the trailing window) is a
 * judgement about the world rather than arithmetic. Nothing here is a balance
 * number, and there are deliberately no literals below.
 */

const DAY_MS = 86_400_000;

/** What kind of obligation a commitment is, so a UI can name the cause. */
export type CommitmentKind =
  /** Salaries and base overhead for flight and cabin crew (§9.2). */
  | 'crew'
  /** Head-office and executive salaries (§10). */
  | 'office'
  /** Payroll for stations the airline handles itself (§9.3). */
  | 'ground'
  /** A game day of interest on the outstanding debt (§13.4). */
  | 'interest'
  /** Interest already charged and unpaid — owed now, not later (§13.5). */
  | 'arrears';

/** One dated outflow the airline has already committed to. */
export interface CashCommitment {
  /** Game-time instant it falls due. On or before `gameNow` means owed now. */
  dueAt: Date;
  /** Minor units, positive. A commitment is money leaving. */
  amountMinor: number;
  kind: CommitmentKind;
  /** Plain words, for the drill-down. */
  label: string;
}

export interface RunwayInput {
  cashMinor: number;
  gameNow: Date;
  /**
   * Net operating cash per game day — trading, at the rate it has been running.
   *
   * Negative is a burn, positive is an airline funding itself. Deliberately
   * *net*: revenue and its per-flight costs arrive in the same settlement, and
   * splitting them here would invite a caller to forget one.
   */
  dailyOperatingMinor: number;
  commitments: readonly CashCommitment[];
  /** How far ahead to look. Past it the honest answer is "further than this". */
  horizonDays: number;
}

export interface RunwayProjection {
  /**
   * Whole game days the airline can fund, or `null` for "beyond the horizon".
   *
   * Null rather than the horizon itself, because *"365 days"* and *"at least
   * 365 days"* are different claims and a strip that showed the first would be
   * lying on the day the projection improved.
   */
  days: number | null;
  horizonDays: number;
  /** Cash at the end of the horizon, when the airline reaches it. */
  endingCashMinor: number;
  /**
   * The commitment that took the balance below zero, when one did.
   *
   * Null when the operating burn alone exhausted it — a meaningful distinction:
   * one is a bill to plan for and the other is a business to fix.
   */
  tippedBy: CashCommitment | null;
  /** Everything owed on or before `gameNow`, already deducted from day zero. */
  owedNowMinor: number;
  /** What the commitments below the horizon add up to, for the drill-down. */
  committedMinor: number;
}

/** Whole game days between two instants, floored at zero. */
function dayIndexOf(gameNow: Date, dueAt: Date): number {
  const ms = dueAt.getTime() - gameNow.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.ceil(ms / DAY_MS);
}

/**
 * Walk the airline's cash forward and say when it runs out.
 *
 * A day is funded when the balance is still non-negative at the end of it, so an
 * airline whose cash reaches exactly zero on day 12 has twelve days of runway
 * rather than eleven: it paid everything it owed. An airline already overdrawn
 * has none, and that is `0` rather than a negative number — there is no such
 * thing as minus three days of runway, and a UI would have to special-case it.
 */
export function cashRunway(input: RunwayInput): RunwayProjection {
  const horizonDays = Math.max(0, Math.floor(input.horizonDays));

  /*
   * Commitments bucketed by the day they fall due. Anything already due lands in
   * bucket zero and is taken before the first day is funded, which is the right
   * reading of arrears: the money is owed, and the next dollar in pays it.
   */
  const byDay = new Map<number, CashCommitment[]>();
  let owedNowMinor = 0;
  let committedMinor = 0;
  for (const commitment of input.commitments) {
    const day = dayIndexOf(input.gameNow, commitment.dueAt);
    if (day > horizonDays) continue;
    if (day === 0) owedNowMinor += commitment.amountMinor;
    committedMinor += commitment.amountMinor;
    const bucket = byDay.get(day);
    if (bucket) bucket.push(commitment);
    else byDay.set(day, [commitment]);
  }

  let balance = input.cashMinor;
  for (const commitment of byDay.get(0) ?? []) {
    balance -= commitment.amountMinor;
  }
  if (balance < 0) {
    return {
      days: 0,
      horizonDays,
      endingCashMinor: balance,
      tippedBy: null,
      owedNowMinor,
      committedMinor,
    };
  }

  for (let day = 1; day <= horizonDays; day += 1) {
    balance += input.dailyOperatingMinor;
    let tippedBy: CashCommitment | null = null;
    for (const commitment of byDay.get(day) ?? []) {
      balance -= commitment.amountMinor;
      // The one that crossed the line, not merely the last one on the day: a
      // player told "your crew payroll broke you" wants the bill that did it.
      if (balance < 0 && tippedBy === null) tippedBy = commitment;
    }
    if (balance < 0) {
      return {
        days: day - 1,
        horizonDays,
        endingCashMinor: balance,
        tippedBy,
        owedNowMinor,
        committedMinor,
      };
    }
  }

  return {
    days: null,
    horizonDays,
    endingCashMinor: balance,
    tippedBy: null,
    owedNowMinor,
    committedMinor,
  };
}

/**
 * Every game month boundary strictly after `from`, up to `horizonDays` ahead.
 *
 * The monthly payrolls all settle on the first of the following game month, so
 * this is where their due dates come from. Exported because the server assembles
 * three separate monthly bills from it and they must fall on the same days —
 * two implementations of "the first of next month" is two answers to when the
 * airline goes broke.
 */
export function monthBoundariesAhead(from: Date, horizonDays: number): Date[] {
  const limit = from.getTime() + Math.max(0, horizonDays) * DAY_MS;
  const boundaries: Date[] = [];
  const year = from.getUTCFullYear();
  // `Date.UTC` normalises a month index past 11 into the following year, so the
  // loop can simply count months and never has to carry the year itself.
  for (let month = from.getUTCMonth() + 1; ; month += 1) {
    const next = new Date(Date.UTC(year, month, 1));
    if (next.getTime() > limit) return boundaries;
    boundaries.push(next);
  }
}
