/**
 * What one flight earned and what it cost (M2-06, §11, §13.4, §14.1).
 *
 * §3.1's principle is that economic resolution happens **at flight events, not
 * continuously**. This is the arithmetic that runs when a flight arrives: every
 * revenue line, every direct cost line, and a net figure that is exactly their
 * difference.
 *
 * ## It does not compute demand, and it must not
 *
 * Revenue arrives already priced, on the flight's `load` — per class, seats
 * offered, passengers carried, revenue taken. Producing that is the whole of M3:
 * the gravity model (M3-01), the logit share model (M3-03), per-class allocation
 * (M3-06), the booking curve (M3-08) and fare setting (M3-09). Settlement sums
 * what those decided and never second-guesses it.
 *
 * That boundary is the same one M2-04 and M2-05 drew — a turnaround takes a
 * congestion factor as a field rather than modelling the airport, a block time
 * takes a cruise speed rather than modelling the airframe. The systems that do
 * not exist yet arrive as inputs, not as stubs.
 *
 * ## Direct costs only, and why that is not a shortcut
 *
 * §13.4 costs out the one-aircraft Amsterdam airline in eight lines:
 *
 *     fuel · maintenance · airport fees · handling · lease · crew · gate · admin
 *
 * Five of those are caused by the flight and stop if it does not operate. Three
 * — **lease, gate and admin** — are period costs: the lease is due whether the
 * aircraft flies or is parked, and charging a share of it to each sector would
 * make a flight look unprofitable for a reason that has nothing to do with the
 * flight. Worse, it would make the cost per sector depend on how many other
 * sectors happened to be flown that month, which is not a property of this
 * flight at all.
 *
 * So a `flight_result` carries direct operating costs and says so. The period
 * costs belong to a periodic P&L, and §14.4's *"profit by route, ranked, with a
 * breakeven line"* is drawn against contribution — which is exactly what
 * {@link FlightSettlement.netMinor} is.
 *
 * ## Every figure carries its cause
 *
 * Invariant 4, and §14.1: *"every figure drills down to its cause."* Nothing here
 * returns a bare total. Each line names its source, its amount, and a sentence
 * saying how it was arrived at, and the totals are computed **by summing the
 * lines** rather than alongside them — so a breakdown that does not reconcile is
 * not representable.
 */

import { CABIN_ORDER } from '@tailfin/shared';
import type { AirportFees, FlightKind, FlightLoad } from '@tailfin/shared';

import { minorFromMajor, roundMinor, sumMinor } from './money';

import type { FuelCostResult } from './fuel-price';
import type { BlockTimeResult } from '../flight/block';

/** Where money came from (§11). */
export type RevenueSource = 'tickets' | 'ancillary' | 'cargo';

/**
 * Where money went. §13.4's five flight-caused lines.
 *
 * `lease`, `gate` and `admin` are deliberately absent — see the note above. If
 * one ever appears here it should be because someone decided a flight causes it,
 * not because a report wanted the columns to add up to a familiar total.
 */
export type CostSource = 'fuel' | 'crew' | 'maintenance' | 'airport' | 'handling';

/** One line of the bill, and the sentence that explains it. */
export interface SettlementLine {
  source: RevenueSource | CostSource;
  /** Whole minor units, always non-negative. The sign is carried by which list it is in. */
  amountMinor: number;
  detail: string;
}

export interface FlightSettlement {
  /** Why the aircraft flew. A `ferry` is all cost and no revenue, by construction. */
  kind: FlightKind;
  /** Sum of {@link revenue}. */
  revenueMinor: number;
  /** Sum of {@link costs}. */
  costMinor: number;
  /** `revenueMinor − costMinor`. Contribution, not profit — period costs are not here. */
  netMinor: number;

  revenue: SettlementLine[];
  costs: SettlementLine[];

  /** Seats offered across every class the cabin has. */
  seats: number;
  /** Passengers actually carried. */
  passengers: number;
  /**
   * Passengers who wanted this flight and could not get on (A.5, M3-05).
   *
   * Carried straight through from the load. A.5 asks the game to be able to
   * say "you turned away 40 passengers a day", and it is not recoverable from
   * anything else on a settled flight.
   */
  spilled: number;
  /** `passengers / seats`, or 0 for a flight with no seats. The headline operating number. */
  loadFactor: number;
  /** Belly freight carried, in kilograms (§12.1). */
  cargoKg: number;
  /** Off-blocks to on-blocks, from M2-05. What crew and maintenance are charged against. */
  blockMinutes: number;

