import type { ServiceExecutionBalance } from '@tailfin/shared';

/**
 * Service execution — where inside its band a tier actually lands (M8-04, App. D.1).
 *
 * M8-03 built the ladder and left `execution` as a 0–1 input on purpose. This is
 * that input, and App. D.1 defines it:
 *
 * ```
 * Execution = f( crew service skill (§10.2) · crew morale (§9.2)
 *              · catering vendor quality (§9.3) · crew-to-passenger ratio )
 * ```
 *
 * > **The weakest input dominates.** Chef-designed catering served by an
 * > exhausted, understaffed crew lands at the bottom of Tier 5 — you paid €78 a
 * > head for 0.85 when you could have had 1.00. That's the most expensive
 * > mistake in the catalogue and it's entirely self-inflicted.
 *
 * ## Weakest-link, not average
 *
 * An average would let a superb crew paper over a budget caterer, which is
 * precisely the outcome the appendix rules out. So the result is a blend pulled
 * hard toward the **minimum**: `w·min + (1−w)·mean`, with `w` in the economy
 * config and set high. The mean still appears because a pure minimum would make
 * every other input worthless once one of them was low — an airline with one
 * weak link would have no reason to fix anything else, which is a dead end
 * rather than a trade.
 *
 * ## An input with no source is absent, not zero
 *
 * Two of App. D.1's four inputs have no source in the game yet:
 *
 * - **Crew service skill** is §10.2's training academy, which is M10.
 * - **Crew-to-passenger ratio** needs a flight's actual carried load beside its
 *   actual cabin crew; a caller that has both passes it, and a configurator
 *   previewing a package has neither.
 *
 * They arrive as `null`, and a null input is **left out of both the minimum and
 * the mean** rather than counted as 0 or as 1. Counting a missing academy as 0
 * would peg every airline in the game at its band floor for a system nobody can
 * use yet; counting it as 1 would quietly flatter everyone. Leaving it out means
 * an unbuilt system does not move the number, which is the only honest reading —
 * and when M10 lands it starts moving without anything else changing.
 *
 * With no inputs at all, {@link ServiceExecutionBalance.fallback} answers. That
 * is a named reference in the sense `REFERENCE_SELF` and
 * `REFERENCE_HANDLING_PRICE_FACTOR` already use in this repository: a system that
 * does not exist yet arrives as a reference rather than as a stub.
 *
 * ## Morale arrives already translated
 *
 * `crewMorale` is **not** raw morale. M5-03 built `crew/morale.ts`'s
 * `serviceExecution(morale)` — the tuned map from a base's morale onto its
 * service contribution, between `serviceExecutionAtZero` and
 * `serviceExecutionAtFull` — and left it deliberately unconsumed, saying that a
 * caller who multiplied it into something before M8-04 would have made M8-04's
 * decision for it. This is that decision: the crew function is the translation,
 * and this is the weakest-link rule applied to its output alongside the others.
 * Feeding raw morale here instead would silently use a second, untuned curve.
 */

/** What the four levers are called, in App. D.1's order. */
export const EXECUTION_INPUTS = [
  'crewServiceSkill',
  'crewMorale',
  'vendorQuality',
  'crewToPaxRatio',
] as const;

export type ExecutionInput = (typeof EXECUTION_INPUTS)[number];

/**
 * The levers, each 0–1, each nullable.
 *
 * `crewToPaxRatio` is **already normalised** to 0–1 by the caller: it is the
 * cabin crew actually carried against the crew the cabin is designed for,
 * clamped at 1. A ratio above the design complement is not better service, it is
 * deadheads — so the clamp is the model, not a convenience.
 */
export type ExecutionInputs = Readonly<Partial<Record<ExecutionInput, number | null>>>;

/** One lever's contribution, for the explanation a payback table or tooltip shows. */
export interface ExecutionFactor {
  input: ExecutionInput;
  value: number;
  /** True for the lever that set the floor — the one worth fixing first. */
  weakest: boolean;
}

export interface ExecutionResult {
  /** 0–1, the value `bandPosition` takes. */
  execution: number;
  /** Every lever that had a value, in App. D.1's order. Empty when none did. */
  factors: ExecutionFactor[];
  /** The levers with no source yet — an unbuilt system, not a bad score. */
  absent: ExecutionInput[];
  /** True when nothing could be read and the configured fallback answered. */
  fromFallback: boolean;
}

function unit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * App. D.1's execution multiplier.
 *
 * Deterministic and pure: the same inputs give the same number, which is what
 * lets a `flight_result` be re-derived (invariant 2) and what makes the payback
 * table honest about what a change would buy.
 */
export function serviceExecutionMultiplier(
  balance: ServiceExecutionBalance,
  inputs: ExecutionInputs,
): ExecutionResult {
  const present: { input: ExecutionInput; value: number }[] = [];
  const absent: ExecutionInput[] = [];

  for (const input of EXECUTION_INPUTS) {
    const raw = inputs[input];
    if (raw === undefined || raw === null) {
      absent.push(input);
      continue;
    }
    present.push({ input, value: unit(raw) });
  }

  if (present.length === 0) {
    return {
      execution: unit(balance.fallback),
      factors: [],
      absent,
      fromFallback: true,
    };
  }

  const lowest = present.reduce((low, entry) => Math.min(low, entry.value), 1);
  const mean = present.reduce((sum, entry) => sum + entry.value, 0) / present.length;
  const weight = unit(balance.weakestLinkWeight);
  const execution = unit(weight * lowest + (1 - weight) * mean);

  return {
    execution,
    // Every lever at the floor is marked, not just the first found: two levers
    // tied at the bottom are two things to fix, and naming one would send the
    // player to fix half a problem.
    factors: present.map((entry) => ({ ...entry, weakest: entry.value === lowest })),
    absent,
    fromFallback: false,
  };
}

/**
 * Cabin crew carried against the crew the cabin is designed for, 0–1.
 *
 * Null when the cabin needs nobody — a freighter, or a configuration with no
 * cabin crew requirement — because a ratio with a zero denominator is not a
 * score of 0, it is a question that does not apply. Clamped at 1 above the
 * design complement, for the reason {@link ExecutionInputs} gives.
 */
export function crewToPaxRatio(carried: number, required: number): number | null {
  if (required <= 0) return null;
  return unit(carried / required);
}
