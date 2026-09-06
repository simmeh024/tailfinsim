import { and, eq, ne, or, sql } from 'drizzle-orm';

import {
  CABIN_ORDER,
  type CabinClass,
  FareTable,
  type ServicePackageContent,
} from '@tailfin/shared';
import { asOperator, type ClassOperator, frequencyFor, productScoreForPackage } from '@tailfin/sim';

import { type Database } from '../db/client';
import { airline, route } from '../db/schema';
import { type PinnedEconomyConfig } from '../economy/config';
import { servicePackageForRoutes } from '../service/store';

import { canonicalPair } from './economics';

/**
 * Who else is selling this market (M3-12).
 *
 * Until M3-12 this list was empty and the comment above it said why:
 * *"Competitors are not [real]. Nobody else is flying, because there are no AI
 * carriers (M3-12) and one player. An empty competitor list is a real state,
 * not a stub — a monopoly is a market of one."*
 *
 * It is no longer a monopoly. This turns the other airlines on a pair into the
 * `ClassOperator` shape A.3's logit consumes, and it does so for **players and
 * NPCs alike** — a rival player is a competitor by exactly the same mechanism,
 * which is what stops the NPC path from becoming a second way of being in a
 * market.
 *
 * ## Both directions of the pair
 *
 * A `route` is directional and a market is not. An airline flying LEBL→EHAM is
 * competing with one flying EHAM→LEBL for the same passengers, and matching
 * only the stored direction would produce two carriers on one market, each
 * believing it had the market to itself. Same reconciliation `poolsFor` needed.
 */

/**
 * What a player's competing route is assumed to offer.
 *
 * A player has no schedule attached to a route yet, so their frequency is
 * reconstructed the same way `REFERENCE_SELF` reconstructs the viewer's own.
 *
 * **`productScore` is no longer among the assumptions.** Since M8-04 a rival's
 * product is assembled from their *actual* service package, through the same
 * `sim/service/product-score.ts` that scores the viewer's own — because a
 * competitor's product is not private to the simulation. Passengers experience
 * it, and App. A.3 cannot allocate them without it.
 *
 * What is still a reference for a rival is their **execution**: App. D.1's
 * levers are that airline's crew morale and their caterer's grade, and reading
 * every competitor's crew base and contracts on every route view would be a
 * query per rival per lever for a number the viewer sees as an estimate. So a
 * rival's package is real and their execution is the configured reference,
 * which is stated here rather than hidden in a middling constant.
 */
const PLAYER_ASSUMPTION = { frequency: 2 };

export interface CompetitorQuery {
  worldId: string;
  originIcao: string;
  destinationIcao: string;
  /** The airline asking. Excluded, because you do not compete with yourself. */
  excludeAirlineId: string;
  economy: PinnedEconomyConfig;
  /** Seats per cabin a player-operated competitor is assumed to fly. */
  playerSeatsByCabin: Partial<Record<CabinClass, number>>;
}

export async function competitorsFor(
  db: Database,
  query: CompetitorQuery,
): Promise<ClassOperator[]> {
  const [a, b] = canonicalPair(query.originIcao, query.destinationIcao);

  const rows = await db
    .select({
      routeId: route.id,
      airlineId: route.airlineId,
      originIcao: route.originIcao,
      fares: route.fares,
      kind: airline.kind,
      archetype: airline.archetype,
      reputation: airline.reputation,
    })
    .from(route)
    .innerJoin(airline, eq(airline.id, route.airlineId))
    .where(
      and(
        eq(route.worldId, query.worldId),
        eq(route.active, true),
        ne(route.airlineId, query.excludeAirlineId),
        // A ceased airline is history, not competition (AIR-09).
        eq(airline.status, 'active'),
        or(
          and(eq(route.originIcao, a), eq(route.destinationIcao, b)),
          and(eq(route.originIcao, b), eq(route.destinationIcao, a)),
        ),
      ),
    );

  /*
   * Every rival's service package, in one query rather than one per rival.
   * `servicePackageForRoutes` is scoped by airline, so this asks per airline —
   * grouped so a market with four rivals costs four statements at worst rather
   * than four per cabin.
   */
  const packages = new Map<string, ServicePackageContent>();
  const routesByAirline = new Map<string, string[]>();
  for (const row of rows) {
    if (row.kind === 'npc') continue;
    routesByAirline.set(row.airlineId, [
      ...(routesByAirline.get(row.airlineId) ?? []),
      row.routeId,
    ]);
  }
  await Promise.all(
    [...routesByAirline].map(async ([airlineId, routeIds]) => {
      const resolved = await servicePackageForRoutes(db, airlineId, routeIds);
      for (const [routeId, entry] of resolved) packages.set(routeId, entry.content);
    }),
  );

  const operators: ClassOperator[] = [];

  for (const row of rows) {
    // A malformed fare table skips the operator rather than failing the whole
    // market preview. One competitor missing from a panel is recoverable; a
    // route page that will not load because a rival stored bad JSON is not.
    const parsed = FareTable.safeParse(JSON.parse(row.fares) as unknown);
    if (!parsed.success) continue;

    const operator =
      row.kind === 'npc' && row.archetype !== null
        ? npcOperator(row.airlineId, parsed.data, query.economy, row.archetype)
        : playerOperator(
            row.airlineId,
            parsed.data,
            query.playerSeatsByCabin,
            row.reputation,
            rivalProduct(row.routeId, packages, query.economy, query.playerSeatsByCabin),
          );

    if (operator !== null) operators.push(operator);
  }

  return operators;
}

