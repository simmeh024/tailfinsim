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

import type { OfficeRole } from '@tailfin/shared';

import chiefPilot2 from './assets/portraits/chief-pilot-2.webp';
import chiefPilot3 from './assets/portraits/chief-pilot-3.webp';
import chiefPilot from './assets/portraits/chief-pilot.webp';
import groundOps2 from './assets/portraits/ground-ops-2.webp';
import groundOps3 from './assets/portraits/ground-ops-3.webp';
import groundOps from './assets/portraits/ground-ops.webp';
import opsController2 from './assets/portraits/ops-controller-2.webp';
import opsController3 from './assets/portraits/ops-controller-3.webp';
import opsController from './assets/portraits/ops-controller.webp';
import revenueManager2 from './assets/portraits/revenue-manager-2.webp';
import revenueManager3 from './assets/portraits/revenue-manager-3.webp';
import revenueManager from './assets/portraits/revenue-manager.webp';
import routePlanner2 from './assets/portraits/route-planner-2.webp';
import routePlanner3 from './assets/portraits/route-planner-3.webp';
import routePlanner from './assets/portraits/route-planner.webp';
import safetyCompliance2 from './assets/portraits/safety-compliance-2.webp';
import safetyCompliance3 from './assets/portraits/safety-compliance-3.webp';
import safetyCompliance from './assets/portraits/safety-compliance.webp';
import socialMediaAttractiveness from './assets/portraits/social-media-attractiveness.webp';
import socialMediaReputation from './assets/portraits/social-media-reputation.webp';

/**
 * The six MVP roles. Aliased to the shared `OfficeRole` so the client's role
 * strings and the server's are one type — a candidate's `roleId` is exactly what
 * `POST /api/office/hires` expects, checked by the compiler rather than by hope.
 */
export type HqRoleId = OfficeRole;

/**
 * The roles that are also **seats** — the six with a fixed room, i.e. every
 * office role except the neutral-only `social-media` specialist. A seat role is
 * always a valid `OfficeSeatId`, which the six `HqRole` rows below rely on.
 */
export type HqSeatRoleId = Exclude<OfficeRole, 'social-media'>;

/** A candidate's seniority band. Flavour for now; real tiers arrive with the market. */
export type HqTier = 'Analyst' | 'Manager' | 'Director';

