import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';

import {
  HUB_FACILITY_KINDS,
  hubTierForAirport,
  type AirportTier,
  type HubCandidate,
  type HubCandidateListResponse,
  type HubFacilityKind,
  type HubFacilityView,
  type HubSlotScarcity,
  type HubTier,
  type HubsResponse,
  type HubView,
  type NextHubPricing,
  type OpenHubFacilityRequest,
  type PurchaseHubRequest,
  type SlotLevel,
} from '@tailfin/shared';
import {
  gameTime,
  hubAnnualFee,
  hubFacilityCost,
  hubPurchaseCost,
  type WorldClock,
} from '@tailfin/sim';

import { moveAirlineCash } from '../airline/cash';
import { airline, airlineHub, airport, hubFacility, slotHolding, world } from '../db/schema';
import { loadWorldEconomyConfig } from '../economy/loader';
import { isCoordinated, slotCapacityPerHour } from '../network/slots';

import type { ResolvedPlayerAirline } from '../airline/context';
import type { Database } from '../db/client';
import type { PinnedEconomyConfig } from '../economy/config';

/**
 * Hubs — purchase, the App. B.5 curve, and facilities (M7-04).
 *
 * A hub is where an airline bases aircraft, holds gates and stations crew. The
 * *curve* is `@tailfin/sim`'s and its coefficients are the world's pinned economy
 * config; this owns the rows an airline buys against them, and the three rules
 * that make a hub a decision rather than a purchase:
 *
 *   1. **The multiplier counts hubs owned, not hubs of that tier.** Every cheap
 *      hub bought early makes every later flagship dearer, across the whole
 *      airline. That is the tension App. B.5 exists to create.
 *   2. **The price is quoted, then echoed, then charged.** The client sends back
 *      the figure it showed; a mismatch is refused rather than silently charged.
 *   3. **The tier is pinned at purchase.** A reference-data refresh may reclassify
 *      the airport; it must not re-price a hub somebody already owns.
 *
 * Owner-scoped throughout — the airline is resolved from the session, never
 * accepted from the client (ADR-0020).
 *
 * ## What this does not do
 *
 * Nothing here bills. The recurring fee is a worker sweep, in `upkeep.ts`, for the
 * same reason every other recurring charge is: it is a per-world game-time event,
 * and the web node has no clock. **Production has no worker**, so a production
 * hub would be bought once and then held free for ever — see the note there.
 */

/** Fastify turns each of these into its own status; the route table owns the mapping. */
export type HubProblem =
  | 'unknown_airport'
  | 'airport_not_playable'
  | 'already_a_hub'
  | 'cost_changed'
  | 'insufficient_funds'
  | 'unknown_hub'
  | 'facility_already_open'
  | 'requires_maintenance_line';

export type HubOutcome = { ok: true; hubs: HubsResponse } | { ok: false; problem: HubProblem };

interface WorldContext {
  clock: WorldClock;
  economy: PinnedEconomyConfig;
}

async function loadWorldContext(db: Database, worldId: string): Promise<WorldContext | null> {
  const [row] = await db
    .select({
      epoch: world.epoch,
      launchDate: world.launchDate,
      speedMultiplier: world.speedMultiplier,
    })
    .from(world)
    .where(eq(world.id, worldId))
    .limit(1);
  if (!row) return null;
  return {
    clock: {
      epoch: row.epoch,
      launchDate: row.launchDate,
      speedMultiplier: Number(row.speedMultiplier),
    },
    economy: await loadWorldEconomyConfig(db, worldId),
  };
}

/**
 * The tier a hub is priced in, and the fallback for a row that predates M7-04.
 *
 * A null `airline_hub.tier` means the hub was granted before the column existed —
 * every founder hub in every existing world. Those are read at the airport's
 * *current* tier, which is the only answer available and was true when the grant
 * was made. A null airport tier (an aerodrome with no scheduled service) reads as
 * `small`: nothing can be founded or bought there, so this only ever covers data
 * that changed underneath a hub somebody already holds, and the cheapest band is
 * the right way to be wrong about a bill.
 */
function effectiveTier(pinned: HubTier | null, airportTier: AirportTier | null): HubTier {
  if (pinned !== null) return pinned;
  return airportTier === null ? 'small' : hubTierForAirport(airportTier);
}

