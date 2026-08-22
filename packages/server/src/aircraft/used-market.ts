import { and, asc, eq, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';

import {
  type UsedMarketListing as UsedMarketListingDto,
  type UsedMarketResponse,
  type UsedMarketValuation,
} from '@tailfin/shared';
import {
  draftUsedListing,
  gameTime,
  generationIndex,
  type UsedListingDraft,
  type UsedMarketCandidate,
  type WorldClock,
} from '@tailfin/sim';

import { type Database } from '../db/client';
import { airport, usedAircraftListing, world } from '../db/schema';
import { loadEconomyConfig } from '../economy/loader';

import { loadCatalogueVersion } from './catalogue';

/**
 * The used aircraft market (M4-05, App. C.5).
 *
 * `packages/sim` decides *what* an airframe is worth and *which* one stands in a
 * berth; this file is the part that talks to the database. The split is the usual
 * one, and it matters more than usual here: the valuation is the interesting
 * logic and it is tested without Postgres, so a failing price is reproducible
 * from a unit test rather than from a world.
 *
 * ## The market is berths, not a list
 *
 * `slots` berths, each holding at most one available listing. That shape is what
 * makes M4-05's acceptance criterion — *"inventory does not become infinite or
 * exhausted"* — a property rather than a hope:
 *
 *   - **not infinite**, because a berth holds one aircraft and there are
 *     `slots` of them;
 *   - **not exhausted**, because generations keep arriving and an empty berth is
 *     refilled at the next one.
 *
 * ## Idempotency is the database's job, not the caller's
 *
 * The engine ticks every second. A game generation lasts a week. So the refresh
 * is called tens of thousands of times per generation, and it has to do nothing
 * almost every time.
 *
 * It is not made safe by a remembered timestamp or by a lock. Every insert
 * carries `(world_id, slot_index, generation_index)`, which is unique, and lands
 * with `ON CONFLICT DO NOTHING`. Two workers racing on the same berth produce one
 * row and neither of them has to know about the other — the same disposition
 * `airframe.source_order_id` already uses for deliveries.
 *
 * A consequence worth stating, because it is a design choice and not an
 * oversight: **a berth whose aircraft was sold stays empty until the next
 * generation.** The insert conflicts with the sold row and does nothing. Buying
 * an aeroplane does not immediately conjure its replacement, which is both more
 * plausible and a real constraint on a player waiting for the market to turn
 * over.
 */

export interface UsedMarketRefreshResult {
  worldId: string;
  /** Berths filled on this call. Zero on almost every tick. */
  created: number;
  /** Listings withdrawn because they had been on the market too long. */
  withdrawn: number;
  /** The generation the world's clock is in, or `-1` before launch. */
  generation: number;
  /** False when the world has not launched, or has no catalogue to draw from. */
  refreshed: boolean;
}

function clockOf(row: { epoch: Date; launchDate: Date; speedMultiplier: string }): WorldClock {
  return {
    epoch: row.epoch,
    launchDate: row.launchDate,
    speedMultiplier: Number(row.speedMultiplier),
  };
}

/**
 * Where a generated aircraft is standing.
 *
 * Tiered rather than any of ~86,000 aerodromes, because a twelve-year-old A350
 * parked at an unpaved regional strip is not a market, it is a bug that reads
 * like one. Ordered by ICAO so the shortlist is stable: the draw picks an index,
 * and an index into an unordered result would give a different airport on every
 * call for the same seed — which would quietly destroy the determinism the whole
 * generator is built on.
 */
const MARKET_LOCATION_TIERS = ['flagship', 'large', 'medium'] as const;
const MARKET_LOCATION_LIMIT = 400;

async function marketLocations(db: Database): Promise<string[]> {
  const rows = await db
    .select({ icao: airport.icaoCode })
    .from(airport)
    .where(
      and(
        isNotNull(airport.icaoCode),
        eq(airport.scheduledService, true),
        inArray(airport.tier, [...MARKET_LOCATION_TIERS]),
      ),
    )
    .orderBy(asc(airport.icaoCode))
    .limit(MARKET_LOCATION_LIMIT);

  return rows.flatMap((row) => (row.icao === null ? [] : [row.icao]));
}

/**
 * A registration for a generated airframe.
 *
 * Deterministic in the berth and generation, so a replay produces the same tail
 * number, and prefixed to read as provisional. **HIST-02 (#509) owns registration
 * lifecycle and history**; this is the same placeholder shape M4-04 already uses
 * for a new delivery, not a competing scheme, and it is deliberately not derived
 * from a country or an operator because inventing that would be inventing part of
 * HIST-02's answer.
 */
function provisionalRegistration(worldId: string, slot: number, generation: number): string {
  const stem = `${worldId.replaceAll('-', '')}${slot}x${generation}`;
  let hash = 2_166_136_261;
  for (let i = 0; i < stem.length; i += 1) {
    hash = Math.imul(hash ^ stem.charCodeAt(i), 16_777_619) >>> 0;
  }
  return `TU-${hash.toString(36).toUpperCase().padStart(6, '0').slice(0, 6)}`;
}

function valuationDto(draft: UsedListingDraft): UsedMarketValuation {
  const { valuation } = draft;
  return {
    anchorMinor: valuation.anchorMinor,
    anchorSource: valuation.anchorSource,
    ageYears: valuation.ageYears,
    ageFactor: valuation.ageFactor,
    hours: valuation.hours,
    expectedHours: valuation.expectedHours,
    utilisationFactor: valuation.utilisationFactor,
    configurationFactor: valuation.configuration.factor,
    unusualness: valuation.configuration.unusualness,
    configurationDrags: valuation.configuration.drags.map((drag) => ({
      optionId: drag.optionId,
      category: drag.category,
      retrofittable: drag.retrofittable,
      drag: drag.drag,
    })),
  };
}

/**
 * Withdraw, then refill. One world, one call, safe on every tick.
 *
 * Returns without touching anything when the world has not launched or the
 * generation's berths are already filled, which is the overwhelmingly common
 * case — the same disposition `reviewNpcCarriers` takes, and for the same reason.
 */
export async function refreshUsedAircraftMarket(
  db: Database,
  worldId: string,
  now: Date = new Date(),
): Promise<UsedMarketRefreshResult> {
  const empty: UsedMarketRefreshResult = {
    worldId,
    created: 0,
    withdrawn: 0,
    generation: -1,
    refreshed: false,
  };

  const worlds = await db
    .select({
      epoch: world.epoch,
      launchDate: world.launchDate,
      speedMultiplier: world.speedMultiplier,
      catalogueVersion: world.aircraftCatalogueVersion,
      economyConfigVersion: world.economyConfigVersion,
      seed: world.seed,
    })
    .from(world)
    .where(eq(world.id, worldId))
    .limit(1);

  const row = worlds[0];
  if (!row) return empty;

  const gameNow = gameTime(clockOf(row), now);
  const economy = await loadEconomyConfig(db, row.economyConfigVersion);
  const balance = economy.usedMarket;
  const generation = generationIndex(row.epoch, gameNow, balance);
  if (generation < 0) return { ...empty, generation };

  // Withdrawal first, so a berth freed by an expiry can be refilled in the same
  // call rather than a generation later.
  //
  // Scoped to rows that have an `expires_at`: a listing written by hand, or by
  // M4-04 before this migration, has none and is none of this sweep's business.
  const expired = await db
    .update(usedAircraftListing)
    .set({ status: 'withdrawn' })
    .where(
      and(
        eq(usedAircraftListing.worldId, worldId),
        eq(usedAircraftListing.status, 'available'),
        isNotNull(usedAircraftListing.expiresAt),
        lte(usedAircraftListing.expiresAt, gameNow),
      ),
    )
    .returning({ id: usedAircraftListing.id });

  const occupied = await db
    .select({ slotIndex: usedAircraftListing.slotIndex })
    .from(usedAircraftListing)
    .where(
      and(
        eq(usedAircraftListing.worldId, worldId),
        eq(usedAircraftListing.status, 'available'),
        isNotNull(usedAircraftListing.slotIndex),
      ),
    );

  const taken = new Set(occupied.flatMap((r) => (r.slotIndex === null ? [] : [r.slotIndex])));
  const vacant: number[] = [];
  for (let slot = 0; slot < balance.inventory.slots; slot += 1) {
    if (!taken.has(slot)) vacant.push(slot);
  }

  if (vacant.length === 0) {
    return { worldId, created: 0, withdrawn: expired.length, generation, refreshed: true };
  }

  const [catalogue, locations] = await Promise.all([
    loadCatalogueVersion(db, row.catalogueVersion),
    marketLocations(db),
  ]);
  if (locations.length === 0) {
    return { worldId, created: 0, withdrawn: expired.length, generation, refreshed: false };
  }

  const candidates: UsedMarketCandidate[] = [...catalogue.types.values()].map((type) => ({
    designation: type.designation,
    aircraftClass: type.class,
    era: type.eraDates,
    baseSpec: type.baseSpec,
    listPriceMinor: type.listPrice,
    monthlyLeaseRateMinor: type.monthlyLeaseRate,
    availableOptionIds: type.availableOptionIds,
  }));

  let created = 0;
  for (const slot of vacant) {
    const draft = draftUsedListing({
      worldSeed: row.seed,
      epoch: row.epoch,
      gameNow,
      slotIndex: slot,
      candidates,
      optionCatalogue: catalogue.options,
      locationCount: locations.length,
      balance,
    });
    // Null means no type has a feasible build window — a world only weeks past a
    // 1950s epoch, say. Not an error, and not something to retry: the next
    // generation will find the same answer until the calendar moves.
    if (draft === null) continue;

    const locationIcao = locations[draft.locationIndex];
    if (locationIcao === undefined) continue;

    const inserted = await db
      .insert(usedAircraftListing)
      .values({
        worldId,
        catalogueVersion: catalogue.version,
        typeDesignation: draft.typeDesignation,
        registration: provisionalRegistration(worldId, slot, draft.generationIndex),
        buildOptionIds: JSON.stringify(draft.buildOptionIds),
        effectiveSpec: JSON.stringify(draft.effectiveSpec),
        hours: draft.hours,
        cycles: draft.cycles,
        askingPriceMinor: draft.valuation.askingPriceMinor,
        locationIcao,
        slotIndex: slot,
        generationIndex: draft.generationIndex,
        builtAt: draft.builtAt,
        expiresAt: draft.expiresAt,
        valuation: JSON.stringify(valuationDto(draft)),
        availableAt: gameNow,
      })
      // The whole idempotency story, in one clause. See the module note.
      .onConflictDoNothing({
        target: [
          usedAircraftListing.worldId,
          usedAircraftListing.slotIndex,
          usedAircraftListing.generationIndex,
        ],
      })
      .returning({ id: usedAircraftListing.id });

    created += inserted.length;
  }

  return { worldId, created, withdrawn: expired.length, generation, refreshed: true };
}

/**
 * The market as a player sees it.
 *
 * Reads what generation wrote and computes no price of its own. That is the
 * point: the economy config can be re-pinned, and a read path that recomputed
 * would eventually explain an old listing with today's coefficients — a
 * valuation that disagreed with the asking price beside it, which is invariant 4
 * failing in the most confusing possible place.
 */
export async function listUsedMarket(db: Database, worldId: string): Promise<UsedMarketResponse> {
  const worlds = await db
    .select({ economyConfigVersion: world.economyConfigVersion })
    .from(world)
    .where(eq(world.id, worldId))
    .limit(1);
  const target = worlds[0];
  if (!target) throw new Error(`No world ${worldId}`);

  const economy = await loadEconomyConfig(db, target.economyConfigVersion);

  const rows = await db
    .select()
    .from(usedAircraftListing)
    .where(
      and(
        eq(usedAircraftListing.worldId, worldId),
        eq(usedAircraftListing.status, 'available'),
        // A row with no stored valuation predates M4-05. It is still buyable
        // through M4-04's listing id, but it cannot be shown on a page whose
        // contract promises a price that explains itself — and fabricating a
        // decomposition for it would be worse than leaving it out.
        isNotNull(usedAircraftListing.valuation),
        isNotNull(usedAircraftListing.builtAt),
      ),
    )
    .orderBy(asc(usedAircraftListing.askingPriceMinor), asc(usedAircraftListing.id));

  const listings = rows.flatMap((row): UsedMarketListingDto[] => {
    if (row.valuation === null || row.builtAt === null) return [];
    return [
      {
        id: row.id,
        typeDesignation: row.typeDesignation,
        registration: row.registration,
        locationIcao: row.locationIcao,
        buildOptionIds: JSON.parse(row.buildOptionIds) as string[],
        effectiveSpec: JSON.parse(row.effectiveSpec) as UsedMarketListingDto['effectiveSpec'],
        builtAt: row.builtAt.toISOString(),
        hours: row.hours,
        cycles: row.cycles,
        askingPriceMinor: row.askingPriceMinor,
        valuation: JSON.parse(row.valuation) as UsedMarketValuation,
        availableAt: row.availableAt.toISOString(),
        expiresAt: row.expiresAt === null ? null : row.expiresAt.toISOString(),
      },
    ];
  });

  return { listings, slots: economy.usedMarket.inventory.slots };
}

/** How many berths this world is currently offering. For the admin health page. */
export async function usedMarketDepth(db: Database, worldId: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(usedAircraftListing)
    .where(
      and(
        eq(usedAircraftListing.worldId, worldId),
        eq(usedAircraftListing.status, 'available'),
        isNull(usedAircraftListing.soldAt),
      ),
    );
  return rows[0]?.count ?? 0;
}