function npcOperator(
  airlineId: string,
  fares: FareTable,
  economy: PinnedEconomyConfig,
  archetype: NonNullable<(typeof airline.archetype)['_']['data']>,
): ClassOperator | null {
  const profile = economy.npc.archetypes[archetype];
  const cabins: Partial<Record<CabinClass, { seats: number; fareMinor: number }>> = {};

  for (const cabin of CABIN_ORDER) {
    const seats = profile.seatsByCabin[cabin];
    const fareMinor = fares[cabin];
    if (seats > 0 && fareMinor !== undefined && fareMinor > 0) {
      cabins[cabin] = { seats, fareMinor };
    }
  }
  if (Object.keys(cabins).length === 0) return null;

  // Frequency from the archetype's own sizing rule rather than stored, so a
  // retune of `targetShare` moves every NPC's frequency without a migration.
  // The seats it is sized against are the archetype's, which is the same number
  // the cabins above are built from.
  const seatsTotal = CABIN_ORDER.reduce((sum, c) => sum + profile.seatsByCabin[c], 0);
  const economyFare = fares.economy ?? Object.values(cabins)[0]!.fareMinor;

  return asOperator(
    {
      operatorId: airlineId,
      // Sized to the seats actually on offer. A market's size is not known here
      // — the caller has it — so the archetype's cap stands in, which is the
      // conservative reading: an NPC never claims more frequency than its
      // archetype allows.
      frequency: frequencyFor(profile, seatsTotal * profile.maxFrequency, seatsTotal),
      economyFareMinor: economyFare,
      cabins,
    },
    profile,
  );
}

/**
 * A rival's product: their real package, at the reference execution.
 *
 * The same assembly the viewer's own score uses — that is M8-04's second
 * acceptance criterion — with the execution left at the configured reference for
 * the reason `PLAYER_ASSUMPTION` gives.
 */
function rivalProduct(
  routeId: string,
  packages: Map<string, ServicePackageContent>,
  economy: PinnedEconomyConfig,
  seatsByCabin: Partial<Record<CabinClass, number>>,
): { overall: number; byCabin: Partial<Record<CabinClass, number>> } {
  const content = packages.get(routeId) ?? { perClass: {}, commercialIntensity: 0 };
  const execution = economy.service.execution.fallback;

  const byCabin: Partial<Record<CabinClass, number>> = {};
  let weighted = 0;
  let seats = 0;
  for (const cabin of CABIN_ORDER) {
    const cabinSeats = seatsByCabin[cabin] ?? 0;
    if (cabinSeats <= 0) continue;
    const score = productScoreForPackage(economy.service, {
      content,
      cabin,
      execution,
      seat: null,
    }).score;
    byCabin[cabin] = score;
    weighted += score * cabinSeats;
    seats += cabinSeats;
  }

  return {
    overall:
      seats > 0
        ? weighted / seats
        : productScoreForPackage(economy.service, {
            content,
            cabin: 'economy',
            execution,
            seat: null,
          }).score,
    byCabin,
  };
}

function playerOperator(
  airlineId: string,
  fares: FareTable,
  seatsByCabin: Partial<Record<CabinClass, number>>,
  reputation: string,
  product: { overall: number; byCabin: Partial<Record<CabinClass, number>> },
): ClassOperator | null {
  const cabins: Partial<
    Record<CabinClass, { seats: number; fareMinor: number; productScore?: number }>
  > = {};

  for (const cabin of CABIN_ORDER) {
    const seats = seatsByCabin[cabin] ?? 0;
    const fareMinor = fares[cabin];
    if (seats > 0 && fareMinor !== undefined && fareMinor > 0) {
      cabins[cabin] = { seats, fareMinor, productScore: product.byCabin[cabin] };
    }
  }
  if (Object.keys(cabins).length === 0) return null;

  return {
    id: airlineId,
    frequency: PLAYER_ASSUMPTION.frequency,
    productScore: product.overall,
    // `numeric(3,2)` is a string at the driver boundary — the trap CLAUDE.md
    // records — so it is parsed rather than trusted.
    reputation: Number(reputation),
    cabins,
  };
}

/** How many active airlines sell a market. Used by the entry decision. */
export async function operatorCount(
  db: Database,
  worldId: string,
  originIcao: string,
  destinationIcao: string,
): Promise<number> {
  const [a, b] = canonicalPair(originIcao, destinationIcao);
  const rows = await db
    .select({ n: sql<number>`count(distinct ${route.airlineId})::int` })
    .from(route)
    .innerJoin(airline, eq(airline.id, route.airlineId))
    .where(
      and(
        eq(route.worldId, worldId),
        eq(route.active, true),
        eq(airline.status, 'active'),
        or(
          and(eq(route.originIcao, a), eq(route.destinationIcao, b)),
          and(eq(route.originIcao, b), eq(route.destinationIcao, a)),
        ),
      ),
    );
  return rows[0]?.n ?? 0;
}
