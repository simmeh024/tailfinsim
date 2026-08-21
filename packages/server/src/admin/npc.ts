import { and, count, eq, sql } from 'drizzle-orm';

import { type AdminNpcCarrier, type AdminNpcResponse } from '@tailfin/shared';

import { type Database } from '../db/client';
import { airline, route } from '../db/schema';
import { readNpcDecisions } from '../npc/decisions';

/**
 * NPC carriers, as the admin console sees them (M3-12).
 *
 * The third acceptance criterion: *"NPC decisions are logged and inspectable in
 * the admin console."* Inspectable is the operative word — a log nobody can
 * reach is a log nobody reads, and the question this page has to answer is the
 * one a player's support ticket will ask: *why did a competitor appear in my
 * market last week?*
 */

/**
 * Where a carrier flies from.
 *
 * Derived from its own network rather than stored, because a hub is not a fact
 * about an airline — it is a summary of where its routes happen to touch, and a
 * stored column would go stale the first time a carrier's network moved. The
 * airport appearing most often across its routes is the honest answer.
 */
async function hubsFor(db: Database, worldId: string): Promise<Map<string, string>> {
  const rows = await db
    .select({
      airlineId: route.airlineId,
      icao: route.originIcao,
      n: count(route.id),
    })
    .from(route)
    .innerJoin(airline, eq(airline.id, route.airlineId))
    .where(and(eq(route.worldId, worldId), eq(airline.kind, 'npc'), eq(route.active, true)))
    .groupBy(route.airlineId, route.originIcao);

  const best = new Map<string, { icao: string; n: number }>();
  for (const row of rows) {
    const current = best.get(row.airlineId);
    // Ties break on the code, so the same network always names the same hub.
    if (!current || row.n > current.n || (row.n === current.n && row.icao < current.icao)) {
      best.set(row.airlineId, { icao: row.icao, n: row.n });
    }
  }
  return new Map([...best].map(([id, v]) => [id, v.icao]));
}

export async function buildNpcReport(
  db: Database,
  worldId: string,
  decisionLimit = 100,
): Promise<AdminNpcResponse> {
  const rows = await db
    .select({
      airlineId: airline.id,
      name: airline.name,
      iataCode: airline.iataCode,
      icaoCode: airline.icaoCode,
      archetype: airline.archetype,
      baseCountry: airline.baseCountry,
      cashMinor: airline.cashMinor,
      reputation: airline.reputation,
    })
    .from(airline)
    .where(and(eq(airline.worldId, worldId), eq(airline.kind, 'npc')))
    .orderBy(airline.name);

  // A grouped query and a lookup rather than a correlated subquery in the
  // select list — the pattern CLAUDE.md records after a correlated `select`
  // came back empty against real Postgres.
  const routeCounts = await db
    .select({ airlineId: route.airlineId, n: count(route.id) })
    .from(route)
    .innerJoin(airline, eq(airline.id, route.airlineId))
    .where(and(eq(route.worldId, worldId), eq(airline.kind, 'npc'), eq(route.active, true)))
    .groupBy(route.airlineId);

  const byAirline = new Map(routeCounts.map((r) => [r.airlineId, r.n]));
  const hubs = await hubsFor(db, worldId);

  const carriers: AdminNpcCarrier[] = rows.flatMap((row) => {
    // The `airline_kind_matches_operator` check guarantees an NPC has one, but
    // the column is nullable because player airlines do not. A row that somehow
    // lost it is dropped rather than shown as a carrier of no kind.
    if (row.archetype === null) return [];
    return [
      {
        airlineId: row.airlineId,
        name: row.name,
        iataCode: row.iataCode,
        icaoCode: row.icaoCode,
        archetype: row.archetype,
        baseCountry: row.baseCountry,
        hubIcao: hubs.get(row.airlineId) ?? null,
        routes: byAirline.get(row.airlineId) ?? 0,
        cashMinor: row.cashMinor,
        // `numeric(3,2)` is a string at the driver boundary.
        reputation: Number(row.reputation),
      },
    ];
  });

  return {
    carriers,
    decisions: await readNpcDecisions(db, worldId, decisionLimit),
    // Asked of the table rather than inferred from `carriers.length`: a world
    // whose carriers have all ceased is seeded and empty, which is a different
    // problem from a world that was never seeded at all.
    seeded: await worldSeeded(db, worldId),
  };
}

async function worldSeeded(db: Database, worldId: string): Promise<boolean> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(airline)
    .where(and(eq(airline.worldId, worldId), eq(airline.kind, 'npc')));
  return (rows[0]?.n ?? 0) > 0;
}
