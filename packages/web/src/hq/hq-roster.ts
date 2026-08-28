/**
 * The Head Office roster and its candidate market (M5-04, §9.1; boosts are the
 * §9.1 follow-up).
 *
 * §9.1's shape still holds: a **role** is the seat and carries the concrete
 * capability unlock, the same for anyone you put in it; a **candidate** is a named
 * person in the market for a seat. What is new is that a candidate now also carries
 * a small, salary-scaled **boost** — the "visible trait" made real — decided by the
 * shared {@link OFFICE_CANDIDATES} catalogue so the server, the worker and the
 * client all read one number.
 *
 * ## Derived from the shared catalogue
 *
 * The identity, tier, salary and boost come straight from `@tailfin/shared`; this
 * file adds only what is the client's to own — the **portrait** (imported so a
 * missing file is a build error) and the optional flavour **trait**. So a new
 * arrival is one raw entry in the shared catalogue plus a portrait here, and the
 * two can never disagree about who someone is or what they cost.
 */

import { OFFICE_CANDIDATES, type ExecutiveBoost, type OfficeRole } from '@tailfin/shared';

import chiefPilot2 from './assets/portraits/chief-pilot-2.webp';
import chiefPilot3 from './assets/portraits/chief-pilot-3.webp';
import chiefPilot4 from './assets/portraits/chief-pilot-4.webp';
import chiefPilot5 from './assets/portraits/chief-pilot-5.webp';
import chiefPilot6 from './assets/portraits/chief-pilot-6.webp';
import chiefPilot7 from './assets/portraits/chief-pilot-7.webp';
import chiefPilot from './assets/portraits/chief-pilot.webp';
import groundOps2 from './assets/portraits/ground-ops-2.webp';
import groundOps3 from './assets/portraits/ground-ops-3.webp';
import groundOps4 from './assets/portraits/ground-ops-4.webp';
import groundOps5 from './assets/portraits/ground-ops-5.webp';
import groundOps6 from './assets/portraits/ground-ops-6.webp';
import groundOps7 from './assets/portraits/ground-ops-7.webp';
import groundOps from './assets/portraits/ground-ops.webp';
import opsController2 from './assets/portraits/ops-controller-2.webp';
import opsController3 from './assets/portraits/ops-controller-3.webp';
import opsController4 from './assets/portraits/ops-controller-4.webp';
import opsController5 from './assets/portraits/ops-controller-5.webp';
import opsController6 from './assets/portraits/ops-controller-6.webp';
import opsController7 from './assets/portraits/ops-controller-7.webp';
import opsController from './assets/portraits/ops-controller.webp';
import revenueManager2 from './assets/portraits/revenue-manager-2.webp';
import revenueManager3 from './assets/portraits/revenue-manager-3.webp';
import revenueManager4 from './assets/portraits/revenue-manager-4.webp';
import revenueManager5 from './assets/portraits/revenue-manager-5.webp';
import revenueManager from './assets/portraits/revenue-manager.webp';
import routePlanner2 from './assets/portraits/route-planner-2.webp';
import routePlanner3 from './assets/portraits/route-planner-3.webp';
import routePlanner4 from './assets/portraits/route-planner-4.webp';
import routePlanner5 from './assets/portraits/route-planner-5.webp';
import routePlanner6 from './assets/portraits/route-planner-6.webp';
import routePlanner7 from './assets/portraits/route-planner-7.webp';
import routePlanner from './assets/portraits/route-planner.webp';
import safetyCompliance2 from './assets/portraits/safety-compliance-2.webp';
import safetyCompliance3 from './assets/portraits/safety-compliance-3.webp';
import safetyCompliance4 from './assets/portraits/safety-compliance-4.webp';
import safetyCompliance5 from './assets/portraits/safety-compliance-5.webp';
import safetyCompliance6 from './assets/portraits/safety-compliance-6.webp';
import safetyCompliance from './assets/portraits/safety-compliance.webp';
import socialMediaAttractiveness from './assets/portraits/social-media-attractiveness.webp';
import socialMediaReputation from './assets/portraits/social-media-reputation.webp';

/**
 * The six MVP roles. Aliased to the shared `OfficeRole` so the client's role
 * strings and the server's are one type.
 */
export type HqRoleId = OfficeRole;

