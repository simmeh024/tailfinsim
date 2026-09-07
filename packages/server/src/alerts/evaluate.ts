import { and, eq, gte, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';

import { AlertKind } from '@tailfin/shared';
import {
  availableHeads,
  evaluateAlerts,
  reconcileAlerts,
  requiredComplement,
  type AirlineAlertState,
  type AlertRouteState,
  type CheckDue,
  type ContractTerm,
  type CrewProjection,
  type RaisedAlert,
  type RouteDayContribution,
} from '@tailfin/sim';

import { fleetMaintenance } from '../aircraft/maintenance';
import {
  aircraftOrder,
  airframe,
  aircraftType,
  airline,
  alert,
  alertState,
  crewBase,
  crewPool,
  flight,
  flightResult,
  groundContract,
  route,
} from '../db/schema';
import { loadWorldEconomyConfig } from '../economy/loader';
import { readDebtServiceCoverage } from '../finance/credit';
import { readCashRunway } from '../finance/runway';

import {
  ALERT_THRESHOLDS,
  MAX_AIRLINES_PER_SWEEP,
  SWEEP_INTERVAL_GAME_HOURS,
  TRAFFIC_WINDOW_DAYS,
} from './thresholds';

import type { ResolvedPlayerAirline } from '../airline/context';
import type { Database } from '../db/client';

/**
 * §14.5's alert sweep (M8-13).
 *
 * ## Why this is the worker's, and what that costs on a node without one
 *
 * The digest is the reason. M8-13's first criterion is that it covers *"the
 * exact period since last seen"*, and a period only means something if the
 * things inside it are dated when they happened. Evaluating the rules on read
 * would date every alert at the moment the player looked, which puts all of them
 * inside every window and makes the digest a list of everything currently wrong
 * rather than a report of what changed while they were away.
 *
 * So the worker raises rows on the world's game clock. **Production has no
 * worker**, so there `swept_at` stays null for ever: no alert is ever raised, the
 * digest covers a period in which nothing is recorded as having happened, and
 * `GET /api/alerts` answers `200` with an empty list. That reads as an airline
 * with nothing wrong rather than as a missing process — the same trap as the
 * empty used market and the fleet page at `0.0 h/day` — which is precisely why
 * `evaluatedAt` is on the response and null there. `alertsRaised`,
 * `alertsResolved` and `alertErrors` are the counters that distinguish the two.
 *
 * ## The deduplication is a constraint, not a memory
 *
 * `reconcileAlerts` decides what is new; `alert_open_subject_key` enforces it.
 * Both, deliberately: the reconciliation is what makes the *counters* honest —
 * a raise that the index silently swallowed would be counted as news — and the
 * index is what survives two workers racing through a handover. The insert is
 * `ON CONFLICT DO NOTHING` **without a target**, because Postgres cannot infer a
 * partial unique index from the target columns alone and answers 42P10 as though
 * the index were missing.
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export interface AlertSweepResult {
  airlinesSwept: number;
  raised: number;
  resolved: number;
}

/**
 * Evaluate every player airline in the world whose watermark is due.
 *
 * Scoped to one world because game time is a per-world quantity, exactly like
 * the crew, ground and finance sweeps beside it — a sweep that was not would
 * measure one world's week against another world's clock.
 */
export async function sweepWorldAlerts(
  db: Database,
  worldId: string,
  gameNow: Date,
): Promise<AlertSweepResult> {
  const due = new Date(gameNow.getTime() - SWEEP_INTERVAL_GAME_HOURS * HOUR_MS);

  /*
   * Oldest watermark first, and nulls first inside that — an airline that has
   * never been swept is the one whose player has never seen an alert. The cap
   * bounds the tick; the ones left over keep their watermark and are picked up
   * next time, so nothing can be starved.
   */
  const airlines = await db
    .select({ id: airline.id, name: airline.name })
    .from(airline)
    .leftJoin(alertState, eq(alertState.airlineId, airline.id))
    .where(
      and(
        eq(airline.worldId, worldId),
        eq(airline.kind, 'player'),
        // A ceased airline has no decisions left to alert about. A restricted one
        // very much does — §13.5's ladder is exactly when a player needs telling.
        sql`${airline.status} <> 'ceased'`,
        or(isNull(alertState.sweptAt), lte(alertState.sweptAt, due)),
      ),
    )
    // `asc()` would append its own keyword after the null ordering and Postgres
    // rejects `nulls first asc` as a syntax error — the whole clause is written
    // out rather than composed.
    .orderBy(sql`${alertState.sweptAt} asc nulls first`)
    .limit(MAX_AIRLINES_PER_SWEEP);

  let raised = 0;
  let resolved = 0;

  for (const row of airlines) {
    const own: ResolvedPlayerAirline = { id: row.id, worldId, status: 'active' };
    const result = await sweepAirlineAlerts(db, own, row.name, gameNow);
    raised += result.raised;
    resolved += result.resolved;
  }

  return { airlinesSwept: airlines.length, raised, resolved };
}

/**
 * One airline: read, decide, reconcile, stamp the watermark.
 *
 * The watermark moves whether or not anything fired, because *"the rules ran and
 * found nothing"* is the answer `GET /api/alerts` needs in order to tell an
 * empty list apart from a sweep that has never happened.
 */
export async function sweepAirlineAlerts(
  db: Database,
  own: ResolvedPlayerAirline,
  airlineName: string,
  gameNow: Date,
): Promise<{ raised: number; resolved: number }> {
  const state = await readAirlineAlertState(db, own, airlineName, gameNow);
  const evaluated = evaluateAlerts(state, ALERT_THRESHOLDS);

  const open = await db
    .select({ id: alert.id, kind: alert.kind, subjectKey: alert.subjectKey })
    .from(alert)
    .where(and(eq(alert.airlineId, own.id), isNull(alert.resolvedAt)));

  /*
   * A `kind` the running build no longer knows is left alone rather than
   * resolved. Dropping a rule would otherwise mass-resolve every row it ever
   * raised on the first tick after the deploy, and dropping it by accident —
   * a typo in an enum — would do the same thing silently.
   */
  const known = open.flatMap((row) => {
    const kind = AlertKind.safeParse(row.kind);
    return kind.success ? [{ id: row.id, kind: kind.data, subjectKey: row.subjectKey }] : [];
  });

  const plan = reconcileAlerts(evaluated, known);

  if (plan.raise.length > 0) {
    await db
      .insert(alert)
      .values(plan.raise.map((entry) => toRow(entry, own, gameNow)))
      .onConflictDoNothing();
  }

  if (plan.resolve.length > 0) {
    await db
      .update(alert)
      .set({ resolvedAt: gameNow })
      .where(and(inArray(alert.id, plan.resolve), isNull(alert.resolvedAt)));
  }

  await db
    .insert(alertState)
    .values({ airlineId: own.id, worldId: own.worldId, sweptAt: gameNow })
    .onConflictDoUpdate({
      target: alertState.airlineId,
      set: { sweptAt: gameNow, updatedAt: new Date() },
    });

  return { raised: plan.raise.length, resolved: plan.resolve.length };
}

function toRow(entry: RaisedAlert, own: ResolvedPlayerAirline, gameNow: Date) {
  return {
    worldId: own.worldId,
    airlineId: own.id,
    kind: entry.kind,
    severity: entry.severity,
    subjectType: entry.subjectType,
    subjectId: entry.subjectId,
    subjectLabel: entry.subjectLabel,
    subjectKey: entry.subjectKey,
    title: entry.title,
    detail: entry.detail,
    screen: entry.screen,
    raisedAt: gameNow,
  };
}

/* ------------------------------------------------------------------ reads */

/**
 * Everything the eight rules read about one airline.
 *
 * Every figure is drawn from the subsystem that owns it — the runway from
 * §13.6's projection, the coverage ratio from §13.1's arithmetic, the checks
 * from M4-06's maintenance status — rather than re-derived here. An alert that
 * computed its own version of a number the player can also read on a page would
 * eventually disagree with that page, and the alert would be the one nobody
 * trusted.
 */
export async function readAirlineAlertState(
  db: Database,
  own: ResolvedPlayerAirline,
  airlineName: string,
  gameNow: Date,
): Promise<AirlineAlertState> {
  const [routes, runway, coverage, crew, checks, contracts] = await Promise.all([
    readRouteStates(db, own, gameNow),
    readCashRunway(db, own),
    readDebtServiceCoverage(db, own, gameNow),
    readCrewProjection(db, own, gameNow),
    readChecksDue(db, own),
    readContractTerms(db, own, gameNow),
  ]);

  return {
    airlineId: own.id,
    airlineLabel: airlineName,
    runwayDays: runway.days,
    dscr: coverage.dscr,
    dscrMinimum: coverage.minimumDscr,
    routes,
    crew,
    checks,
    contracts,
  };
}

/**
 * Per-route trading, spill and new entrants, in three grouped queries.
 *
 * `flight` carries no route id — a route is resolved from its airport pair, the
 * same join M8-09 and M8-12 use — so every one of these groups by
 * `(origin, destination)` and the route ids are attached afterwards. One query
 * per question rather than one per route: an airline with three hundred routes
 * must not cost three hundred round trips on a sweep that runs every game hour.
 */
async function readRouteStates(
  db: Database,
  own: ResolvedPlayerAirline,
  gameNow: Date,
): Promise<AlertRouteState[]> {
  const routes = await db
    .select({
      id: route.id,
      originIcao: route.originIcao,
      destinationIcao: route.destinationIcao,
    })
    .from(route)
    .where(and(eq(route.airlineId, own.id), eq(route.active, true)));

  if (routes.length === 0) return [];

  /** An ICAO pair, joined on a separator no identifier can contain. */
  const pairKey = (origin: string, destination: string) => `${origin}\u0000${destination}`;
  const lossSince = new Date(gameNow.getTime() - ALERT_THRESHOLDS.routeLossWindowDays * DAY_MS);
  const trafficSince = new Date(gameNow.getTime() - TRAFFIC_WINDOW_DAYS * DAY_MS);
  const rivalSince = new Date(gameNow.getTime() - ALERT_THRESHOLDS.competitorLookbackDays * DAY_MS);
  /*
   * The rival query is bounded by the two ICAO sets rather than by the exact
   * pairs. A row-value `IN ((a, b), ...)` would be tighter, and the first draft
   * built it by concatenating the two columns and comparing against an array of
   * keys — which Postgres rejected outright (`08P01 insufficient data left in
   * message`), because a JS array interpolated into a `sql` template is not a
   * bound array parameter. Two `inArray`s over-fetch the cross pairs and the
   * lookup below simply never asks for them, which is correct and needs no
   * hand-built SQL.
   */
  const origins = [...new Set(routes.map((row) => row.originIcao))];
  const destinations = [...new Set(routes.map((row) => row.destinationIcao))];

  const [daily, traffic, rivals] = await Promise.all([
    /*
     * Contribution per route per game day. `net_minor` is the flight's own
     * settled contribution, which is the figure §14.4's chart ranks — so the
     * alert and the chart cannot disagree about which routes are below the line.
     */
    db
      .select({
        originIcao: flight.originIcao,
        destinationIcao: flight.destinationIcao,
        day: sql<string>`to_char(${flightResult.settledAt} at time zone 'UTC', 'YYYY-MM-DD')`,
        netMinor: sql<string>`sum(${flightResult.netMinor})::text`,
      })
      .from(flightResult)
      .innerJoin(flight, eq(flight.id, flightResult.flightId))
      .where(
        and(
          eq(flightResult.airlineId, own.id),
          eq(flightResult.kind, 'scheduled'),
          gte(flightResult.settledAt, lossSince),
          lte(flightResult.settledAt, gameNow),
        ),
      )
      .groupBy(
        flight.originIcao,
        flight.destinationIcao,
        sql`to_char(${flightResult.settledAt} at time zone 'UTC', 'YYYY-MM-DD')`,
      ),

    db
      .select({
        originIcao: flight.originIcao,
        destinationIcao: flight.destinationIcao,
        flights: sql<string>`count(*)::text`,
        carried: sql<string>`sum(${flightResult.passengers})::text`,
        spilled: sql<string>`sum(${flightResult.spilledPassengers})::text`,
      })
      .from(flightResult)
      .innerJoin(flight, eq(flight.id, flightResult.flightId))
      .where(
        and(
          eq(flightResult.airlineId, own.id),
          eq(flightResult.kind, 'scheduled'),
          gte(flightResult.settledAt, trafficSince),
          lte(flightResult.settledAt, gameNow),
        ),
      )
      .groupBy(flight.originIcao, flight.destinationIcao),

    /*
     * Who else flies these pairs, and when they *first* did.
     *
     * "Entered" is started flying, not opened a route row: a rival can hold an
     * open route it never operates, and that costs the player nothing. So the
     * test is the rival's earliest settled flight on the pair, which needs no
     * remembered state and stops being true on its own once they have older
     * history — the alert resolves without anything having to expire it.
     */
    db
      .select({
        airlineId: flightResult.airlineId,
        name: airline.name,
        originIcao: flight.originIcao,
        destinationIcao: flight.destinationIcao,
        firstAt: sql<string>`min(${flightResult.settledAt})::text`,
      })
      .from(flightResult)
      .innerJoin(flight, eq(flight.id, flightResult.flightId))
      .innerJoin(airline, eq(airline.id, flightResult.airlineId))
      .where(
        and(
          eq(flight.worldId, own.worldId),
          ne(flightResult.airlineId, own.id),
          inArray(flight.originIcao, origins),
          inArray(flight.destinationIcao, destinations),
        ),
      )
      .groupBy(flightResult.airlineId, airline.name, flight.originIcao, flight.destinationIcao),
  ]);

  const days = new Map<string, RouteDayContribution[]>();
  for (const row of daily) {
    const key = pairKey(row.originIcao, row.destinationIcao);
    const list = days.get(key) ?? [];
    list.push({ day: row.day, contributionMinor: Math.round(Number(row.netMinor)) });
    days.set(key, list);
  }

  const trafficByPair = new Map(
    traffic.map((row) => [
      pairKey(row.originIcao, row.destinationIcao),
      {
        flights: Number(row.flights),
        carried: Number(row.carried ?? 0),
        spilled: Number(row.spilled ?? 0),
      },
    ]),
  );

  const newRivals = new Map<string, { airlineId: string; name: string }[]>();
  for (const row of rivals) {
    // `min()` on a timestamp comes back as a string: column type parsers do not
    // apply to raw aggregates. Normalise at the boundary — CLAUDE.md's trap.
    const firstAt = new Date(row.firstAt);
    if (!Number.isFinite(firstAt.getTime()) || firstAt < rivalSince) continue;

    const key = pairKey(row.originIcao, row.destinationIcao);
    const list = newRivals.get(key) ?? [];
    list.push({ airlineId: row.airlineId, name: row.name });
    newRivals.set(key, list);
  }

  return routes.map((row) => {
    const key = pairKey(row.originIcao, row.destinationIcao);
    const measured = trafficByPair.get(key);
    return {
      routeId: row.id,
      label: `${row.originIcao}–${row.destinationIcao}`,
      days: (days.get(key) ?? []).sort((a, b) => a.day.localeCompare(b.day)),
      flights: measured?.flights ?? 0,
      carried: measured?.carried ?? 0,
      spilled: measured?.spilled ?? 0,
      newRivals: (newRivals.get(key) ?? []).sort((a, b) => a.name.localeCompare(b.name)),
    };
  });
}

/**
 * Crew supply against demand, today and once the deliveries land.
 *
 * §14.5 asks for the shortfall *"at base in 5 days"*, and there are two things
 * here that the crew model cannot give it. It is **not per base**: M5-01's
 * demand is a legal complement per `(family, rank)` summed over the whole fleet,
 * so there is no per-base requirement to be short of. And the *5 days* is the
 * **fleet's** horizon rather than the roster's: what makes a shortfall
 * forecastable in this game is an aeroplane arriving, because it raises the
 * complement on the day it lands and both hiring and conversion take longer than
 * that. A rostering forecast would need duty and rest projected forward, which
 * §9.2 defers and M5-01 explicitly does not build.
 *
 * Both limits are recorded in `docs/alerts-and-digest.md` rather than papered
 * over, because an alert that claimed to know a base was short would be inventing
 * the one number the player would act on.
 */
async function readCrewProjection(
  db: Database,
  own: ResolvedPlayerAirline,
  gameNow: Date,
): Promise<CrewProjection[]> {
  const horizon = new Date(gameNow.getTime() + ALERT_THRESHOLDS.crewShortfallDays * DAY_MS);

  const [economy, pools, owned, arriving] = await Promise.all([
    loadWorldEconomyConfig(db, own.worldId),

    db
      .select({
        family: crewPool.family,
        rank: crewPool.rank,
        headcount: crewPool.headcount,
        unavailable: crewPool.unavailable,
      })
      .from(crewPool)
      .innerJoin(crewBase, eq(crewBase.id, crewPool.crewBaseId))
      .where(and(eq(crewBase.airlineId, own.id), eq(crewBase.status, 'open'))),

    db
      .select({ family: aircraftType.family, effectiveSpec: airframe.effectiveSpec })
      .from(airframe)
      .innerJoin(aircraftType, eq(aircraftType.designation, airframe.typeDesignation))
      .where(
        and(
          eq(airframe.airlineId, own.id),
          // A seized aeroplane is not the airline's any more (§13.5). It needs no crew.
          isNull(airframe.repossessedAt),
        ),
      ),

    db
      .select({ family: aircraftType.family, effectiveSpec: aircraftOrder.effectiveSpec })
      .from(aircraftOrder)
      .innerJoin(aircraftType, eq(aircraftType.designation, aircraftOrder.typeDesignation))
      .where(
        and(
          eq(aircraftOrder.airlineId, own.id),
          eq(aircraftOrder.status, 'pending'),
          lte(aircraftOrder.deliveryAt, horizon),
        ),
      ),
  ]);

  const required = (frames: readonly { family: string; effectiveSpec: string }[]) => {
    const out = new Map<string, number>();
    for (const frame of frames) {
      const spec = JSON.parse(frame.effectiveSpec) as { seatsTwoClass?: number };
      // A short sector, matching M5-01's floor exactly: no relief crew, which is
      // the smallest honest requirement and the one the Crew page displays.
      const complement = requiredComplement(
        { seats: spec.seatsTwoClass ?? 0, blockMinutes: 0 },
        economy.crew.regulation,
      );
      for (const slot of [...complement.flightDeck, ...complement.cabin]) {
        const key = `${frame.family}\u0000${slot.rank}`;
        out.set(key, (out.get(key) ?? 0) + slot.count);
      }
    }
    return out;
  };

  const now = required(owned);
  const atHorizon = required([...owned, ...arriving]);

  const available = new Map<string, number>();
  for (const pool of pools) {
    const key = `${pool.family}\u0000${pool.rank}`;
    available.set(key, (available.get(key) ?? 0) + availableHeads(pool));
  }

  return [...atHorizon.keys()]
    .map((key) => {
      const [family = '', rank = ''] = key.split('\u0000');
      return {
        family,
        rank,
        available: available.get(key) ?? 0,
        requiredNow: now.get(key) ?? 0,
        requiredAtHorizon: atHorizon.get(key) ?? 0,
      };
    })
    .sort((a, b) => a.family.localeCompare(b.family) || a.rank.localeCompare(b.rank));
}

/**
 * The heaviest outstanding check per airframe, from M4-06's own status.
 *
 * One entry per aeroplane, not one per tier: a player with a D-check due does
 * not need to be told about the A-check underneath it, and three rows for one
 * airframe would make the list unreadable exactly when it matters most.
 */
async function readChecksDue(db: Database, own: ResolvedPlayerAirline): Promise<CheckDue[]> {
  const fleet = await fleetMaintenance(db, own);

  return fleet.airframes.flatMap((frame) => {
    // Heaviest first: `d` sorts above `c` above `a`, which is also the order
    // M4-06 says to do them in.
    const heaviest = [...frame.tiers].sort(
      (a, b) => b.tier.localeCompare(a.tier) || b.usedFraction - a.usedFraction,
    );
    const worst = heaviest.find((tier) => tier.due) ?? maxUsed(frame.tiers);
    if (!worst) return [];

    return [
      {
        airframeId: frame.airframeId,
        registration: frame.registration,
        tier: worst.tier,
        usedFraction: worst.usedFraction,
        inCheck: frame.status === 'in_check',
        grounded: frame.status === 'grounded' || !frame.airworthy,
      },
    ];
  });
}

function maxUsed<T extends { usedFraction: number }>(tiers: readonly T[]): T | undefined {
  let best: T | undefined;
  for (const tier of tiers) if (!best || tier.usedFraction > best.usedFraction) best = tier;
  return best;
}

/**
 * Active handling contracts and how much of their term is left.
 *
 * A null `term_end` is a contract signed before terms existed and never expires
 * (M5-06), so it is skipped rather than read as expiring at the epoch — which
 * would raise a critical alert on every legacy contract on the first sweep.
 */
async function readContractTerms(
  db: Database,
  own: ResolvedPlayerAirline,
  gameNow: Date,
): Promise<ContractTerm[]> {
  const rows = await db
    .select({
      id: groundContract.id,
      airportIcao: groundContract.airportIcao,
      serviceLine: groundContract.serviceLine,
      termEnd: groundContract.termEnd,
    })
    .from(groundContract)
    .where(and(eq(groundContract.airlineId, own.id), eq(groundContract.status, 'active')));

  return rows.flatMap((row) => {
    if (row.termEnd === null) return [];
    return [
      {
        contractId: row.id,
        airportIcao: row.airportIcao,
        serviceLine: serviceLineLabel(row.serviceLine),
        daysRemaining: (row.termEnd.getTime() - gameNow.getTime()) / DAY_MS,
      },
    ];
  });
}

/**
 * `ramp_baggage` reads as *ramp baggage* in a sentence a player is shown.
 *
 * The same transformation the Operations page applies, deliberately: a second
 * label table would be a second vocabulary for the same six service lines, which
 * is the failure M8-12's chart-language guard exists to prevent.
 */
function serviceLineLabel(line: string): string {
  return line.replace(/_/g, ' ');
}
