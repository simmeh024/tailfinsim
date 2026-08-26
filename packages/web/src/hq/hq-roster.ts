/**
 * The Head Office roster and its candidate market (M5-04, design doc §9.1).
 *
 * §9.1's rule shapes this whole file: **senior hires are capability unlocks and
 * automation, not stat bonuses.** So the model has two halves:
 *
 * - a **role** — the seat — carries the concrete §9.1 `unlock`, the same for
 *   anyone you put in it, and that is M5-04's second acceptance criterion;
 * - a **candidate** — a named person in the market for a seat — carries a salary,
 *   a tier and a **visible trait** (§9.1: "a rotating candidate market with
 *   visible traits"). A seat can have several candidates; you hire one.
 *
 * The trait is the candidate's colour, not the hire's mechanism, and is **not yet
 * applied to the simulation** — a trait that reads as a small percentage is
 * flavour, never a stat bonus. Wiring traits and the candidate-market refresh is
 * the server/sim half of M5-04 that lands on top of this scaffold; when it does,
 * `HQ_CANDIDATES` is replaced by what the server sends and neither the page nor
 * the role table changes.
 */

import chiefPilot from './assets/portraits/chief-pilot.svg';
import groundOps from './assets/portraits/ground-ops.svg';
import opsController from './assets/portraits/ops-controller.svg';
import revenueManager from './assets/portraits/revenue-manager.svg';
import routePlanner2 from './assets/portraits/route-planner-2.svg';
import routePlanner3 from './assets/portraits/route-planner-3.svg';
import routePlanner from './assets/portraits/route-planner.svg';
import safetyCompliance from './assets/portraits/safety-compliance.svg';

/** The six MVP roles named in the M5-04 issue and §9.1. */
export type HqRoleId =
  | 'route-planner'
  | 'revenue-manager'
  | 'ops-controller'
  | 'chief-pilot'
  | 'ground-ops'
  | 'safety-compliance';

/** A candidate's seniority band. Flavour for now; real tiers arrive with the market. */
export type HqTier = 'Analyst' | 'Manager' | 'Director';

export interface HqRole {
  id: HqRoleId;
  /** The seat. */
  role: string;
  /** The concrete §9.1 capability filling the seat unlocks. Never a percentage. */
  unlock: string;
  /**
   * Set only on a seat that gates a capability nothing else can grant. Today only
   * Safety & Compliance does — §9.1 and the M5-04 acceptance criterion make
   * long-haul/ETOPS and international rights unreachable without it.
   */
  gates?: string;
}

export interface HqCandidateTrait {
  /** A short badge, e.g. "Early to market". */
  label: string;
  /** One line of what it means, in flavour terms. */
  detail: string;
}

export interface HqCandidate {
  /** Unique across the market. */
  id: string;
  roleId: HqRoleId;
  name: string;
  tier: HqTier;
  /** Salary per game month, integer minor units — the money convention used everywhere else. */
  salaryPerMonthMinor: number;
  /** The candidate's own visible trait (§9.1). Flavour; not yet applied to the sim. */
  trait: HqCandidateTrait;
  /** Portrait, imported so a missing file is a build error. */
  portrait: string;
}

/**
 * The seats, in §9.1's order: opportunity and revenue first, then the operational
 * seats, with the compliance gate last because it unlocks the others' reach
 * rather than a daily job.
 */
export const HQ_ROLES: readonly HqRole[] = [
  {
    id: 'route-planner',
    role: 'Route Planner',
    unlock: 'Surfaces ranked route opportunities with demand and competition analysis.',
  },
  {
    id: 'revenue-manager',
    role: 'Revenue Manager',
    unlock: 'Unlocks automated fare rules — set a policy and they run it per flight.',
  },
  {
    id: 'ops-controller',
    role: 'Ops Controller',
    unlock:
      'Runs disruption by your standing policy while you are offline — swap, delay or cancel to the rules you set.',
  },
  {
    id: 'chief-pilot',
    role: 'Chief Pilot',
    unlock:
      'Unlocks training programmes and type-rating conversions, and raises the fatigue safety margin.',
  },
  {
    id: 'ground-ops',
    role: 'Head of Ground Ops',
    unlock: 'Unlocks self-handling and improves the turnaround baseline across your network.',
  },
  {
    id: 'safety-compliance',
    role: 'Safety & Compliance',
    unlock: 'Required for long-haul and ETOPS authority and international rights.',
    gates:
      'Long-haul, ETOPS and international authority are unreachable until this seat is filled.',
  },
];

