/**
 * Maintenance — §7.3 (M4-06).
 *
 * §7.3 is two bullets, and §24 lists maintenance as **MVP-blocking** with those
 * two bullets against it. So the shape here is derived from the two sentences the
 * design does give, and every number lives in `EconomyConfig.maintenance`:
 *
 *   1. *"Flight hours and cycles accumulate; A/C/D-check tiers with escalating
 *      downtime."*
 *   2. *"Skipped maintenance → reliability decay → delays and cancellations →
 *      reputation damage."*
 *
 * The first is a due calculation. The second is a number M2-08 already reserved a
 * slot for: `DisruptionRisk.technical`, documented there as *"the inverse of
 * condition: a new aircraft fresh from a C-check is near 0, one overdue for
 * maintenance approaches 1. M4-06 owns what moves it."* This module is what moves
 * it, and nothing else in the codebase writes that field.
 *
 * ## Two intervals, whichever comes first
 *
 * Every tier has an hour limit and a cycle limit. That is the single decision
 * that makes types feel different to operate: a regional turboprop flying eight
 * short sectors a day hits its **cycle** limit long before its hours, and a ULH
 * widebody hits its **hours** long before its cycles. One interval would have
 * made every aeroplane the same shape of problem, and would have wasted the
 * cycles figure the used market already generates.
 *
 * ## What deliberately is not here
 *
 * **Unscheduled AOG.** Real groundings are mostly a failed part or a bird strike,
 * and §24 lists *"Safety, incidents & insurance"* as its own unaddressed area
 * with no incident definition, severity ladder or investigation. Inventing one
 * here would be answering that milestone's question. So the only grounding in
 * M4-06 is *"you deferred this check past the limit"* — a decision the player
 * made, and one they can reverse.
 *
 * **Facilities and outsourced slots.** The issue mentions both; App. B.5 turns out
 * to be hubs, and hangar facilities are named in §24's debt list. A check
 * therefore costs money and takes time, and *where* it happens is left to whoever
 * specifies hangars.
 */

import { type EconomyConfig, type MaintenanceProfile, ECONOMY_CONFIG_V1 } from '@tailfin/shared';

export type MaintenanceBalance = EconomyConfig['maintenance'];

/** The shipped slice, for tests and callers without a world in hand. */
export const DEFAULT_MAINTENANCE: MaintenanceBalance = ECONOMY_CONFIG_V1.maintenance;

/** §7.3's three tiers, lightest first. */
export const CHECK_TIERS = ['a', 'c', 'd'] as const;
export type CheckTier = (typeof CHECK_TIERS)[number];

/**
 * How much an airframe has flown, and when each tier last happened.
 *
 * Counted in cumulative hours and cycles rather than in dates, because that is
 * what a maintenance programme actually counts, and because it makes the whole
 * calculation independent of the world clock — an airframe parked for a game year
 * is no closer to its next check, which is correct.
 */
export interface MaintenanceState {
  totalHours: number;
  totalCycles: number;
  /** Cumulative hours at the last completion of each tier. */
  hoursAtLastCheck: Record<CheckTier, number>;
  /** Cumulative cycles at the last completion of each tier. */
  cyclesAtLastCheck: Record<CheckTier, number>;
}

/** A fresh airframe: nothing flown, every tier notionally just done. */
export const NEW_AIRFRAME_STATE: MaintenanceState = {
  totalHours: 0,
  totalCycles: 0,
  hoursAtLastCheck: { a: 0, c: 0, d: 0 },
  cyclesAtLastCheck: { a: 0, c: 0, d: 0 },
};

// ---------------------------------------------------------------------------
// What is due
// ---------------------------------------------------------------------------

/** Where one tier stands. */
export interface TierStatus {
  tier: CheckTier;
  /** Hours flown since this tier was last completed. */
  hoursSince: number;
  cyclesSince: number;
  /** Hours left before it falls due; negative once overdue. */
  hoursRemaining: number;
  cyclesRemaining: number;
  /**
   * Which limit is binding, and therefore what the player should watch.
   *
   * The interesting output rather than a detail: *"your ATR is 200 cycles from an
   * A-check"* is actionable in a way *"your ATR needs an A-check soonish"* is
   * not.
   */
  binding: 'hours' | 'cycles';
  /** `0` when fresh, `1` at the limit, above `1` once overdue. */
  usedFraction: number;
  due: boolean;
  /** How far past the limit, as a multiple of the interval. `0` when not overdue. */
  overdueMultiple: number;
}