export interface HqRole {
  id: HqSeatRoleId;
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
 * Every seat has three candidates in the market — and you hire one. Each is one
 * entry here; a new arrival is a new entry plus its portrait.
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
    id: 'revenue-manager-sofia',
    roleId: 'revenue-manager',
    name: 'Sofía Reyes',
    tier: 'Manager',
    salaryPerMonthMinor: 2_100_000,
    trait: {
      label: 'Ancillary hunter',
      detail: 'Turns bags, seats and lounges into a revenue line of their own.',
    },
    portrait: revenueManager2,
  },
  {
    id: 'revenue-manager-anders',
    roleId: 'revenue-manager',
    name: 'Anders Holm',
    tier: 'Director',
    salaryPerMonthMinor: 2_900_000,
    trait: {
      label: 'Premium instinct',
      detail: 'Reads exactly when the front cabin will bear another notch of fare.',
    },
    portrait: revenueManager3,
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
    id: 'ops-controller-marta',
    roleId: 'ops-controller',
    name: 'Marta Silva',
    tier: 'Manager',
    salaryPerMonthMinor: 2_300_000,
    trait: {
      label: 'Weather-wise',
      detail: 'Sees a cell building on the radar before it reaches the arrivals bank.',
    },
    portrait: opsController2,
  },
  {
    id: 'ops-controller-jun',
    roleId: 'ops-controller',
    name: 'Jun Park',
    tier: 'Director',
    salaryPerMonthMinor: 2_700_000,
    trait: {
      label: 'On-time obsessive',
      detail: 'Claws a morning of delays back to schedule by the evening bank.',
    },
    portrait: opsController3,
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
    id: 'chief-pilot-fiona',
    roleId: 'chief-pilot',
    name: 'Fiona Brennan',
    tier: 'Director',
    salaryPerMonthMinor: 2_900_000,
    trait: {
      label: 'Line-current',
      detail: 'Still flies the line, so her training reflects the aeroplane, not the manual.',
    },
    portrait: chiefPilot2,
  },
  {
    id: 'chief-pilot-grant',
    roleId: 'chief-pilot',
    name: 'Grant Wexford',
    tier: 'Director',
    salaryPerMonthMinor: 3_000_000,
    trait: {
      label: 'Standard-setter',
      detail: 'Runs a check-and-training programme other airlines quietly copy.',
    },
    portrait: chiefPilot3,
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
    id: 'ground-ops-omar',
    roleId: 'ground-ops',
    name: 'Omar Haddad',
    tier: 'Director',
    salaryPerMonthMinor: 2_500_000,
    trait: {
      label: 'Turnaround tactician',
      detail: 'Keeps every gate to schedule when the whole bank stacks up at once.',
    },
    portrait: groundOps2,
  },
  {
    id: 'ground-ops-luca',
    roleId: 'ground-ops',
    name: 'Luca Moretti',
    tier: 'Manager',
    salaryPerMonthMinor: 2_000_000,
    trait: {
      label: 'Ramp-hardened',
      detail: 'Came up on the ramp, so nothing on the apron in bad weather surprises him.',
    },
    portrait: groundOps3,
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
  {
    id: 'safety-compliance-hiroshi',
    roleId: 'safety-compliance',
    name: 'Hiroshi Tanaka',
    tier: 'Director',
    salaryPerMonthMinor: 3_100_000,
    trait: {
      label: 'Zero-compromise',
      detail: 'Has grounded a jet over a paperwork gap, and would do it again tomorrow.',
    },
    portrait: safetyCompliance2,
  },
  {
    id: 'safety-compliance-emma',
    roleId: 'safety-compliance',
    name: 'Emma Larsson',
    tier: 'Manager',
    salaryPerMonthMinor: 2_400_000,
    trait: {
      label: 'Reporting-culture builder',
      detail: 'Gets crews logging the near-miss nobody else would have written up.',
    },
    portrait: safetyCompliance3,
  },
];

/** The candidates in the market for one seat, in roster order. */
export function candidatesForRole(roleId: HqRoleId): readonly HqCandidate[] {
  return HQ_CANDIDATES.filter((candidate) => candidate.roleId === roleId);
}

/**
 * The social media specialists — the "Specialist" row (§9.1).
 *
 * Kept apart from {@link HQ_CANDIDATES} on purpose: a specialist never competes
 * for one of the six seats, and a world only ever offers **one** of these two,
 * so they are not part of the seat market the roster above renders. Their ids
 * match the shared {@link SOCIAL_MEDIA_SPECIALISTS} so the server and worker know
 * the same faces. The trait is the perk the specialist actually carries.
 */
export const SPECIALIST_CANDIDATES: readonly HqCandidate[] = [
  {
    id: 'social-media-reputation',
    roleId: 'social-media',
    name: 'Lena Voss',
    tier: 'Manager',
    salaryPerMonthMinor: 1_500_000,
    trait: {
      label: 'Brand builder',
      detail: 'Grows your airline’s public reputation a little more every month she stays.',
    },
    portrait: socialMediaReputation,
  },
  {
    id: 'social-media-attractiveness',
    roleId: 'social-media',
    name: 'Kai Mercer',
    tier: 'Manager',
    salaryPerMonthMinor: 1_500_000,
    trait: {
      label: 'Crowd-puller',
      detail: 'Nudges undecided travellers your way when you fly more than one route.',
    },
    portrait: socialMediaAttractiveness,
  },
];

/** The specialist with this id, or null — used to render the world's offer. */
export function specialistById(id: string): HqCandidate | null {
  return SPECIALIST_CANDIDATES.find((candidate) => candidate.id === id) ?? null;
}

/** Salary as the game shows money elsewhere: major units, grouped, no fraction. */
export function formatSalary(minor: number): string {
  return (minor / 100).toLocaleString('en-GB', { maximumFractionDigits: 0 });
}