/** The roles that are also **seats** — the six with a fixed room. */
export type HqSeatRoleId = Exclude<OfficeRole, 'social-media'>;

/** A candidate's seniority band. */
export type HqTier = 'Analyst' | 'Manager' | 'Director';

export interface HqRole {
  id: HqSeatRoleId;
  /** The seat. */
  role: string;
  /** The concrete §9.1 capability filling the seat unlocks. Never a percentage. */
  unlock: string;
  /** Set only on a seat that gates a capability nothing else can grant. */
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
  /** The candidate's small, salary-scaled boost, from the shared catalogue. */
  boost: ExecutiveBoost;
  /** Optional flavour trait — colour on top of the boost. Not every candidate carries one. */
  trait?: HqCandidateTrait;
  /** Portrait, imported so a missing file is a build error. */
  portrait: string;
}

/**
 * The seats, in §9.1's order: opportunity and revenue first, then the operational
 * seats, with the compliance gate last because it unlocks the others' reach.
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

/** Portrait per candidate id — imported so a missing one is a build error. */
const PORTRAITS: Readonly<Record<string, string>> = {
  'route-planner-mara': routePlanner,
  'route-planner-tom': routePlanner2,
  'route-planner-victor': routePlanner3,
  'route-planner-rahman': routePlanner4,
  'route-planner-bianchi': routePlanner5,
  'route-planner-novak': routePlanner6,
  'route-planner-park': routePlanner7,
  'revenue-manager-kenji': revenueManager,
  'revenue-manager-sofia': revenueManager2,
  'revenue-manager-anders': revenueManager3,
  'revenue-manager-lim': revenueManager4,
  'revenue-manager-petrova': revenueManager5,
  'ops-controller-diego': opsController,
  'ops-controller-marta': opsController2,
  'ops-controller-jun': opsController3,
  'ops-controller-boateng': opsController4,
  'ops-controller-chen': opsController5,
  'ops-controller-doyle': opsController6,
  'ops-controller-romano': opsController7,
  'chief-pilot-sten': chiefPilot,
  'chief-pilot-fiona': chiefPilot2,
  'chief-pilot-grant': chiefPilot3,
  'chief-pilot-nordheim': chiefPilot4,
  'chief-pilot-holloway': chiefPilot5,
  'chief-pilot-kelly': chiefPilot6,
  'chief-pilot-sokolova': chiefPilot7,
  'ground-ops-nadia': groundOps,
  'ground-ops-omar': groundOps2,
  'ground-ops-luca': groundOps3,
  'ground-ops-okafor': groundOps4,
  'ground-ops-adeyemi': groundOps5,
  'ground-ops-kwon': groundOps6,
  'ground-ops-herrera': groundOps7,
  'safety-compliance-claire': safetyCompliance,
  'safety-compliance-hiroshi': safetyCompliance2,
  'safety-compliance-emma': safetyCompliance3,
  'safety-compliance-fischer': safetyCompliance4,
  'safety-compliance-braun': safetyCompliance5,
  'safety-compliance-weiss': safetyCompliance6,
  'social-media-reputation': socialMediaReputation,
  'social-media-attractiveness': socialMediaAttractiveness,
};

