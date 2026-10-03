/**
 * §10.4's third rule, as arithmetic: doctrine lapses if you stop funding it
 * (M9-06).
 *
 * > *"**Upkeep.** Academies and research carry ongoing cost. Doctrine lapses if
 * > you stop funding it — advantages must be maintained, not just banked."*
 *
 * A completed research node is not a permanent possession. Each one carries a
 * monthly upkeep, and the player may stop paying it; the node then **lapses
 * over game weeks** rather than vanishing at once, and recovers the same way
 * when funding returns. The acceptance criterion is *"Ceasing upkeep visibly
 * decays the advantage over game weeks"*, and both halves of that are here: the
 * decay is gradual, so a player can watch it, and it is on the world's clock
 * (ADR-0026), so a world at 4× lapses four times as fast in real time as one at
 * 1× — exactly as it researched four times as fast.
 *
 * ## A strength, computed rather than swept
 *
 * The state is three facts written when funding last changed — whether it is
 * funded now, the strength at that moment, and the moment — and the strength at
 * any later instant is a pure function of them. Nothing ticks the strength
 * down, so nothing has to run for the decay to be true: a world whose worker is
 * down still reads the right strength on its next arrival, and a replay of an
 * old arrival reads the strength it had then. The same argument the used market
 * makes for having no "last generated" column.
 *
 * ## Linear, both ways
 *
 * A straight line is the one shape a player can extrapolate by eye, which is
 * what *"visibly"* asks for: half the advantage gone in half the lapse period,
 * and the date it reaches zero is printable. Recovery is a separate, shorter
 * period — re-establishing a routine the crew still half remember is quicker
 * than forgetting it — and both are balance in `EconomyConfig.research.upkeep`.
 */

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** How fast an unfunded doctrine lapses, and a refunded one recovers, in game weeks. */
export interface DoctrineDecayBalance {
  /** Game weeks from full strength to nothing once funding stops. */
  lapseWeeks: number;
  /** Game weeks from nothing back to full strength once funding resumes. */
  recoveryWeeks: number;
}

/** What is stored when funding last changed. Completion counts as a change to funded. */
export interface DoctrineFundingState {
  funded: boolean;
  /** 0–1. */
  strengthAtChange: number;
  /** Game time. */
  changedAt: Date;
}

function assertBalance(balance: DoctrineDecayBalance): void {
  if (!Number.isFinite(balance.lapseWeeks) || balance.lapseWeeks <= 0) {
    throw new Error(`Lapse must take more than zero weeks, got ${String(balance.lapseWeeks)}`);
  }
  if (!Number.isFinite(balance.recoveryWeeks) || balance.recoveryWeeks <= 0) {
    throw new Error(
      `Recovery must take more than zero weeks, got ${String(balance.recoveryWeeks)}`,
    );
  }
}

function clampStrength(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * A doctrine's strength at a game instant: 1 is the full effect, 0 none.
 *
 * An instant before the last change reads the stored strength, rather than
 * extrapolating backwards through a change it knows nothing about.
 */
export function doctrineStrength(
  state: DoctrineFundingState,
  at: Date,
  balance: DoctrineDecayBalance,
): number {
  assertBalance(balance);
  const start = clampStrength(state.strengthAtChange);
  const weeks = Math.max(0, (at.getTime() - state.changedAt.getTime()) / WEEK_MS);
  return state.funded
    ? clampStrength(start + weeks / balance.recoveryWeeks)
    : clampStrength(start - weeks / balance.lapseWeeks);
}

/**
 * The game instant the strength stops moving: back at full strength when
 * funded, gone entirely when not. Null when it is already there.
 *
 * The date the readout prints, so *"fully lapsed in three game weeks"* is a
 * sentence the interface can say rather than a slope it leaves to the player.
 */
export function doctrineSettlesAt(
  state: DoctrineFundingState,
  balance: DoctrineDecayBalance,
): Date | null {
  assertBalance(balance);
  const start = clampStrength(state.strengthAtChange);
  const remaining = state.funded ? 1 - start : start;
  if (remaining <= 0) return null;
  const weeks = remaining * (state.funded ? balance.recoveryWeeks : balance.lapseWeeks);
  return new Date(state.changedAt.getTime() + weeks * WEEK_MS);
}

/**
 * The state after the player funds or stops funding a doctrine at `at`.
 *
 * The strength is carried across the change, so stopping and restarting within
 * a week costs a week's lapse and a week's recovery — never a free reset and
 * never a cliff.
 */
export function changeDoctrineFunding(
  state: DoctrineFundingState,
  funded: boolean,
  at: Date,
  balance: DoctrineDecayBalance,
): DoctrineFundingState {
  return { funded, strengthAtChange: doctrineStrength(state, at, balance), changedAt: at };
}

/**
 * Was this doctrine funded at any instant of `[monthStart, monthEnd)`?
 *
 * The question a month's upkeep bill asks. A change inside the month means both
 * states held during it, so one of them was funded and the month is owed —
 * which is what stops a player escaping a month's bill by switching funding off
 * on its last day and on again on the next month's first. The caller bills every
 * closed month before it records a change (see the server's `research/upkeep.ts`), so a
 * change can never fall after the end of a month that has not been billed.
 */
export function doctrineFundedDuring(
  state: Pick<DoctrineFundingState, 'funded' | 'changedAt'>,
  monthStart: Date,
  monthEnd: Date,
): boolean {
  if (state.changedAt.getTime() >= monthEnd.getTime()) return !state.funded;
  if (state.changedAt.getTime() >= monthStart.getTime()) return true;
  return state.funded;
}
