import { and, eq, gte, isNull, sql } from 'drizzle-orm';

import {
  addFlight,
  emptyTraffic,
  loadFactor,
  NM_TO_KM,
  passengerYield,
  spillRate,
} from '@tailfin/sim';

import {
  airframe,
  airline,
  crewBase,
  crewPool,
  flight,
  flightResult,
  groundContract,
  groundSelfHandling,
  route,
} from '../db/schema';
import { worldGameNow } from '../world/game-now';

import type { ResolvedPlayerAirline } from '../airline/context';
import type { Database } from '../db/client';
import type {
  BaseMoraleRow,
  ContractExpiry,
  CrewRankHeadcount,
  DelayByCause,
  DelayCause,
  FleetAgeBand,
  OperationsDashboardResponse,
} from '@tailfin/shared';

/**
 * §14.3's five operational dashboards, assembled once (M8-12).
 *
 * One window, one read of `flight_result`, one response. Five endpoints would
 * let five panels disagree about which flights were in the period — and every
 * one of them would carry the same *"production has no worker so this is all
 * zero"* caveat separately.
 *
 * ## Delay is attributed, and the unattributed part is named
 *
 * M8-12's first criterion is that delay minutes are attributed by M2-08's cause
 * taxonomy. The taxonomy is `flight.disruption_cause`, and a flight can arrive
 * late with **no** disruption row against it — a slow turn, a long taxi, weather
 * en route that never became a recorded disruption.
 *
 * Those minutes are real, so they are reported under `unattributed` rather than
 * dropped. A dashboard that only summed the causes would show a player *less*
 * delay than they actually suffered, and the total would silently disagree with
 * the on-time rate beside it. That is the one thing an attribution must not do.
 *
 * ## Spill is a count first
 *
 * The second criterion asks for spill as *"passengers turned away"*. A rate says
 * you are losing eight per cent of something; a count says you turned away 1,240
 * people. Both are here and the count leads.
 */

/** The window every figure covers, in game days. One game month. */
const WINDOW_DAYS = 30;

/** §14.3's D15 threshold, shared with `network/performance.ts`. */
const D15_MINUTES = 15;

/** How many contract expiries come back. The ones still worth acting on. */
const EXPIRY_LIMIT = 6;

const DAY_MS = 86_400_000;

/** The age bands §14.3's profile is drawn in, in years. */
const AGE_BANDS: readonly { label: string; upToYears: number | null }[] = [
  { label: 'Under 5', upToYears: 5 },
  { label: '5–10', upToYears: 10 },
  { label: '10–20', upToYears: 20 },
  { label: 'Over 20', upToYears: null },
];

/** Every M2-08 cause, plus the bucket for delay nobody attributed. */
const DELAY_CAUSES: readonly DelayCause[] = [
  'weather_origin',
  'weather_destination',
  'atc_flow',
  'technical',
  'crew_timeout',
  'ground_vendor',
  'airport_closure',
  'unattributed',
];