  /**
   * Revenue per available seat, in minor units — RASM, the industry's own
   * measure, and the one §14.4's route ranking is drawn from. Rounded, so it is
   * money rather than a float; the unrounded figure is `revenueMinor / seats`.
   */
  revenuePerSeatMinor: number;
  /** Cost per available seat — CASM. The other half of the same comparison. */
  costPerSeatMinor: number;
}

/**
 * Balance numbers (CONTRIBUTING invariant 3), retunable against a snapshot under
 * §22.3 rather than compiled in.
 *
 * **Calibrated against §13.4**, which is the only place the design doc costs an
 * airline out line by line: an ATR 72 flying eight ~200 nm sectors a day at 68%
 * load factor. Every rate below reproduces its line in that table to within 0.6%
 * — see `settlement.test.ts`, which runs the whole month and checks each one.
 *
 * Rates rather than per-sector amounts, because a rate is a claim about *what
 * drives the cost* and an amount is not. Maintenance is charged per block hour
 * because that is what wears an airframe; handling is charged per seat because
 * that is what makes a turn bigger.
 */
export interface SettlementConfig {
  /**
   * Ancillary revenue per passenger — bags, seat selection, food (§11).
   *
   * **Zero by default, deliberately.** §13.4's revenue is exactly
   * `passengers × average fare` with nothing added, so the €75 in that example
   * is an all-in figure. Splitting fare from ancillary is M3-09's job, and until
   * it happens a non-zero default here would silently inflate every route's
   * revenue above the only published figure there is to check against.
   */
  ancillaryPerPassengerMinor: number;
  /**
   * Belly cargo yield per tonne (§12.1).
   *
   * **Not calibrated.** §13.4's example carries no freight, so there is no
   * anchor for this one and it is an estimate at short-haul belly rates. M12
   * owns cargo pricing properly; treat this as a placeholder that produces a
   * plausible number rather than a defended one.
   */
  cargoRatePerTonneMinor: number;

  /** Flight and cabin crew, per block hour. Block time is what crew are paid for. */
  crewCostPerBlockHourMinor: number;
  /**
   * Maintenance accrual per block hour.
   *
   * An accrual rather than a bill: heavy checks arrive in lumps and this is the
   * reserve set aside against them, which is how airlines actually cost it and
   * how §7.3's maintenance profile will draw against it.
   */
  maintenanceCostPerBlockHourMinor: number;

  /** The part of ground handling that does not care how big the aircraft is. */
  groundHandlingPerTurnMinor: number;
  /** The part that does. More seats, more bags, more cleaning (§9.3). */
  groundHandlingPerSeatMinor: number;
}

export const DEFAULT_SETTLEMENT: SettlementConfig = {
  ancillaryPerPassengerMinor: 0,
  cargoRatePerTonneMinor: 30_000,
  crewCostPerBlockHourMinor: 19_500,
  maintenanceCostPerBlockHourMinor: 65_000,
  groundHandlingPerTurnMinor: 15_000,
  groundHandlingPerSeatMinor: 325,
};

/**
 * Version tag, mirroring `FUEL_BURN_CONFIG_VERSION` and `TURNAROUND_CONFIG_VERSION`.
 *
 * Stored on every `flight_result`, and load-bearing there: a settled flight is a
 * permanent financial record, and after these rates are retuned the only way to
 * explain an old one is to know which rates it ran under (invariant 4).
 */
export const SETTLEMENT_CONFIG_VERSION = 'v1' as const;

/**
 * Placeholder airport charges, until airport rows carry their own.
 *
 * App. B.2 gives every airport a `fees` block and `packages/shared` already has
 * the shape (`AirportFees`), but the `airport` table has no such columns yet — so
 * there is nowhere to read a real per-station figure from. These are a mid-tier
 * European airport, calibrated so that landing plus passenger charges reproduce
 * §13.4's *"airport fees 144k"*.
 *
 * `parkingPerHour` and `gateLeaseAnnual` are part of the contract and are not
 * used here: parking is an overnight cost and a gate lease is a period cost, and
 * neither is caused by a single sector.
 */
export const DEFAULT_AIRPORT_FEES: AirportFees = {
  landingPerTonne: 1_200,
  paxFee: 680,
  parkingPerHour: 4_500,
  gateLeaseAnnual: 22_000_000,
};

/** What the airframe brings to the bill. */
export interface SettlementAircraft {
  /**
   * Maximum takeoff weight in tonnes — what a landing fee is charged against.
   *
   * App. C.3 flags the consequence and it is a real trade: the paper MTOW
   * upgrade buys payload or range and *"raises landing fees at every airport,
   * for ever"*. Reading MTOW here rather than a weight class is what makes that
   * true without special-casing the option.
   */
  maxTakeoffWeightT: number;
}

