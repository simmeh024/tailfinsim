import { and, eq, inArray } from 'drizzle-orm';

import { moveAirlineCash } from '../airline/cash';
import { monthAfter, previousMonth } from '../crew/payroll';
import { aircraftOrder, airframe, cashMovement } from '../db/schema';

import type { Database } from '../db/client';

/**
 * §7.2's lease, finally charged (OTHER-01).
 *
 * > *"**Lease** — low upfront, monthly drain, available immediately."*
 *
 * `aircraft_order.monthly_lease_rate_minor` has been written on every lease since
 * M4-03 and nothing ever charged it, so a leased aeroplane cost its deposit and
 * then nothing, for ever — and §7.2's whole trade, lower cash now for a higher
 * cost over time, had no second half. Leasing was strictly better than buying at
 * every fleet size. This is the second half.
 *
 * ## Month to month, from delivery
 *
 * A lease is billed for every game month the airframe is held, from its
 * `delivered_at` until it is repossessed, **prorated by the game time held in the
 * month** — so an aeroplane delivered on the 28th pays three days of its first
 * month, not thirty. There is **no term and no return**: §24 names *"lessor
 * counterparties, lease terms and return conditions"* as a gap the design doc
 * does not yet specify, and MARKET-05 (#1103) owns the lessor model. Rolling
 * month to month is the reading that invents nothing — and the one the shipped
 * data already describes, since `aircraft_order` records a rate and no term.
 *
 * ## One arithmetic, for the bill and for the forecast
 *
 * `leaseRentalForMonth` decides what one airframe owes for one month, and both
 * `runLeaseRentals` (the worker's charge) and the cash runway's commitment call
 * it — so the runway projects exactly the figure the sweep goes on to charge, the
 * acceptance criterion M8-08 excluded leases to avoid breaking.
 */

/** One leased airframe, as the rental reads it. */
export interface LeaseRentalLine {
  airlineId: string;
  airframeId: string;
  registration: string;
  monthlyLeaseRateMinor: number;
  /** Game time it entered the world. */
  deliveredAt: Date;
  /** Game time it was repossessed (§13.5), or null. Not billed after it. */
  repossessedAt: Date | null;
}

/** Every leased airframe in a world (or one airline's), with the rate it was signed at. */
export async function leaseRentalLines(
  db: Database,
  worldId: string,
  airlineId?: string,
): Promise<LeaseRentalLine[]> {
  const rows = await db
    .select({
      airlineId: airframe.airlineId,
      airframeId: airframe.id,
      registration: airframe.registration,
      monthlyLeaseRateMinor: aircraftOrder.monthlyLeaseRateMinor,
      deliveredAt: airframe.deliveredAt,
      repossessedAt: airframe.repossessedAt,
    })
    .from(airframe)
    .innerJoin(aircraftOrder, eq(aircraftOrder.id, airframe.sourceOrderId))
    .where(
      and(
        eq(airframe.worldId, worldId),
        eq(airframe.ownership, 'leased'),
        eq(aircraftOrder.kind, 'lease'),
        ...(airlineId === undefined ? [] : [eq(airframe.airlineId, airlineId)]),
      ),
    );
  // A lease row with no rate cannot be priced; it is skipped rather than billed
  // as zero, and a rate is written on every lease order, so this is defensive.
  return rows.flatMap((row) =>
    row.monthlyLeaseRateMinor === null || row.monthlyLeaseRateMinor <= 0
      ? []
      : [{ ...row, monthlyLeaseRateMinor: row.monthlyLeaseRateMinor }],
  );
}

/** A `YYYY-MM` game month's bounds, `[start, end)`. */
export function monthBounds(period: string): { start: Date; end: Date } {
  return {
    start: new Date(`${period}-01T00:00:00.000Z`),
    end: new Date(`${monthAfter(period)}-01T00:00:00.000Z`),
  };
}

/**
 * What one leased airframe owes for one game month: its monthly rate times the
 * share of the month it was held, rounded to a whole minor unit.
 */