/** What the next hub costs at each of the four tiers, on today's curve. */
function priceNextHub(hubsOwned: number, economy: PinnedEconomyConfig): NextHubPricing {
  const hubs = economy.hubs;
  return {
    hubsOwned,
    small: hubPurchaseCost('small', hubsOwned, hubs),
    medium: hubPurchaseCost('medium', hubsOwned, hubs),
    large: hubPurchaseCost('large', hubsOwned, hubs),
    flagship: hubPurchaseCost('flagship', hubsOwned, hubs),
  };
}

interface HubRow {
  id: string;
  airportIdent: string;
  airportIcao: string | null;
  airportIata: string | null;
  airportName: string;
  airportTier: AirportTier | null;
  pinnedTier: HubTier | null;
  founderGrant: boolean;
  purchaseCostMinor: number | null;
  openedAt: Date | null;
  createdAt: Date;
}

async function hubRowsOf(db: Database, airlineId: string): Promise<HubRow[]> {
  return db
    .select({
      id: airlineHub.id,
      airportIdent: airport.ident,
      airportIcao: airport.icaoCode,
      airportIata: airport.iataCode,
      airportName: airport.name,
      airportTier: airport.tier,
      pinnedTier: airlineHub.tier,
      founderGrant: airlineHub.founderGrant,
      purchaseCostMinor: airlineHub.purchaseCostMinor,
      openedAt: airlineHub.openedAt,
      createdAt: airlineHub.createdAt,
    })
    .from(airlineHub)
    .innerJoin(airport, eq(airport.id, airlineHub.airportId))
    .where(eq(airlineHub.airlineId, airlineId))
    .orderBy(asc(airlineHub.createdAt));
}

/** One facility a hub already holds, at the fee it was sold at. */
interface OpenFacility {
  openedAt: Date;
  annualFeeMinor: number;
}

/** What a hub already holds, keyed by kind. */
type OpenFacilities = Map<HubFacilityKind, OpenFacility>;

/**
 * Every facility view for one hub: the open ones, and what the rest would cost.
 *
 * All five kinds are always returned. A client showing only what is open cannot
 * show what a hub could become, and App. B.5's facilities are a build-out plan
 * rather than a list of purchases already made.
 */
function facilityViews(
  tier: HubTier,
  open: OpenFacilities,
  economy: PinnedEconomyConfig,
): HubFacilityView[] {
  const hasMaintenanceLine = open.has('maintenance_line');
  return HUB_FACILITY_KINDS.map((kind): HubFacilityView => {
    const existing = open.get(kind);
    const quoted = hubFacilityCost(kind, tier, economy.hubs);
    return {
      kind,
      openedAt: existing ? existing.openedAt.toISOString() : null,
      openingCostMinor: quoted.openingMinor,
      // An open facility reports the fee it was sold at, not today's quote: the
      // config may have been retuned since, and the hub is billed the pinned one.
      annualFeeMinor: existing ? existing.annualFeeMinor : quoted.annualFeeMinor,
      blockedBy: existing
        ? 'already_open'
        : kind === 'heavy_check' && !hasMaintenanceLine
          ? 'requires_maintenance_line'
          : null,
    };
  });
}

