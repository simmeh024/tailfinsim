import { and, eq } from 'drizzle-orm';

import {
  RESEARCH_NODE_IDS,
  type DoctrineView,
  type ResearchBalance,
  type ResearchNodeId,
} from '@tailfin/shared';
import {
  changeDoctrineFunding,
  doctrineBoosts,
  doctrineFundedDuring,
  doctrineSettlesAt,
  doctrineStrength,
  type DoctrineBoosts,
  type DoctrineFundingState,
} from '@tailfin/sim';

import { moveAirlineCash } from '../airline/cash';
import { monthAfter, previousMonth } from '../crew/payroll';
import { cashMovement, researchProject } from '../db/schema';
import { loadWorldEconomyConfig } from '../economy/loader';

import type { Database } from '../db/client';

/**
 * §10.4's third rule, on the server: doctrine that is applied, paid for, and
 * lapses when it is not (M9-06).
 *
 * > *"**Upkeep.** Academies and research carry ongoing cost. Doctrine lapses if
 * > you stop funding it — advantages must be maintained, not just banked."*
 *
 * Three things live here, because all three read the same three columns on
 * `research_project` and must agree about them:
 *
 *   - **What a node is worth now.** `doctrineStrength` over the stored funding
 *     state, at a game instant the caller supplies — the arrival for a
 *     settlement, the departure for a disruption roll, the world's clock for the
 *     page. A replay of an old arrival reads the strength it had then.
 *   - **What a month costs.** `runResearchUpkeep` bills the game month that has
 *     just closed, once, for every completed node that was funded at any point
 *     of it — the academy upkeep's shape exactly, idempotent by AIR-06's
 *     reference and needing no "last billed" column.
 *   - **Changing funding.** `setDoctrineFunding` bills any closed month first,
 *     then records the change. That order is what makes a month's facts final
 *     once it closes: a change can never land after the end of a month nobody
 *     has billed, so the worker and the handler always compute the same bill.
 */

/** A completed-or-running project, as doctrine reads it. */
export interface DoctrineProject {
  nodeId: ResearchNodeId;
  completesAt: Date;
  cashCostMinor: number;
  funded: boolean;
  fundingChangedAt: Date | null;
  strengthAtChangePermille: number;
}

const PERMILLE = 1_000;
const KNOWN_NODES = new Set<string>(RESEARCH_NODE_IDS);

/** The airline's projects with their funding columns. Unknown nodes (a later build's) are skipped. */
export async function doctrineProjectsOf(
  db: Database,
  airlineId: string,
): Promise<DoctrineProject[]> {
  const rows = await db
    .select({
      nodeId: researchProject.nodeId,
      completesAt: researchProject.completesAt,
      cashCostMinor: researchProject.cashCostMinor,
      funded: researchProject.funded,
      fundingChangedAt: researchProject.fundingChangedAt,
      strengthAtChangePermille: researchProject.strengthAtChangePermille,
    })
    .from(researchProject)
    .where(eq(researchProject.airlineId, airlineId));
  return rows
    .filter((row) => KNOWN_NODES.has(row.nodeId))
    .map((row) => ({ ...row, nodeId: row.nodeId as ResearchNodeId }));
}

/**
 * The stored funding state as `@tailfin/sim` reads it.
 *
 * **A null `funding_changed_at` is a change at `completes_at`** — funded since
 * the node completed, at full strength. That is every node nobody has touched,
 * and every row written before M9-06, without a backfill.
 */
export function fundingStateOf(project: DoctrineProject): DoctrineFundingState {
  return {
    funded: project.funded,
    strengthAtChange: project.strengthAtChangePermille / PERMILLE,
    changedAt: project.fundingChangedAt ?? project.completesAt,
  };
}

function isComplete(project: DoctrineProject, at: Date): boolean {
  return project.completesAt.getTime() <= at.getTime();
}

/** What a completed node costs a month to keep funded, on the price actually paid. */
export function monthlyUpkeepMinor(project: DoctrineProject, balance: ResearchBalance): number {
  return Math.round(project.cashCostMinor * balance.upkeep.monthlyFractionOfCashCost);
}

