/**
 * What a stand costs to hold, and what happens when you do not use it (M7-06).
 *
 * Two sweeps, both the worker's, both on the world's game clock.
 *
 * ## This is a worker story, and the failure mode is generosity
 *
 * App. B.6 makes gates *"the single most contested resource at flagship
 * airports"* and counters hoarding with a use-it-or-lose-it floor. Neither the
 * bill nor the floor happens without something running them. **Production has no
 * worker** (OPS-12), so on a production world a lease is signed once and then
 * held free and for ever: no monthly fee, no floor, and an exclusive lease over
 * every gate at a flagship becomes a costless permanent blockade of every rival.
 *
 * That reads as **generous balance**, not as a broken feature — the same trap
 * `billHubUpkeep` records, and worse here, because the airline it is generous to
 * is the one denying a resource to everybody else. `gateFeesBilled`,
 * `gateLeasesWithdrawn` and `gateErrors` are the counters that tell the two
 * apart, and `gateFeesBilled` rising with `gateLeasesWithdrawn` at zero is the
 * healthy reading: leases billed, everybody using what they hold.
 *
 * ## Billing: annual figure, monthly instalment, idempotent by reference
 *
 * Exactly `billHubUpkeep`'s shape, and deliberately so rather than by accident —
 * the reference is `gate_lease:<airlineId>:<YYYY-MM>` in the world's own
 * calendar, AIR-06 refuses a second movement with the same cause and reference,
 * and `occurredAt` is the fixed instant the billed month closed so every retry
 * replays identical facts. A lease is billed only for a month it was held
 * **before that month began**, which is the same one grace month a hub gets and
 * for the same reason: billing the month it was signed would make the amount
 * depend on when the tick ran, and AIR-06's replay guard would throw rather than
 * no-op.
 *
 * The fee comes from the **row**, not from today's config. A lease was quoted an
 * exact annual figure and pinned it; re-pricing it on a retune would change a
 * bill the airline had already agreed. That is the same split `billHubUpkeep`
 * makes between a hub's own fee (today's config) and a facility's (pinned).
 *
 * ## The floor: no watermark, and none needed
 *
 * {@link withdrawIdleStands} is a pure function of current state — a lease past
 * its grace period whose stand is below the floor is withdrawn, and once it is
 * gone there is nothing to withdraw again. So it can run on every tick and needs
 * no "last reviewed" column, which matters more than it saves: ADR-0005 would
 * require such a column to be reset on a world reset, and forgetting would leave
 * a fresh world believing it had already reviewed.
 *
 * It costs two queries per world regardless of how many airlines are in it, for
 * the same reason `resolveLegSlots` is batched.
 */

import { and, eq, inArray, lt, sql } from 'drizzle-orm';

import type { StandKind } from '@tailfin/shared';
import {
  belowUtilisationFloor,
  GATE_UTILISATION_GRACE_GAME_DAYS,
  standOccupancies,
  standUtilisation,
  type StandOccupancy,
} from '@tailfin/sim';

import { moveAirlineCash } from '../airline/cash';
import { airline, airport, cashMovement, flight, gateHolding } from '../db/schema';

import { monthlyLeaseBill } from './gates';

import type { Database } from '../db/client';

const MINUTES_PER_DAY = 1_440;
const GAME_DAY_MS = 86_400_000;

export interface GateUpkeepResult {
  /** Airlines billed on this run. Zero on every tick but the first of a month. */
  airlinesBilled: number;
  totalMinor: number;
}