/** The whole hub list for one airline, priced and with the next-hub curve. */
export async function listHubs(db: Database, own: ResolvedPlayerAirline): Promise<HubsResponse> {
  const economy = await loadWorldEconomyConfig(db, own.worldId);
  const rows = await hubRowsOf(db, own.id);

  const facilityRows =
    rows.length === 0
      ? []
      : await db
          .select({
            hubId: hubFacility.hubId,
            kind: hubFacility.kind,
            annualFeeMinor: hubFacility.annualFeeMinor,
            openedAt: hubFacility.openedAt,
          })
          .from(hubFacility)
          .where(
            inArray(
              hubFacility.hubId,
              rows.map((r) => r.id),
            ),
          );

  const byHub = new Map<string, OpenFacilities>();
  for (const row of facilityRows) {
    let hub = byHub.get(row.hubId);
    if (!hub) {
      hub = new Map();
      byHub.set(row.hubId, hub);
    }
    hub.set(row.kind, { openedAt: row.openedAt, annualFeeMinor: row.annualFeeMinor });
  }

  const hubs: HubView[] = rows.map((row) => {
    const tier = effectiveTier(row.pinnedTier, row.airportTier);
    const open = byHub.get(row.id) ?? new Map<HubFacilityKind, OpenFacility>();
    const facilities = facilityViews(tier, open, economy);
    const ownFee = hubAnnualFee(tier, economy.hubs);
    let totalAnnualFeeMinor = ownFee;
    for (const facility of open.values()) totalAnnualFeeMinor += facility.annualFeeMinor;
    return {
      id: row.id,
      airportIdent: row.airportIdent,
      airportIcao: row.airportIcao,
      airportIata: row.airportIata,
      airportName: row.airportName,
      tier,
      founderGrant: row.founderGrant,
      purchaseCostMinor: row.purchaseCostMinor ?? 0,
      openedAt: (row.openedAt ?? row.createdAt).toISOString(),
      annualFeeMinor: ownFee,
      totalAnnualFeeMinor,
      facilities,
    };
  });

  return {
    hubs,
    totalAnnualFeeMinor: hubs.reduce((sum, hub) => sum + hub.totalAnnualFeeMinor, 0),
    nextHub: priceNextHub(rows.length, economy),
  };
}

/**
 * How contested an airport's bands are, as measured facts (M7-05).
 *
 * `bandsFull` counts the hourly bands where no further airline could hold a slot.
 * At an uncoordinated airport nothing is ever full, because nothing is ever
 * required — which is why `capacityPerBand` is reported as zero there rather than
 * as the notional cap: an airline reading "capacity 4, 0 full" at a Level 1
 * airport would think it was looking at scarcity that does not exist.
 */
async function slotScarcity(
  db: Database,
  worldId: string,
  icao: string | null,
  slotLevel: SlotLevel | null,
  tier: AirportTier | null,
): Promise<HubSlotScarcity> {
  const coordinated = isCoordinated(slotLevel);
  if (!coordinated || icao === null) {
    return { slotLevel, coordinated: false, capacityPerBand: 0, bandsFull: 0 };
  }
  const capacityPerBand = slotCapacityPerHour(tier);
  const held = await db
    .select({ band: slotHolding.band, holders: sql<number>`count(*)::int` })
    .from(slotHolding)
    .where(and(eq(slotHolding.worldId, worldId), eq(slotHolding.airportIcao, icao)))
    .groupBy(slotHolding.band);
  const bandsFull = held.filter((row) => row.holders >= capacityPerBand).length;
  return { slotLevel, coordinated: true, capacityPerBand, bandsFull };
}

const CANDIDATE_LIMIT = 20;

/**
 * Airports the airline could take as its next hub, each fully priced.
 *
 * The third acceptance criterion of M7-04 lives here: *"a free flagship hub is
 * permitted but its fees and slot scarcity are shown before confirming"*. Every
 * candidate therefore carries its purchase price on today's curve, the annual fee
 * it would then charge for ever, and real M7-05 slot numbers — so a flagship is
 * refused by an informed player rather than by the server.
 *
 * Only tiered airports appear. `airport.tier` is null for anything without
 * scheduled service, and an aerodrome with no demand pool is not a hub.
 */
