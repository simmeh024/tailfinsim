import { randomUUID } from 'node:crypto';

import { and, eq, gt, lte, sql } from 'drizzle-orm';

import {
  academyLevelForResearchTier,
  RESEARCH_BRANCH_DEFINITIONS,
  RESEARCH_NODE_IDS,
  researchNode,
  researchNodesInBranch,
  type AcademyCommissionedLevel,
  type ResearchBalance,
  type ResearchNodeId,
  type ResearchNodeView,
  type ResearchRefusal,
  type ResearchResponse,
} from '@tailfin/shared';
import {
  academyResearchTier,
  activeResearchProject,
  completeResearchNodeIds,
  researchCompletesAt,
  researchNodeState,
  type ResearchProjectFacts,
} from '@tailfin/sim';

import { moveAirlineCash } from '../airline/cash';
import { academy, airline, flightResult, researchProject } from '../db/schema';
import { loadWorldEconomyConfig } from '../economy/loader';
import { worldGameNow } from '../world/game-now';

import {
  debitResearchPoints,
  lockResearchAccount,
  readResearchAccount,
  RESEARCH_MILLI_PER_POINT,
  researchPointsFromMilli,
} from './points';

import type { Database } from '../db/client';

/**
 * §10.3's research tree: reading it and starting a project (M9-05).
 *
 * `packages/sim` decides what a node's status is and whether it may start;
 * `research/points.ts` owns the points; this file owns the projects, the cash
 * and the response.
 *
 * ## Owner-scoped by resolution
 *
 * Every query is scoped by the session-resolved airline (ADR-0020). There are
 * no resource ids on these routes at all: the node is a **selector over the
 * fixed catalogue**, not an owned resource, so there is nobody else's node to
 * conceal — what is scoped is the airline whose projects and points are read,
 * and that comes from the session alone.
 *
 * ## Completion is lazy
 *
 * A project is complete when the world's clock has reached `completes_at`, read
 * here on every request. No worker finishes research, so research finishes on
 * time on every node — but points are earned only by settlement, which is the
 * worker's, and that asymmetry is the trap `CLAUDE.md` records.
 */

export interface ResearchOwner {
  worldId: string;
  airlineId: string;
}

export type ResearchResult<T> = { ok: true; value: T } | { ok: false; refusal: ResearchRefusal };

class InsufficientFunds extends Error {}

/** How far back `points.recentPerDay` looks: a game week. */
const RECENT_WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1_000;

interface AcademyPosition {
  levelSum: number;
  highest: AcademyCommissionedLevel;
}

/** Σ and max of the airline's commissioned academy levels, in one query. */
async function academyPosition(db: Database, airlineId: string): Promise<AcademyPosition> {
  const [row] = await db
    .select({
      levelSum: sql<string | number | null>`coalesce(sum(${academy.level}), 0)`,
      highest: sql<string | number | null>`coalesce(max(${academy.level}), 0)`,
    })
    .from(academy)
    .where(eq(academy.airlineId, airlineId));
  return { levelSum: Number(row?.levelSum ?? 0), highest: Number(row?.highest ?? 0) };
}

async function projectsOf(db: Database, airlineId: string): Promise<ResearchProjectFacts[]> {
  const rows = await db
    .select({
      nodeId: researchProject.nodeId,
      startedAt: researchProject.startedAt,
      completesAt: researchProject.completesAt,
    })
    .from(researchProject)
    .where(eq(researchProject.airlineId, airlineId));
  // `node_id` is text; a row naming a node this build does not know (a later
  // build's tree, after a rollback) is not part of this build's tree.
  const known = new Set<string>(RESEARCH_NODE_IDS);
  return rows
    .filter((row) => known.has(row.nodeId))
    .map((row) => ({ ...row, nodeId: row.nodeId as ResearchNodeId }));
}

async function cashOf(db: Database, airlineId: string): Promise<number> {
  const [row] = await db
    .select({ cashMinor: airline.cashMinor })
    .from(airline)
    .where(eq(airline.id, airlineId))
    .limit(1);
  return row?.cashMinor ?? 0;
}

/**
 * Points earned over the last game week, per day — an observation, not a
 * projection.
 *
 * Summed from what settlement recorded on each flight's breakdown rather than
 * recomputed, so it is the rate the airline actually earned at, under whatever
 * academies it held when each flight landed. Divided by the whole window even
 * for an airline younger than a week, which understates a brand-new airline —
 * the safe direction, the same choice the cash runway makes.
 */