/** Bill every airline in this world for the stands it held through the month just ended. */
export async function billGateLeases(
  db: Database,
  worldId: string,
  gameNow: Date,
): Promise<GateUpkeepResult> {
  const period = previousMonth(gameNow);
  const periodStart = new Date(`${period}-01T00:00:00.000Z`);
  /* The instant the billed month closed. Fixed, so every retry replays identical facts. */
  const occurredAt = new Date(`${monthAfter(period)}-01T00:00:00.000Z`);

  const holdings = await db
    .select({
      airlineId: gateHolding.airlineId,
      annualFeeMinor: gateHolding.annualFeeMinor,
    })
    .from(gateHolding)
    .innerJoin(airline, eq(airline.id, gateHolding.airlineId))
    .where(
      and(
        eq(gateHolding.worldId, worldId),
        eq(airline.worldId, worldId),
        // Held before the month began — the grace month, see the note above.
        lt(gateHolding.leasedAt, periodStart),
      ),
    );
  if (holdings.length === 0) return { airlinesBilled: 0, totalMinor: 0 };

  const byAirline = new Map<string, { annualFeeMinor: number }[]>();
  for (const row of holdings) {
    const list = byAirline.get(row.airlineId) ?? [];
    list.push({ annualFeeMinor: row.annualFeeMinor });
    byAirline.set(row.airlineId, list);
  }

  const bills = new Map<string, number>();
  for (const [airlineId, stands] of byAirline) {
    const monthlyMinor = monthlyLeaseBill(stands);
    if (monthlyMinor > 0) bills.set(airlineId, monthlyMinor);
  }
  if (bills.size === 0) return { airlinesBilled: 0, totalMinor: 0 };

  /*
   * The month's references are read once and the airlines holding them skipped,
   * rather than relying on AIR-06 to refuse the replay. `crew/payroll.ts` learned
   * that on dev: the guard asserts a replay carries the *same facts*, and the
   * amount here moves the moment a stand is leased or given back.
   */
  const references = [...bills.keys()].map((airlineId) => referenceFor(airlineId, period));
  const alreadyBilled = await db
    .select({ reference: cashMovement.reference })
    .from(cashMovement)
    .where(and(eq(cashMovement.cause, 'gate_lease'), inArray(cashMovement.reference, references)));
  const settled = new Set(alreadyBilled.map((row) => row.reference));

  let airlinesBilled = 0;
  let totalMinor = 0;
  for (const [airlineId, monthlyMinor] of bills) {
    const reference = referenceFor(airlineId, period);
    if (settled.has(reference)) continue;
    // Inside a transaction: `moveAirlineCash` inserts the movement and then
    // updates the balance, and the reconciling trigger is deferred to commit.
    await db.transaction(async (tx) => {
      await moveAirlineCash(tx, {
        airlineId,
        amountMinor: -monthlyMinor,
        cause: 'gate_lease',
        reference,
        occurredAt,
        ledgerLines: [
          { amountMinor: -monthlyMinor, category: 'gate_lease', counterparty: 'airport authority' },
        ],
      });
    });
    airlinesBilled += 1;
    totalMinor += monthlyMinor;
  }

  return { airlinesBilled, totalMinor };
}

export interface GateFloorResult {
  /** Leases withdrawn for going unused. */
  withdrawn: number;
}

/**
 * Take back leases that are past their grace period and below the floor.
 *
 * App. B.6's *"use-it-or-lose-it utilisation floor"*, applied to the two stands
 * that are turnarounds. An overnight position, a cargo stand and a maintenance
 * stand are exempt by construction — see `belowUtilisationFloor`, which explains
 * why measuring them against a 06:00–23:00 operating day would withdraw every one
 * of them on the first sweep.
 *
 * The sample is the same forward game day the gates page shows, so a player who
 * reads "below floor" on screen is reading the number this acts on rather than a
 * different one computed elsewhere.
 */
