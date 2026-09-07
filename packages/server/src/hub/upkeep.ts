import { and, eq, inArray, lt } from 'drizzle-orm';

import type { AirportTier, HubFacilityKind, HubTier } from '@tailfin/shared';
import { hubTierForAirport } from '@tailfin/shared';
import { hubAnnualFee, roundMinor } from '@tailfin/sim';

import { moveAirlineCash } from '../airline/cash';
import { airline, airlineHub, airport, cashMovement, hubFacility } from '../db/schema';
import { loadWorldEconomyConfig } from '../economy/loader';

import type { Database } from '../db/client';

/**
 * What a hub costs to hold (M7-04, App. B.5).
 *
 * App. B.5's answer to *"why is a free flagship hub not simply the best move?"* is
 * this function: *"annual facility fees scale with tier — a flagship hub bleeds
 * you monthly from day one"*. Acquisition is waived for the first hub; upkeep
 * never is. Without something charging it, taking Dubai on opening day is free and
 * the entire self-balancing argument in App. B.5 is decoration.
 *
 * ## This is a worker story, and the failure mode is silence
 *
 * Runs on the **worker**, against the world's game clock, like every crew,
 * maintenance and ground sweep. **Production has no worker** (OPS-12), so on a
 * production world a hub would be bought once and then held for nothing for ever:
 * no monthly fee, no pressure to close a hub that stopped earning, and the free
 * flagship becoming exactly the dominant strategy App. B.5 designed against. That
 * reads as generous balance rather than as a missing process, which is the same
 * trap as "ticks: 0, errors: 0". `hubFeesBilled` and `hubErrors` are the counters
 * that tell the two apart.
 *
 * ## Annual figure, monthly bill
 *
 * The config states the fee a year because App. B.5 does; this charges a twelfth
 * of it a month because App. B.5 also says "bleeds you monthly". Rounding happens
 * on the monthly figure, so an airline pays twelve identical instalments that may
 * differ from the annual total by a few minor units — the predictable month is
 * worth more than an annual sum nothing actually charges.
 *
 * ## Idempotent by reference, with no bookkeeping column
 *
 * The reference is `hub_upkeep:<airlineId>:<YYYY-MM>` in the world's own calendar,
 * and AIR-06 already refuses a second movement with the same cause and reference.
 * So this can be attempted on every tick and bills once, and no "last billed"
 * column is needed — which matters more than it saves, because ADR-0005 would
 * require such a column to be reset on a world reset and forgetting would leave a
 * fresh world believing it had already paid.
 *
 * The month just ended is retried for as long as the following month lasts, so a
 * worker down over a month boundary bills when it returns rather than skipping.
 *
 * ## Why the already-billed references are read first
 *
 * Because AIR-06's replay guard asserts the movement is replayed with the **same
 * facts** — `occurred_at` and `amount_minor` included. Both move here: the instant
 * would differ every tick if it were `gameNow`, and the amount changes the moment
 * a hub or facility is bought. `crew/payroll.ts` learned this on dev, where it
 * failed once a second from the moment it deployed. So: the month's references are
 * looked up once, the airlines holding them are skipped, and `occurredAt` is the
 * instant the billed month closed.
 *
 * A hub is billed only for a month it was open **before the month began**, which
 * is the same stability requirement seen from the other side. Billing a hub for
 * the month it opened would make the amount depend on when in the following month
 * the tick happened to run, and the second attempt would throw rather than no-op.
 * The effect is one grace month on a new hub, which is stated in `docs/hubs.md`
 * rather than hidden.
 *
 * ## Insolvency is not modelled, and upkeep can cause it
 *
 * Like payroll, this cannot refuse — the hub was held — so **an airline that
 * cannot pay its hub fees goes negative**, and nothing yet acts on a negative
 * balance. §11's bankruptcy is not built, and inventing one here would be a far
 * larger decision than this function. What must not happen is the fee silently
 * skipping, which would make "hold hubs you cannot afford" free.
 */

export interface HubUpkeepResult {
  /** Airlines billed on this run. Zero on every tick but the first of a month. */
  airlinesBilled: number;
  totalMinor: number;
}

const MONTHS_PER_YEAR = 12;