async function recentActivity(
  db: Database,
  airlineId: string,
  gameNow: Date,
): Promise<{ pointsPerDay: number; fleetHoursPerDay: number }> {
  const since = new Date(gameNow.getTime() - RECENT_WINDOW_DAYS * DAY_MS);
  const [row] = await db
    .select({
      total: sql<string | number | null>`coalesce(sum(
        (${flightResult.breakdown}::jsonb -> 'research' ->> 'points')::numeric
      ), 0)`,
      // The formula's third factor over the same window, from the same rows: the
      // block time settlement billed, which is the time the research accrued on.
      blockSeconds: sql<string | number | null>`coalesce(sum(${flightResult.blockSeconds}), 0)`,
    })
    .from(flightResult)
    .where(
      and(
        eq(flightResult.airlineId, airlineId),
        gt(flightResult.settledAt, since),
        lte(flightResult.settledAt, gameNow),
      ),
    );
  return {
    pointsPerDay: Number(row?.total ?? 0) / RECENT_WINDOW_DAYS,
    fleetHoursPerDay: Number(row?.blockSeconds ?? 0) / 3_600 / RECENT_WINDOW_DAYS,
  };
}

/** One node as the tree shows it. */
function nodeView(
  id: ResearchNodeId,
  balance: ResearchBalance,
  state: ReturnType<typeof researchNodeState>,
  project: ResearchProjectFacts | undefined,
): ResearchNodeView {
  const node = researchNode(id);
  const row = balance.nodes[id];
  const required = academyLevelForResearchTier(node.tier);
  return {
    id,
    branch: node.branch,
    tier: node.tier,
    name: node.name,
    description: node.description,
    effects: node.targets.flatMap((target) => {
      const fraction = row.effects[target];
      return fraction === undefined ? [] : [{ target, fraction }];
    }),
    cost: {
      researchPoints: row.researchPoints,
      cashMinor: row.cashCostMinor,
      buildWeeks: row.buildWeeks,
    },
    released: node.released,
    status: state.status,
    requiredAcademyLevel: required.level,
    requiredAcademyName: required.name,
    startRefusal: state.startRefusal,
    startedAt: project?.startedAt.toISOString() ?? null,
    completesAt: project?.completesAt.toISOString() ?? null,
  };
}

/**
 * The whole tree, as this airline stands in it.
 *
 * Everything in one response, for the reason the academy and roster endpoints
 * return the whole state: starting a project changes the points, the cash, the
 * running project and every other node's `startRefusal` at once.
 *
 * `now` is the wall-clock instant the world's game time is read at; injectable
 * for tests, and the only real-time read on this path.
 */
export async function readResearch(
  db: Database,
  own: ResearchOwner,
  now: Date = new Date(),
): Promise<ResearchResponse> {
  const balance = (await loadWorldEconomyConfig(db, own.worldId)).research;
  const gameNow = await worldGameNow(db, own.worldId, now);

  const [position, account, projects, cashMinor, recent] = await Promise.all([
    academyPosition(db, own.airlineId),
    readResearchAccount(db, own.airlineId),
    projectsOf(db, own.airlineId),
    cashOf(db, own.airlineId),
    recentActivity(db, own.airlineId, gameNow),
  ]);

  const complete = completeResearchNodeIds(projects, gameNow);
  const active = activeResearchProject(projects, gameNow);
  const pointsBalance = researchPointsFromMilli(account.earnedMilli - account.spentMilli);
  const projectByNode = new Map(projects.map((project) => [project.nodeId, project] as const));

  return {
    points: {
      balance: pointsBalance,
      earnedTotal: researchPointsFromMilli(account.earnedMilli),
      recentPerDay: recent.pointsPerDay,
    },
    formula: {
      academyLevelSum: position.levelSum,
      academyStaffQuality: balance.pointsFormula.academyStaffQuality,
      scalingFactorHours: balance.pointsFormula.scalingFactorHours,
      fleetFlightHoursPerDay: recent.fleetHoursPerDay,
    },
    academy: {
      highestLevel: position.highest,
      researchTier: academyResearchTier(position.highest),
    },
    branches: RESEARCH_BRANCH_DEFINITIONS.map((definition) => ({
      branch: definition.branch,
      name: definition.name,
      summary: definition.summary,
      nodes: researchNodesInBranch(definition.branch).map((node) => {
        const row = balance.nodes[node.id];
        const state = researchNodeState({
          node,
          cost: { researchPoints: row.researchPoints, cashCostMinor: row.cashCostMinor },
          completeNodeIds: complete,
          activeNodeId: active?.nodeId ?? null,
          highestAcademyLevel: position.highest,
          pointsBalance,
          cashMinor,
        });
        return nodeView(node.id, balance, state, projectByNode.get(node.id));
      }),
    })),
    active:
      active === null
        ? null
        : {
            nodeId: active.nodeId,
            startedAt: active.startedAt.toISOString(),
            completesAt: active.completesAt.toISOString(),
          },
    gameNow: gameNow.toISOString(),
  };
}

