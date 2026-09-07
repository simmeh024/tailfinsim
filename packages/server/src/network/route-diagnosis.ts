import { and, eq, gte } from 'drizzle-orm';

import type { RouteDiagnosisResponse, RouteCompetitionResponse } from '@tailfin/shared';
import {
  addFlight,
  cask,
  diagnoseRoute,
  emptyTraffic,
  loadFactor,
  medianOf,
  NM_TO_KM,
  passengerYield,
  type PeerBenchmark,
  type TrafficTotals,
} from '@tailfin/sim';

import { flight, flightResult, route } from '../db/schema';
import { worldGameNow } from '../world/game-now';

import type { ResolvedPlayerAirline } from '../airline/context';
import type { Database } from '../db/client';

/**
 * §14.4's drill-down, fed real trading (M8-11).
 *
 * > …the drill-down tells you whether it's yield, cost, load factor or a
 * > competitor — and therefore whether to reprice, re-gauge, re-time, or kill it.
 *
 * The decision is `@tailfin/sim`'s. This module answers the three questions it
 * cannot: what this route actually did, what the airline's *other* routes look
 * like, and who else is in the market.
 *
 * ## Why this is per route rather than part of the chart
 *
 * §14.4's chart has to work with three hundred routes (M8-11's second criterion),
 * and the competitive share behind the fourth cause comes from running App. A's
 * share model against a market. Three hundred of those on one page load would
 * make the chart the slowest screen in the game.
 *
 * So the split is: the **chart** reads `GET /api/statistics/operating_profit/
 * breakdown?by=route`, which is one grouped query however many routes there are,
 * and the **diagnosis** is this endpoint, one route at a time, on a click. The
 * expensive half is paid per question asked rather than per render.
 *
 * ## The benchmark is the airline's own median
 *
 * Not a world median: §14.6 asks for *"benchmarks against world median for your
 * fleet size"* and nothing computes one yet. Saying "worse than your own
 * average" is the comparison a player can act on today, and it is honest about
 * what it is. The one thing it must not do is pretend to be the other.
 */

/** The window both the route and its peers are measured over, in game days. */
const WINDOW_DAYS = 30;

/**
 * Rival share above which a thin route is somebody else's market.
 *
 * Sixty per cent: a rival with more of the traffic than you is winning the
 * market rather than sharing it, and re-timing into that is the intervention
 * §14.4 wants a player warned off. A decision-support threshold rather than a
 * balance number — nothing prices off it and no `flight_result` is billed
 * against it — so it lives here beside the window, the same way
 * `network/performance.ts` owns its trend window.
 */
const RIVAL_SHARE_THRESHOLD = 0.6;

const DAY_MS = 86_400_000;

interface RouteTotals {
  routeId: string | null;
  label: string;
  totals: TrafficTotals;
}

/** Fold this airline's settled flights into per-route totals over the window. */
async function totalsByRoute(
  db: Database,
  own: ResolvedPlayerAirline,
  since: Date,
): Promise<Map<string, RouteTotals>> {
  const rows = await db
    .select({
      routeId: route.id,
      originIcao: flight.originIcao,
      destinationIcao: flight.destinationIcao,
      greatCircleNm: route.greatCircleNm,
      seats: flightResult.seats,
      passengers: flightResult.passengers,
      spilledPassengers: flightResult.spilledPassengers,
      cargoKg: flightResult.cargoKg,
      revenueMinor: flightResult.revenueMinor,
      costMinor: flightResult.costMinor,
      blockSeconds: flightResult.blockSeconds,
      arrivalDelayMinutes: flightResult.arrivalDelayMinutes,
    })
    .from(flightResult)
    .innerJoin(flight, eq(flight.id, flightResult.flightId))
    .leftJoin(
      route,
      and(
        eq(route.airlineId, flightResult.airlineId),
        eq(route.originIcao, flight.originIcao),
        eq(route.destinationIcao, flight.destinationIcao),
      ),
    )
    .where(
      and(
        eq(flightResult.airlineId, own.id),
        eq(flightResult.kind, 'scheduled'),
        gte(flightResult.settledAt, since),
      ),
    );

  const byRoute = new Map<string, RouteTotals>();
  for (const row of rows) {
    const label = `${row.originIcao}–${row.destinationIcao}`;
    const key = row.routeId ?? label;
    const entry = byRoute.get(key) ?? { routeId: row.routeId, label, totals: emptyTraffic() };
    entry.totals = addFlight(entry.totals, {
      seats: row.seats,
      passengers: row.passengers,
      spilledPassengers: row.spilledPassengers,
      cargoKg: row.cargoKg,
      distanceKm: (row.greatCircleNm ?? 0) * NM_TO_KM,
      revenueMinor: row.revenueMinor,
      costMinor: row.costMinor,
      blockSeconds: row.blockSeconds,
      // The on-time flag does not reach the diagnosis; folded for shape only.
      onTime: row.arrivalDelayMinutes <= 15,
    });
    byRoute.set(key, entry);
  }
  return byRoute;
}

