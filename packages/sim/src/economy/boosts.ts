/**
 * §10.4's efficiency boosts, and the ceilings they may never pass.
 *
 * M2-04 needed this for turnaround and M2-05 needs it twice more, for fuel burn
 * and block time. Three copies of the same stacking rule would be three chances
 * for one of them to drift past a ceiling the design doc calls **non-negotiable**,
 * so it lives here once.
 *
 * ## What a boost may and may not do
 *
 * §10.4 is unusually firm: *"Boosts are **operational efficiency**, never demand
 * or money directly. They make you cheaper and faster, not more popular."* So
 * everything in this module reduces a **cost or a duration**, and nothing here
 * may ever be wired to demand capture, price tolerance or reputation.
 *
 * ## Why the ceilings exist
 *
 * Not for realism — for the shared world. §10.4 says why in a sentence worth
 * keeping in front of anyone tempted to raise one: *"a year-one player must
 * never face an unbeatable wall of stacked veteran bonuses. −8% fuel is a real
 * edge that a smarter network plan can beat. −40% would be a moat, and moats
 * kill persistent multiplayer games."*
 */

/**
 * One boost from a research node, an academy doctrine, a Head of Ground Ops or a
 * Training Captain (§10.1–§10.4). `fraction` is the share of the quantity it
 * removes, before stacking.
 */
export interface EfficiencyBoost {
  id: string;
  /** 0.05 removes five percent. */
  fraction: number;
}

/**
 * The ceilings from §10.4, verbatim.
 *
 * Here rather than scattered across the modules that apply them, so a change to
 * the table is a change in one place and a reviewer can see all six at once.
 */
export const EFFICIENCY_CEILINGS = {
  /** −8%. */
  fuelBurn: 0.08,
  /** −20%. */
  turnaroundTime: 0.2,
  /** −4%. Taxi and routing efficiency; it does not make the aircraft fly faster. */
  blockTime: 0.04,
  /** −12%. */
  maintenanceCost: 0.12,
  /** −30%. */
  incidentRate: 0.3,
  /** −15%. */
  serviceCost: 0.15,
} as const;

export interface StackedBoosts {
  /** The reduction actually applied, 0–1, after diminishing returns and the cap. */
  fraction: number;
  /** Whether the ceiling clipped it. A further boost of this kind buys nothing. */
  capped: boolean;
}

/**
 * Combine boosts and clamp them to a ceiling.
 *
 * Combined **multiplicatively**, which is diminishing returns by construction:
 * two 10% boosts give 19%, not 20%. §10.4 asks for exactly that — *"diminishing
 * returns before the cap"* — and then for a hard ceiling, which is the clamp.
 *
 * An asymptotic curve approaching the cap without reaching it was the obvious
 * alternative and is worse: it charges the *first* boost most heavily, so a
 * player's first node in a branch feels broken. Multiplicative stacking keeps a
 * lone boost worth its face value and only bites once several are held.
 */
export function stackEfficiencyBoosts(
  boosts: readonly EfficiencyBoost[],
  ceiling: number,
): StackedBoosts {
  if (!Number.isFinite(ceiling) || ceiling < 0) {
    throw new Error(`Ceiling must be zero or more, got ${String(ceiling)}`);
  }

  let remaining = 1;
  for (const boost of boosts) {
    if (!Number.isFinite(boost.fraction)) {
      throw new Error(`Boost ${boost.id} must be a finite number, got ${String(boost.fraction)}`);
    }
    if (boost.fraction < 0 || boost.fraction >= 1) {
      throw new Error(
        `Boost ${boost.id} must remove between 0% and 100%, got ${String(boost.fraction)}`,
      );
    }
    remaining *= 1 - boost.fraction;
  }

  const combined = 1 - remaining;
  const capped = combined > ceiling;
  return { fraction: capped ? ceiling : combined, capped };
}