/** A node's doctrine standing for the page, or null until it is complete. */
export function doctrineViewOf(
  project: DoctrineProject | undefined,
  at: Date,
  balance: ResearchBalance,
): DoctrineView | null {
  if (project === undefined || !isComplete(project, at)) return null;
  const state = fundingStateOf(project);
  return {
    funded: project.funded,
    strength: doctrineStrength(state, at, balance.upkeep),
    monthlyUpkeepMinor: monthlyUpkeepMinor(project, balance),
    settlesAt: doctrineSettlesAt(state, balance.upkeep)?.toISOString() ?? null,
  };
}

/**
 * The airline's doctrine at a game instant, as a §10.4 boost source and a crew
 * XP fraction: every complete node at its current strength.
 *
 * Pure over the projects, so a caller already holding them — the page — does
 * not read them twice.
 */
export function doctrineAt(
  projects: readonly DoctrineProject[],
  at: Date,
  balance: ResearchBalance,
): DoctrineBoosts {
  const byNode = new Map(projects.map((project) => [project.nodeId, project] as const));
  const complete = projects.filter((project) => isComplete(project, at)).map((p) => p.nodeId);
  return doctrineBoosts(complete, balance, (nodeId) => {
    const project = byNode.get(nodeId);
    return project === undefined
      ? 0
      : doctrineStrength(fundingStateOf(project), at, balance.upkeep);
  });
}

/** {@link doctrineAt}, reading the projects. */
export async function airlineDoctrine(
  db: Database,
  airlineId: string,
  at: Date,
  balance: ResearchBalance,
): Promise<DoctrineBoosts> {
  return doctrineAt(await doctrineProjectsOf(db, airlineId), at, balance);
}

// ---------------------------------------------------------------------------
// Upkeep
// ---------------------------------------------------------------------------

/** The month's bounds, `[start, end)`, for a `YYYY-MM` period. Game time. */
function monthBounds(period: string): { start: Date; end: Date } {
  return {
    start: new Date(`${period}-01T00:00:00.000Z`),
    end: new Date(`${monthAfter(period)}-01T00:00:00.000Z`),
  };
}

/**
 * What one airline owes for one closed month of doctrine.
 *
 * Every node complete before the month ended and funded at **any** instant of
 * it — `doctrineFundedDuring` — at its own monthly rate. A node completed
 * mid-month pays the whole month, as an academy level commissioned mid-month
 * does; switching funding off on the month's last day does not escape it.
 */
export function researchUpkeepForMonth(
  projects: readonly DoctrineProject[],
  period: string,
  balance: ResearchBalance,
): number {
  const { start, end } = monthBounds(period);
  let total = 0;
  for (const project of projects) {
    if (project.completesAt.getTime() >= end.getTime()) continue;
    if (!doctrineFundedDuring(fundingStateOf(project), start, end)) continue;
    total += monthlyUpkeepMinor(project, balance);
  }
  return total;
}

function upkeepReference(airlineId: string, period: string): string {
  return `research_upkeep:${airlineId}:${period}`;
}

/**
 * Bill the closed month for one airline, inside the caller's transaction.
 *
 * Reads the reference first and returns without moving anything when the month
 * is already billed — AIR-06's replay guard asserts a replay carries the same
 * facts, and checking first keeps a re-run from ever asking it to.
 */
export async function billResearchUpkeepForAirline(
  tx: Database,
  airlineId: string,
  gameNow: Date,
  balance: ResearchBalance,
): Promise<number> {
  const period = previousMonth(gameNow);
  const reference = upkeepReference(airlineId, period);
  const [billed] = await tx
    .select({ id: cashMovement.id })
    .from(cashMovement)
    .where(and(eq(cashMovement.cause, 'research_upkeep'), eq(cashMovement.reference, reference)))
    .limit(1);
  if (billed !== undefined) return 0;

  const amount = researchUpkeepForMonth(await doctrineProjectsOf(tx, airlineId), period, balance);
  if (amount <= 0) return 0;

  const result = await moveAirlineCash(tx, {
    airlineId,
    amountMinor: -amount,
    cause: 'research_upkeep',
    reference,
    occurredAt: monthBounds(period).end,
  });
  return result.status === 'already-applied' ? 0 : amount;
}