export async function searchHubCandidates(
  db: Database,
  own: ResolvedPlayerAirline,
  input: string | undefined,
): Promise<HubCandidateListResponse> {
  const query = (input ?? '').trim().slice(0, 80);
  const economy = await loadWorldEconomyConfig(db, own.worldId);
  const owned = await hubRowsOf(db, own.id);
  const hubsOwned = owned.length;
  const ownedIdents = new Set(owned.map((row) => row.airportIdent));

  const upper = query.toUpperCase();
  const like = `%${query.toLowerCase()}%`;
  const rows = await db
    .select({
      ident: airport.ident,
      icao: airport.icaoCode,
      iata: airport.iataCode,
      name: airport.name,
      city: airport.municipality,
      country: airport.isoCountry,
      tier: airport.tier,
      slotLevel: airport.slotLevel,
    })
    .from(airport)
    .where(
      and(
        eq(airport.scheduledService, true),
        sql`${airport.tier} is not null`,
        query === ''
          ? sql`true`
          : or(
              eq(airport.ident, upper),
              eq(airport.icaoCode, upper),
              eq(airport.iataCode, upper),
              sql`lower(${airport.name}) like ${like}`,
              sql`lower(${airport.municipality}) like ${like}`,
            ),
      ),
    )
    // Exact identifier matches first, then alphabetically — the same ordering the
    // founder-hub picker uses, so the two searches behave identically.
    .orderBy(
      sql`case when ${airport.ident} = ${upper} or ${airport.icaoCode} = ${upper} or ${airport.iataCode} = ${upper} then 0 else 1 end`,
      asc(airport.name),
    )
    .limit(CANDIDATE_LIMIT);

  const airports: HubCandidate[] = [];
  for (const row of rows) {
    // `tier is not null` is in the where clause; this narrows the type.
    if (row.tier === null) continue;
    const tier = hubTierForAirport(row.tier);
    const alreadyHeld = ownedIdents.has(row.ident);
    const slotLevel = row.slotLevel as SlotLevel | null;
    airports.push({
      ident: row.ident,
      icao: row.icao,
      iata: row.iata,
      name: row.name,
      city: row.city,
      country: row.country,
      airportTier: row.tier,
      tier,
      purchaseCostMinor: hubPurchaseCost(tier, hubsOwned, economy.hubs),
      annualFeeMinor: hubAnnualFee(tier, economy.hubs),
      slots: await slotScarcity(db, own.worldId, row.icao, slotLevel, row.tier),
      alreadyHeld,
    });
  }

  return { airports, query, nextHub: priceNextHub(hubsOwned, economy) };
}

/**
 * Buy a hub, and move the money for it, in one transaction (App. B.5).
 *
 * The whole operation is serialised on the airline, because the price depends on
 * how many hubs it owns: two concurrent purchases that both read "2 owned" would
 * both charge the third-hub price and leave the airline with four hubs having
 * paid for three. `moveAirlineCash` locks the airline row, but it locks it *after*
 * the price has been computed, so the lock is taken here first and the count is
 * read inside it.
 *
 * Insufficient funds is a refusal, not an overdraft. Every player-initiated spend
 * in the game refuses; only payroll, which cannot, is allowed to go negative.
 */
