import { and, eq, sql } from 'drizzle-orm';

import { CABIN_ORDER, FlightLoad } from '@tailfin/shared';
import type { AirportFees, FlightDisruption } from '@tailfin/shared';
import {
  computeBlockTime,
  computeFuelBurn,
  computeFuelCost,
  DEFAULT_FLIGHT_PROFILE,
  disruptionCost,
  type DisruptionOutcome,
  type FlightProfile,
  type FlightSettlement,
  type FuelMarket,
  type FuelStation,
  haversineNm,
  type SettlementConfig,
  settleFlight,
} from '@tailfin/sim';

import { accrueFlightHours } from '../aircraft/maintenance';
import { moveAirlineCash } from '../airline/cash';
import { airport, flight, flightResult, route } from '../db/schema';
import { type PinnedEconomyConfig } from '../economy/config';
import { loadWorldFuelContext, marketAt, stationFor } from '../economy/fuel';
import { loadWorldEconomyConfig } from '../economy/loader';

import type { Database } from '../db/client';
import type { EventHandler } from '../sim/event-queue';

/**
 * Settling a flight when it arrives (M2-06, §3.1, §11).
 *
 * §3.1's rule is that economic resolution happens **at flight events, not
 * continuously**, and this is that resolution: on `FLIGHT_ARRIVE` the flight is
 * priced, a `flight_result` is written, and the airline's cash moves by exactly
 * the net.
 *
 * ## Three things happen or none of them do
 *
 * The result row, the cash movement and the flight's own arrival are one
 * transaction. Any other arrangement has a failure mode that loses money: write
 * the result and crash, and the airline flew for free; move the cash and crash,
 * and there is no record of why the balance changed. `drainDueEvents` already
 * hands the handler a transaction, so this joins that one rather than opening
 * its own — the event is marked done in the same commit that pays for it.
 *
 * ## Replaying is a no-op, by construction
 *
 * `flight_result.flight_id` and AIR-06's cash-movement `(cause, reference)` are
 * both unique. A second settlement of the same flight is refused **by the
 * database**, not by a check this code has to remember to do. That is what
 * makes M2-06's idempotency criterion a property of the schema rather than a
 * promise — see the notes on both tables.
 *
 * Two workers racing land in the same place. Both take the flight row `FOR
 * UPDATE` first, so the second waits, then finds the row already written and
 * does nothing.
 *
 * ## What it has to be told, and why
 *
 * Distance comes from the airports' own coordinates, so that much is real. The
 * rest — what the airframe weighs and burns, what each station charges for fuel
 * and handling — has nowhere to come from yet: there is no aircraft catalogue
 * (M4) and the `airport` table has no `fees` columns, though App. B.2 specifies
 * them and `packages/shared` already has the shape.
 *
 * So those arrive as **resolver functions** with defaults, rather than as stubs
 * inside the settlement. When M4 lands, one function is replaced and nothing else
 * here changes. It is the same boundary M2-04 and M2-05 drew, moved up a layer.
 */

/** What the settlement needs to know about the airframe that flew. */
export interface SettlementAirframe {
  maxTakeoffWeightT: number;
  cruiseSpeedKt: number;
  /** Tonnes per nautical mile, range-calibrated — App. C.6's `effective_spec`. */
  cruiseBurnTPerNm: number;
}

/**
 * A placeholder ATR 72-600, until there is a catalogue to look one up in.
 *
 * The same fixture the sim tests calibrate against, and it is here rather than
 * hidden in a default parameter so that a reader can see immediately that every
 * flight is currently being costed as a turboprop regardless of what it is. That
 * is wrong, it is temporary, and it is M4's to fix — but it is visibly wrong,
 * which a silently-averaged "typical narrowbody" would not be.
 */
export const PLACEHOLDER_AIRFRAME: SettlementAirframe = {
  maxTakeoffWeightT: 23,
  cruiseSpeedKt: 275,
  cruiseBurnTPerNm: 2.5 / 825,
};

export interface SettlementDeps {
  /**
   * The economy to bill against.
   *
   * Left out in production, where it is resolved from the flight's own world
   * through `world.economy_config_version` — so a retune reaches the next
   * arrival without a deploy (M3-11, §22.3). Supplied only by tests that want to
   * price a flight under coefficients of their own.
   */
  economy?: PinnedEconomyConfig;

  /** Airframe id to its performance. M4 replaces the default. */
  resolveAirframe?: (airframeId: string) => SettlementAirframe;
  /** Per-station charges. App. B.2 specifies them; no column holds them yet. */
  resolveFees?: (icao: string) => AirportFees;
  /**
   * Per-station fuel pricing (§9.3).
   *
   * Left out in production, where M5-07 derives it from the origin's own row —
   * its region, its tier and its world's per-station spread. Supplied only by
   * tests that want to price a sector at a station of their choosing.
   */
  resolveStation?: (icao: string) => FuelStation;
  /**
   * The world curve's level (§11).
   *
   * Left out in production, where it is sampled from the flight's own world at
   * the instant the fuel was bought. Supplied by tests that want a fixed price.
   */
  market?: FuelMarket;
  profile?: FlightProfile;
  config?: SettlementConfig;
}

