import type { AirportTier, HandlerGrade } from '@tailfin/shared';

/**
 * Ground handling — what a vendor at a station is, and what it does (M5-06, §9.3).
 *
 * §9.3 makes ground services the shared-world layer: at every airport a service
 * is either self-handled or contracted to a vendor, and each vendor trades on
 * five numbers — *price · reliability · speed · quality · capacity*. This module
 * owns the **operational** half of that trade: how good a handler is and what
 * that costs the operation. Price in real money and finite capacity are the data
 * and economy layers' (they are per-station facts, not properties of a grade);
 * what a grade *is* — how often it fumbles a turn, how long it takes, how well it
 * does the job — lives here as balance, like the turnaround and disruption
 * models rather than the economy config.
 *
 * ## Grades, not a free-form slider
 *
 * A station's vendors come in three grades — **budget · standard · premium** —
 * because §9.3's whole point is a legible trade the player can diagnose: *"cheap
 * ramp handlers = slower turns and more mishandled bags = OTP and reputation
 * damage."* A grade is a named bundle of that trade, so a player choosing the
 * cheap handler is choosing the slow, fumble-prone one on purpose, and can read
 * why an on-time figure slipped back to the one station that runs a budget ramp.
 *
 * ## What reads this, and what does not yet
 *
 * `speedFactor` is the multiplier the turnaround model already takes
 * (`flight/turnaround.ts`); `reliability` becomes the `DisruptionRisk.groundVendor`
 * input that M2-08 reserved and M5-05's loop can now carry, via
 * {@link groundVendorRisk}. `quality` is the satisfaction lever, and its consumer
 * — an OTP/satisfaction model — is not built, so it is defined and carried but
 * not yet read, exactly as the disruption risk inputs were before their systems
 * landed.
 */

/** The operational profile of a grade: what it does, and the relative price of it. */
export interface HandlerGradeProfile {
  /**
   * The probability a turn goes cleanly, 0–1. Its complement is what feeds the
   * disruption roll — a budget handler fumbles more turns into delays and
   * mishandled bags than a premium one does.
   */
  reliability: number;
  /**
   * Turnaround multiplier for the turnaround model. 1 is the contracted norm;
   * above 1 is a handler taking longer than it should; below 1 is one that beats
   * it. §9.3: *"cheap ramp handlers = slower turns."*
   */
  speedFactor: number;
  /**
   * Product/satisfaction effect, 0–1 — how well the job is actually done. The
   * lever §9.3 links to the cabin builder; its consumer is not built yet.
   */
  quality: number;
  /**
   * Relative cost index against the standard grade (1.0). The absolute price is a
   * per-station fact for the economy/data layer; this is only the shape of the
   * trade — premium costs more, budget less.
   */
  priceIndex: number;
}

export interface GroundHandlingConfig {
  grades: Record<HandlerGrade, HandlerGradeProfile>;
  /**
   * Base contract capacity per grade at each airport tier — how many airlines a
   * vendor of that grade will take before it is full. `0` means the grade is not
   * offered at that tier by default: a regional strip has no premium handler.
   *
   * The scarcity is the competition §9.3 wants — the good handler at a busy hub
   * has few slots, so airlines contend for it. Premium capacity stays low even at
   * a flagship for exactly that reason.
   */
  stationCapacity: Record<AirportTier, Record<HandlerGrade, number>>;
  /**
   * How long a signed contract runs, in **game days** (§9.3: *"Contracts run for a
   * fixed term"*). A span in the world's own calendar, like a maintenance
   * downtime or a crew conversion — a world at 4× renews its handlers twice as
   * often in real time as one at 2× — which is why it is balance here rather than
   * a real-week deadline like a factory delivery.
   */
  termDays: number;
  /**
   * How many game days before a term ends a contract is flagged **expiring**, so
   * §9.3's *"players compete for the good handlers"* stays true across a renewal:
   * the alert lands with enough runway to re-sign, or contend for, the slot before
   * it lapses back to walk-up handling.
   */
  expiryWarningDays: number;
  /** What handling it yourself achieves, staffed and unstaffed. */
  selfHandling: SelfHandlingBalance;
}

/**
 * Balance (CONTRIBUTING invariant 3), sim-owned like the turnaround and
 * disruption models — §22.3's admin can retune it against a snapshot. The spread
 * is calibrated to make the trade legible rather than to a published figure:
 * budget fumbles roughly three times as many turns as premium and takes a fifth
 * longer, for two-thirds of the price.
 */
