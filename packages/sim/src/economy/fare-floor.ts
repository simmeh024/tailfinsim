/**
 * The price floor (M3-09, App. A.10, §8.3).
 *
 * A.10 lists it among the anti-degenerate rules, against the exploit *"price to
 * zero and dominate"*:
 *
 * > *"Fares below 60% of route variable cost are blocked."*
 *
 * Without it the logit has an obvious dominant strategy. β_price is the largest
 * coefficient leisure has, so a fare of one cent takes essentially the whole
 * leisure market — and since A.2's induced demand *grows* the pool as fares
 * fall, the market rewards it twice. The floor is what stops the whole game
 * collapsing into a race to zero.
 *
 * ## The floor is computed by settling a flight, not by a cost model of its own
 *
 * The obvious implementation is a second cost formula — distance times a rate.
 * That would drift from settlement the first time a cost line was retuned, and
 * a floor that disagrees with the bill is worse than no floor: it either blocks
 * fares that are actually profitable, or permits ones that are not.
 *
 * So {@link routeVariableCostPerSeatMinor} builds a synthetic full-load flight
 * for the route and runs {@link settleFlight} on it — the same function that
 * settles a real arrival — then divides the cost by the seats. There is exactly
 * one cost model in this codebase, and this is not a second one.
 *
 * That also gives the floor the right shape for free: §13.4's split between
 * flight-caused and period costs already lives in `settleFlight`, so the floor
 * is drawn against **direct operating cost** rather than against a share of the
 * lease, which is what "variable cost" means.
 *
 * ## What it does not know yet
 *
 * A route's cost depends on the aircraft flying it, and there is no fleet
 * (M4). The airframe therefore arrives as an input rather than being looked up
 * — the same seam M2-04 and M2-05 use, and the same reason: a system that does
 * not exist yet arrives as a parameter, not as a stub.
 */

import type { AirportFees, CabinClass, FlightLoad } from '@tailfin/shared';

import { computeBlockTime } from '../flight/block';
import { computeFuelBurn } from '../flight/fuel';
import { DEFAULT_FLIGHT_PROFILE, type FlightProfile } from '../flight/profile';

import { computeFuelCost, type FuelMarket, type FuelStation } from './fuel-price';
import { DEFAULT_SETTLEMENT, type SettlementConfig, settleFlight } from './settlement';

/** A.10's threshold: a fare may not fall below this share of variable cost. */
export const FARE_FLOOR_RATIO = 0.6;

/** What the aircraft on this route costs to fly, until M4 can say. */
export interface FareFloorAircraft {
  cruiseSpeedKt: number;
  cruiseBurnTPerNm: number;
  maxTakeoffWeightT: number;
  /** Seats per cabin. The floor is per seat, so the layout matters. */
  seatsByCabin: Partial<Record<CabinClass, number>>;
}

export interface FareFloorInputs {
  distanceNm: number;
  aircraft: FareFloorAircraft;
  market: FuelMarket;
  originStation: FuelStation;
  originFees: AirportFees;
  destinationFees: AirportFees;
  /** Defaults to `DEFAULT_FLIGHT_PROFILE`; a sector with its own climb profile should pass it. */
  profile?: FlightProfile;
}

export interface RouteVariableCost {
  /** Direct operating cost for one full sector, in minor units. */
  sectorCostMinor: number;
  seats: number;
  /** `sectorCostMinor ÷ seats`, unrounded. */
  perSeatMinor: number;
  blockMinutes: number;
}

function totalSeats(seatsByCabin: Partial<Record<CabinClass, number>>): number {
  return Object.values(seatsByCabin).reduce((sum, n) => sum + (n ?? 0), 0);
}

/**
 * What one seat on this route costs to operate.
 *
 * Settles a synthetic full flight — see the module note on why this is not a
 * cost model of its own. Full, because variable cost per seat is a property of
 * the sector rather than of how well it happened to sell; dividing a
 * half-empty flight's cost by its seats would give the same answer anyway,
 * since the costs `settleFlight` charges are per block hour and per seat rather
 * than per passenger.
 */
