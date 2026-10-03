import { z } from 'zod';

import { EfficiencyQuantity } from './efficiency';

import type { ResearchTier } from './academy';

/**
 * §10.3's research tree, "Operational Doctrine" — identity (M9-05).
 *
 * > *"Airline-wide, permanent unlocks. Distinct from personal skill trees:
 * > **skill trees make one pilot good, research makes your whole airline
 * > good.**"*
 *
 * The tier gate and the wire contract are in `research-contract.ts`. This file
 * must not import anything that imports `economy-config.ts` at module load —
 * `EconomyConfig.research` validates its node table against `RESEARCH_NODES`,
 * so the economy depends on this file, and `academy.ts` (which the contract
 * needs) depends on the economy. `ResearchTier` is a type-only import for that
 * reason; that file says the rest.
 *
 * ## Why the tree is here and the prices are not
 *
 * The split `academy.ts` and `crew-skills.ts` already draw. *Which* nodes exist,
 * which branch and tier each sits in and *which* quantity it makes cheaper or
 * faster is **design** — moving Continuous descent off fuel burn would be a
 * redesign of §10.3's table. What a node costs in research points and cash, how
 * many weeks it takes and how much it removes are **balance**, and live in
 * `EconomyConfig.research`, versioned and retunable per world.
 *
 * ## What a node may make better
 *
 * §10.4 is the constraint every effect below was chosen against: *"Boosts are
 * **operational efficiency**, never demand or money directly."* So every target
 * is one of §10.4's six efficiency quantities, plus `crewXp` — the rate crew
 * learn, which is what the Crew Development branch is about (§10.3's T4 is
 * literally *"In-house Training Captain programme"*). `crewXp` is not a demand
 * input either, and it shares M9-04's Training Captain cap, so research cannot
 * turn §10.2's compounding loop into a runaway one.
 *
 * ## MVP ships tiers 1 and 2
 *
 * Issue #92: *"MVP ships tiers 1-2"*, and *"Tier 3 and 4 nodes are visible but
 * locked until the required academy level exists."* Both hold. Every node is in
 * the catalogue and priced, so the player can see exactly what they are working
 * toward and what facility it demands — §10.3's *"tier gating is the whole
 * point"*. Tiers 3 and 4 are `released: false`: shown, priced, and refused with
 * `not_released` even to an airline whose academy would open them. Several are
 * capabilities rather than efficiencies (ETOPS authority, in-house heavy
 * checks) that need systems of their own, and one — *"Best-in-class product
 * multiplier"* — names a demand effect §10.4 forbids, which is recorded on the
 * issue rather than resolved by inventing a cost-shaped reading of it.
 */

/** §10.3's six branches. */
export const ResearchBranch = z.enum([
  'fuel_performance',
  'turnaround_ground',
  'safety_reliability',
  'service_cabin',
  'crew_development',
  'maintenance',
]);
export type ResearchBranch = z.infer<typeof ResearchBranch>;
export const RESEARCH_BRANCHES = ResearchBranch.options;

/** Every node, T1 → T4 within each branch, in §10.3's order. */
export const ResearchNodeId = z.enum([
  'cost_index_sop',
  'continuous_descent',
  'tankering_doctrine',
  'fleet_performance_optimisation',

  'boarding_sop',
  'parallel_servicing',
  'rapid_turn_certification',
  'sub_25_minute_turn',

  'reporting_culture',
  'predictive_fault_detection',
  'etops_authority',
  'all_weather_cat_iiib',

  'service_standards',
  'signature_service',
  'premium_ritual',
  'best_in_class_product',

  'efficient_conversion',
  'cadet_pipeline',
  'fatigue_resilience',
  'in_house_training_captains',

  'line_efficiency',
  'predictive_maintenance',
  'reduced_aog',
  'in_house_heavy_checks',
]);
export type ResearchNodeId = z.infer<typeof ResearchNodeId>;
export const RESEARCH_NODE_IDS = ResearchNodeId.options;

/** What a node can make better: §10.4's six, or how fast crew learn. */
export const ResearchEffectTarget = z.enum([...EfficiencyQuantity.options, 'crewXp']);
export type ResearchEffectTarget = z.infer<typeof ResearchEffectTarget>;

export interface ResearchBranchDefinition {
  branch: ResearchBranch;
  /** §10.3's name for the branch. */
  name: string;
  /** One sentence on what researching it buys. */
  summary: string;
}

export const RESEARCH_BRANCH_DEFINITIONS: readonly ResearchBranchDefinition[] = [
  {
    branch: 'fuel_performance',
    name: 'Fuel & Performance',
    summary: 'Fly the same sector on less fuel, and in less block time.',
  },
  {
    branch: 'turnaround_ground',
    name: 'Turnaround & Ground',
    summary: 'Turn the aeroplane round faster at every station.',
  },
  {
    branch: 'safety_reliability',
    name: 'Safety & Reliability',
    summary: 'Fewer technical faults, delays and diversions.',
  },
  {
    branch: 'service_cabin',
    name: 'Service & Cabin',
    summary: 'Deliver the service you sell for less — never sell more of it.',
  },
  {
    branch: 'crew_development',
    name: 'Crew Development',
    summary: 'Crew learn faster from every sector they fly.',
  },
  {
    branch: 'maintenance',
    name: 'Maintenance',
    summary: 'Keep the fleet airworthy for less.',
  },
];

