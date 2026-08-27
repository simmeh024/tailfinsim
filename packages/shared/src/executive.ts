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

/**
 * The C-Suite roster (§9.1 follow-up, Phase 2).
 *
 * The people who staff the executive floor's offices. Unlike the ground-floor
 * seats, an executive office is **generic** — it has no fixed role, and any
 * C-Suite member fits any open office — so a hire consumes one free office rather
 * than filling a named seat. An airline can employ as many as it has **opened
 * offices**; past that the remaining candidates are locked until another office
 * opens.
 *
 * Like {@link OFFICE_CANDIDATES}, this catalogue is the **authoritative source of
 * a candidate's pay**: the server bills `monthlySalaryMinor` keyed by `id`, never
 * a figure the client sends, and snapshots it onto the hire so a later retune does
 * not silently re-price a standing executive. Portraits and role titles are the
 * client's to render and are not billable, so they live in the web roster.
 *
 * Phase 2 is the roster and the office-capacity gate; the roles and their
 * gameplay effects (the "higher boosts") land on top of this, keyed by the same
 * ids, exactly as the ground-floor traits will.
 */
export type ExecutiveCandidateTier = 'Director' | 'VP' | 'President';

export interface ExecutiveCandidate {
  /** Stable id, shared by the client roster, the wire and the payroll. */
  id: string;
  /** Placeholder name until the real roster lands; the client renders it. */
  name: string;
  tier: ExecutiveCandidateTier;
  /** Salary per game month, minor units — $150k to $1M ($1 = 100 minor). */
  monthlySalaryMinor: number;
}

/**
 * The executive hiring market — twenty placeholder candidates spanning the three
 * C-Suite bands, so there are always more people than the ten offices and the
 * "no free office" locked state is reachable. The names are placeholders the real
 * roster replaces; the ids are stable so a portrait, a role and a standing hire
 * all keep pointing at the same person when the real content arrives.
 */
export const EXECUTIVE_CANDIDATES: readonly ExecutiveCandidate[] = [
  { id: 'csuite-01', name: 'Adrienne Vale', tier: 'Director', monthlySalaryMinor: 15_000_000 },
  { id: 'csuite-02', name: 'Marcus Reid', tier: 'Director', monthlySalaryMinor: 18_000_000 },
  { id: 'csuite-03', name: 'Priya Nair', tier: 'Director', monthlySalaryMinor: 20_000_000 },
  { id: 'csuite-04', name: 'Daniel Osei', tier: 'Director', monthlySalaryMinor: 22_000_000 },
  { id: 'csuite-05', name: 'Helena Brandt', tier: 'Director', monthlySalaryMinor: 25_000_000 },
  { id: 'csuite-06', name: 'Ravi Menon', tier: 'Director', monthlySalaryMinor: 27_000_000 },
  { id: 'csuite-07', name: 'Clara Jensen', tier: 'Director', monthlySalaryMinor: 28_000_000 },
  { id: 'csuite-08', name: 'Theo Marchetti', tier: 'Director', monthlySalaryMinor: 30_000_000 },
  { id: 'csuite-09', name: 'Nadia Farouk', tier: 'VP', monthlySalaryMinor: 35_000_000 },
  { id: 'csuite-10', name: 'Julian Frost', tier: 'VP', monthlySalaryMinor: 40_000_000 },
  { id: 'csuite-11', name: 'Sofia Marchand', tier: 'VP', monthlySalaryMinor: 45_000_000 },
  { id: 'csuite-12', name: 'Warren Ito', tier: 'VP', monthlySalaryMinor: 50_000_000 },
  { id: 'csuite-13', name: 'Beatrix Lund', tier: 'VP', monthlySalaryMinor: 55_000_000 },
  { id: 'csuite-14', name: 'Elias Cross', tier: 'VP', monthlySalaryMinor: 58_000_000 },
  { id: 'csuite-15', name: 'Margaret Shaw', tier: 'VP', monthlySalaryMinor: 60_000_000 },
  { id: 'csuite-16', name: 'Vincent Aldridge', tier: 'President', monthlySalaryMinor: 70_000_000 },
  { id: 'csuite-17', name: 'Rosalind Pike', tier: 'President', monthlySalaryMinor: 75_000_000 },
  { id: 'csuite-18', name: 'Anton Reyes', tier: 'President', monthlySalaryMinor: 82_000_000 },
  { id: 'csuite-19', name: 'Genevieve Toure', tier: 'President', monthlySalaryMinor: 90_000_000 },
  { id: 'csuite-20', name: 'Sullivan Marsh', tier: 'President', monthlySalaryMinor: 100_000_000 },
];

/** The executive candidate with this id, or undefined — the server's billing lookup. */
export function executiveCandidate(id: string): ExecutiveCandidate | undefined {
  return EXECUTIVE_CANDIDATES.find((candidate) => candidate.id === id);
}

/** One executive hired into a (generic) office, as the client sees it. */
export const ExecutiveHire = z.object({
  candidateId: z.string().min(1),
  candidateName: z.string().min(1),
  monthlySalaryMinor: z.number().int().nonnegative(),
  hiredAt: z.string(),
});
export type ExecutiveHire = z.infer<typeof ExecutiveHire>;

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
    /** The C-Suite members currently staffing the open offices. */
    hires: z.array(ExecutiveHire),
  })
  .strict();
export type ExecutiveFloorState = z.infer<typeof ExecutiveFloorState>;

/** `POST /api/office/executive/hires` — put a C-Suite candidate into a free office. */
export const HireExecutiveRequest = z.object({ candidateId: z.string().min(1) }).strict();
export type HireExecutiveRequest = z.infer<typeof HireExecutiveRequest>;
