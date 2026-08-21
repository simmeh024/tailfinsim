/**
 * Setting a fare, and refusing one (M3-09, App. A.10, §8.3).
 *
 * Two things happen here, and the interesting part of each is *where* it
 * happens rather than what it computes.
 *
 * ## The floor is enforced on the server, against the real settlement
 *
 * A.10 blocks fares below 60% of route variable cost. That check runs here
 * because invariant 1 says the server is authoritative — a client-side floor is
 * a suggestion — and it draws its cost from `routeVariableCostPerSeatMinor`,
 * which settles a synthetic full flight through the same `settleFlight` a real
 * arrival gets. There is one cost model in this codebase and the floor is not a
 * second one.
 *
 * ## The preview runs the resolution code, because it cannot run anything else
 *
 * M3-09 asks that the preview *"uses the same sim code as resolution, not a
 * duplicate estimate"*, and the architecture makes that the only option
 * available: `packages/web` may not import `@tailfin/sim` at all — ESLint
 * refuses it — so a projected share has to come from the server or not exist.
 *
 * So {@link previewFares} calls `computeShares` and `allocateByClass`: the same
 * functions that will decide the market for real. A preview that disagreed with
 * the outcome would be worse than no preview, because a player would price
 * against it.
 *
 * ## What it does not know yet
 *
 * There is no fleet (M4) and no competitor discovery, so the aircraft and the
 * rival operators arrive as inputs. The seam is the one M2-04, M2-05 and
 * M3-07 all use — a system that does not exist yet arrives as a parameter,
 * never as a stub that pretends to be it.
 */

import { and, eq } from 'drizzle-orm';

import {
  type CabinClass,
  CABIN_ORDER,
  type CabinMarketPosition,
  type DemandSegment,
  type FareFloorViolation,
  FareTable,
  type FarePreviewResponse,
  type SetFaresResponse,
  type AirportFees,
} from '@tailfin/shared';
import {
  allocateByClass,
  type CabinOffer,
  checkFare,
  type ClassOperator,
  fareFloor,
  type FareFloorAircraft,
  routeVariableCostPerSeatMinor,
  type FuelMarket,
  type FuelStation,
} from '@tailfin/sim';

import { airline, route } from '../db/schema';

import type { Database } from '../db/client';

/**
 * Everything about the route that M4 and M7 will one day supply.
 *
 * Passed in rather than looked up, and the caller is responsible for it being
 * true. When the fleet exists this becomes a query and this interface becomes
 * its result.
 */
export interface RouteEconomics {
  aircraft: FareFloorAircraft;
  market: FuelMarket;
  originStation: FuelStation;
  originFees: AirportFees;
  destinationFees: AirportFees;
  /** Today's pool for this pair, per segment, from M3-01 and M3-02. */
  segmentPools: Record<DemandSegment, number>;
  /** Who else is selling this pair. Empty is legal — a monopoly is a market of one. */
  competitors: readonly ClassOperator[];
  /** The player's own non-price attributes, until M6 and §15 can supply them. */
  self: { reputation: number; productScore: number; frequency: number };
}

export interface RouteRow {
  id: string;
  /** Carried so the economics provider can find this route's own market. */
  worldId: string;
  airlineId: string;
  originIcao: string;
  destinationIcao: string;
  greatCircleNm: number;
  fares: FareTable;
}

/** Parse the stored fare table, loudly. */
export function parseFares(raw: string): FareTable {
  // Through the shared schema rather than cast, for the same reason
  // `flight.load` is: a malformed fare table must fail the request rather than
  // price a seat at a plausible wrong number.
  return FareTable.parse(JSON.parse(raw));
}

/**
 * The floor for this route, per seat.
 *
 * One figure for the whole route rather than one per cabin: A.10's rule is
 * about *route* variable cost, and a business seat does not cost four times an
 * economy seat to fly — it costs the same to fly and takes more floor space.
 * Charging a premium cabin a higher floor would be inventing a rule the design
 * doc does not have.
 */
export function floorFor(economics: RouteEconomics, greatCircleNm: number) {
  return fareFloor(
    routeVariableCostPerSeatMinor({
      distanceNm: greatCircleNm,
      aircraft: economics.aircraft,
      market: economics.market,
      originStation: economics.originStation,
      originFees: economics.originFees,
      destinationFees: economics.destinationFees,
    }),
  );
}

/**
 * Check a proposed fare table against A.10's floor.
 *
 * Every offending cabin is returned, not just the first. A player who set four
 * fares too low should be told about four, or they will fix one and be refused
 * again — which is the kind of interaction that teaches people the console is
 * lying to them.
 */
export function violationsFor(
  fares: FareTable,
  economics: RouteEconomics,
  greatCircleNm: number,
): FareFloorViolation[] {
  const floor = floorFor(economics, greatCircleNm);
  const violations: FareFloorViolation[] = [];

  for (const cabin of CABIN_ORDER) {
    const fareMinor = fares[cabin];
    if (fareMinor === undefined) continue;

    const result = checkFare(fareMinor, floor);
    if (result.ok) continue;

    violations.push({
      cabin,
      fareMinor,
      floorMinor: result.floorMinor,
      shortfallMinor: result.shortfallMinor,
      variableCostPerSeatMinor: Math.round(result.variableCostPerSeatMinor),
      ratio: result.ratio,
    });
  }

  return violations;
}