export function leaseRentalForMonth(line: LeaseRentalLine, period: string): number {
  const { start, end } = monthBounds(period);
  const from = Math.max(start.getTime(), line.deliveredAt.getTime());
  const until = Math.min(end.getTime(), line.repossessedAt?.getTime() ?? end.getTime());
  if (until <= from) return 0;
  const share = (until - from) / (end.getTime() - start.getTime());
  return Math.round(line.monthlyLeaseRateMinor * share);
}

export interface AirlineLeaseBill {
  totalMinor: number;
  /** Per airframe, for the ledger's aircraft dimension. */
  lines: { airframeId: string; registration: string; amountMinor: number }[];
}

/** Fold every airframe's month into one bill per airline. */
export function foldLeaseRentals(
  lines: readonly LeaseRentalLine[],
  period: string,
): Map<string, AirlineLeaseBill> {
  const bills = new Map<string, AirlineLeaseBill>();
  for (const line of lines) {
    const amountMinor = leaseRentalForMonth(line, period);
    if (amountMinor <= 0) continue;
    const bill = bills.get(line.airlineId) ?? { totalMinor: 0, lines: [] };
    bill.totalMinor += amountMinor;
    bill.lines.push({ airframeId: line.airframeId, registration: line.registration, amountMinor });
    bills.set(line.airlineId, bill);
  }
  return bills;
}

function rentalReference(airlineId: string, period: string): string {
  return `aircraft_lease_rental:${airlineId}:${period}`;
}

export interface LeaseRentalResult {
  airlinesBilled: number;
  totalMinor: number;
}

/**
 * The worker's sweep: bill the game month that has just closed, once, for every
 * leased airframe in the world.
 *
 * The payroll's shape exactly — attempted every tick, idempotent by AIR-06's
 * reference, needing no "last billed" column and self-healing across a month
 * boundary the worker was down for. One movement per airline per month, with a
 * ledger line per airframe under `lease_finance`, so §14.1's *"why did I pay
 * this?"* is answered aeroplane by aeroplane.
 *
 * **Production has no worker**, so there a lease is still free — not a degraded
 * mechanic but a dominant strategy, the same shape as an unbilled self-handling
 * payroll. `leaseRentalsBilled` and `leaseErrors` are the counters.
 */
export async function runLeaseRentals(
  db: Database,
  worldId: string,
  gameNow: Date,
): Promise<LeaseRentalResult> {
  const period = previousMonth(gameNow);
  const bills = foldLeaseRentals(await leaseRentalLines(db, worldId), period);
  if (bills.size === 0) return { airlinesBilled: 0, totalMinor: 0 };

  // Already billed this month: read first, so AIR-06's replay guard is never
  // the ordinary path (the payroll's reasoning).
  const already = new Set(
    (
      await db
        .select({ reference: cashMovement.reference })
        .from(cashMovement)
        .where(
          inArray(
            cashMovement.reference,
            [...bills.keys()].map((airlineId) => rentalReference(airlineId, period)),
          ),
        )
    ).map((row) => row.reference),
  );

  const occurredAt = monthBounds(period).end;
  let airlinesBilled = 0;
  let totalMinor = 0;
  for (const [airlineId, bill] of bills) {
    const reference = rentalReference(airlineId, period);
    if (already.has(reference)) continue;
    // Inside a transaction, as every payroll is: the reconciliation trigger is
    // deferred, and outside one the movement would commit before the balance.
    const result = await db.transaction((tx) =>
      moveAirlineCash(tx, {
        airlineId,
        amountMinor: -bill.totalMinor,
        cause: 'aircraft_lease_rental',
        reference,
        occurredAt,
        ledgerLines: bill.lines.map((line) => ({
          amountMinor: -line.amountMinor,
          category: 'lease_finance' as const,
          counterparty: 'lessor',
          aircraftId: line.airframeId,
        })),
      }),
    );
    if (result.status !== 'already-applied') {
      airlinesBilled += 1;
      totalMinor += bill.totalMinor;
    }
  }
  return { airlinesBilled, totalMinor };
}
