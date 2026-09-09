/**
 * The belly cargo one flight can sell, resolved from the world (M8-15, §12.1).
 *
 * `@tailfin/sim` owns the two models — `bellyCapacity` says what fits and
 * `cargoLane` says what it earns — and both are pure. This is the layer that
 * feeds them: the airports' own catchment and indices, the airframe's own
 * effective spec, and the world's own pinned economy.
 *
 * ## One resolver, two callers, and that is the point
 *
 * `flight/depart.ts` calls it to decide what a departing flight actually loads;
 * `network/routes.ts` calls it to show a player what a route's hold is worth
 * before they fly it. The projection and the money have to agree, so they run the
 * same function rather than two that look alike — the same discipline that makes
 * the fares preview and the competition view share one allocator.
 *
 * ## The planning cabin, and why it is the seats fitted
 *
 * `flight.load` is still `'{}'`: nothing books passengers onto a flight yet, so
 * there is no cabin load to read. Rather than plan against an empty aeroplane —
 * which would sell belly capacity the passengers are about to need — this plans
 * against **the seats the airframe is offering**, `effective_spec.seatsTwoClass`,
 * which is the same proxy `crew/dispatch.ts` and `crew/legality.ts` already use
 * for "how big is this cabin".
 *
 * That is deliberately the conservative direction. A full cabin is the load
 * planner's assumption and §12.1's own case, so belly revenue is understated
 * rather than overstated until real bookings arrive — and when they do,
 * {@link BellyPlanInput.passengers} is the one line that changes.
 *
 * ## Fuel is read, never re-derived
 *
 * The sector's fuel comes through `computeBlockTime` → `computeFuelBurn`, which
 * is what the settlement itself bills. A second fuel figure computed here would
 * let a flight be *loaded* against one number and *billed* against another, and
 * §12.1's equation has fuel in it — so the two would disagree about how much
 * freight the aeroplane could have taken.
 */

import { inArray } from 'drizzle-orm';

import type { AircraftSpec } from '@tailfin/shared';
import {
  bellyCapacity,
  cargoLane,
  computeBlockTime,
  computeFuelBurn,
  DEFAULT_FLIGHT_PROFILE,
  haversineNm,
  type BellyCapacityResult,
  type CargoLane,
  type CargoLaneConfig,
  type CargoLaneEndpoint,
  type FlightProfile,
} from '@tailfin/sim';

import { loadOptions } from '../aircraft/catalogue';
import { loadFlightAirframe } from '../aircraft/performance';
import { airport } from '../db/schema';
import { loadWorldEconomyConfig } from '../economy/loader';

import type { Database } from '../db/client';
import type { PinnedEconomyConfig } from '../economy/config';
/** One end of a lane, with the coordinates the distance comes from. */
interface LaneAirport extends CargoLaneEndpoint {
  icao: string;
  latitude: number;
  longitude: number;
}

/** A lane resolved against the world, priced in both directions. */
export interface ResolvedCargoLane {
  /** Great-circle sector length, from the airports' own coordinates. */
  distanceNm: number;
  origin: LaneAirport;
  destination: LaneAirport;
  /** Origin → destination. */
  lane: CargoLane;
  /** Destination → origin — §12.2's other leg, and a different number. */
  reverse: CargoLane;
}

/**
 * What a flight's hold is worth, and what limits it.
 *
 * Everything a player needs to make §12.1's trade, and nothing derived twice:
 * the tonnage carried is the lesser of what fits and what the lane offers, and
 * both halves are reported so that "why only two tonnes?" has an answer.
 */
export interface BellyPlan {
  /** Great-circle sector length, from the airports' own coordinates. */
  distanceNm: number;
  /** Fuel aboard for the sector, in tonnes — the term in §12.1's equation. */
  fuelTonnes: number;
  /** Passengers the plan assumed, and whose bags are in the hold. */
  passengers: number;
  /** App. C.6's belly volume multiplier for the options actually fitted. */
  cargoVolumeFactor: number;
  /** What physically fits, and which of the three limits bound it. */
  capacity: BellyCapacityResult;
  /** What the lane pays in this direction. */
  lane: CargoLane;
  /** And flying back, so a rotation can be priced from one call (§12.2). */
  reverseLane: CargoLane;
  /**
   * Tonnes actually loaded: the lesser of capacity and offered demand.
   *
   * Which of the two won is worth knowing and is derivable —
   * `capacity.availableTonnes` and `lane.offeredTonnes` are both here — because
   * *"the hold is full"* and *"there is no more freight on this lane"* are
   * different problems with different answers.
   */
  carriedTonnes: number;
  /** The same figure the `flight.cargo_kg` column takes: whole kilograms. */
  carriedKg: number;
  /** What the whole load earns at this lane's rate, minor units. */
  revenueMinor: number;
}