export const DEFAULT_GROUND_HANDLING: GroundHandlingConfig = {
  grades: {
    budget: { reliability: 0.85, speedFactor: 1.2, quality: 0.5, priceIndex: 0.7 },
    standard: { reliability: 0.95, speedFactor: 1.0, quality: 0.75, priceIndex: 1.0 },
    premium: { reliability: 0.99, speedFactor: 0.9, quality: 0.95, priceIndex: 1.5 },
  },
  stationCapacity: {
    flagship: { premium: 4, standard: 10, budget: 16 },
    large: { premium: 3, standard: 8, budget: 12 },
    medium: { premium: 1, standard: 5, budget: 8 },
    small: { premium: 0, standard: 2, budget: 4 },
    regional: { premium: 0, standard: 0, budget: 2 },
  },
  // A season-length term with a fortnight's warning: long enough that signing is a
  // commitment rather than a per-flight choice, short enough that a scarce vendor
  // changes hands and the market stays contested.
  termDays: 90,
  expiryWarningDays: 14,
  /*
   * A fully staffed operation of your own lands just short of the premium
   * contractor, and that gap is deliberate: a specialist handler runs ramps for a
   * living and you do not, so the *reason* to self-handle is the cost curve and
   * the control, never a better number than money can buy. An unstaffed one is
   * well below budget, which is what makes understaffing a decision with a
   * consequence rather than a free saving.
   */
  selfHandling: {
    staffed: { reliability: 0.985, speedFactor: 0.92, quality: 0.9 },
    unstaffed: { reliability: 0.7, speedFactor: 1.45, quality: 0.3 },
  },
};

/** Game milliseconds in a day, for the term arithmetic. */
const MS_PER_DAY = 86_400_000;

/** Version tag, mirroring the turnaround and disruption configs (invariant 4). */
export const GROUND_HANDLING_CONFIG_VERSION = 'v1' as const;

/** The profile for a grade, from a config. */
export function handlerProfile(
  grade: HandlerGrade,
  config: GroundHandlingConfig = DEFAULT_GROUND_HANDLING,
): HandlerGradeProfile {
  return config.grades[grade];
}

/**
 * The `DisruptionRisk.groundVendor` input a handler contributes, 0–1.
 *
 * The complement of reliability: a handler that gets 85% of turns cleanly away
 * carries a 0.15 ground-vendor hazard into the disruption roll, a premium one at
 * 99% carries 0.01. This is the first real value that input has had — it was 0
 * until a handler existed to supply it.
 *
 * Takes only the field it reads, so it prices a grade, an operation of the
 * airline's own at whatever staffing it is running, and walk-up handling, from
 * one function — `handlingProfile` produces all three and none of them agree
 * about what a `priceIndex` would mean.
 */
export function groundVendorRisk(profile: Pick<HandlerGradeProfile, 'reliability'>): number {
  return Math.min(1, Math.max(0, 1 - profile.reliability));
}

/**
 * When a contract signed at `signedAt` (game time) reaches the end of its term.
 *
 * Pure and game-time in, game-time out (CONTRIBUTING invariant 2): the caller
 * hands in the world clock's reading at the moment of signing, so the term is a
 * span in the world's calendar rather than in real weeks.
 */
export function contractTermEnd(
  signedAt: Date,
  config: GroundHandlingConfig = DEFAULT_GROUND_HANDLING,
): Date {
  return new Date(signedAt.getTime() + config.termDays * MS_PER_DAY);
}

/**
 * Whether a contract ending at `termEnd` is close enough to lapsing to warn about.
 *
 * True inside the warning window and also once the term has already passed but the
 * contract has not yet been swept out — an overdue handler is at least as worth
 * flagging as one about to expire. A `null` term (a legacy row signed before terms
 * existed) never expires, so it is never expiring.
 */
export function contractExpiring(
  termEnd: Date | null,
  gameNow: Date,
  config: GroundHandlingConfig = DEFAULT_GROUND_HANDLING,
): boolean {
  if (termEnd === null) return false;
  return termEnd.getTime() - gameNow.getTime() <= config.expiryWarningDays * MS_PER_DAY;
}

// ---------------------------------------------------------------------------
// Self-handling, and the money side of a contract (M5-06, §9.3)
// ---------------------------------------------------------------------------

/**
 * The operational profile self-handling delivers, at the two ends of staffing.
 *
 * Balance, and sim-owned like the grades for the same reason: what a ground
 * operation *is* at a given staffing level is behaviour, not money. What the
 * heads cost is `EconomyConfig.ground.selfHandling`.
 */
export interface SelfHandlingBalance {
  /** What a fully staffed operation of your own achieves. */
  staffed: Omit<HandlerGradeProfile, 'priceIndex'>;
  /** What one with nobody in it achieves. Worse than the budget vendor. */
  unstaffed: Omit<HandlerGradeProfile, 'priceIndex'>;
}

/** What self-handling is achieving at a station right now. */
export interface SelfHandlingProfile extends Omit<HandlerGradeProfile, 'priceIndex'> {
  /**
   * Heads employed over heads the station needs, clamped to 1.
   *
   * Clamped rather than uncapped, so over-hiring buys nothing: §10.4's rule that
   * an edge must be *"a real edge that a smarter network plan can beat"* rather
   * than a moat applies here too — a player with money should not be able to buy
   * past a premium contractor by simply hiring twice as many people.
   */
  staffing: number;
}

/**
 * What an airline's handling at a station actually is, for the models to read.
 *
 * Three states, and they are genuinely different rather than three grades: a
 * **vendor** contract is a grade, **self-handling** is a staffing level, and
 * **walk-up** is what an airline has when it has arranged nothing at all. The
 * models that care — turnaround speed, disruption risk, the settlement's
 * handling line — each read this rather than each rediscovering the three cases.
 */
