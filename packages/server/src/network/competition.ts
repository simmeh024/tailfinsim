import { inArray } from 'drizzle-orm';

import type { RouteCompetitionResponse, RouteCompetitor } from '@tailfin/shared';
import { allocateByClass } from '@tailfin/sim';

import { airline } from '../db/schema';

import { passengersFor, selfAsOperator, type RouteEconomics, type RouteRow } from './fares';

import type { ResolvedPlayerAirline } from '../airline/context';
import type { Database } from '../db/client';

/**
 * Who else is in a route's market, and how much of it each takes (M3-12, §8.3).
 *
 * The live competition read the network page's mock stood in for. It runs the
 * **same** `allocateByClass` the fares preview and the waterfall run, over the
 * same operators — so the share it reports for a rival and the projection the
 * pricing panel draws for you cannot disagree. `you` are one of the operators, so
 * the market reads as a whole rather than as an implied self against "them".
 *
 * Every figure is a projection of the market model, not a rollup of flown
 * flights — it answers *"who is here and how strong are they"* at today's fares,
 * which is a different question from `performance.ts`'s *"what did the route do"*.
 * It therefore needs no worker: a monopoly on a fresh world is a real answer (you,
 * at share 1), not an empty one.
 */

/** One daily departure is `1/7` of a week; the panel shows weekly frequency. */
const DAYS_PER_WEEK = 7;

/** What an operator is called — the one thing the market model does not carry. */
export interface OperatorName {
  name: string;
  kind: 'player' | 'npc';
}

/**
 * Build the market for one owned route, given the operators' names.
 *
 * Pure and testable like the waterfall: the caller resolves `row` and
 * `economics` (the same `ownedRoute` and `economicsFor` every route endpoint
 * uses) and supplies the names. All the arithmetic — the shared share model, the
 * share of each operator, the sort — is here.
 */
export function buildCompetition(
  own: ResolvedPlayerAirline,
  row: RouteRow,
  economics: RouteEconomics,
  names: ReadonlyMap<string, OperatorName>,
): RouteCompetitionResponse {
  const operators = [selfAsOperator(own.id, row.fares, economics), ...economics.competitors];
  const allocation = allocateByClass({ operators, segmentPools: economics.segmentPools });
  const { totalPool } = allocation;

  const competitors: RouteCompetitor[] = operators
    .map((operator): RouteCompetitor => {
      const meta = names.get(operator.id);
      const passengers = passengersFor(allocation, operator.id);
      return {
        airlineId: operator.id,
        name: meta?.name ?? 'Unknown carrier',
        kind: meta?.kind ?? 'player',
        isYou: operator.id === own.id,
        weeklyFrequency: Math.round(operator.frequency * DAYS_PER_WEEK),
        economyFareMinor: operator.cabins.economy?.fareMinor ?? null,
        share: totalPool > 0 ? Math.min(1, passengers / totalPool) : 0,
        productScore: operator.productScore,
      };
    })
    // Most of the market first — the reader's own line falls where its share puts
    // it, which is itself the answer to "how am I doing here".
    .sort((a, b) => b.share - a.share);

  return {
    routeId: row.id,
    marketDailyPassengers: totalPool,
    operators: competitors,
  };
}

/**
 * The market for one owned route, names looked up.
 *
 * The one thing {@link buildCompetition} needs the database for: NPC and player
 * alike are airlines, so a single indexed lookup names every operator.
 */
export async function routeCompetition(
  db: Database,
  own: ResolvedPlayerAirline,
  row: RouteRow,
  economics: RouteEconomics,
): Promise<RouteCompetitionResponse> {
  const ids = [own.id, ...economics.competitors.map((operator) => operator.id)];
  const names = new Map<string, OperatorName>();
  if (ids.length > 0) {
    const rows = await db
      .select({ id: airline.id, name: airline.name, kind: airline.kind })
      .from(airline)
      .where(inArray(airline.id, ids));
    for (const airlineRow of rows) {
      names.set(airlineRow.id, {
        name: airlineRow.name,
        kind: airlineRow.kind === 'npc' ? 'npc' : 'player',
      });
    }
  }
  return buildCompetition(own, row, economics, names);
}
