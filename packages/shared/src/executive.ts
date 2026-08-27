import { z } from 'zod';

/**
 * The executive floor and its C-Suite (design §9.1 follow-up).
 *
 * A second headquarters floor, reached by the floor pager on the plan. It is a
 * late-game money sink with two gates stacked: the floor itself unlocks only
 * once the airline is both **rich enough** (a one-off charge) and **earning
 * enough** (a trailing monthly gross-revenue floor), and then each of its ten
 * offices unlocks in turn, right to left, each dearer than the last. The costs
 * are balance numbers — like the seat salaries and the expansion tiers they live
 * here until the office economy moves into the economy config — and every figure
 * is integer **minor units** ($1 = 100), so $100M is 10_000_000_000.
 *
 * Phase 1 builds the floor and the unlocks; the offices stay empty until the
 * C-Suite roster (directors, VPs, presidents) lands.
 */

/** What it costs to open the executive floor: a one-off $100M. */
export const EXECUTIVE_FLOOR_UNLOCK_COST_MINOR = 10_000_000_000;

/**
 * The trailing monthly gross flight revenue an airline must clear to be allowed
 * to open the floor — $50M a month. Gross revenue (what flights earned), summed
 * over the last game month; not profit, and not cash on hand.
 */
export const EXECUTIVE_FLOOR_REVENUE_GATE_MINOR = 5_000_000_000;

/** The executive floor has ten offices, like the ground floor. */
export const EXECUTIVE_OFFICE_COUNT = 10;

/**
 * The cost to unlock each executive office, in the order they open — right to
 * left, cheapest first. Index 0 is the first (rightmost) office at $75M; the
 * tenth is $5B. An office opens only once the one before it has.
 */
export const EXECUTIVE_OFFICE_COSTS_MINOR: readonly number[] = [
  7_500_000_000, // $75M
  10_000_000_000, // $100M
  15_000_000_000, // $150M
  20_000_000_000, // $200M
  40_000_000_000, // $400M
  50_000_000_000, // $500M
  100_000_000_000, // $1B
  150_000_000_000, // $1.5B
  250_000_000_000, // $2.5B
  500_000_000_000, // $5B
];

/**
 * The next office an airline can unlock, given how many it already holds, or null
 * once all ten are open. The index is 0-based into {@link EXECUTIVE_OFFICE_COSTS_MINOR}.
 */
export function nextExecutiveOffice(
  officesUnlocked: number,
): { index: number; costMinor: number } | null {
  if (officesUnlocked >= EXECUTIVE_OFFICE_COUNT) return null;
  const costMinor = EXECUTIVE_OFFICE_COSTS_MINOR[officesUnlocked];
  if (costMinor === undefined) return null;
  return { index: officesUnlocked, costMinor };
}

/** The floor's state for the client — what is unlocked, and what the next gate is. */
export const ExecutiveFloorState = z
  .object({
    /** Whether the executive floor itself has been opened. */
    unlocked: z.boolean(),
    /** How many of its ten offices are open (0–10). */
    officesUnlocked: z.number().int().min(0).max(EXECUTIVE_OFFICE_COUNT),
    /** The one-off charge to open the floor. */
    unlockCostMinor: z.number().int().nonnegative(),
    /** The monthly gross-revenue floor to be allowed to open it. */
    revenueGateMinor: z.number().int().nonnegative(),
    /** The airline's own trailing monthly gross revenue, for the "need X more" overlay. */
    monthlyRevenueMinor: z.number().int().nonnegative(),
    /** The next office to unlock and its cost, or null when all ten are open. */
    nextOffice: z.object({ index: z.number().int(), costMinor: z.number().int() }).nullable(),
  })
  .strict();
export type ExecutiveFloorState = z.infer<typeof ExecutiveFloorState>;