/**
 * Start researching a node: spend its points and its cash, and set the clock
 * running.
 *
 * One transaction. The airline's `research_account` row is locked **first**,
 * before the projects are read, which serialises every start for the airline —
 * so *one project at a time*, a rule no constraint can state because "running"
 * depends on the game clock, holds against two requests arriving together.
 * Without a row there are no points, and a node costs points, so there is
 * nothing to race.
 *
 * The verdict is `researchNodeState`'s, the same function that labelled the
 * button: a request is refused for exactly the reason the tree showed.
 *
 * There is no lever on the wait. `researchCompletesAt` takes a start instant
 * and the world's build weeks and nothing else, so §10.3's *"you cannot rush
 * it"* is held by absence, as §10.1's build time is.
 */
export async function startResearch(
  db: Database,
  own: ResearchOwner,
  nodeId: ResearchNodeId,
  now: Date = new Date(),
): Promise<ResearchResult<{ projectId: string; completesAt: Date }>> {
  const balance = (await loadWorldEconomyConfig(db, own.worldId)).research;
  const row = balance.nodes[nodeId];
  /*
   * The world's instant, read once: the project's dates and the cash movement
   * dated beside them must agree. Game time throughout — the span by ADR-0026,
   * the movement's `occurred_at` by TIME-02.
   */
  const startedAt = await worldGameNow(db, own.worldId, now);
  const completesAt = researchCompletesAt(startedAt, row.buildWeeks);

  try {
    return await db.transaction(async (tx) => {
      const account = await lockResearchAccount(tx, own.airlineId);
      // In turn rather than together: one transaction is one connection.
      const position = await academyPosition(tx, own.airlineId);
      const projects = await projectsOf(tx, own.airlineId);
      const cashMinor = await cashOf(tx, own.airlineId);

      const state = researchNodeState({
        node: researchNode(nodeId),
        cost: { researchPoints: row.researchPoints, cashCostMinor: row.cashCostMinor },
        completeNodeIds: completeResearchNodeIds(projects, startedAt),
        activeNodeId: activeResearchProject(projects, startedAt)?.nodeId ?? null,
        highestAcademyLevel: position.highest,
        pointsBalance: researchPointsFromMilli(account.earnedMilli - account.spentMilli),
        cashMinor,
      });
      if (state.refusal !== null) return { ok: false, refusal: state.refusal };

      await debitResearchPoints(tx, own.airlineId, row.researchPoints * RESEARCH_MILLI_PER_POINT);

      const movement = await moveAirlineCash(tx, {
        airlineId: own.airlineId,
        amountMinor: -row.cashCostMinor,
        cause: 'research',
        reference: `${own.airlineId}:research:${nodeId}`,
        occurredAt: startedAt,
      });
      // The purse was read above, but another request may have spent from it
      // since. Throwing rolls the points back with the cash.
      if (movement.movement.balanceAfterMinor < 0) throw new InsufficientFunds();

      const projectId = randomUUID();
      await tx.insert(researchProject).values({
        id: projectId,
        worldId: own.worldId,
        airlineId: own.airlineId,
        nodeId,
        startedAt,
        completesAt,
        researchPoints: row.researchPoints,
        cashCostMinor: row.cashCostMinor,
      });

      return { ok: true, value: { projectId, completesAt } };
    });
  } catch (error) {
    if (error instanceof InsufficientFunds) return { ok: false, refusal: 'insufficient_funds' };
    throw error;
  }
}
