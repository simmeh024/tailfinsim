import { and, eq, sql } from 'drizzle-orm';

import { CABIN_ORDER, FlightLoad } from '@tailfin/shared';
import type { AirportFees, FlightDisruption } from '@tailfin/shared';
import {
  cargoLane,
  type CargoLaneEndpoint,
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
  handlingPriceFactor,
  haversineNm,
  type SettlementConfig,
  settleFlight,
  type Weather,
  weatherFor,
  type XpDisruption,
} from '@tailfin/sim';

import { accrueFlightHours } from '../aircraft/maintenance';
import {
  loadFlightAirframe,
  UnknownAirframeError,
  type FlightAirframeBasis,
} from '../aircraft/performance';
import { moveAirlineCash } from '../airline/cash';
import { awardFlightXp } from '../crew/xp-store';
import { airport, flight, flightResult, route, world } from '../db/schema';
import { type PinnedEconomyConfig } from '../economy/config';
import { loadWorldFuelContext, marketAt, stationFor } from '../economy/fuel';
import { loadWorldEconomyConfig } from '../economy/loader';
import { handlingArrangementFor, handlingPriceBalanceOf } from '../ground/contracts';

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
 * Three of the four inputs are now real. Distance comes from the airports' own
 * coordinates; fuel is priced at the origin's own station under the world's own
 * curve (M5-07); and since IMPROVE-02 the **aeroplane is the one that flew** —
 * read from `airframe.effective_spec` for the id the flight carries, so block
 * time, fuel burn and the landing fee are all that aircraft's, with any fitted
 * option already folded in.
 *
 * That last one was the expensive gap. Every flight in the game was costed as a
 * 23-tonne turboprop whatever it was, so the fleet page's whole purpose —
 * choosing an aircraft — never reached anybody's balance sheet.
 *
 * What is still a stand-in is **airport charges**: the `airport` table has no
 * `fees` columns, though App. B.2 specifies them and `packages/shared` already
 * has the shape, so every station charges the world's default schedule. M7-04
 * owns that.
 *
 * All four arrive as **resolver functions** with defaults rather than as stubs
 * inside the settlement, which is what let the aircraft become real without
 * anything else here changing. Same boundary M2-04 and M2-05 drew, moved up a
 * layer.
 *
 * ## A flight it cannot cost is not settled
 *
 * If the airframe will not resolve, this throws rather than substituting
 * anything — see `UnknownAirframeError` for why an unsettled arrival is
 * recoverable and a wrongly billed one is not.
 */

export type { SettlementAirframe } from '../aircraft/performance';

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

  /**
   * The aeroplane that flew, and which one it was (IMPROVE-02).
   *
   * Left out in production, where it is read from `airframe.effective_spec` for
   * the id the flight itself carries — so the aircraft a player bought, with the
   * options they fitted, is the aircraft they are billed for. Supplied by tests
   * whose subject is the settlement rather than the fleet, and by nothing else.
   *
   * Returning `null` refuses the settlement rather than substituting anything;
   * see {@link UnknownAirframeError}.
   */
  resolveAirframe?: (
    airframeId: string,
  ) => Promise<FlightAirframeBasis | null> | FlightAirframeBasis | null;
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
  /**
   * The weather the crew landed in (M9-02, §10.2).
   *
   * Left out in production, where M2-09's model derives it from the world's
   * seed, the arrival station and the game date — deterministic, so an old
   * arrival re-derives the same conditions. Supplied by tests whose subject is
   * the XP rather than the weather, because two worlds have two seeds and
   * therefore two different days at what is otherwise the same airport: without
   * this, *"all else equal"* is not a thing a test can arrange.
   *
   * Returning `null` drops the weather term rather than failing the arrival.
   */
  resolveWeather?: (station: {
    icaoCode: string;
    latitude: number;
    longitude: number;
  }) => Weather | null;
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
 * The same disruption, in §10.2's vocabulary.
 *
 * A separate mapping from `disruptionOutcomeOf` and not a reuse, because the two
 * questions differ: that one asks *what does this owe the passengers*, and
 * `returned_to_stand` owes them a rebooking while teaching the crew nothing
 * because the aeroplane never left. This one asks *what did the crew learn*, and
 * only a flight that actually flew and arrived has an answer.
 */