export interface ResearchNodeDefinition {
  id: ResearchNodeId;
  branch: ResearchBranch;
  tier: ResearchTier;
  /** §10.3's sample node name. */
  name: string;
  /** What the doctrine is, in a sentence a player can act on. */
  description: string;
  /**
   * What it makes cheaper, faster or quicker to learn. The *amount* is balance
   * (`EconomyConfig.research.nodes[id].effects`).
   *
   * Empty for a node outside this release whose effect is a capability nothing
   * yet models — an empty list is honest, a guessed efficiency is not.
   */
  targets: readonly ResearchEffectTarget[];
  /** Issue #92: the MVP ships tiers 1 and 2. False for every tier 3 and 4 node. */
  released: boolean;
}

/**
 * §10.3's table, one row per node.
 *
 * The names are §10.3's own *"sample nodes"*. Two readings needed a decision:
 *
 *   - **Signature service lowers service cost, it does not raise service
 *     quality.** Quality is App. D's tier ladder, which a player buys, and
 *     §10.4 says a veteran airline is *"leaner, not more attractive"*. A
 *     doctrine is a routine the cabin runs with fewer touches.
 *   - **Crew Development feeds crew XP.** None of §10.4's six fits it, and the
 *     branch's own T4 is the Training Captain programme — this is the branch
 *     that turns §10.2's loop, and it turns it through the same cap.
 */