/**
 * The candidate market. Several candidates may compete for one seat — the Route
 * Planner has three — and you hire one. Everyone else has one for now; more
 * arrive as portraits and names are generated, and each is one entry here.
 */
export const HQ_CANDIDATES: readonly HqCandidate[] = [
  {
    id: 'route-planner-mara',
    roleId: 'route-planner',
    name: 'Mara Ellison',
    tier: 'Manager',
    salaryPerMonthMinor: 1_800_000,
    trait: {
      label: 'Early to market',
      detail: 'Spots an unserved city-pair a season before the board would.',
    },
    portrait: routePlanner,
  },
  {
    id: 'route-planner-tom',
    roleId: 'route-planner',
    name: 'Tom Bakker',
    tier: 'Analyst',
    salaryPerMonthMinor: 1_200_000,
    trait: {
      label: 'Fresh eyes',
      detail: 'Chases the long-thin routes the majors have written off.',
    },
    portrait: routePlanner2,
  },
  {
    id: 'route-planner-victor',
    roleId: 'route-planner',
    name: 'Victor Lindqvist',
    tier: 'Director',
    salaryPerMonthMinor: 2_600_000,
    trait: {
      label: 'Old hand',
      detail: 'Reads a market’s turn a full season out, and has been right before.',
    },
    portrait: routePlanner3,
  },
  {
    id: 'revenue-manager-kenji',
    roleId: 'revenue-manager',
    name: 'Kenji Tan',
    tier: 'Manager',
    salaryPerMonthMinor: 2_000_000,
    trait: {
      label: 'Holds the line',
      detail: 'Keeps yield a touch firmer through a fare war than most would dare.',
    },
    portrait: revenueManager,
  },
  {
    id: 'ops-controller-diego',
    roleId: 'ops-controller',
    name: 'Diego Alvarez',
    tier: 'Director',
    salaryPerMonthMinor: 2_600_000,
    trait: {
      label: 'Curfew-proof',
      detail: 'Reshuffles a broken evening bank without tripping a night restriction.',
    },
    portrait: opsController,
  },
  {
    id: 'chief-pilot-sten',
    roleId: 'chief-pilot',
    name: 'Sten Halvorsen',
    tier: 'Director',
    salaryPerMonthMinor: 2_800_000,
    trait: {
      label: 'Clean sheet',
      detail: 'Brings a training record without a single failed check ride.',
    },
    portrait: chiefPilot,
  },
  {
    id: 'ground-ops-nadia',
    roleId: 'ground-ops',
    name: 'Nadia Kovač',
    tier: 'Director',
    salaryPerMonthMinor: 2_400_000,
    trait: {
      // The turnaround example from the brief — placed on Ground Ops, not the
      // Route Planner, because §9.1 assigns the turnaround baseline to this seat.
      // Shown as the candidate's colour; not yet applied to the sim.
      label: 'Quick on the ramp',
      detail: 'Trims about a point off turnaround when the ramp is hers to run.',
    },
    portrait: groundOps,
  },
  {
    id: 'safety-compliance-claire',
    roleId: 'safety-compliance',
    name: 'Claire Fontaine',
    tier: 'Director',
    salaryPerMonthMinor: 3_000_000,
    trait: {
      label: 'Audit-clean',
      detail: 'Clears an ETOPS audit without a single finding against the fleet.',
    },
    portrait: safetyCompliance,
  },
];

/** The candidates in the market for one seat, in roster order. */
export function candidatesForRole(roleId: HqRoleId): readonly HqCandidate[] {
  return HQ_CANDIDATES.filter((candidate) => candidate.roleId === roleId);
}

/** Salary as the game shows money elsewhere: major units, grouped, no fraction. */
export function formatSalary(minor: number): string {
  return (minor / 100).toLocaleString('en-GB', { maximumFractionDigits: 0 });
}