export async function purchaseHub(
  db: Database,
  own: ResolvedPlayerAirline,
  request: PurchaseHubRequest,
  now: Date = new Date(),
): Promise<HubOutcome> {
  const context = await loadWorldContext(db, own.worldId);
  if (context === null) return { ok: false, problem: 'unknown_airport' };

  const [target] = await db
    .select({ id: airport.id, tier: airport.tier })
    .from(airport)
    .where(eq(airport.ident, request.airportIdent))
    .limit(1);
  if (!target) return { ok: false, problem: 'unknown_airport' };
  if (target.tier === null) return { ok: false, problem: 'airport_not_playable' };

  const tier = hubTierForAirport(target.tier);
  const gameNow = gameTime(context.clock, now);

  const problem = await db.transaction(async (tx): Promise<HubProblem | null> => {
    // Serialise this airline's hub purchases against each other. Taken before the
    // count is read, so the curve position cannot move underneath the price.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`hub:${own.id}`}))`);

    const [existing] = await tx
      .select({ id: airlineHub.id })
      .from(airlineHub)
      .where(and(eq(airlineHub.airlineId, own.id), eq(airlineHub.airportId, target.id)))
      .limit(1);
    if (existing) return 'already_a_hub';

    const [{ count: hubsOwned } = { count: 0 }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(airlineHub)
      .where(eq(airlineHub.airlineId, own.id));

    const costMinor = hubPurchaseCost(tier, hubsOwned, context.economy.hubs);
    // The quoted-price echo. A stale quote is refused rather than charged, so
    // "the player can see the arithmetic before committing" survives the case
    // where the arithmetic moved while they were reading it.
    if (costMinor !== request.expectedCostMinor) return 'cost_changed';

    if (costMinor > 0) {
      const [balance] = await tx
        .select({ cashMinor: airline.cashMinor })
        .from(airline)
        .where(eq(airline.id, own.id))
        .limit(1);
      if (!balance || balance.cashMinor < costMinor) return 'insufficient_funds';
    }

    const [created] = await tx
      .insert(airlineHub)
      .values({
        airlineId: own.id,
        airportId: target.id,
        founderGrant: false,
        tier,
        purchaseCostMinor: costMinor,
        openedAt: gameNow,
      })
      .returning({ id: airlineHub.id });
    if (!created) throw new Error('Hub insert returned no row');

    // A free hub still gets a row and still gets no movement: AIR-06 records
    // causes, and "nothing moved" is not one. The zero is explained by
    // `purchase_cost_minor` on the hub itself.
    if (costMinor > 0) {
      await moveAirlineCash(tx, {
        airlineId: own.id,
        amountMinor: -costMinor,
        cause: 'hub_purchase',
        reference: created.id,
        occurredAt: gameNow,
        ledgerLines: [
          {
            amountMinor: -costMinor,
            category: 'hub_purchase',
            counterparty: request.airportIdent,
            hubId: created.id,
          },
        ],
      });
    }
    return null;
  });

  if (problem !== null) return { ok: false, problem };
  return { ok: true, hubs: await listHubs(db, own) };
}

/**
 * Open one facility at one of this airline's hubs.
 *
 * Owner-scoped by resolution rather than by a check afterwards (ADR-0020): the
 * hub is selected by `(id, airlineId)`, so another player's hub id and a
 * nonexistent one run the identical query and produce the identical refusal.
 */
export async function openHubFacility(
  db: Database,
  own: ResolvedPlayerAirline,
  hubId: string,
  request: OpenHubFacilityRequest,
  now: Date = new Date(),
): Promise<HubOutcome> {
  const context = await loadWorldContext(db, own.worldId);
  if (context === null) return { ok: false, problem: 'unknown_hub' };

  const [hub] = await db
    .select({
      id: airlineHub.id,
      pinnedTier: airlineHub.tier,
      airportTier: airport.tier,
      airportIdent: airport.ident,
    })
    .from(airlineHub)
    .innerJoin(airport, eq(airport.id, airlineHub.airportId))
    .where(and(eq(airlineHub.id, hubId), eq(airlineHub.airlineId, own.id)))
    .limit(1);
  if (!hub) return { ok: false, problem: 'unknown_hub' };

  const tier = effectiveTier(hub.pinnedTier, hub.airportTier);
  const quoted = hubFacilityCost(request.kind, tier, context.economy.hubs);
  const gameNow = gameTime(context.clock, now);

  const problem = await db.transaction(async (tx): Promise<HubProblem | null> => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`hub-facility:${hub.id}`}))`);

    const openKinds = await tx
      .select({ kind: hubFacility.kind })
      .from(hubFacility)
      .where(eq(hubFacility.hubId, hub.id));
    const open = new Set(openKinds.map((row) => row.kind));

    if (open.has(request.kind)) return 'facility_already_open';
    // App. B.5's own ordering: "maintenance line, then heavy check capability".
    if (request.kind === 'heavy_check' && !open.has('maintenance_line')) {
      return 'requires_maintenance_line';
    }
    if (quoted.openingMinor !== request.expectedCostMinor) return 'cost_changed';

    const [balance] = await tx
      .select({ cashMinor: airline.cashMinor })
      .from(airline)
      .where(eq(airline.id, own.id))
      .limit(1);
    if (!balance || balance.cashMinor < quoted.openingMinor) return 'insufficient_funds';

    const [created] = await tx
      .insert(hubFacility)
      .values({
        hubId: hub.id,
        kind: request.kind,
        openingCostMinor: quoted.openingMinor,
        annualFeeMinor: quoted.annualFeeMinor,
        openedAt: gameNow,
      })
      .returning({ id: hubFacility.id });
    if (!created) throw new Error('Hub facility insert returned no row');

    await moveAirlineCash(tx, {
      airlineId: own.id,
      amountMinor: -quoted.openingMinor,
      cause: 'hub_facility_opening',
      reference: created.id,
      occurredAt: gameNow,
      ledgerLines: [
        {
          amountMinor: -quoted.openingMinor,
          category: 'hub_purchase',
          counterparty: `${hub.airportIdent} ${request.kind}`,
          hubId: hub.id,
        },
      ],
    });
    return null;
  });

  if (problem !== null) return { ok: false, problem };
  return { ok: true, hubs: await listHubs(db, own) };
}