export type HandlingArrangement =
  | { kind: 'vendor'; grade: HandlerGrade }
  | { kind: 'self'; headcount: number; requiredHeadcount: number }
  | { kind: 'walk_up' };

/**
 * The operational profile an arrangement delivers.
 *
 * Walk-up reads as **budget**, which is not a shortcut: `disruption.ts` has said
 * since M5-06's first PR that an airline with no contract *"scrambles the bags
 * itself, at budget-grade reliability"*, and the point of this function is that
 * there is now one place saying so.
 */
export function handlingProfile(
  arrangement: HandlingArrangement,
  config: GroundHandlingConfig = DEFAULT_GROUND_HANDLING,
): Omit<HandlerGradeProfile, 'priceIndex'> {
  switch (arrangement.kind) {
    case 'vendor':
      return config.grades[arrangement.grade];
    case 'self':
      return selfHandlingProfile(
        arrangement.headcount,
        arrangement.requiredHeadcount,
        config.selfHandling,
      );
    case 'walk_up':
      return config.grades.budget;
  }
}

/**
 * What self-handling achieves at a given headcount.
 *
 * Linear between `unstaffed` and `staffed` across the ratio of heads employed to
 * heads the station needs. Linear rather than a curve because the interesting
 * property is that it is **monotonic and legible**: every head hired makes the
 * handling measurably better until the station is staffed, and a player cutting
 * heads to save payroll can read the consequence off the same scale they read a
 * vendor grade off.
 *
 * A required headcount of zero or less would make the ratio meaningless, so it is
 * treated as fully staffed — a station that needs nobody is handled by nobody,
 * perfectly.
 */
export function selfHandlingProfile(
  headcount: number,
  requiredHeadcount: number,
  balance: SelfHandlingBalance = DEFAULT_GROUND_HANDLING.selfHandling,
): SelfHandlingProfile {
  const staffing =
    requiredHeadcount <= 0 ? 1 : Math.min(1, Math.max(0, headcount / requiredHeadcount));
  const between = (from: number, to: number): number => from + (to - from) * staffing;
  return {
    staffing,
    reliability: between(balance.unstaffed.reliability, balance.staffed.reliability),
    speedFactor: between(balance.unstaffed.speedFactor, balance.staffed.speedFactor),
    quality: between(balance.unstaffed.quality, balance.staffed.quality),
  };
}

/** The money terms an arrangement's per-turn price needs from the economy. */
export interface HandlingPriceBalance {
  walkUpPriceIndex: number;
  selfHandlingTurnPriceIndex: number;
}

/**
 * What to multiply a turn's handling cost by, given how it is being handled.
 *
 * The **fifth** of §9.3's five vendor numbers, and the one that was missing.
 * Until M5-06's price landed, a grade changed the speed and the reliability of a
 * turn and not its cost — so the budget handler was slower and clumsier for
 * exactly the same money, and no player would ever have chosen one. The trade
 * only exists because this multiplier does.
 *
 * A vendor's multiplier is its grade's `priceIndex`, which is sim balance because
 * it is the *shape* of the trade; walk-up's and self-handling's are the economy's,
 * because they are not a property of any grade. Both halves are retunable and
 * neither is a literal.
 */
export function handlingPriceFactor(
  arrangement: HandlingArrangement,
  money: HandlingPriceBalance,
  config: GroundHandlingConfig = DEFAULT_GROUND_HANDLING,
): number {
  switch (arrangement.kind) {
    case 'vendor':
      return config.grades[arrangement.grade].priceIndex;
    case 'self':
      return money.selfHandlingTurnPriceIndex;
    case 'walk_up':
      return money.walkUpPriceIndex;
  }
}

/**
 * How much of a term has been served at `gameNow`, 0–1.
 *
 * The one piece of arithmetic both money consequences share. The early-exit
 * penalty is charged on what is **left** (`1 - elapsed`), so walking away on the
 * last day is nearly free and walking away on the first costs the lot; the volume
 * commitment on an early exit is pro-rated to what has been **served**, so
 * terminating cannot be used to escape a shortfall the airline has already run
 * up.
 *
 * Clamped at both ends and defensive about a degenerate term: a start at or after
 * its end reads as fully served, which makes a broken row cost nothing to leave
 * rather than charging a full penalty on arithmetic nobody can check.
 */
export function elapsedTermFraction(termStart: Date, termEnd: Date, gameNow: Date): number {
  const span = termEnd.getTime() - termStart.getTime();
  if (!Number.isFinite(span) || span <= 0) return 1;
  const served = (gameNow.getTime() - termStart.getTime()) / span;
  if (!Number.isFinite(served)) return 1;
  return Math.min(1, Math.max(0, served));
}

/**
 * The departures a contract commits to over its whole term.
 *
 * Per-day balance × the term's length, so retuning `termDays` moves the
 * commitment with it rather than silently changing what a day of it is worth.
 */
export function committedDepartures(
  perDay: number,
  config: GroundHandlingConfig = DEFAULT_GROUND_HANDLING,
): number {
  return Math.max(0, Math.round(perDay * config.termDays));
}