export interface ResearchUpkeepResult {
  airlinesBilled: number;
  totalMinor: number;
}

/**
 * The worker's sweep: bill the month that has just closed, for every airline in
 * the world holding a completed node (M9-06).
 *
 * The academy upkeep's shape — attempted every tick, bills once, self-heals
 * across a month boundary the worker was down for. **Production has no worker**,
 * so there doctrine is never billed: it is applied (the settlement that reads it
 * is the worker's too, so on production nothing is applied either) and costs
 * nothing, which is consistent if useless — the same trap as every other sweep.
 */
export async function runResearchUpkeep(
  db: Database,
  worldId: string,
  gameNow: Date,
): Promise<ResearchUpkeepResult> {
  const balance = (await loadWorldEconomyConfig(db, worldId)).research;
  const rows = await db
    .selectDistinct({ airlineId: researchProject.airlineId })
    .from(researchProject)
    .where(eq(researchProject.worldId, worldId));

  let airlinesBilled = 0;
  let totalMinor = 0;
  for (const { airlineId } of rows) {
    /*
     * One transaction per airline, and not optional: `moveAirlineCash` inserts
     * the movement and then updates the balance, and the reconciliation trigger
     * is deferred — outside a transaction the insert commits alone and the
     * trigger refuses it. `runAcademyUpkeep` records the same lesson.
     */
    const amount = await db.transaction((tx) =>
      billResearchUpkeepForAirline(tx, airlineId, gameNow, balance),
    );
    if (amount > 0) {
      airlinesBilled += 1;
      totalMinor += amount;
    }
  }
  return { airlinesBilled, totalMinor };
}

// ---------------------------------------------------------------------------
// Funding
// ---------------------------------------------------------------------------

export type DoctrineFundingOutcome =
  | { ok: true }
  /** The airline never researched this node: the endpoint's 404. */
  | { ok: false; kind: 'absent' }
  /** Still being researched: nothing to fund yet. */
  | { ok: false; kind: 'not_complete' };

/**
 * Fund a completed node, or stop funding it (M9-06).
 *
 * A level, not a toggle: asking for the state it is already in changes nothing
 * and moves nothing. The project row is locked first, then any closed month is
 * billed **before** the change is written — see the file comment for why that
 * order makes every month's bill final.
 *
 * The strength is carried across the change, so stopping and restarting costs a
 * stretch of lapse and recovery and is never a free reset.
 */
export async function setDoctrineFunding(
  db: Database,
  own: { worldId: string; airlineId: string },
  nodeId: ResearchNodeId,
  funded: boolean,
  gameNow: Date,
  balance: ResearchBalance,
): Promise<DoctrineFundingOutcome> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: researchProject.id,
        nodeId: researchProject.nodeId,
        completesAt: researchProject.completesAt,
        cashCostMinor: researchProject.cashCostMinor,
        funded: researchProject.funded,
        fundingChangedAt: researchProject.fundingChangedAt,
        strengthAtChangePermille: researchProject.strengthAtChangePermille,
      })
      .from(researchProject)
      .where(
        and(
          eq(researchProject.worldId, own.worldId),
          eq(researchProject.airlineId, own.airlineId),
          eq(researchProject.nodeId, nodeId),
        ),
      )
      .limit(1)
      .for('update');
    if (row === undefined) return { ok: false, kind: 'absent' };

    const project: DoctrineProject = { ...row, nodeId };
    if (!isComplete(project, gameNow)) return { ok: false, kind: 'not_complete' };

    await billResearchUpkeepForAirline(tx, own.airlineId, gameNow, balance);
    if (project.funded === funded) return { ok: true };

    const next = changeDoctrineFunding(fundingStateOf(project), funded, gameNow, balance.upkeep);
    await tx
      .update(researchProject)
      .set({
        funded: next.funded,
        fundingChangedAt: next.changedAt,
        strengthAtChangePermille: Math.round(next.strengthAtChange * PERMILLE),
      })
      .where(eq(researchProject.id, row.id));
    return { ok: true };
  });
}