function tierStatus(
  tier: CheckTier,
  state: MaintenanceState,
  programme: MaintenanceBalance['programmes'][MaintenanceProfile],
): TierStatus {
  const limits = programme[tier];
  const hoursSince = Math.max(0, state.totalHours - state.hoursAtLastCheck[tier]);
  const cyclesSince = Math.max(0, state.totalCycles - state.cyclesAtLastCheck[tier]);

  const hoursFraction = hoursSince / limits.intervalHours;
  const cyclesFraction = cyclesSince / limits.intervalCycles;

  // Whichever limit is closer decides. Ties go to hours, arbitrarily but
  // consistently — a tie means both are binding and either answer is true.
  const binding = cyclesFraction > hoursFraction ? 'cycles' : 'hours';
  const usedFraction = Math.max(hoursFraction, cyclesFraction);

  return {
    tier,
    hoursSince,
    cyclesSince,
    hoursRemaining: limits.intervalHours - hoursSince,
    cyclesRemaining: limits.intervalCycles - cyclesSince,
    binding,
    usedFraction,
    due: usedFraction >= 1,
    overdueMultiple: Math.max(0, usedFraction - 1),
  };
}

/** Whether the airframe is legal to fly, and why not. */
export type Airworthiness =
  | { airworthy: true }
  | { airworthy: false; reason: 'grounded_overdue'; tier: CheckTier; overdueMultiple: number };

export interface MaintenanceStatus {
  tiers: Record<CheckTier, TierStatus>;
  /** Tiers currently due or overdue, heaviest first — the order to do them in. */
  dueTiers: readonly CheckTier[];
  /** The technical-fault probability this airframe contributes to a flight. */
  technicalRisk: number;
  airworthiness: Airworthiness;
}

/**
 * Everything the game needs to know about one airframe's condition.
 *
 * One call, because every consumer wants more than one of these answers and
 * computing them separately is how the due timeline and the disruption roll end
 * up disagreeing about the same aeroplane.
 */
export function maintenanceStatus(
  state: MaintenanceState,
  profile: MaintenanceProfile,
  balance: MaintenanceBalance = DEFAULT_MAINTENANCE,
): MaintenanceStatus {
  const programme = balance.programmes[profile];
  const tiers = {
    a: tierStatus('a', state, programme),
    c: tierStatus('c', state, programme),
    d: tierStatus('d', state, programme),
  };

  // Heaviest first: a D-check subsumes the lighter work, so an operator facing
  // both should be told about the D.
  const dueTiers = ([...CHECK_TIERS] as CheckTier[]).filter((tier) => tiers[tier].due).reverse();

  return {
    tiers,
    dueTiers,
    technicalRisk: technicalRisk(tiers, balance),
    airworthiness: airworthiness(tiers, balance),
  };
}

/**
 * §7.3's *"skipped maintenance → reliability decay"*, as the 0–1 number M2-08
 * reserved.
 *
 * The baseline is what a perfectly maintained aeroplane still carries. Each
 * overdue tier adds its own penalty, **ramped over hours rather than applied as a
 * step** — a step would make a deferred check either free or catastrophic with
 * nothing in between, and the acceptance criterion asks for a rise a player can
 * measure over a few game weeks.
 *
 * Tiers add rather than max, because deferring all three is genuinely worse than
 * deferring the D alone. The total is capped: §7.2b's *"uneconomic before it
 * becomes illegal"* applies here too, and grounding — not a probability creeping
 * toward 1 — is what eventually stops the aeroplane.
 */
export function technicalRisk(
  tiers: Record<CheckTier, TierStatus>,
  balance: MaintenanceBalance = DEFAULT_MAINTENANCE,
): number {
  const { baselineRisk, overdueRisk, overdueRampHours, maxRisk } = balance.reliability;

  let risk = baselineRisk;
  for (const tier of CHECK_TIERS) {
    const status = tiers[tier];
    if (!status.due) continue;
    // Hours past the limit, ramped to 1 over `overdueRampHours`. Measured in
    // hours even when cycles were the binding limit: the ramp is about how long
    // the aeroplane has been flown in a deteriorating state, and hours are the
    // honest measure of that.
    const hoursOverdue = Math.max(0, -status.hoursRemaining);
    const ramp = Math.min(1, hoursOverdue / overdueRampHours);
    risk += overdueRisk[tier] * ramp;
  }

  return Math.min(maxRisk, risk);
}

/**
 * Whether this airframe may fly at all.
 *
 * The only grounding M4-06 has, and it is entirely self-inflicted: fly past
 * `groundingOverdueMultiple` times a check's interval and the aeroplane stops.
 * Unscheduled AOG belongs to §24's incident work — see the module note.
 *
 * Reported heaviest-tier-first so the message names the most serious problem
 * rather than whichever tier happens to be checked first.
 */