export type SettleOutcome =
  | { status: 'settled'; settlement: FlightSettlement; netMinor: number }
  /** Already had a result. The replay case, and the expected one after a restart. */
  | { status: 'already-settled' }
  | { status: 'not-found' };

/** The `world_event` idempotency key for a flight's arrival, matching `departureKey`. */
export function arrivalKey(flightId: string): string {
  return `flight:${flightId}:arrive`;
}

/** The disruption outcome to bill an arrival for, or null when it arrived clean. */
function disruptionOutcomeOf(disruption: FlightDisruption | null): DisruptionOutcome | null {
  switch (disruption) {
    case 'delayed':
      return 'delay';
    case 'diverted':
      return 'divert';
    case 'air_return':
      return 'air_return';
    default:
      // null (clean), 'cancelled' (never settles) and 'returned_to_stand' (never
      // left the stand) have nothing to bill at an arrival.
      return null;
  }
}

/**
 * Price an arrived flight, write its result, and move the airline's cash.
 *
 * `arrivedAt` is a **game-time** instant — the flight's on-blocks time — like
 * every other time in the queue. It is passed in rather than read from a clock
 * because nothing in this path may consult real time: the same flight must settle
 * to the same figures on a replay (invariant 2, and M13-01's harness).
 */
export async function settleArrivedFlight(
  tx: Database,
  flightId: string,
  arrivedAt: Date,
  deps: SettlementDeps = {},
): Promise<SettleOutcome> {
  const resolveAirframe = deps.resolveAirframe ?? (() => PLACEHOLDER_AIRFRAME);
  // Aircraft performance rather than economy: taxi and climb times are physics
  // and the §22.5 catalogue, versioned separately from the money (M3-11).
  const profile = deps.profile ?? DEFAULT_FLIGHT_PROFILE;

  // `FOR UPDATE` before anything else: it serialises two workers handling the
  // same arrival, so the loser waits here rather than racing to the insert.
  const flights = await tx.select().from(flight).where(eq(flight.id, flightId)).for('update');
  const row = flights[0];
  if (!row) return { status: 'not-found' };

  const existing = await tx
    .select({ id: flightResult.id })
    .from(flightResult)
    .where(eq(flightResult.flightId, flightId));
  if (existing.length > 0) return { status: 'already-settled' };

  // The world's own economy, read after the row because it is the *flight's*
  // world that decides the rates — resolved through the pin every time, so an
  // admin re-pinning a world moves the next arrival and not this one, which is
  // already inside a transaction.
  const economy = deps.economy ?? (await loadWorldEconomyConfig(tx, row.worldId));
  const resolveFees = deps.resolveFees ?? (() => economy.costs.defaultAirportFees);
  const config: SettlementConfig = deps.config ?? economy.costs.settlement;

  // Distance from the airports' own coordinates — the one input that is real.
  // A diversion is settled to where the aircraft actually went, not where it was
  // aimed: that is the cost the airline actually incurred (§8.4).
  const arrivalIcao = row.diversionIcao ?? row.destinationIcao;
  const ends = await tx
    .select({
      icao: airport.icaoCode,
      lat: airport.latitude,
      lon: airport.longitude,
      // M5-07 prices the uplift at the origin's own station, so the three columns
      // that decide a fuel region and an into-plane fee come back with the
      // coordinates rather than in a second query.
      continent: airport.continent,
      isoCountry: airport.isoCountry,
      tier: airport.tier,
    })
    .from(airport)
    .where(sql`${airport.icaoCode} in (${row.originIcao}, ${arrivalIcao})`);

  const origin = ends.find((a) => a.icao === row.originIcao);
  const arrival = ends.find((a) => a.icao === arrivalIcao);
  if (!origin || !arrival) {
    throw new Error(
      `Cannot settle flight ${flightId}: no coordinates for ${!origin ? row.originIcao : arrivalIcao}`,
    );
  }

  const distanceNm = haversineNm(origin.lat, origin.lon, arrival.lat, arrival.lon);
  const airframe = resolveAirframe(row.airframeId);

  /*
   * Fuel is bought at the origin, before the aeroplane leaves (M5-07, §9.3) —
   * so the station is the origin's and the world curve is read at the departure
   * instant rather than at this arrival. Both are game time and both are stored,
   * which is what keeps a replay billing the same fuel: nothing here consults a
   * real clock or a counter.
   *
   * A world whose row has gone (a reset mid-flight) falls back to the world's
   * default rates and opening level rather than failing the arrival — the money
   * has already been earned, and refusing to settle it would strand the flight.
   */
  const fuelCtx = await loadWorldFuelContext(tx, row.worldId);
  const uplift = row.actualDeparture ?? row.scheduledDeparture;
  const resolveStation =
    deps.resolveStation ??
    ((icao: string) => {
      if (fuelCtx === null) return { icao, ...economy.fuel.defaultStation };
      const end = ends.find((a) => a.icao === icao);
      return stationFor(
        icao,
        end === undefined
          ? undefined
          : { icao, continent: end.continent, isoCountry: end.isoCountry, tier: end.tier },
        fuelCtx,
        economy,
      );
    });
  const market: FuelMarket =
    deps.market ??
    (fuelCtx === null
      ? { basePricePerTonne: economy.fuel.basePricePerTonne }
      : marketAt(fuelCtx, uplift, economy));

  const block = computeBlockTime(distanceNm, airframe.cruiseSpeedKt, profile);
  const burn = computeFuelBurn(block, { cruiseBurnTPerNm: airframe.cruiseBurnTPerNm });
  const fuelCost = computeFuelCost(burn.tonnes, market, resolveStation(row.originIcao));

  // `flight.load` is JSON text that M3 writes. Parsed through the shared schema
  // rather than cast, because a malformed load must fail the event loudly rather
  // than settle a flight for a plausible-looking wrong number.
  const load = FlightLoad.parse(JSON.parse(row.load));

  const settlement = settleFlight(
    {
      // A ferry settles to all cost and no revenue, and `settleFlight` refuses
      // one that arrives carrying passengers rather than quietly zeroing it.
      kind: row.kind,
      load,
      cargoKg: row.cargoKg,
      block,
      fuelCost,
      aircraft: { maxTakeoffWeightT: airframe.maxTakeoffWeightT },
      originFees: resolveFees(row.originIcao),
      destinationFees: resolveFees(arrivalIcao),
    },
    config,
  );

  const delayMinutes = Math.round((arrivedAt.getTime() - row.estimatedArrival.getTime()) / 60_000);

  const [routeRow] = await tx
    .select({ id: route.id })
    .from(route)
    .where(
      and(
        eq(route.airlineId, row.airlineId),
        eq(route.originIcao, row.originIcao),
        eq(route.destinationIcao, row.destinationIcao),
      ),
    )
    .limit(1);

  // `onConflictDoNothing` rather than a plain insert: the select above closes the
  // window for anything holding the same lock, but not for a caller that reached
  // here another way. If this reports nothing, someone else settled it and the
  // cash below must not move.
  const written = await tx
    .insert(flightResult)
    .values({
      worldId: row.worldId,
      flightId: row.id,
      airlineId: row.airlineId,
      revenueMinor: settlement.revenueMinor,
      costMinor: settlement.costMinor,
      netMinor: settlement.netMinor,
      kind: row.kind,
      seats: settlement.seats,
      passengers: settlement.passengers,
      spilledPassengers: settlement.spilled,
      cargoKg: row.cargoKg,
      blockSeconds: Math.max(1, Math.round(block.blockMinutes * 60)),
      arrivalDelayMinutes: delayMinutes,
      breakdown: JSON.stringify({
        revenue: settlement.revenue,
        costs: settlement.costs,
        distanceNm,
        fuelTonnes: burn.tonnes,
        loadFactor: settlement.loadFactor,
      }),
      // The world's own economy version, not a constant from the code. This is
      // the column that makes an old settlement explicable after a retune
      // (invariant 4): without it, "why was this flight billed that much?" has
      // no answer once the coefficients have moved.
      settlementVersion: economy.version,
      settledAt: arrivedAt,
    })
    .onConflictDoNothing({ target: flightResult.flightId })
    .returning({ id: flightResult.id });

  if (written.length === 0) return { status: 'already-settled' };

  const cash = await moveAirlineCash(tx, {
    airlineId: row.airlineId,
    amountMinor: settlement.netMinor,
    cause: 'flight_settlement',
    reference: row.id,
    occurredAt: arrivedAt,
    ledgerLines: [
      ...CABIN_ORDER.flatMap((cabin) => {
        const amountMinor = load[cabin]?.revenue ?? 0;
        return amountMinor === 0
          ? []
          : [
              {
                amountMinor,
                category: 'ticket' as const,
                counterparty: 'passengers',
                flightId: row.id,
                routeId: routeRow?.id,
                aircraftId: row.airframeId,
                cabinClass: cabin,
              },
            ];
      }),
      ...settlement.revenue
        .filter((line) => line.source !== 'tickets' && line.amountMinor !== 0)
        .map((line) => ({
          amountMinor: line.amountMinor,
          category: line.source === 'ancillary' ? ('ancillary' as const) : ('cargo' as const),
          counterparty: line.source === 'ancillary' ? 'passengers' : 'cargo_customers',
          flightId: row.id,
          routeId: routeRow?.id,
          aircraftId: row.airframeId,
        })),
      ...settlement.costs
        .filter((line) => line.amountMinor !== 0)
        .map((line) => ({
          amountMinor: -line.amountMinor,
          category:
            line.source === 'fuel'
              ? ('fuel' as const)
              : line.source === 'crew'
                ? ('crew' as const)
                : line.source === 'maintenance'
                  ? ('maintenance' as const)
                  : line.source === 'airport'
                    ? ('airport_slot' as const)
                    : line.source === 'handling'
                      ? ('ground_handling' as const)
                      : ('airport_slot' as const),
          counterparty:
            line.source === 'fuel'
              ? 'fuel_supplier'
              : line.source === 'crew'
                ? 'crew'
                : line.source === 'maintenance'
                  ? 'maintenance_reserve'
                  : line.source === 'airport'
                    ? 'airport'
                    : line.source === 'handling'
                      ? 'ground_handler'
                      : 'regulator',
          flightId: row.id,
          routeId: routeRow?.id,
          aircraftId: row.airframeId,
        })),
    ],
  });
  if (cash.status !== 'applied') {
    // A result inserted in this transaction cannot legitimately find a prior
    // movement. Treat it as ledger drift and roll the whole settlement back.
    throw new Error(`Flight ${row.id} had a cash movement before its result`);
  }

  /*
   * Disruption cost (M5-05, §8.4). A flight that arrived delayed, diverted or
   * air-returned owes its passengers rebooking, EU261 compensation and duty of
   * care — a separate ledger line from the flight's own settlement, so the bill
   * stays explicable. Charged against the load it actually carried, and once:
   * this is inside the block the `flight_result` insert has already proved is not
   * a replay. The delay the passenger felt is the departure delay, since the
   * aeroplane does not make time up in the air.
   */
  const outcome = disruptionOutcomeOf(row.disruption);
  if (outcome !== null) {
    const departureDelayMinutes = row.actualDeparture
      ? Math.max(
          0,
          Math.round((row.actualDeparture.getTime() - row.scheduledDeparture.getTime()) / 60_000),
        )
      : 0;
    const cost = disruptionCost(outcome, departureDelayMinutes, load, economy.costs.disruption);
    if (cost.totalMinor > 0) {
      await moveAirlineCash(tx, {
        airlineId: row.airlineId,
        amountMinor: -cost.totalMinor,
        cause: 'disruption_cost',
        reference: `${row.id}:disruption`,
        occurredAt: arrivedAt,
      });
    }
  }

  // The airframe got older (M4-06, §7.3). In this transaction, after the
  // `flight_result` insert has proved the arrival is not a replay — so hours and
  // cycles accrue exactly once per flight, for the same reason the cash does.
  //
  // A flight whose money moved but whose hours did not would leave the fleet
  // permanently younger than its own history, and the drift would be silent and
  // unrecoverable. `block.blockMinutes` is the number the settlement already
  // billed against; recomputing it here would be a second answer to one fact.
  await accrueFlightHours(tx, row.airframeId, block.blockMinutes / 60);

  // The flight's own arrival. `actualArrival` is only written if it is not
  // already set — a diversion or an air return records its own arrival, and this
  // must not overwrite what actually happened with the queue's schedule.
  await tx
    .update(flight)
    .set({ phase: 'turnaround', actualArrival: row.actualArrival ?? arrivedAt })
    .where(eq(flight.id, row.id));

  return { status: 'settled', settlement, netMinor: settlement.netMinor };
}

/**
 * The `FLIGHT_ARRIVE` handler, for the registry `drainDueEvents` takes.
 *
 * The first production handler in the queue — until now the only ones were test
 * stubs. Note that nothing runs the tick loop in any environment yet, so this is
 * built and tested but not executed: where the engine lives is OPS-08's decision
 * and deliberately not settled here.
 */
export function createFlightArriveHandler(deps: SettlementDeps = {}): EventHandler {
  return async (event, { payload, tx }) => {
    const flightId = payload.flightId;
    if (typeof flightId !== 'string') {
      throw new Error(`FLIGHT_ARRIVE ${event.id} has no flightId in its payload`);
    }

    const outcome = await settleArrivedFlight(tx, flightId, event.fireAt, deps);

    // A missing flight is a real error and must not be swallowed: the event was
    // scheduled against something, and if that something is gone the queue and
    // the flight table disagree. Already-settled is the opposite — the expected
    // outcome of a replay, and the whole point of the unique constraint.
    if (outcome.status === 'not-found') {
      throw new Error(`FLIGHT_ARRIVE ${event.id} refers to unknown flight ${flightId}`);
    }
  };
}