export interface BellyPlanInput {
  worldId: string;
  airframeId: string;
  originIcao: string;
  destinationIcao: string;
  /**
   * Passengers to plan against, or omitted for the seats fitted.
   *
   * The seam described in the module note. A caller with a real cabin load passes
   * it; everything today omits it and gets the airframe's own layout.
   */
  passengers?: number;
  /** The world's pinned economy, when the caller already has it. */
  economy?: PinnedEconomyConfig;
  /** Aircraft performance, not economy — the same default the settlement takes. */
  profile?: FlightProfile;
}

/**
 * `null` when the flight cannot be planned, and the reasons are all "no data".
 *
 * An unknown airframe, an airport with no coordinates, or a pair the world does
 * not have. Not an error: a departure whose belly cannot be planned should still
 * depart carrying nothing, and a projection should say it does not know rather
 * than refuse the whole route.
 */
/**
 * The lane, both ways, and the sector it runs over.
 *
 * Separate from {@link planBellyCargo} because the lane needs no aeroplane: an
 * airline with no fleet, or a world with no worker, can still be told what
 * freight moves between two cities and what it pays. Both directions come back
 * together because §12.2 calls pricing a cargo lane per leg *"the single most
 * common real-world mistake"*, and a function that made the reverse an extra
 * call would make that mistake the cheaper one to write.
 *
 * `null` when either airport is missing from the world — the same "no data"
 * answer, not an error.
 */
export async function cargoLaneFor(
  db: Database,
  originIcao: string,
  destinationIcao: string,
  config: CargoLaneConfig,
): Promise<ResolvedCargoLane | null> {
  const ends = await laneAirports(db, originIcao, destinationIcao);
  if (!ends) return null;
  const [origin, destination] = ends;

  const distanceNm = haversineNm(
    origin.latitude,
    origin.longitude,
    destination.latitude,
    destination.longitude,
  );

  return {
    distanceNm,
    origin,
    destination,
    lane: cargoLane(origin, destination, distanceNm, config),
    reverse: cargoLane(destination, origin, distanceNm, config),
  };
}

export async function planBellyCargo(
  db: Database,
  input: BellyPlanInput,
): Promise<BellyPlan | null> {
  const basis = await loadFlightAirframe(db, input.worldId, input.airframeId);
  if (!basis) return null;

  const economy = input.economy ?? (await loadWorldEconomyConfig(db, input.worldId));
  const profile = input.profile ?? DEFAULT_FLIGHT_PROFILE;

  const resolved = await cargoLaneFor(db, input.originIcao, input.destinationIcao, economy.cargo);
  if (!resolved) return null;

  // The settlement's own arithmetic, in the settlement's own order. See the
  // module note: a second fuel figure here would let a flight be loaded against
  // one number and billed against another.
  const block = computeBlockTime(resolved.distanceNm, basis.performance.cruiseSpeedKt, profile);
  const burn = computeFuelBurn(block, {
    cruiseBurnTPerNm: basis.performance.cruiseBurnTPerNm,
  });

  const cargoVolumeFactor = await cargoVolumeFactorOf(
    db,
    basis.catalogueVersion,
    basis.buildOptionIds,
  );
  const passengers = input.passengers ?? plannedSeats(basis.spec);
  const capacity = bellyCapacity({
    aircraft: {
      mtowTonnes: basis.spec.mtowTonnes,
      oewTonnes: basis.spec.oewTonnes,
      maxPayloadTonnes: basis.spec.maxPayloadTonnes,
    },
    passengers,
    fuelTonnes: burn.tonnes,
    cargoVolumeFactor,
    freightDensityKgPerM3: economy.cargo.freightDensityKgPerM3,
  });

  // Whole kilograms, because `flight.cargo_kg` is an integer column and rounding
  // at the boundary is the only place it can be done once. Floor rather than
  // round: an aeroplane may not carry a kilogram more than fits.
  const carriedKg = Math.floor(
    Math.min(capacity.availableTonnes, resolved.lane.offeredTonnes) * 1000,
  );

  return {
    distanceNm: resolved.distanceNm,
    fuelTonnes: burn.tonnes,
    passengers,
    cargoVolumeFactor,
    capacity,
    lane: resolved.lane,
    reverseLane: resolved.reverse,
    carriedTonnes: carriedKg / 1000,
    carriedKg,
    revenueMinor: Math.round((carriedKg / 1000) * resolved.lane.ratePerTonneMinor),
  };
}