/**
 * The airline's median route, excluding the one being diagnosed.
 *
 * Excluded on purpose: a route compared against a median it is itself inside
 * pulls the benchmark toward its own figure, and the effect is largest exactly
 * when it matters most — a two-route airline diagnosing one of them would be
 * comparing it against the average of itself and one other.
 */
function peersExcluding(routes: Iterable<RouteTotals>, excludeKey: string): PeerBenchmark {
  const yields: (number | null)[] = [];
  const casks: (number | null)[] = [];
  const loads: (number | null)[] = [];
  let counted = 0;

  for (const entry of routes) {
    const key = entry.routeId ?? entry.label;
    if (key === excludeKey) continue;
    counted += 1;
    yields.push(passengerYield(entry.totals));
    casks.push(cask(entry.totals));
    loads.push(loadFactor(entry.totals));
  }

  return {
    yieldMinor: medianOf(yields),
    caskMinor: medianOf(casks),
    loadFactor: medianOf(loads),
    routes: counted,
  };
}

/**
 * Diagnose one of the airline's routes, or null if it is not theirs.
 *
 * Concealed by resolution like every private id (ADR-0020): a stranger's route
 * and a route that does not exist receive the same answer.
 *
 * `competition` is passed in rather than read here, because building it needs
 * the route row and the economics provider the network routes already hold — and
 * because a caller that cannot afford the share model can omit it and still get
 * a diagnosis, with the competitor cause simply unavailable.
 */
export async function diagnoseOwnRoute(
  db: Database,
  own: ResolvedPlayerAirline,
  routeId: string,
  competition: RouteCompetitionResponse | null,
): Promise<RouteDiagnosisResponse | null> {
  const [owned] = await db
    .select({
      id: route.id,
      originIcao: route.originIcao,
      destinationIcao: route.destinationIcao,
    })
    .from(route)
    .where(and(eq(route.id, routeId), eq(route.airlineId, own.id), eq(route.worldId, own.worldId)))
    .limit(1);
  if (!owned) return null;

  const gameNow = await worldGameNow(db, own.worldId);
  const byRoute = await totalsByRoute(db, own, new Date(gameNow.getTime() - WINDOW_DAYS * DAY_MS));

  const label = `${owned.originIcao}–${owned.destinationIcao}`;
  const mine = byRoute.get(owned.id) ?? { routeId: owned.id, label, totals: emptyTraffic() };
  const peers = peersExcluding(byRoute.values(), owned.id);

  /*
   * Everyone except this airline. `share` is App. A.4's projected share of the
   * market's daily demand, so summing the rivals is the share of the market the
   * airline does *not* hold — which is the question the fourth cause asks.
   */
  const rivalShare =
    competition === null
      ? null
      : Math.min(
          1,
          Math.max(
            0,
            competition.operators
              .filter((operator) => !operator.isYou)
              .reduce((total, operator) => total + operator.share, 0),
          ),
        );

  const diagnosis = diagnoseRoute({
    totals: mine.totals,
    peers,
    rivalShare,
    rivalShareThreshold: RIVAL_SHARE_THRESHOLD,
  });

  return {
    routeId: owned.id,
    label,
    windowDays: WINDOW_DAYS,
    gameNow: gameNow.toISOString(),
    flights: mine.totals.flights,
    cause: diagnosis.cause,
    action: diagnosis.action,
    contributionMinor: diagnosis.contributionMinor,
    loadFactor: diagnosis.loadFactor,
    breakevenLoadFactor: diagnosis.breakevenLoadFactor,
    unfillable: diagnosis.unfillable,
    rivalShare: diagnosis.rivalShare,
    rivalShareThreshold: RIVAL_SHARE_THRESHOLD,
    peerRoutes: peers.routes,
    gaps: {
      yield: diagnosis.gaps.yield,
      cost: diagnosis.gaps.cost,
      load: diagnosis.gaps.load,
    },
  };
}