function xpDisruptionOf(disruption: FlightDisruption | null): XpDisruption {
  switch (disruption) {
    case 'delayed':
      return 'delay';
    case 'diverted':
      return 'divert';
    case 'air_return':
      return 'air_return';
    default:
      return 'none';
  }
}

/**
 * The three §12.2 columns off an airport row, in the shape `cargoLane` wants.
 *
 * `business_index` and `wealth_index` are `numeric`, so the driver hands them
 * over as strings; a `null` stays `null`, because an airport with no scheduled
 * service has no catchment row and `cargoLane` treats that as unknown rather
 * than as zero.
 */
function laneEndpointOf(row: {
  catchmentPopulation: number | null;
  businessIndex: string | null;
  wealthIndex: string | null;
}): CargoLaneEndpoint {
  return {
    catchmentPopulation: row.catchmentPopulation,
    businessIndex: numericOrNull(row.businessIndex),
    wealthIndex: numericOrNull(row.wealthIndex),
  };
}

function numericOrNull(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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
      // §12.2's trade proxy (M8-15), for the same reason: the lane's freight rate
      // needs both ends' catchment and indices, and a second query for three
      // columns already on the row would be a query per arrival.
      catchmentPopulation: airport.catchmentPopulation,
      businessIndex: airport.businessIndex,
      wealthIndex: airport.wealthIndex,
      // §10.2's crew XP (M9-02): how hard the field is, and what its local clock
      // reads. Both on the row already, so no second query for two columns.
      difficulty: airport.difficulty,
      utcOffsetMinutes: airport.utcOffsetMinutes,
    })
    .from(airport)
    // The scheduled destination is in the list as well as the arrival airport, so
    // a diverted flight can still be told what its freight was sold at. They are
    // the same airport on every flight that arrived where it was aimed, and
    // Postgres does not mind being asked twice.
    .where(sql`${airport.icaoCode} in (${row.originIcao}, ${arrivalIcao}, ${row.destinationIcao})`);

  const origin = ends.find((a) => a.icao === row.originIcao);
  const arrival = ends.find((a) => a.icao === arrivalIcao);
  if (!origin || !arrival) {
    throw new Error(
      `Cannot settle flight ${flightId}: no coordinates for ${!origin ? row.originIcao : arrivalIcao}`,
    );
  }

  const distanceNm = haversineNm(origin.lat, origin.lon, arrival.lat, arrival.lon);

  /*
   * The aeroplane that actually flew (IMPROVE-02).
   *
   * Every flight used to be costed as a 23-tonne turboprop regardless of what it
   * was, which meant the fleet page's whole purpose — choosing an aircraft —
   * never reached the balance sheet. Read from the id the flight carries, so
   * block time, fuel and the landing fee are all the real aeroplane's, and a
   * fitted option arrives folded into the stored spec.
   *
   * Refused rather than defaulted when it cannot be resolved. See
   * `UnknownAirframeError` for why an unsettled flight is recoverable and a
   * wrongly settled one is not.
   */
  const basis =
    (await (deps.resolveAirframe ?? ((id: string) => loadFlightAirframe(tx, row.worldId, id)))(
      row.airframeId,
    )) ?? null;
  if (basis === null) throw new UnknownAirframeError(row.airframeId, 'missing');
  const airframe = basis.performance;

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

  /*
   * What the departure turn's handling cost (M5-06, §9.3), read from the
   * snapshot the aeroplane took when it actually left.
   *
   * Stored rather than resolved here, because the arrangement is mutable and the
   * flight is not: reading it live billed a flight for whoever handles the
   * station by the time the arrival drained — a player switching handlers
   * mid-flight moved the bill — and made a replay of an old arrival produce a
   * different figure, which the note at the top of this function promises will
   * not happen.
   *
   * **Null means the flight departed before the snapshot existed**, not that it
   * was handled at the standard rate. Those settle the way every flight used to,
   * by resolving the arrangement now; the origin's tier is passed in because it
   * has already been read above.
   */
  const handlingFactor =
    row.handlingPriceFactor ??
    handlingPriceFactor(
      await handlingArrangementFor(
        tx,
        row.airlineId,
        row.originIcao,
        'ramp_baggage',
        economy,
        origin.tier,
      ),
      handlingPriceBalanceOf(economy),
    );

  // `flight.load` is JSON text that M3 writes. Parsed through the shared schema
  // rather than cast, because a malformed load must fail the event loudly rather
  // than settle a flight for a plausible-looking wrong number.
  const load = FlightLoad.parse(JSON.parse(row.load));

  /*
   * What the hold earned, at this lane's own rate in this direction (M8-15, §12.2).
   *
   * The tonnage was decided at pushback and is on the row; only the yield is
   * resolved here, because yield is a property of the *lane* and the lane is a
   * pair of airports this transaction already has. Every other rate on this
   * settlement is resolved the same way and for the same reason — one economy
   * config, read through the world's pin, with `settlement_version` recording
   * which one billed the flight (invariant 4).
   *
   * **Priced on the lane the freight was sold on, not the one flown.** A
   * diversion is settled to where the aeroplane actually went for every *cost*,
   * because that is what the airline incurred (§8.4) — but the shipper bought
   * carriage to the scheduled destination, so the rate and the sector length are
   * the sold lane's. On a flight that arrived where it was aimed these are the
   * same pair and the same distance.
   *
   * `undefined` when the scheduled destination's row has gone, which falls the
   * settlement back to the world-wide figure rather than failing an arrival over
   * a freight rate. See `SettlementConfig.cargoRatePerTonneMinor`.
   */
  const soldTo = ends.find((a) => a.icao === row.destinationIcao);
  const cargoRatePerTonneMinor =
    soldTo === undefined
      ? undefined
      : cargoLane(
          laneEndpointOf(origin),
          laneEndpointOf(soldTo),
          haversineNm(origin.lat, origin.lon, soldTo.lat, soldTo.lon),
          economy.cargo,
        ).ratePerTonneMinor;

  const settlement = settleFlight(
    {
      // A ferry settles to all cost and no revenue, and `settleFlight` refuses
      // one that arrives carrying passengers rather than quietly zeroing it.
      kind: row.kind,
      load,
      cargoKg: row.cargoKg,
      cargoRatePerTonneMinor,
      block,
      fuelCost,
      aircraft: { maxTakeoffWeightT: airframe.maxTakeoffWeightT },
      originFees: resolveFees(row.originIcao),
      destinationFees: resolveFees(arrivalIcao),
      handlingPriceFactor: handlingFactor,
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
        /*
         * Which aeroplane, and under which catalogue (IMPROVE-02).
         *
         * The three performance numbers are recorded alongside the identity
         * rather than left to be looked up, because an airframe is mutable — it
         * can be reconfigured, and its options can change — while this row is
         * not. Without them, "why was this flight billed that much?" is only
         * answerable for an aircraft nobody has touched since.
         *
         * `catalogueVersion` is §22.5's pin and is deliberately not
         * `settlementVersion`, which is §22.3's economy. Two versioned things,
         * and a settlement needs both to be explicable.
         */
        aircraft: {
          airframeId: basis.airframeId,
          catalogueVersion: basis.catalogueVersion,
          typeDesignation: basis.typeDesignation,
          buildOptionIds: basis.buildOptionIds,
          cruiseSpeedKt: airframe.cruiseSpeedKt,
          maxTakeoffWeightT: airframe.maxTakeoffWeightT,
          cruiseBurnTPerNm: airframe.cruiseBurnTPerNm,
        },
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

  /*
   * And the crew got better (M9-02, §10.2). Same position and same reason as the
   * hours above: after the `flight_result` insert has proved this is not a
   * replay, so XP accrues exactly once per flight.
   *
   * The **first server consumer of M2-09's weather model.** It was built
   * deterministic per station-day precisely so a question like this could be
   * re-answered months later, and until now nothing asked — the disruption roll
   * still leaves its two weather risks at zero. `worldSeed` is read here rather
   * than threaded through the settlement because this is the only line that
   * needs it, and a missing world row (a reset mid-flight) simply drops the
   * weather term rather than failing an arrival over it.
   *
   * Isolated from the money above it in one respect only: XP that could not be
   * awarded must not roll back a settled flight. There is nothing here that can
   * fail on a legitimate arrival — the reads are indexed and the update matches
   * on a unique key — so it is left inside the transaction, where an unexpected
   * failure loses the settlement rather than silently diverging the two. A crew
   * that flew a flight the ledger recorded and gained nothing from it is the
   * drift this ordering exists to prevent.
   */
  const arrivalStation = {
    icaoCode: arrival.icao ?? arrivalIcao,
    latitude: arrival.lat,
    longitude: arrival.lon,
  };

  let arrivalWeather: Weather | null;
  if (deps.resolveWeather !== undefined) {
    arrivalWeather = deps.resolveWeather(arrivalStation);
  } else {
    const [worldRow] = await tx
      .select({ seed: world.seed })
      .from(world)
      .where(eq(world.id, row.worldId))
      .limit(1);
    arrivalWeather =
      worldRow === undefined ? null : weatherFor(worldRow.seed, arrivalStation, arrivedAt);
  }

  /*
   * Local hour at the arrival field. `utc_offset_minutes` is **standard time**
   * and deliberately not daylight saving (see the column) — which is the right
   * answer here as well: a night landing is a night landing, and shifting the
   * window twice a year would make the same rotation earn different XP in
   * summer.
   */
  const arrivalLocalHour =
    arrival.utcOffsetMinutes === null
      ? null
      : Math.floor(
          ((((arrivedAt.getTime() + arrival.utcOffsetMinutes * 60_000) / 3_600_000) % 24) + 24) %
            24,
        );

  const xpAward = await awardFlightXp(
    tx,
    {
      crewDutyPeriodId: row.crewDutyPeriodId,
      distanceNm,
      maxTakeoffWeightT: airframe.maxTakeoffWeightT,
      arrivalDifficulty: arrival.difficulty,
      originDifficulty: origin.difficulty,
      arrivalWeather,
      arrivalLocalHour,
      disruption: xpDisruptionOf(row.disruption),
      // The oceanic proxy (§10.2). Both continents are on the rows already read.
      crossesContinents:
        origin.continent !== null &&
        arrival.continent !== null &&
        origin.continent !== arrival.continent,
    },
    economy.crew.xp,
  );

  /*
   * Recorded on the result rather than in a table of its own. §14.1 wants a
   * figure to explain itself, and *"why did that flight earn 209 XP?"* is
   * answered by the factors — but a row per flight per rank would be the
   * highest-volume table in the schema for a question nobody queries in
   * aggregate. `breakdown` is already the settlement's audit trail.
   */
  if (xpAward !== null) {
    await tx
      .update(flightResult)
      .set({
        breakdown: sql`
          jsonb_set(${flightResult.breakdown}::jsonb, '{crewXp}', ${JSON.stringify({
            xpPerHead: xpAward.xp.xpPerHead,
            heads: xpAward.heads,
            totalXp: xpAward.totalXp,
            base: xpAward.xp.base,
            typeFactor: xpAward.xp.typeFactor,
            difficultyMultiplier: xpAward.xp.difficultyMultiplier,
            capped: xpAward.xp.capped,
            factors: xpAward.xp.factors,
            pools: xpAward.pools,
          })}::jsonb, true)::text`,
      })
      .where(eq(flightResult.flightId, row.id));
  }

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