export interface SettlementInputs {
  /**
   * Why the aircraft flew (M2-07).
   *
   * A `ferry` earns nothing and costs everything. That is enforced here rather
   * than left to the caller passing an empty load, because "no revenue" is a
   * property of the *kind of flight*, and a positioning leg that quietly booked
   * ticket revenue would be a bug worth thousands and invisible in a total.
   */
  kind: FlightKind;
  /** Per class: seats offered, passengers carried, revenue taken. M3 fills it. */
  load: FlightLoad;
  /** Belly freight in kilograms, from `flight.cargo_kg`. */
  cargoKg: number;
  /** From M2-05. Supplies block time, which crew and maintenance are charged against. */
  block: BlockTimeResult;
  /** From M2-05. Already money, in **major** units — converted here, once. */
  fuelCost: FuelCostResult;
  aircraft: SettlementAircraft;
  /** Charges at the departure airport. Passenger fees are levied on departure. */
  originFees: AirportFees;
  /** Charges at the arrival airport. Landing fees are levied on arrival. */
  destinationFees: AirportFees;
}

/** Order for display, so a readout is stable and a test can prove each is reachable. */
export const REVENUE_SOURCES: readonly RevenueSource[] = ['tickets', 'ancillary', 'cargo'];
export const COST_SOURCES: readonly CostSource[] = [
  'fuel',
  'crew',
  'maintenance',
  'airport',
  'handling',
];