/** Bill every airline in this world for the hubs it held through the month just ended. */
export async function billHubUpkeep(
  db: Database,
  worldId: string,
  gameNow: Date,
): Promise<HubUpkeepResult> {
  const period = previousMonth(gameNow);
  const periodStart = new Date(`${period}-01T00:00:00.000Z`);
  /*
   * Midnight on the first of the following month: the instant the billed month
   * closed. Fixed for the period, so every retry replays identical facts.
   */
  const occurredAt = new Date(`${monthAfter(period)}-01T00:00:00.000Z`);
  const economy = await loadWorldEconomyConfig(db, worldId);

  const hubs = await db
    .select({
      hubId: airlineHub.id,
      airlineId: airlineHub.airlineId,
      pinnedTier: airlineHub.tier,
      airportTier: airport.tier,
      openedAt: airlineHub.openedAt,
      createdAt: airlineHub.createdAt,
    })
    .from(airlineHub)
    .innerJoin(airline, eq(airline.id, airlineHub.airlineId))
    .innerJoin(airport, eq(airport.id, airlineHub.airportId))
    .where(eq(airline.worldId, worldId));

  // Held before the month began — see the grace-month note above.
  const billable = hubs.filter((hub) => (hub.openedAt ?? hub.createdAt) < periodStart);
  if (billable.length === 0) return { airlinesBilled: 0, totalMinor: 0 };

  const facilities = await db
    .select({
      hubId: hubFacility.hubId,
      annualFeeMinor: hubFacility.annualFeeMinor,
      kind: hubFacility.kind,
      openedAt: hubFacility.openedAt,
    })
    .from(hubFacility)
    .where(
      and(
        inArray(
          hubFacility.hubId,
          billable.map((hub) => hub.hubId),
        ),
        lt(hubFacility.openedAt, periodStart),
      ),
    );

  const facilitiesByHub = new Map<string, { annualFeeMinor: number; kind: HubFacilityKind }[]>();
  for (const row of facilities) {
    const list = facilitiesByHub.get(row.hubId) ?? [];
    list.push({ annualFeeMinor: row.annualFeeMinor, kind: row.kind });
    facilitiesByHub.set(row.hubId, list);
  }

  const bills = new Map<string, number>();
  for (const hub of billable) {
    const tier = effectiveTier(hub.pinnedTier, hub.airportTier);
    /*
     * The hub's own fee comes from today's config; a facility's comes from the row
     * it was sold at. Deliberately different: a retune is meant to move what hubs
     * cost to hold — that is what retuning `annualFeeMinor` is for — while a
     * facility was quoted an exact fee at purchase and pinned it, so re-pricing it
     * afterwards would change a bill the airline had already agreed.
     */
    let annualMinor = hubAnnualFee(tier, economy.hubs);
    for (const facility of facilitiesByHub.get(hub.hubId) ?? []) {
      annualMinor += facility.annualFeeMinor;
    }
    const monthlyMinor = roundMinor(annualMinor / MONTHS_PER_YEAR);
    if (monthlyMinor === 0) continue;
    bills.set(hub.airlineId, (bills.get(hub.airlineId) ?? 0) + monthlyMinor);
  }
  if (bills.size === 0) return { airlinesBilled: 0, totalMinor: 0 };

  const references = [...bills.keys()].map((airlineId) => referenceFor(airlineId, period));
  const alreadyBilled = await db
    .select({ reference: cashMovement.reference })
    .from(cashMovement)
    .where(and(eq(cashMovement.cause, 'hub_upkeep'), inArray(cashMovement.reference, references)));
  const settled = new Set(alreadyBilled.map((row) => row.reference));

  let airlinesBilled = 0;
  let totalMinor = 0;
  for (const [airlineId, monthlyMinor] of bills) {
    const reference = referenceFor(airlineId, period);
    if (settled.has(reference)) continue;
    await db.transaction(async (tx) => {
      await moveAirlineCash(tx, {
        airlineId,
        amountMinor: -monthlyMinor,
        cause: 'hub_upkeep',
        reference,
        occurredAt,
        ledgerLines: [
          {
            amountMinor: -monthlyMinor,
            category: 'hub_facility',
            counterparty: 'airport authority',
          },
        ],
      });
    });
    airlinesBilled += 1;
    totalMinor += monthlyMinor;
  }

  return { airlinesBilled, totalMinor };
}

/** `hub_upkeep:<airlineId>:<YYYY-MM>` — AIR-06's identity rule, not a new one. */
function referenceFor(airlineId: string, period: string): string {
  return `${airlineId}:${period}`;
}

/** The same fallback `hubs.ts` documents: a null tier means a hub granted before M7-04. */
function effectiveTier(pinned: HubTier | null, airportTier: AirportTier | null): HubTier {
  if (pinned !== null) return pinned;
  return airportTier === null ? 'small' : hubTierForAirport(airportTier);
}

/** `YYYY-MM` of the calendar month before `gameNow`, in the world's clock. */
function previousMonth(gameNow: Date): string {
  const year = gameNow.getUTCFullYear();
  const month = gameNow.getUTCMonth();
  const previous = new Date(Date.UTC(year, month - 1, 1));
  return `${String(previous.getUTCFullYear()).padStart(4, '0')}-${String(previous.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** `YYYY-MM` of the month after the given one. */
function monthAfter(period: string): string {
  const [year, month] = period.split('-').map(Number);
  const next = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1 + 1, 1));
  return `${String(next.getUTCFullYear()).padStart(4, '0')}-${String(next.getUTCMonth() + 1).padStart(2, '0')}`;
}