export function routeVariableCostPerSeatMinor(
  inputs: FareFloorInputs,
  config: SettlementConfig = DEFAULT_SETTLEMENT,
): RouteVariableCost {
  const seats = totalSeats(inputs.aircraft.seatsByCabin);
  if (seats <= 0) {
    throw new Error('A route with no seats has no cost per seat');
  }

  const profile = inputs.profile ?? DEFAULT_FLIGHT_PROFILE;
  const block = computeBlockTime(inputs.distanceNm, inputs.aircraft.cruiseSpeedKt, profile);
  const burn = computeFuelBurn(block, { cruiseBurnTPerNm: inputs.aircraft.cruiseBurnTPerNm });
  const fuelCost = computeFuelCost(burn.tonnes, inputs.market, inputs.originStation);

  // A full load at zero revenue. Revenue is irrelevant to a cost figure, and
  // passing zero keeps this from accidentally becoming a profitability model.
  const load: FlightLoad = {};
  for (const [cabin, n] of Object.entries(inputs.aircraft.seatsByCabin)) {
    if ((n ?? 0) > 0) {
      load[cabin as CabinClass] = { seats: n, passengers: n, revenue: 0 };
    }
  }

  const settlement = settleFlight(
    {
      kind: 'scheduled',
      load,
      cargoKg: 0,
      block,
      fuelCost,
      aircraft: { maxTakeoffWeightT: inputs.aircraft.maxTakeoffWeightT },
      originFees: inputs.originFees,
      destinationFees: inputs.destinationFees,
    },
    config,
  );

  return {
    sectorCostMinor: settlement.costMinor,
    seats,
    perSeatMinor: settlement.costMinor / seats,
    blockMinutes: block.blockMinutes,
  };
}

export interface FareFloor {
  /** The lowest fare A.10 permits, in whole minor units. */
  floorMinor: number;
  /** What one seat costs to fly, for the message. */
  variableCostPerSeatMinor: number;
  ratio: number;
}

/**
 * A.10's floor, rounded **up**.
 *
 * Up rather than to nearest, because a floor rounded down is a floor a fare can
 * sit fractionally beneath — which is the one direction a limit must never
 * round.
 */
export function fareFloor(cost: RouteVariableCost, ratio: number = FARE_FLOOR_RATIO): FareFloor {
  if (!Number.isFinite(ratio) || ratio <= 0) {
    throw new Error(`The floor ratio must be positive, got ${String(ratio)}`);
  }
  return {
    floorMinor: Math.ceil(cost.perSeatMinor * ratio),
    variableCostPerSeatMinor: cost.perSeatMinor,
    ratio,
  };
}

export type FareCheck =
  | { ok: true; floorMinor: number }
  | {
      ok: false;
      floorMinor: number;
      /** How far under it the fare is, so the message can say by how much. */
      shortfallMinor: number;
      variableCostPerSeatMinor: number;
      ratio: number;
    };

/**
 * Whether a fare clears the floor.
 *
 * Returns the floor either way. M3-09's acceptance criterion is that a
 * rejection *"explains the floor value"* — a refusal that does not say what
 * the limit was leaves the player guessing at a number the server already
 * knows, which is §14.1's dead-end number wearing a different hat.
 */
export function checkFare(fareMinor: number, floor: FareFloor): FareCheck {
  if (!Number.isFinite(fareMinor) || fareMinor < 0) {
    throw new Error(`A fare must be zero or more, got ${String(fareMinor)}`);
  }

  if (fareMinor >= floor.floorMinor) {
    return { ok: true, floorMinor: floor.floorMinor };
  }

  return {
    ok: false,
    floorMinor: floor.floorMinor,
    shortfallMinor: floor.floorMinor - fareMinor,
    variableCostPerSeatMinor: floor.variableCostPerSeatMinor,
    ratio: floor.ratio,
  };
}
