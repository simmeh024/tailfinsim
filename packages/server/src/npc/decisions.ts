import { desc, eq } from 'drizzle-orm';

import {
  type AdminNpcDecision,
  type NpcDecisionBasis,
  NpcDecisionBasis as NpcDecisionBasisSchema,
  type NpcDecisionKind,
} from '@tailfin/shared';

import { type Database } from '../db/client';
import { airline, npcDecision } from '../db/schema';

/**
 * The record of what an NPC did, and why (M3-12).
 *
 * The third acceptance criterion asks for NPC decisions to be *logged and
 * inspectable in the admin console*, and the reason is the one App. A.1 gives
 * about the demand model generally: a system whose behaviour cannot be
 * inspected is one players will assume is rigged. A competitor that appeared in
 * a player's market overnight with no visible reason is exactly that.
 *
 * Written in the same transaction as the change wherever there is one, for the
 * same reason `writeAudit` insists on it: a record written afterwards can go
 * missing precisely when the change was the surprising one.
 */

export interface PendingDecision {
  airlineId: string;
  /** **Game time** — the instant the world thinks this happened. */
  decidedAt: Date;
  kind: NpcDecisionKind;
  originIcao?: string;
  destinationIcao?: string;
  basis: NpcDecisionBasis;
  reason: string;
  economyConfigVersion: string;
}

/**
 * Write a batch of decisions.
 *
 * A batch rather than one at a time because a review cycle produces a handful
 * per carrier across sixty carriers, and sixty round trips per tick would make
 * the worker's cost dominated by its own bookkeeping.
 */
export async function recordDecisions(
  db: Database,
  worldId: string,
  decisions: readonly PendingDecision[],
): Promise<number> {
  if (decisions.length === 0) return 0;

  await db.insert(npcDecision).values(
    decisions.map((decision) => ({
      worldId,
      airlineId: decision.airlineId,
      decidedAt: decision.decidedAt,
      kind: decision.kind,
      originIcao: decision.originIcao ?? null,
      destinationIcao: decision.destinationIcao ?? null,
      // Parsed on the way in, so a malformed basis fails the write rather than
      // the admin console's response schema an hour later.
      basis: JSON.stringify(NpcDecisionBasisSchema.parse(decision.basis)),
      reason: decision.reason,
      economyConfigVersion: decision.economyConfigVersion,
    })),
  );

  return decisions.length;
}

/**
 * The most recent decisions in a world, newest first.
 *
 * Bounded, and deliberately so: `npc_decision` grows without limit and a console
 * page that asked for all of it would eventually ask for all of a very large
 * table. The bound is the page size, not a filter — an admin looking for an old
 * decision wants a query, and that is a later issue rather than a hidden limit
 * pretending to be a listing.
 */
export async function readNpcDecisions(
  db: Database,
  worldId: string,
  limit = 100,
): Promise<AdminNpcDecision[]> {
  const rows = await db
    .select({
      id: npcDecision.id,
      airlineId: npcDecision.airlineId,
      airlineName: airline.name,
      airlineIataCode: airline.iataCode,
      archetype: airline.archetype,
      decidedAt: npcDecision.decidedAt,
      recordedAt: npcDecision.recordedAt,
      kind: npcDecision.kind,
      originIcao: npcDecision.originIcao,
      destinationIcao: npcDecision.destinationIcao,
      basis: npcDecision.basis,
      reason: npcDecision.reason,
      economyConfigVersion: npcDecision.economyConfigVersion,
    })
    .from(npcDecision)
    .innerJoin(airline, eq(airline.id, npcDecision.airlineId))
    .where(eq(npcDecision.worldId, worldId))
    .orderBy(desc(npcDecision.decidedAt), desc(npcDecision.recordedAt))
    .limit(limit);

  return rows.flatMap((row) => {
    // The archetype cannot be null for an NPC — the `airline_kind_matches_operator`
    // check guarantees it — but the column is nullable for player airlines, so
    // the type says it might be. A row that somehow lost it is dropped rather
    // than rendered as a decision by nobody.
    if (row.archetype === null) return [];

    const parsed = NpcDecisionBasisSchema.safeParse(JSON.parse(row.basis));
    return [
      {
        id: row.id,
        airlineId: row.airlineId,
        airlineName: row.airlineName,
        airlineIataCode: row.airlineIataCode,
        archetype: row.archetype,
        decidedAt: row.decidedAt.toISOString(),
        recordedAt: row.recordedAt.toISOString(),
        kind: row.kind,
        originIcao: row.originIcao,
        destinationIcao: row.destinationIcao,
        // An unparseable basis is shown as empty rather than failing the page.
        // The reason sentence is written at decision time and stands alone.
        basis: parsed.success ? parsed.data : {},
        reason: row.reason,
        economyConfigVersion: row.economyConfigVersion,
      },
    ];
  });
}