export function airworthiness(
  tiers: Record<CheckTier, TierStatus>,
  balance: MaintenanceBalance = DEFAULT_MAINTENANCE,
): Airworthiness {
  const limit = balance.groundingOverdueMultiple;
  for (const tier of [...CHECK_TIERS].reverse()) {
    const status = tiers[tier];
    if (status.usedFraction >= limit) {
      return {
        airworthy: false,
        reason: 'grounded_overdue',
        tier,
        overdueMultiple: status.overdueMultiple,
      };
    }
  }
  return { airworthy: true };
}

// ---------------------------------------------------------------------------
// Accrual and completion
// ---------------------------------------------------------------------------

/**
 * Add one completed flight to an airframe's totals.
 *
 * One flight is one cycle, by definition. Hours are block hours, which is what
 * `flight_result.block_seconds` already records — so the accrual reads the number
 * the settlement already computed rather than recomputing block time and risking
 * a second answer.
 */
export function accrueFlight(state: MaintenanceState, blockHours: number): MaintenanceState {
  if (!Number.isFinite(blockHours) || blockHours < 0) {
    throw new Error(`Block hours must be a non-negative number, got ${String(blockHours)}`);
  }
  return {
    ...state,
    totalHours: state.totalHours + blockHours,
    totalCycles: state.totalCycles + 1,
  };
}

/**
 * Mark a tier complete, and the lighter tiers with it.
 *
 * A C-check includes the A-check work and a D-check includes both. Not modelling
 * that would have a player emerge from a five-week D-check with an A-check
 * immediately due, which is wrong about aeroplanes and would read as a bug.
 */
export function completeCheck(state: MaintenanceState, tier: CheckTier): MaintenanceState {
  const index = CHECK_TIERS.indexOf(tier);
  const covered = CHECK_TIERS.slice(0, index + 1);

  const hoursAtLastCheck = { ...state.hoursAtLastCheck };
  const cyclesAtLastCheck = { ...state.cyclesAtLastCheck };
  for (const done of covered) {
    hoursAtLastCheck[done] = state.totalHours;
    cyclesAtLastCheck[done] = state.totalCycles;
  }

  return { ...state, hoursAtLastCheck, cyclesAtLastCheck };
}

/** What a check costs and how long it takes the aeroplane out of service. */
export function checkTerms(
  tier: CheckTier,
  profile: MaintenanceProfile,
  balance: MaintenanceBalance = DEFAULT_MAINTENANCE,
): { costMinor: number; downtimeDays: number } {
  const limits = balance.programmes[profile][tier];
  return { costMinor: limits.costMinor, downtimeDays: limits.downtimeDays };
}

/**
 * A used airframe's plausible maintenance history.
 *
 * A twelve-year-old aeroplane from the used market has flown 30,000 hours, and
 * pretending every tier was completed at hour zero would show it as catastrophically
 * overdue on arrival — grounded before its first flight, for its previous owner's
 * imagined neglect. The honest reading is that a flying aeroplane was being
 * maintained: each tier was last done somewhere inside its own interval.
 *
 * `position` is where in each interval to place it, `0` being just-completed and
 * approaching `1` being nearly due. Deterministic in its caller's hands rather
 * than drawn here, so a listing's condition is as replayable as the rest of it.
 */
export function inferredHistory(
  totalHours: number,
  totalCycles: number,
  profile: MaintenanceProfile,
  position: Record<CheckTier, number>,
  balance: MaintenanceBalance = DEFAULT_MAINTENANCE,
): MaintenanceState {
  const programme = balance.programmes[profile];
  const hoursAtLastCheck = { a: 0, c: 0, d: 0 };
  const cyclesAtLastCheck = { a: 0, c: 0, d: 0 };

  for (const tier of CHECK_TIERS) {
    const clamped = Math.min(0.95, Math.max(0, position[tier]));
    const hoursInto = programme[tier].intervalHours * clamped;
    const cyclesInto = programme[tier].intervalCycles * clamped;
    // Never negative: an airframe younger than one interval has genuinely only
    // ever been checked at hour zero, and that is not overdue.
    hoursAtLastCheck[tier] = Math.max(0, totalHours - hoursInto);
    cyclesAtLastCheck[tier] = Math.max(0, totalCycles - cyclesInto);
  }

  return { totalHours, totalCycles, hoursAtLastCheck, cyclesAtLastCheck };
}