/** Optional flavour trait per candidate id — the original hand-written colour. */
const TRAITS: Readonly<Record<string, HqCandidateTrait>> = {
  'route-planner-mara': {
    label: 'Early to market',
    detail: 'Spots an unserved city-pair a season before the board would.',
  },
  'route-planner-tom': {
    label: 'Fresh eyes',
    detail: 'Chases the long-thin routes the majors have written off.',
  },
  'route-planner-victor': {
    label: 'Old hand',
    detail: 'Reads a market’s turn a full season out, and has been right before.',
  },
  'revenue-manager-kenji': {
    label: 'Holds the line',
    detail: 'Keeps yield a touch firmer through a fare war than most would dare.',
  },
  'revenue-manager-sofia': {
    label: 'Ancillary hunter',
    detail: 'Turns bags, seats and lounges into a revenue line of their own.',
  },
  'revenue-manager-anders': {
    label: 'Premium instinct',
    detail: 'Reads exactly when the front cabin will bear another notch of fare.',
  },
  'ops-controller-diego': {
    label: 'Curfew-proof',
    detail: 'Reshuffles a broken evening bank without tripping a night restriction.',
  },
  'ops-controller-marta': {
    label: 'Weather-wise',
    detail: 'Sees a cell building on the radar before it reaches the arrivals bank.',
  },
  'ops-controller-jun': {
    label: 'On-time obsessive',
    detail: 'Claws a morning of delays back to schedule by the evening bank.',
  },
  'chief-pilot-sten': {
    label: 'Clean sheet',
    detail: 'Brings a training record without a single failed check ride.',
  },
  'chief-pilot-fiona': {
    label: 'Line-current',
    detail: 'Still flies the line, so her training reflects the aeroplane, not the manual.',
  },
  'chief-pilot-grant': {
    label: 'Standard-setter',
    detail: 'Runs a check-and-training programme other airlines quietly copy.',
  },
  'ground-ops-nadia': {
    label: 'Quick on the ramp',
    detail: 'Trims about a point off turnaround when the ramp is hers to run.',
  },
  'ground-ops-omar': {
    label: 'Turnaround tactician',
    detail: 'Keeps every gate to schedule when the whole bank stacks up at once.',
  },
  'ground-ops-luca': {
    label: 'Ramp-hardened',
    detail: 'Came up on the ramp, so nothing on the apron in bad weather surprises him.',
  },
  'safety-compliance-claire': {
    label: 'Audit-clean',
    detail: 'Clears an ETOPS audit without a single finding against the fleet.',
  },
  'safety-compliance-hiroshi': {
    label: 'Zero-compromise',
    detail: 'Has grounded a jet over a paperwork gap, and would do it again tomorrow.',
  },
  'safety-compliance-emma': {
    label: 'Reporting-culture builder',
    detail: 'Gets crews logging the near-miss nobody else would have written up.',
  },
  'social-media-reputation': {
    label: 'Brand builder',
    detail: 'Grows your airline’s public reputation a little more every month she stays.',
  },
  'social-media-attractiveness': {
    label: 'Crowd-puller',
    detail: 'Nudges undecided travellers your way when you fly more than one route.',
  },
};

const placeholderTier = (tier: string): HqTier =>
  tier === 'Analyst' || tier === 'Manager' || tier === 'Director' ? tier : 'Manager';

/** Every candidate — seat candidates and specialists — built from the shared catalogue. */
const ALL_CANDIDATES: readonly HqCandidate[] = OFFICE_CANDIDATES.map((candidate) => {
  const portrait = PORTRAITS[candidate.id];
  if (portrait === undefined) throw new Error(`no portrait for office candidate ${candidate.id}`);
  return {
    id: candidate.id,
    roleId: candidate.role,
    name: candidate.name,
    tier: placeholderTier(candidate.tier),
    salaryPerMonthMinor: candidate.monthlySalaryMinor,
    boost: candidate.boost,
    trait: TRAITS[candidate.id],
    portrait,
  };
});

/** The candidate market for the six seats (specialists kept apart — see below). */
export const HQ_CANDIDATES: readonly HqCandidate[] = ALL_CANDIDATES.filter(
  (candidate) => candidate.roleId !== 'social-media',
);

/** The candidates in the market for one seat, in roster order. */
export function candidatesForRole(roleId: HqRoleId): readonly HqCandidate[] {
  return HQ_CANDIDATES.filter((candidate) => candidate.roleId === roleId);
}

/**
 * The social media specialists — the "Specialist" row (§9.1). Kept apart from
 * {@link HQ_CANDIDATES} because a specialist never competes for one of the six
 * seats, and a world only ever offers one of the two.
 */
export const SPECIALIST_CANDIDATES: readonly HqCandidate[] = ALL_CANDIDATES.filter(
  (candidate) => candidate.roleId === 'social-media',
);

/** The specialist with this id, or null — used to render the world's offer. */
export function specialistById(id: string): HqCandidate | null {
  return SPECIALIST_CANDIDATES.find((candidate) => candidate.id === id) ?? null;
}

/** Any candidate — a seat candidate or a specialist — by id, or null. */
export function candidateById(id: string): HqCandidate | null {
  return ALL_CANDIDATES.find((candidate) => candidate.id === id) ?? null;
}

/** Salary as the game shows money elsewhere: major units, grouped, no fraction. */
export function formatSalary(minor: number): string {
  return (minor / 100).toLocaleString('en-GB', { maximumFractionDigits: 0 });
}