export async function withdrawIdleStands(
  db: Database,
  worldId: string,
  gameNow: Date,
): Promise<GateFloorResult> {
  const graceEnded = new Date(gameNow.getTime() - GATE_UTILISATION_GRACE_GAME_DAYS * GAME_DAY_MS);

  const candidates = await db
    .select({
      id: gateHolding.id,
      airlineId: gateHolding.airlineId,
      airportIcao: gateHolding.airportIcao,
      position: gateHolding.position,
      kind: gateHolding.kind,
      utcOffsetMinutes: airport.utcOffsetMinutes,
    })
    .from(gateHolding)
    .innerJoin(airport, eq(airport.icaoCode, gateHolding.airportIcao))
    .where(
      and(
        eq(gateHolding.worldId, worldId),
        lt(gateHolding.leasedAt, graceEnded),
        inArray(gateHolding.kind, ['contact_gate', 'remote_stand'] as StandKind[]),
      ),
    );
  if (candidates.length === 0) return { withdrawn: 0 };

  const stations = [...new Set(candidates.map((row) => row.airportIcao))];
  const until = new Date(gameNow.getTime() + MINUTES_PER_DAY * 60_000);
  const flights = await db
    .select({
      airlineId: flight.airlineId,
      airframeId: flight.airframeId,
      originIcao: flight.originIcao,
      destinationIcao: flight.destinationIcao,
      departure: sql<Date>`coalesce(${flight.actualDeparture}, ${flight.scheduledDeparture})`,
      arrival: sql<Date>`coalesce(${flight.actualArrival}, ${flight.estimatedArrival})`,
    })
    .from(flight)
    .where(
      and(
        eq(flight.worldId, worldId),
        lt(flight.scheduledDeparture, until),
        sql`${flight.scheduledDeparture} >= ${new Date(gameNow.getTime() - MINUTES_PER_DAY * 60_000)}`,
      ),
    );

  const offsetOf = new Map(candidates.map((row) => [row.airportIcao, row.utcOffsetMinutes ?? 0]));

  /** Every turn stand one airline holds at one airport, and the day it worked. */
  const byPair = new Map<string, { kind: StandKind; ids: string[] }>();
  for (const row of candidates) {
    const key = `${row.airlineId}|${row.airportIcao}`;
    const entry = byPair.get(key) ?? { kind: row.kind, ids: [] };
    entry.ids.push(row.id);
    byPair.set(key, entry);
  }

  const doomed: string[] = [];
  for (const [key, entry] of byPair) {
    const [airlineId, icao] = key.split('|');
    if (airlineId === undefined || icao === undefined || !stations.includes(icao)) continue;

    const occupancies = occupanciesFor(flights, airlineId, icao, offsetOf.get(icao) ?? 0);
    const rows = standUtilisation(occupancies, entry.ids.length);
    /*
     * The greedy assignment concentrates work on the first stands, so the idle
     * ones are the last rows — and it is the last leases, by position, that go.
     * Ordering by position rather than by lease date is deliberate: it is the
     * same order the page shows, so the stand a player was warned about is the
     * stand that is taken.
     */
    const ordered = [...entry.ids].sort();
    ordered.forEach((id, index) => {
      const row = rows[index];
      if (row === undefined) return;
      if (belowUtilisationFloor(entry.kind, row.fraction)) doomed.push(id);
    });
  }
  if (doomed.length === 0) return { withdrawn: 0 };

  await db.delete(gateHolding).where(inArray(gateHolding.id, doomed));
  return { withdrawn: doomed.length };
}

interface FlightRow {
  airlineId: string;
  airframeId: string;
  originIcao: string;
  destinationIcao: string;
  departure: Date | string;
  arrival: Date | string;
}

/** One airline's on-stand intervals at one airport, in local minutes of the day. */
function occupanciesFor(
  flights: readonly FlightRow[],
  airlineId: string,
  icao: string,
  offsetMinutes: number,
): StandOccupancy[] {
  const localMinute = (at: Date | string): number => {
    const ms = at instanceof Date ? at.getTime() : Date.parse(String(at));
    const minutes = Math.floor(ms / 60_000) + offsetMinutes;
    return ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  };

  const arrivals = new Map<string, number[]>();
  const departures = new Map<string, number[]>();
  for (const row of flights) {
    if (row.airlineId !== airlineId) continue;
    if (row.destinationIcao === icao) {
      arrivals.set(row.airframeId, [
        ...(arrivals.get(row.airframeId) ?? []),
        localMinute(row.arrival),
      ]);
    }
    if (row.originIcao === icao) {
      departures.set(row.airframeId, [
        ...(departures.get(row.airframeId) ?? []),
        localMinute(row.departure),
      ]);
    }
  }

  const occupancies: StandOccupancy[] = [];
  for (const airframeId of new Set([...arrivals.keys(), ...departures.keys()])) {
    occupancies.push(
      ...standOccupancies(arrivals.get(airframeId) ?? [], departures.get(airframeId) ?? []),
    );
  }
  return occupancies;
}

/** `gate_lease:<airlineId>:<YYYY-MM>` — AIR-06's identity rule, not a new one. */
function referenceFor(airlineId: string, period: string): string {
  return `${airlineId}:${period}`;
}

/** `YYYY-MM` of the calendar month before `gameNow`, in the world's clock. */
function previousMonth(gameNow: Date): string {
  const previous = new Date(Date.UTC(gameNow.getUTCFullYear(), gameNow.getUTCMonth() - 1, 1));
  return `${String(previous.getUTCFullYear()).padStart(4, '0')}-${String(previous.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** `YYYY-MM` of the month after the given one. */
function monthAfter(period: string): string {
  const [year, month] = period.split('-').map(Number);
  const next = new Date(Date.UTC(year ?? 1970, month ?? 1, 1));
  return `${String(next.getUTCFullYear()).padStart(4, '0')}-${String(next.getUTCMonth() + 1).padStart(2, '0')}`;
}
