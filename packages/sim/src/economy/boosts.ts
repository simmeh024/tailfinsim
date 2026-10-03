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

import {
  BOOST_SOURCES,
  type BoostSource,
  ECONOMY_CONFIG_V1,
  EFFICIENCY_QUANTITIES,
  type EfficiencyQuantity,
} from '@tailfin/shared';

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
/**
 * The ceilings from §10.4.
 *
 * The numbers live in `ECONOMY_CONFIG_V1.boosts.ceilings` in `@tailfin/shared`,
 * with everything else an admin can retune (M3-11, §22.3) — §22.3 names *"boost
 * ceilings"* on its own list. Here as the default parameter for the pure
 * functions below; the server reads the world's pinned config instead.
 */
export const EFFICIENCY_CEILINGS = ECONOMY_CONFIG_V1.boosts.ceilings;

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

// ---------------------------------------------------------------------------
// The central resolver (M9-06)
// ---------------------------------------------------------------------------

/** Unstacked boosts, by §10.4 quantity. A source hands one of these over. */
export type BoostsByQuantity = Record<EfficiencyQuantity, EfficiencyBoost[]>;

/** One source's contribution. A quantity it does not touch may be left out. */
export type SourceBoosts = Partial<Record<EfficiencyQuantity, readonly EfficiencyBoost[]>>;

/** No boosts on any quantity. */
export function emptyBoosts(): BoostsByQuantity {
  return {
    fuelBurn: [],
    turnaroundTime: [],
    blockTime: [],
    maintenanceCost: [],
    incidentRate: [],
    serviceCost: [],
  };
}

/** A quantity once every source has been stacked and the ceiling applied. */
export interface ResolvedEfficiency extends StackedBoosts {
  quantity: EfficiencyQuantity;
  /** The world's ceiling for this quantity. */
  ceiling: number;
  /** Every source stacked multiplicatively, before the ceiling. */
  uncapped: number;
  /** Each source's own stack, alone and before the ceiling, for the readout. */
  bySource: Record<BoostSource, number>;
  /** Every boost that went in, for anything that wants to itemise them. */
  boosts: readonly EfficiencyBoost[];
}

export type ResolvedBoosts = Record<EfficiencyQuantity, ResolvedEfficiency>;

/**
 * Every source of §10.4 efficiency an airline holds, combined once.
 *
 * §10.4's first rule — *"Stacking academy + research + personal skill +
 * Training Captain never exceeds the ceiling. Diminishing returns before the
 * cap."* — applied in one place to every source at once. Stacking each source
 * against the ceiling separately and then adding the results would let three
 * sources each reach the cap and sum past it; that is the failure this function
 * exists to make impossible, and the property test beside it hunts for.
 *
 * The academy is not a source here, by §10's own core rule — see `BoostSource`.
 *
 * `ceilings` is the world's own `EconomyConfig.boosts.ceilings`, so a retune
 * moves the cap without a deploy.
 */
export function resolveEfficiencyBoosts(
  sources: Partial<Record<BoostSource, SourceBoosts>>,
  ceilings: Record<EfficiencyQuantity, number> = EFFICIENCY_CEILINGS,
): ResolvedBoosts {
  const resolved = {} as ResolvedBoosts;

  for (const quantity of EFFICIENCY_QUANTITIES) {
    const bySource = {} as Record<BoostSource, number>;
    const all: EfficiencyBoost[] = [];

    for (const source of BOOST_SOURCES) {
      const own = sources[source]?.[quantity] ?? [];
      // Alone and uncapped: what this source would be worth with nothing else
      // held. A ceiling of 1 cannot clip a stack, which is always below 1.
      bySource[source] = stackEfficiencyBoosts(own, 1).fraction;
      all.push(...own);
    }

    const ceiling = ceilings[quantity];
    const uncapped = stackEfficiencyBoosts(all, 1).fraction;
    const stacked = stackEfficiencyBoosts(all, ceiling);
    resolved[quantity] = { quantity, ceiling, uncapped, bySource, boosts: all, ...stacked };
  }

  return resolved;
}

/**
 * The resolved fraction as the single boost a consumer should apply.
 *
 * `computeFuelBurn`, `computeBlockTime`, `turnaroundMinutes` and
 * `rollDisruption` all take an `EfficiencyBoost[]` and stack it themselves.
 * Handing them the resolved figure as one boost means they apply exactly what
 * the resolver decided, rather than re-stacking the raw list against whatever
 * ceiling they were written with.
 */
export function appliedBoosts(resolved: ResolvedEfficiency): EfficiencyBoost[] {
  return resolved.fraction > 0
    ? [{ id: `resolved:${resolved.quantity}`, fraction: resolved.fraction }]
    : [];
}
