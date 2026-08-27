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

/** The service lines a station's ground work divides into (§9.3). */
export const GROUND_SERVICE_LINES = [
  'ramp_baggage',
  'fuelling',
  'catering',
  'cleaning',
  'pushback',
  'deicing',
] as const;
export type GroundServiceLine = (typeof GROUND_SERVICE_LINES)[number];

/** A handler's quality tier — the named bundle of §9.3's trade. */
export type HandlerGrade = 'budget' | 'standard' | 'premium';
export const HANDLER_GRADES: readonly HandlerGrade[] = ['budget', 'standard', 'premium'];

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
};

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
 */
export function groundVendorRisk(profile: HandlerGradeProfile): number {
  return Math.min(1, Math.max(0, 1 - profile.reliability));
}