/**
 * Save a fare table, or refuse it with the numbers.
 *
 * Ownership is the caller's to have established — this takes a route row it has
 * already resolved within the player's airline, which is the shape that cannot
 * express the "forgot to check" bug.
 */
export async function setFares(
  db: Database,
  row: RouteRow,
  fares: FareTable,
  economics: RouteEconomics,
): Promise<SetFaresResponse | { ok: false; kind: 'airline-ceased' }> {
  const violations = violationsFor(fares, economics, row.greatCircleNm);
  if (violations.length > 0) {
    return { ok: false, violations };
  }

  const saved = await db.transaction(async (tx): Promise<boolean> => {
    const states = await tx
      .select({ status: airline.status })
      .from(airline)
      .where(eq(airline.id, row.airlineId))
      .limit(1)
      .for('update');
    if (states[0]?.status === 'ceased') return false;
    if (!states[0]) throw new Error(`Airline ${row.airlineId} vanished while setting fares`);

    await tx
      .update(route)
      .set({ fares: JSON.stringify(fares), updatedAt: new Date() })
      .where(and(eq(route.id, row.id), eq(route.airlineId, row.airlineId)));
    return true;
  });
  if (!saved) return { ok: false, kind: 'airline-ceased' };

  return { ok: true, fares };
}

/**
 * Build the player's own competitor entry at a given fare table.
 *
 * Exported so M3-10's waterfall competes the *same* airline the preview does.
 * Two constructions of "you" would eventually disagree, and the chart explains
 * the market it is drawn from or it explains nothing.
 */
export function selfAsOperator(
  id: string,
  fares: FareTable,
  economics: RouteEconomics,
): ClassOperator {
  const cabins: Partial<Record<CabinClass, CabinOffer>> = {};

  for (const cabin of CABIN_ORDER) {
    const seats = economics.aircraft.seatsByCabin[cabin] ?? 0;
    const fareMinor = fares[cabin];
    if (seats > 0 && fareMinor !== undefined && fareMinor > 0) {
      cabins[cabin] = { seats, fareMinor };
    }
  }

  return {
    id,
    frequency: economics.self.frequency,
    productScore: economics.self.productScore,
    reputation: economics.self.reputation,
    cabins,
  };
}

function passengersFor(allocation: ReturnType<typeof allocateByClass>, id: string): number {
  return (allocation.byOperator[id] ?? []).reduce((sum, row) => sum + row.passengers, 0);
}

/**
 * What would happen if you saved these fares.
 *
 * Runs A.6's per-cabin allocation — which runs A.3's logit and A.5's capacity
 * clearing underneath — on the proposed fares and again on the saved ones, so
 * the panel can show a delta rather than an absolute nobody can calibrate.
 */
export function previewFares(
  row: RouteRow,
  proposed: FareTable,
  economics: RouteEconomics,
): FarePreviewResponse {
  const floor = floorFor(economics, row.greatCircleNm);
  const you = 'you';

  const run = (fares: FareTable) =>
    allocateByClass({
      operators: [selfAsOperator(you, fares, economics), ...economics.competitors],
      segmentPools: economics.segmentPools,
    });

  const projected = run(proposed);
  const current = run(row.fares);

  const positions: CabinMarketPosition[] = [];

  for (const cabin of CABIN_ORDER) {
    const seats = economics.aircraft.seatsByCabin[cabin] ?? 0;
    const yourFareMinor = proposed[cabin] ?? null;

    // The market average is A.3's `PriceRel` denominator — a plain mean across
    // the operators selling this cabin, exactly as A.8 computes it.
    const sellers = [
      ...(yourFareMinor !== null && seats > 0 ? [yourFareMinor] : []),
      ...economics.competitors
        .map((c) => c.cabins[cabin]?.fareMinor)
        .filter((f): f is number => f !== undefined),
    ];
    const marketAverageMinor =
      sellers.length === 0 ? 0 : sellers.reduce((sum, f) => sum + f, 0) / sellers.length;

    const outcome = projected.byCabin.find((c) => c.cabin === cabin);
    const pool = outcome?.pool ?? 0;
    // A.4's share — demand *won*, before capacity clears it. Not booked ÷ pool:
    // that is a load factor wearing a share's name, and it reads as 0.14 for a
    // monopolist with a small aeroplane, which is the opposite of what a
    // pricing panel is asking.
    const demandWon = outcome?.shares?.totalPassengers[you] ?? 0;

    positions.push({
      cabin,
      yourFareMinor,
      marketAverageMinor: Math.round(marketAverageMinor),
      priceRel:
        yourFareMinor === null || marketAverageMinor === 0
          ? null
          : yourFareMinor / marketAverageMinor,
      floorMinor: floor.floorMinor,
      projectedShare: outcome === undefined || pool === 0 ? null : Math.min(1, demandWon / pool),
      seats,
    });
  }

  return {
    routeId: row.id,
    positions,
    projectedPassengers: passengersFor(projected, you),
    currentPassengers: passengersFor(current, you),
  };
}