export const RESEARCH_NODES: readonly ResearchNodeDefinition[] = [
  // Fuel & Performance -------------------------------------------------------
  {
    id: 'cost_index_sop',
    branch: 'fuel_performance',
    tier: 1,
    name: 'Cost-index SOP',
    description: 'Every crew flies the cost index dispatch planned, not the one they prefer.',
    targets: ['fuelBurn'],
    released: true,
  },
  {
    id: 'continuous_descent',
    branch: 'fuel_performance',
    tier: 2,
    name: 'Continuous descent approach',
    description: 'Idle-thrust descents and shorter level-offs: less fuel, and fewer minutes.',
    targets: ['fuelBurn', 'blockTime'],
    released: true,
  },
  {
    id: 'tankering_doctrine',
    branch: 'fuel_performance',
    tier: 3,
    name: 'Tankering doctrine',
    description: 'Carry fuel from cheap stations to dear ones when the burn penalty pays.',
    targets: ['fuelBurn'],
    released: false,
  },
  {
    id: 'fleet_performance_optimisation',
    branch: 'fuel_performance',
    tier: 4,
    name: 'Fleet-wide performance optimisation',
    description: 'Per-tail performance monitoring that tunes every airframe to its own data.',
    targets: ['fuelBurn', 'blockTime'],
    released: false,
  },

  // Turnaround & Ground ------------------------------------------------------
  {
    id: 'boarding_sop',
    branch: 'turnaround_ground',
    tier: 1,
    name: 'Boarding SOP',
    description: 'One boarding sequence, run the same way at every gate.',
    targets: ['turnaroundTime'],
    released: true,
  },
  {
    id: 'parallel_servicing',
    branch: 'turnaround_ground',
    tier: 2,
    name: 'Parallel servicing',
    description: 'Fuelling, catering and cleaning overlap instead of queueing.',
    targets: ['turnaroundTime'],
    released: true,
  },
  {
    id: 'rapid_turn_certification',
    branch: 'turnaround_ground',
    tier: 3,
    name: 'Rapid turn certification',
    description: 'Fuelling with passengers aboard, under an approved procedure.',
    targets: ['turnaroundTime'],
    released: false,
  },
  {
    id: 'sub_25_minute_turn',
    branch: 'turnaround_ground',
    tier: 4,
    name: 'Sub-25-minute narrowbody turn',
    description: 'The low-cost turn, as a standard rather than a stunt.',
    targets: ['turnaroundTime'],
    released: false,
  },

  // Safety & Reliability -----------------------------------------------------
  {
    id: 'reporting_culture',
    branch: 'safety_reliability',
    tier: 1,
    name: 'Reporting culture',
    description: 'Crew report the near-miss before it becomes the incident.',
    targets: ['incidentRate'],
    released: true,
  },
  {
    id: 'predictive_fault_detection',
    branch: 'safety_reliability',
    tier: 2,
    name: 'Predictive fault detection',
    description: 'Trend monitoring that finds the failing part before it fails in service.',
    targets: ['incidentRate'],
    released: true,
  },
  {
    id: 'etops_authority',
    branch: 'safety_reliability',
    tier: 3,
    name: 'ETOPS authority',
    description: 'Approval to fly extended over-water routings with twin-engined aircraft.',
    // A permission, not an efficiency: it opens routings rather than making any
    // existing one cheaper, and the reachability check has no ETOPS gate yet.
    targets: [],
    released: false,
  },
  {
    id: 'all_weather_cat_iiib',
    branch: 'safety_reliability',
    tier: 4,
    name: 'All-weather Cat IIIb ops',
    description: 'Land in fog that diverts everyone else.',
    targets: ['incidentRate'],
    released: false,
  },

  // Service & Cabin ----------------------------------------------------------
  {
    id: 'service_standards',
    branch: 'service_cabin',
    tier: 1,
    name: 'Service standards',
    description: 'A written service routine, so the cabin stops reinventing it every sector.',
    targets: ['serviceCost'],
    released: true,
  },
  {
    id: 'signature_service',
    branch: 'service_cabin',
    tier: 2,
    name: 'Signature service',
    description: 'One signature routine, practised until it costs less to deliver.',
    targets: ['serviceCost'],
    released: true,
  },
  {
    id: 'premium_ritual',
    branch: 'service_cabin',
    tier: 3,
    name: 'Premium ritual',
    description: 'The premium cabin routine, run by crew who no longer need the card.',
    targets: ['serviceCost'],
    released: false,
  },
  {
    id: 'best_in_class_product',
    branch: 'service_cabin',
    tier: 4,
    name: 'Best-in-class product multiplier',
    description: 'The design document names a product multiplier here.',
    // §10.4 forbids a boost that makes an airline more attractive, and a
    // "product multiplier" is that by name. Left without an effect until the
    // conflict is resolved in the design document; see the issue.
    targets: [],
    released: false,
  },

  // Crew Development ---------------------------------------------------------
  {
    id: 'efficient_conversion',
    branch: 'crew_development',
    tier: 1,
    name: 'Efficient conversion',
    description:
      'A structured syllabus for conversion and recurrent training: crew bank more from every sector.',
    targets: ['crewXp'],
    released: true,
  },
  {
    id: 'cadet_pipeline',
    branch: 'crew_development',
    tier: 2,
    name: 'Cadet pipeline',
    description: 'Mentored progression through the ranks: experience compounds faster.',
    targets: ['crewXp'],
    released: true,
  },
  {
    id: 'fatigue_resilience',
    branch: 'crew_development',
    tier: 3,
    name: 'Fatigue resilience',
    description: 'Fatigue risk management that keeps rostered crew fit to fly.',
    // Duty limits are regulation (§9.2) and a doctrine must not move them; what
    // it could legitimately change is not modelled yet.
    targets: [],
    released: false,
  },
  {
    id: 'in_house_training_captains',
    branch: 'crew_development',
    tier: 4,
    name: 'In-house Training Captain programme',
    description: 'Train your own Training Captains rather than waiting for them to emerge.',
    targets: ['crewXp'],
    released: false,
  },

  // Maintenance ---------------------------------------------------------------
  {
    id: 'line_efficiency',
    branch: 'maintenance',
    tier: 1,
    name: 'Line efficiency',
    description: 'Line maintenance planned around the schedule instead of against it.',
    targets: ['maintenanceCost'],
    released: true,
  },
  {
    id: 'predictive_maintenance',
    branch: 'maintenance',
    tier: 2,
    name: 'Predictive maintenance',
    description: 'Replace components on their condition, not their calendar.',
    targets: ['maintenanceCost'],
    released: true,
  },
  {
    id: 'reduced_aog',
    branch: 'maintenance',
    tier: 3,
    name: 'Reduced AOG',
    description: 'Spares pooled where the fleet actually breaks.',
    targets: ['maintenanceCost'],
    released: false,
  },
  {
    id: 'in_house_heavy_checks',
    branch: 'maintenance',
    tier: 4,
    name: 'In-house heavy checks',
    description: 'C- and D-checks in your own hangar.',
    // A capability (a hangar, a facility kind), not an efficiency on a check
    // somebody else performs. Not modelled yet.
    targets: [],
    released: false,
  },
];

export function researchNode(id: ResearchNodeId): ResearchNodeDefinition {
  const found = RESEARCH_NODES.find((node) => node.id === id);
  if (!found) throw new Error(`Unknown research node ${id}`);
  return found;
}

export function researchBranchDefinition(branch: ResearchBranch): ResearchBranchDefinition {
  const found = RESEARCH_BRANCH_DEFINITIONS.find((row) => row.branch === branch);
  if (!found) throw new Error(`Unknown research branch ${branch}`);
  return found;
}

/** A branch's nodes, tier 1 first. */
export function researchNodesInBranch(branch: ResearchBranch): ResearchNodeDefinition[] {
  return RESEARCH_NODES.filter((node) => node.branch === branch).sort((a, b) => a.tier - b.tier);
}

/** The node a tier-N node needs complete first: the tier below it in the same branch. */
export function researchPrerequisite(id: ResearchNodeId): ResearchNodeDefinition | null {
  const node = researchNode(id);
  return (
    RESEARCH_NODES.find((row) => row.branch === node.branch && row.tier === node.tier - 1) ?? null
  );
}