/**
 * The cabin this airframe is offering.
 *
 * `seatsTwoClass` rather than `maxSeats`: C.2's lower figure is what a normal
 * airline actually fits and the upper is what the certificate allows, and a plan
 * against the certificate would assume a cabin nobody flies. Zero is a real
 * answer — a freighter — and produces a hold with no bags in it, which is
 * exactly right.
 */
function plannedSeats(spec: AircraftSpec): number {
  return spec.seatsTwoClass;
}

/**
 * App. C.6's `cargoVolumeFactor` for the options actually fitted.
 *
 * The one axis of §12.1 that is not in `effective_spec`: C.3 charges belly volume
 * and `AircraftSpec` has no field for it, so `computeEffectiveBuild` carries it
 * as an *extra* and only the fleet API has ever read it. This resolves it from
 * the airframe's own `build_option_ids` against its own pinned catalogue version,
 * which is what makes a belly tank bought three years ago still cost hold space
 * today.
 *
 * `loadCatalogueVersion` caches per version in-process, so this is a map lookup
 * on all but the first flight of a world.
 *
 * An option id that is no longer in its catalogue version contributes nothing
 * rather than failing the flight — the same choice `decomposeAirframe` makes, and
 * for the same reason: the airframe is the record of what was ordered, and an
 * unresolvable id should not stop the aeroplane flying.
 */
async function cargoVolumeFactorOf(
  db: Database,
  catalogueVersion: string,
  optionIds: readonly string[],
): Promise<number> {
  if (optionIds.length === 0) return 1;

  const options = await loadOptions(db, catalogueVersion);
  let factor = 1;
  for (const id of optionIds) {
    factor *= options.get(id)?.specDeltas.cargoVolumeFactor ?? 1;
  }
  return factor;
}

/**
 * Both ends of the lane in one query, or `null` if either is missing.
 *
 * The four cargo columns are the ones §12.2 reads plus the coordinates the
 * distance needs. `wealth_index` and `business_index` are `numeric`, so they
 * arrive as strings and are normalised here — the trap CLAUDE.md records about
 * raw aggregates, in its ordinary-column form.
 */
async function laneAirports(
  db: Database,
  originIcao: string,
  destinationIcao: string,
): Promise<[LaneAirport, LaneAirport] | null> {
  const rows = await db
    .select({
      icao: airport.icaoCode,
      latitude: airport.latitude,
      longitude: airport.longitude,
      catchmentPopulation: airport.catchmentPopulation,
      businessIndex: airport.businessIndex,
      wealthIndex: airport.wealthIndex,
    })
    .from(airport)
    .where(inArray(airport.icaoCode, [originIcao, destinationIcao]));

  const byIcao = new Map(
    rows.map((row) => [
      row.icao,
      {
        icao: row.icao ?? '',
        latitude: row.latitude,
        longitude: row.longitude,
        catchmentPopulation: row.catchmentPopulation,
        businessIndex: numberOrNull(row.businessIndex),
        wealthIndex: numberOrNull(row.wealthIndex),
      } satisfies LaneAirport,
    ]),
  );

  const origin = byIcao.get(originIcao);
  const destination = byIcao.get(destinationIcao);
  return origin && destination ? [origin, destination] : null;
}

/** A `numeric` column reaches the driver as a string; NULL stays NULL. */
function numberOrNull(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