/** Cabin classes in cabin order, so a breakdown reads front to back. */
function assertNonNegative(value: number, what: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${what} must be zero or more, got ${String(value)}`);
  }
}

function money(minor: number): string {
  return (minor / 100).toLocaleString('en-GB', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

function round(value: number, places = 1): string {
  return value.toLocaleString('en-GB', {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  });
}

/** Seats, passengers and spill across every class, in cabin order. */
export function summariseLoad(load: FlightLoad): {
  seats: number;
  passengers: number;
  revenueMinor: number;
  /**
   * Passengers turned away, summed across cabins (A.5, M3-05).
   *
   * Carried through settlement rather than computed from it, because spill
   * cannot be recovered from a settled flight: a full aircraft looks the same
   * whether it turned away nobody or two hundred, and that difference is the
   * whole strategic signal.
   */
  spilled: number;
} {
  let seats = 0;
  let passengers = 0;
  let spilled = 0;
  const revenues: number[] = [];

  for (const cabin of CABIN_ORDER) {
    const entry = load[cabin];
    if (!entry) continue;
    assertNonNegative(entry.seats, `Seats in ${cabin}`);
    assertNonNegative(entry.passengers, `Passengers in ${cabin}`);
    if (entry.passengers > entry.seats) {
      throw new Error(
        `${cabin} carried ${String(entry.passengers)} passengers in ${String(entry.seats)} seats`,
      );
    }
    // Absent means "not recorded" — every load written before M3-05 predates
    // the field — and that reads as zero here without pretending it was measured.
    const turnedAway = entry.spilled ?? 0;
    assertNonNegative(turnedAway, `Spilled passengers in ${cabin}`);
    if (turnedAway > 0 && entry.passengers < entry.seats) {
      throw new Error(
        `${cabin} spilled ${String(turnedAway)} passengers with ${String(entry.seats - entry.passengers)} seats empty`,
      );
    }
    seats += entry.seats;
    passengers += entry.passengers;
    spilled += turnedAway;
    revenues.push(entry.revenue);
  }

  return { seats, passengers, revenueMinor: sumMinor(revenues), spilled };
}

/**
 * Settle one flight.
 *
 * Pure, like everything in this package: the same flight settles to the same
 * figures for ever, which is what lets M13-02's economy regression suite compare
 * a rerun against a recorded one and what lets a player ask in six months why a
 * flight in October made what it made.
 */
export function settleFlight(
  inputs: SettlementInputs,
  config: SettlementConfig = DEFAULT_SETTLEMENT,
): FlightSettlement {
  const { kind, load, cargoKg, block, fuelCost, aircraft, originFees, destinationFees } = inputs;

  assertNonNegative(cargoKg, 'Cargo');
  assertNonNegative(aircraft.maxTakeoffWeightT, 'Maximum takeoff weight');
  assertNonNegative(block.blockMinutes, 'Block minutes');

  const { seats, passengers, revenueMinor: ticketsMinor, spilled } = summariseLoad(load);

  // A ferry is refused rather than silently zeroed. Zeroing would make a
  // mis-typed flight settle to a plausible-looking number; refusing makes it a
  // failed event somebody has to look at, which is the right direction to fail
  // when the alternative is an airline quietly paid for seats it never sold.
  if (kind === 'ferry' && (passengers > 0 || ticketsMinor !== 0)) {
    throw new Error(
      `A ferry flight carries no revenue passengers, but this one has ` +
        `${String(passengers)} passengers and ${money(ticketsMinor)} of ticket revenue`,
    );
  }
  const blockHours = block.blockMinutes / 60;
  const cargoTonnes = cargoKg / 1000;

  // ---- Revenue -----------------------------------------------------------
  const revenue: SettlementLine[] = [];

  revenue.push({
    source: 'tickets',
    amountMinor: ticketsMinor,
    detail:
      kind === 'ferry'
        ? 'Positioning flight — no passengers carried and none may be.'
        : `${String(passengers)} passenger${passengers === 1 ? '' : 's'} in ${String(seats)} seats, ` +
          `priced by the fare model.`,
  });

  const ancillaryMinor = roundMinor(passengers * config.ancillaryPerPassengerMinor);
  if (ancillaryMinor > 0) {
    revenue.push({
      source: 'ancillary',
      amountMinor: ancillaryMinor,
      detail: `Bags, seat selection and onboard sales at ${money(config.ancillaryPerPassengerMinor)} a passenger.`,
    });
  }

  const cargoMinor = roundMinor(cargoTonnes * config.cargoRatePerTonneMinor);
  if (cargoMinor > 0) {
    revenue.push({
      source: 'cargo',
      amountMinor: cargoMinor,
      detail: `${round(cargoTonnes, 2)} t of belly freight at ${money(config.cargoRatePerTonneMinor)} a tonne.`,
    });
  }

  // ---- Direct costs ------------------------------------------------------
  const costs: SettlementLine[] = [];

  const fuelMinor = minorFromMajor(fuelCost.totalCost);
  costs.push({
    source: 'fuel',
    amountMinor: fuelMinor,
    detail:
      `${round(fuelCost.tonnes, 2)} t at ${money(minorFromMajor(fuelCost.pricePerTonne))} a tonne, ` +
      `bought at ${fuelCost.icao}.`,
  });

  const crewMinor = roundMinor(blockHours * config.crewCostPerBlockHourMinor);
  costs.push({
    source: 'crew',
    amountMinor: crewMinor,
    detail: `${round(blockHours, 2)} block hours at ${money(config.crewCostPerBlockHourMinor)} an hour.`,
  });

  const maintenanceMinor = roundMinor(blockHours * config.maintenanceCostPerBlockHourMinor);
  costs.push({
    source: 'maintenance',
    amountMinor: maintenanceMinor,
    detail:
      `${round(blockHours, 2)} block hours accrued at ${money(config.maintenanceCostPerBlockHourMinor)} ` +
      `an hour against future checks.`,
  });

  const landingMinor = roundMinor(aircraft.maxTakeoffWeightT * destinationFees.landingPerTonne);
  const paxFeeMinor = roundMinor(passengers * originFees.paxFee);
  costs.push({
    source: 'airport',
    amountMinor: sumMinor([landingMinor, paxFeeMinor]),
    detail:
      `Landing ${round(aircraft.maxTakeoffWeightT, 1)} t at ${money(destinationFees.landingPerTonne)} a tonne ` +
      `(${money(landingMinor)}), and ${String(passengers)} departing passengers at ` +
      `${money(originFees.paxFee)} each (${money(paxFeeMinor)}).`,
  });

  const handlingMinor = roundMinor(
    config.groundHandlingPerTurnMinor + seats * config.groundHandlingPerSeatMinor,
  );
  costs.push({
    source: 'handling',
    amountMinor: handlingMinor,
    detail:
      `Ramp, bags and cleaning: ${money(config.groundHandlingPerTurnMinor)} a turn plus ` +
      `${String(seats)} seats at ${money(config.groundHandlingPerSeatMinor)}.`,
  });

  // ---- Totals ------------------------------------------------------------
  // Summed from the rounded lines, never computed alongside them. That is what
  // makes the breakdown reconcile exactly rather than to within a cent.
  const revenueMinor = sumMinor(revenue.map((l) => l.amountMinor));
  const costMinor = sumMinor(costs.map((l) => l.amountMinor));

  return {
    kind,
    revenueMinor,
    costMinor,
    netMinor: revenueMinor - costMinor,
    revenue,
    costs,
    seats,
    passengers,
    spilled,
    loadFactor: seats === 0 ? 0 : passengers / seats,
    cargoKg,
    blockMinutes: block.blockMinutes,
    revenuePerSeatMinor: seats === 0 ? 0 : roundMinor(revenueMinor / seats),
    costPerSeatMinor: seats === 0 ? 0 : roundMinor(costMinor / seats),
  };
}
