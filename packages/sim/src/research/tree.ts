import {
  academyLevelForResearchTier,
  researchPrerequisite,
  type AcademyCommissionedLevel,
  type ResearchNodeDefinition,
  type ResearchNodeId,
  type ResearchNodeStatus,
  type ResearchRefusal,
} from '@tailfin/shared';

import { buildCompletesAt } from '../academy/levels';

/**
 * Where a research node stands for one airline, and whether it may start
 * (M9-05, §10.3).
 *
 * Pure: the tree's shape arrives from `@tailfin/shared`'s catalogue, the price
 * from the world's balance, and the airline's position — what it has
 * completed, what is running, its academies, its points and its cash — as
 * plain values. The server decides nothing of its own about a node; it reads
 * the facts and asks here, for the start request and for the tree's every
 * button alike, so the two can never disagree.
 */

/** One research project as the tree needs it. Both instants are **game** time. */
export interface ResearchProjectFacts {
  nodeId: ResearchNodeId;
  startedAt: Date;
  completesAt: Date;
}

export interface ResearchNodeFacts {
  node: ResearchNodeDefinition;
  /** The node's price, from the world's balance. */
  cost: { researchPoints: number; cashCostMinor: number };
  /** Every node this airline has completed, as of the world's clock. */
  completeNodeIds: ReadonlySet<ResearchNodeId>;
  /** The one project running, or null. One at a time, airline-wide. */
  activeNodeId: ResearchNodeId | null;
  /** The highest commissioned academy level the airline holds. 0 with none. */
  highestAcademyLevel: AcademyCommissionedLevel;
  /** Unspent research points. */
  pointsBalance: number;
  /** The airline's cash, in minor units. */
  cashMinor: number;
}

export interface ResearchNodeState {
  status: ResearchNodeStatus;
  /**
   * What a start request for this node receives right now, or null when it
   * would start. Never null on a complete or running node: a second request
   * for one is refused, and says why.
   */
  refusal: ResearchRefusal | null;
  /**
   * The wire's `startRefusal`: `refusal`, except **null** on a complete or
   * running node, because there is nothing to start and the tree has no button
   * to put the reason beside. The two are separate fields so the server copies
   * one rather than re-deriving the rule.
   */
  startRefusal: ResearchRefusal | null;
}

/**
 * Decide a node's status and what a start request would be told.
 *
 * The refusals are checked in a fixed order, and the order is the design:
 *
 *  1. `already_complete`, `already_in_progress` — nothing to start.
 *  2. `academy_level` — §10.3's *"tier gating is the whole point"*. First of
 *     the locks, so a tier-3 node at an airline with a Training Room says
 *     *build a Full-Flight Sim Centre* rather than anything less useful. It is
 *     the acceptance criterion's *"facility level required, stated plainly"*.
 *  3. `not_released` — tiers 3 and 4 are visible, priced and refused even to
 *     an airline whose academy would open them (issue #92: the MVP ships 1-2).
 *  4. `prerequisite` — the tier below in this branch is not complete.
 *  5. `project_running` — one project at a time, airline-wide.
 *  6. `insufficient_points`, then `insufficient_funds` — points first, because
 *     they are the scarce thing: cash can be earned in many ways, points in one.
 *
 * 2-4 make a node `locked`; 5-6 leave it `available` with the reason on it,
 * because the node is open to this airline and only the moment is wrong.
 */
export function researchNodeState(facts: ResearchNodeFacts): ResearchNodeState {
  const { node } = facts;

  if (facts.completeNodeIds.has(node.id)) {
    return { status: 'complete', refusal: 'already_complete', startRefusal: null };
  }
  if (facts.activeNodeId === node.id) {
    return { status: 'in_progress', refusal: 'already_in_progress', startRefusal: null };
  }

  const locked = (refusal: ResearchRefusal): ResearchNodeState => ({
    status: 'locked',
    refusal,
    startRefusal: refusal,
  });
  if (facts.highestAcademyLevel < academyLevelForResearchTier(node.tier).level) {
    return locked('academy_level');
  }
  if (!node.released) return locked('not_released');
  const prerequisite = researchPrerequisite(node.id);
  if (prerequisite !== null && !facts.completeNodeIds.has(prerequisite.id)) {
    return locked('prerequisite');
  }

  const waiting = (refusal: ResearchRefusal | null): ResearchNodeState => ({
    status: 'available',
    refusal,
    startRefusal: refusal,
  });
  if (facts.activeNodeId !== null) return waiting('project_running');
  if (facts.pointsBalance < facts.cost.researchPoints) return waiting('insufficient_points');
  if (facts.cashMinor < facts.cost.cashCostMinor) return waiting('insufficient_funds');
  return waiting(null);
}

/**
 * When a project started at `startedAt` completes.
 *
 * **Game** instant in, game instant out (ADR-0026) — the same arithmetic as an
 * academy's construction, and deliberately the same function: §10.3's *"you
 * cannot rush it"* is held, as §10.1's build time is, by there being no third
 * parameter for anything a player could buy to reach.
 */
export function researchCompletesAt(startedAt: Date, buildWeeks: number): Date {
  if (!Number.isInteger(buildWeeks) || buildWeeks < 1) {
    throw new Error(`buildWeeks must be a whole number ≥ 1, got ${String(buildWeeks)}`);
  }
  return buildCompletesAt(startedAt, buildWeeks);
}

/**
 * Whether a project is complete as of `gameNow`.
 *
 * **Lazy**: a project is complete exactly when the world's clock has reached
 * `completes_at`. There is no sweep and no status column to flip, so there is
 * nothing a missing worker can leave undone — a doctrine finishes on time on
 * every node, production included — and nothing for ADR-0005's world reset to
 * forget to clear.
 */
export function isResearchComplete(project: { completesAt: Date }, gameNow: Date): boolean {
  return project.completesAt.getTime() <= gameNow.getTime();
}

/** Every node whose project has completed as of `gameNow`. */
export function completeResearchNodeIds(
  projects: readonly ResearchProjectFacts[],
  gameNow: Date,
): Set<ResearchNodeId> {
  return new Set(
    projects
      .filter((project) => isResearchComplete(project, gameNow))
      .map((project) => project.nodeId),
  );
}

/**
 * The project still running at `gameNow`, or null.
 *
 * At most one by construction — a start is refused while another runs — but
 * read as "the latest-started", so a history that somehow held two would show
 * the one the player started last rather than throwing on a read.
 */
export function activeResearchProject(
  projects: readonly ResearchProjectFacts[],
  gameNow: Date,
): ResearchProjectFacts | null {
  let active: ResearchProjectFacts | null = null;
  for (const project of projects) {
    if (isResearchComplete(project, gameNow)) continue;
    if (active === null || project.startedAt.getTime() > active.startedAt.getTime()) {
      active = project;
    }
  }
  return active;
}