export async function readOperationsDashboard(
  db: Database,
  own: ResolvedPlayerAirline,
): Promise<OperationsDashboardResponse> {
  const gameNow = await worldGameNow(db, own.worldId);
  const since = new Date(gameNow.getTime() - WINDOW_DAYS * DAY_MS);

  const [settled, cancelled, airframes, pools, bases, contracts, selfHandled, airlineRow] =
    await Promise.all([
      /*
       * Every settled flight in the window, with its route's distance and its
       * disruption cause. The left join to `route` is the same one M8-09 uses:
       * `flight` carries no distance, and a flight whose route has been deleted
       * still counts in the money and the punctuality while contributing no
       * seat-kilometres.
       */
      db
        .select({
          greatCircleNm: route.greatCircleNm,
          seats: flightResult.seats,
          passengers: flightResult.passengers,
          spilledPassengers: flightResult.spilledPassengers,
          cargoKg: flightResult.cargoKg,
          revenueMinor: flightResult.revenueMinor,
          costMinor: flightResult.costMinor,
          blockSeconds: flightResult.blockSeconds,
          arrivalDelayMinutes: flightResult.arrivalDelayMinutes,
          disruptionCause: flight.disruptionCause,
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
        ),

      /*
       * Cancellations, counted from `flight` rather than `flight_result`: a
       * cancelled flight never settles, so it has no result row at all. Counting
       * only what settled would report a perfect cancellation rate on an airline
       * that cancelled everything.
       */
      db
        .select({ n: sql<string>`count(*)::text` })
        .from(flight)
        .where(
          and(
            eq(flight.airlineId, own.id),
            eq(flight.disruption, 'cancelled'),
            gte(flight.scheduledDeparture, since),
          ),
        ),

      db
        .select({
          status: airframe.status,
          builtAt: airframe.builtAt,
          deliveredAt: airframe.deliveredAt,
        })
        .from(airframe)
        .where(and(eq(airframe.airlineId, own.id), isNull(airframe.repossessedAt))),

      db
        .select({
          airportIcao: crewBase.airportIcao,
          rank: crewPool.rank,
          headcount: crewPool.headcount,
          onDuty: crewPool.onDuty,
          reserve: crewPool.reserve,
          unavailable: crewPool.unavailable,
          sick: crewPool.sick,
        })
        .from(crewPool)
        .innerJoin(crewBase, eq(crewBase.id, crewPool.crewBaseId))
        .where(and(eq(crewBase.airlineId, own.id), eq(crewBase.status, 'open'))),

      db
        .select({ airportIcao: crewBase.airportIcao, morale: crewBase.morale })
        .from(crewBase)
        .where(and(eq(crewBase.airlineId, own.id), eq(crewBase.status, 'open'))),

      db
        .select({
          airportIcao: groundContract.airportIcao,
          serviceLine: groundContract.serviceLine,
          grade: groundContract.grade,
          termEnd: groundContract.termEnd,
        })
        .from(groundContract)
        .where(and(eq(groundContract.airlineId, own.id), eq(groundContract.status, 'active'))),

      db
        .select({ n: sql<string>`count(*)::text` })
        .from(groundSelfHandling)
        .where(
          and(eq(groundSelfHandling.airlineId, own.id), eq(groundSelfHandling.status, 'active')),
        ),

      db.select({ reputation: airline.reputation }).from(airline).where(eq(airline.id, own.id)),
    ]);

  /* ---- Traffic and punctuality, from one fold ---------------------------- */

  let totals = emptyTraffic();
  /*
   * Cargo carried, in tonnes. `TrafficTotals` keeps RTK — tonnes *times*
   * distance — which is the right unit for a productivity measure and the wrong
   * one for §14.3's "tonnes carried", so the raw weight is summed alongside it.
   */
  let cargoKg = 0;
  let onTimeD0 = 0;
  let totalDelayMinutes = 0;
  const delayMinutes = new Map<DelayCause, { minutes: number; flights: number }>();

  for (const row of settled) {
    cargoKg += row.cargoKg;
    totals = addFlight(totals, {
      seats: row.seats,
      passengers: row.passengers,
      spilledPassengers: row.spilledPassengers,
      cargoKg: row.cargoKg,
      distanceKm: (row.greatCircleNm ?? 0) * NM_TO_KM,
      revenueMinor: row.revenueMinor,
      costMinor: row.costMinor,
      blockSeconds: row.blockSeconds,
      onTime: row.arrivalDelayMinutes <= D15_MINUTES,
    });

    // D0 is exactly on time or early. Negative delay is an early arrival, which
    // counts: D0 asks whether the flight was late, not whether it was punctual
    // to the minute.
    if (row.arrivalDelayMinutes <= 0) onTimeD0 += 1;

    if (row.arrivalDelayMinutes > 0) {
      totalDelayMinutes += row.arrivalDelayMinutes;
      const cause: DelayCause = (row.disruptionCause as DelayCause | null) ?? 'unattributed';
      const bucket = delayMinutes.get(cause) ?? { minutes: 0, flights: 0 };
      bucket.minutes += row.arrivalDelayMinutes;
      bucket.flights += 1;
      delayMinutes.set(cause, bucket);
    }
  }

  const byCause: DelayByCause[] = DELAY_CAUSES.filter((cause) => delayMinutes.has(cause))
    .map((cause) => ({
      cause,
      minutes: delayMinutes.get(cause)?.minutes ?? 0,
      flights: delayMinutes.get(cause)?.flights ?? 0,
    }))
    // Worst first: the point of an attribution is to name what to fix.
    .sort((a, b) => b.minutes - a.minutes);

  const cancelledFlights = Number(cancelled[0]?.n ?? 0);
  const flownAndCancelled = settled.length + cancelledFlights;

  /* ---- Fleet ------------------------------------------------------------- */

  const aogCount = airframes.filter((row) => row.status === 'grounded').length;
  const inCheck = airframes.filter((row) => row.status === 'in_check').length;

  const ageProfile: FleetAgeBand[] = AGE_BANDS.map((band) => ({ label: band.label, airframes: 0 }));
  for (const row of airframes) {
    // `built_at` is the aeroplane's own age and is carried from the order, so a
    // bought used airframe keeps it. Falling back to delivery would report every
    // second-hand purchase as brand new.
    const born = row.builtAt ?? row.deliveredAt;
    const years = (gameNow.getTime() - born.getTime()) / (365 * DAY_MS);
    const index = AGE_BANDS.findIndex((band) => band.upToYears === null || years < band.upToYears);
    const bucket = ageProfile[index === -1 ? ageProfile.length - 1 : index];
    if (bucket) bucket.airframes += 1;
  }

  /* ---- Crew -------------------------------------------------------------- */

  const byRankMap = new Map<string, CrewRankHeadcount>();
  const headsByBase = new Map<string, number>();
  let headcount = 0;
  let reserves = 0;
  let converting = 0;

  for (const row of pools) {
    const entry = byRankMap.get(row.rank) ?? {
      rank: row.rank,
      headcount: 0,
      onDuty: 0,
      reserve: 0,
      unavailable: 0,
      sick: 0,
    };
    entry.headcount += row.headcount;
    entry.onDuty += row.onDuty;
    entry.reserve += row.reserve;
    entry.unavailable += row.unavailable;
    entry.sick += row.sick;
    byRankMap.set(row.rank, entry);

    headcount += row.headcount;
    reserves += row.reserve;
    // `unavailable` is M5-01's conversion state: heads in a classroom rather
    // than heads who have left, which is why it is the training pipeline's size.
    converting += row.unavailable;
    headsByBase.set(row.airportIcao, (headsByBase.get(row.airportIcao) ?? 0) + row.headcount);
  }

  const moraleByBase: BaseMoraleRow[] = bases
    .map((row) => ({
      airportIcao: row.airportIcao,
      morale: row.morale,
      headcount: headsByBase.get(row.airportIcao) ?? 0,
    }))
    .sort((a, b) => (a.morale ?? 1) - (b.morale ?? 1));

  /* ---- Ground ------------------------------------------------------------ */

  const expiries: ContractExpiry[] = contracts
    .map((row) => ({
      airportIcao: row.airportIcao,
      serviceLine: row.serviceLine,
      grade: row.grade,
      termEnd: row.termEnd?.toISOString() ?? null,
      // Null `term_end` is a legacy contract signed before terms existed. It
      // never lapses, which is a real answer rather than an unknown one.
      daysRemaining:
        row.termEnd === null
          ? null
          : Math.round((row.termEnd.getTime() - gameNow.getTime()) / DAY_MS),
    }))
    .sort(
      (a, b) =>
        (a.daysRemaining ?? Number.MAX_SAFE_INTEGER) - (b.daysRemaining ?? Number.MAX_SAFE_INTEGER),
    )
    .slice(0, EXPIRY_LIMIT);

  const blockHours = totals.blockHours;

  return {
    gameNow: gameNow.toISOString(),
    windowDays: WINDOW_DAYS,
    flights: settled.length,

    traffic: {
      passengers: totals.passengers,
      cargoTonnes: cargoKg / 1_000,
      askKm: totals.askKm,
      rpkKm: totals.rpkKm,
      rtkKm: totals.rtkKm,
      loadFactor: loadFactor(totals),
      spilledPassengers: totals.spilledPassengers,
      spillRate: spillRate(totals),
      yieldMinor: passengerYield(totals),
    },

    punctuality: {
      onTimeD0: settled.length === 0 ? null : onTimeD0 / settled.length,
      onTimeD15: settled.length === 0 ? null : totals.onTimeFlights / settled.length,
      cancellationRate: flownAndCancelled === 0 ? null : cancelledFlights / flownAndCancelled,
      cancelledFlights,
      totalDelayMinutes,
      byCause,
    },

    fleet: {
      airframes: airframes.length,
      aogCount,
      inCheck,
      blockHoursPerDay: airframes.length === 0 ? null : blockHours / airframes.length / WINDOW_DAYS,
      costPerBlockHourMinor: blockHours === 0 ? null : totals.costMinor / blockHours,
      ageProfile,
    },

    crew: {
      headcount,
      byRank: [...byRankMap.values()],
      moraleByBase,
      reserveCoverage: headcount === 0 ? null : reserves / headcount,
      converting,
    },

    ground: {
      activeContracts: contracts.length,
      selfHandledStations: Number(selfHandled[0]?.n ?? 0),
      expiries,
    },

    // M8-04 assembles a `ProductScore` per cabin per package, so there is no
    // single airline-level figure to report yet. Named as absent rather than
    // averaged into a number nothing computes.
    productScore: null,
    reputation: Number(airlineRow[0]?.reputation ?? 0),
    revenueMinor: totals.revenueMinor,
    costMinor: totals.costMinor,
  };
}

export { WINDOW_DAYS as OPERATIONS_WINDOW_DAYS, DELAY_CAUSES };
