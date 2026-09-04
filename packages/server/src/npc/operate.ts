import { and, eq, inArray } from 'drizzle-orm';

import { CABIN_ORDER, type CabinClass, FareTable, type NpcArchetype } from '@tailfin/shared';
import {
  cabinsFor,
  decideEntry,
  decideExit,
  decideFare,
  fareFor,
  frequencyFor,
} from '@tailfin/sim';

import { type Database } from '../db/client';
import { airline, route, world } from '../db/schema';
import { type PinnedEconomyConfig } from '../economy/config';
import { loadEconomyConfig } from '../economy/loader';

import { type PendingDecision, recordDecisions } from './decisions';
import { createCostModel, loadNpcFuel, pairKey, topMarkets } from './market';

/**
 * What NPC carriers do on their own (M3-12).
 *
 * M3-12's second acceptance criterion is the one this file exists for: *"an
 * uncontested high-margin route attracts NPC entry within ~30 game days."* That
 * is A.10's monopoly guard — *"fat margins on an uncontested route visibly
 * attract AI entrants"* — and it is the reason a player cannot simply find an
 * empty market and milk it forever.
 *
 * Three things happen in a review, in this order:
 *
 *   1. **Exit** a route that has been a loss-maker for several reviews running.
 *   2. **Adjust fares** toward the market, without abandoning the carrier's own
 *      economics or A.10's floor.
 *   3. **Enter** the best market it is not already in.
 *
 * Exit first, so a carrier that is failing frees itself before it commits to
 * anything new — and so the entry budget is not spent by a carrier that is
 * about to leave the market next door.
 *
 * ## This is the worker's work
 *
 * ADR-0019: a scheduled job has exactly one owner and it is the worker. This
 * function is called from the engine tick, never from a route. It is also why
 * there is no timer in this file — the engine owns the cadence and this owns
 * the decision.
 *
 * ## Deterministic
 *
 * Everything here is a function of stored state and the world's game clock. The
 * review cadence is measured in **game days since the epoch**, so a world run at
 * 2× reviews twice as often in real time and exactly as often in game time —
 * and a replayed world reviews on the same days.
 */

export interface NpcReviewResult {
  worldId: string;
  /** Carriers considered. Zero on a world with no NPCs. */
  carriers: number;
  entered: number;
  exited: number;
  faresChanged: number;
  /** Decisions written, including the declines. */
  logged: number;
  /** False when the world's clock has not reached the next review yet. */
  reviewed: boolean;
}

/** Whole game days between the world's epoch and now. */
function gameDaysSinceEpoch(epoch: Date, gameNow: Date): number {
  return Math.floor((gameNow.getTime() - epoch.getTime()) / 86_400_000);
}

/**
 * Whether this world is due a review.
 *
 * Keyed off the game clock rather than a stored "last reviewed" column on
 * purpose: a column would have to be reset when a world resets (ADR-0005), and
 * forgetting that would leave a freshly reset world believing it had reviewed
 * yesterday. The clock cannot forget.
 */
export function reviewDue(epoch: Date, gameNow: Date, intervalDays: number): boolean {
  const days = gameDaysSinceEpoch(epoch, gameNow);
  if (days < 0) return false;
  return days % Math.max(1, Math.round(intervalDays)) === 0;
}

interface Carrier {
  id: string;
  archetype: NpcArchetype;
}

/**
 * Review every NPC carrier in one world.
 *
 * Returns without doing anything when the world is not due, which is the common
 * case — the engine ticks far more often than a carrier reviews.
 */
export async function reviewNpcCarriers(
  db: Database,
  worldId: string,
  gameNow: Date,
): Promise<NpcReviewResult> {
  const empty: NpcReviewResult = {
    worldId,
    carriers: 0,
    entered: 0,
    exited: 0,
    faresChanged: 0,
    logged: 0,
    reviewed: false,
  };

  const worlds = await db
    .select({ epoch: world.epoch, economyConfigVersion: world.economyConfigVersion })
    .from(world)
    .where(eq(world.id, worldId))
    .limit(1);
  const target = worlds[0];
  if (!target) return empty;

  const economy = await loadEconomyConfig(db, target.economyConfigVersion);
  if (!reviewDue(target.epoch, gameNow, economy.npc.behaviour.reviewIntervalDays)) return empty;

  const carriers = await db
    .select({ id: airline.id, archetype: airline.archetype })
    .from(airline)
    .where(
      and(eq(airline.worldId, worldId), eq(airline.kind, 'npc'), eq(airline.status, 'active')),
    );

  const active = carriers.flatMap((c): Carrier[] =>
    c.archetype === null ? [] : [{ id: c.id, archetype: c.archetype }],
  );
  if (active.length === 0) return empty;

  const decisions: PendingDecision[] = [];
  let entered = 0;
  let exited = 0;
  let faresChanged = 0;

  // One candidate list for the whole world, shared across carriers: it is the
  // same query for each of them, and sixty carriers each fetching the top
  // markets would be sixty identical scans of `demand_pool`.
  const markets = await topMarkets(
    db,
    worldId,
    economy,
    economy.npc.behaviour.entryCandidates * 4,
    economy.npc.seeding.minDailyPassengers,
  );
  const marketByPair = new Map(markets.map((m) => [pairKey(m.originIcao, m.destinationIcao), m]));

  /*
   * Every origin this review will price, in one query rather than one per
   * carrier: the candidate markets' origins, plus the origins of the routes
   * these carriers already fly, because an exit decision costs a route the
   * carrier holds rather than a market it is considering.
   *
   * Preloaded rather than resolved lazily because the cost model is pure — a
   * station it had not been given would fall back to the world's default rates
   * and quietly mis-price the exit.
   */
  const ownRouteOrigins = await db
    .select({ icao: route.originIcao })
    .from(route)
    .where(
      and(
        eq(route.worldId, worldId),
        eq(route.active, true),
        inArray(
          route.airlineId,
          active.map((c) => c.id),
        ),
      ),
    );
  const costOf = createCostModel(
    economy,
    await loadNpcFuel(db, worldId, economy, [
      ...markets.map((m) => m.originIcao),
      ...ownRouteOrigins.map((r) => r.icao),
    ]),
  );

  for (const carrier of active) {
    const profile = economy.npc.archetypes[carrier.archetype];

    const own = await db
      .select({
        id: route.id,
        originIcao: route.originIcao,
        destinationIcao: route.destinationIcao,
        greatCircleNm: route.greatCircleNm,
        fares: route.fares,
        lossReviews: route.npcLossReviews,
      })
      .from(route)
      .where(and(eq(route.airlineId, carrier.id), eq(route.active, true)));

    // ---------------------------------------------------------------- exit
    for (const own_ of own) {
      const key = pairKey(own_.originIcao, own_.destinationIcao);
      const market = marketByPair.get(key);
      const cost = costOf(own_.greatCircleNm, own_.originIcao);

      // A route whose market has fallen out of the candidate list entirely is
      // a route whose market has collapsed. Treated as a full-strength loss
      // rather than skipped, because "I can no longer see this market" and
      // "this market is empty" are the same fact from here.
      const verdict =
        market === undefined ? null : decideEntry({ ...market }, profile, economy.npc.behaviour);

      const losing = verdict === null || verdict.estimatedMargin < 0;

      // A good review wipes the slate. `exitLossReviews` counts *consecutive*
      // bad ones, so a route that recovers has not half-exited — otherwise a
      // route that lost money one week in four would eventually close having
      // been profitable for three quarters of its life.
      if (!losing) {
        if (own_.lossReviews > 0) {
          await db.update(route).set({ npcLossReviews: 0 }).where(eq(route.id, own_.id));
        }
        continue;
      }

      const lossReviews = own_.lossReviews + 1;
      if (!decideExit(lossReviews, economy.npc.behaviour)) {
        // Counted, not closed. This is the patience the rule is made of.
        await db.update(route).set({ npcLossReviews: lossReviews }).where(eq(route.id, own_.id));
        continue;
      }

      await db
        .update(route)
        .set({ active: false, npcLossReviews: lossReviews })
        .where(eq(route.id, own_.id));
      exited += 1;
      decisions.push({
        airlineId: carrier.id,
        decidedAt: gameNow,
        kind: 'route_closed',
        originIcao: own_.originIcao,
        destinationIcao: own_.destinationIcao,
        basis: {
          dailyPassengers: market ? Math.round(market.dailyPassengers) : 0,
          estimatedMargin: verdict?.estimatedMargin ?? -1,
          variableCostPerSeatMinor: Math.round(cost.variableCostPerSeatMinor),
          greatCircleNm: Math.round(own_.greatCircleNm),
          lossReviews,
        },
        reason:
          market === undefined
            ? 'Closed: the market no longer carries enough passengers to be worth serving.'
            : `Closed after ${String(lossReviews)} consecutive reviews below cost, the last at an estimated ${String(Math.round((verdict?.estimatedMargin ?? -1) * 100))}% margin.`,
        economyConfigVersion: economy.version,
      });
    }

    // ---------------------------------------------------------------- fares
    for (const own_ of own) {
      const market = marketByPair.get(pairKey(own_.originIcao, own_.destinationIcao));
      if (!market) continue;

      const parsed = FareTable.safeParse(JSON.parse(own_.fares) as unknown);
      if (!parsed.success) continue;

      const current = parsed.data.economy ?? 0;
      const target_ = fareFor(profile, market.variableCostPerSeatMinor, market.floorMinor);
      const move = decideFare(
        current,
        target_,
        // The market average this carrier is pulled toward is its own target
        // when it is alone: with nobody else selling, there is no market price
        // to converge on and the carrier's own economics are the whole answer.
        market.incumbents > 0 ? target_ : 0,
        market.floorMinor,
        economy.npc.behaviour,
      );
      if (!move.changed) continue;

      await db
        .update(route)
        .set({
          fares: JSON.stringify(
            Object.fromEntries(
              Object.entries(cabinsFor(profile, move.fareMinor)).map(([cabin, offer]) => [
                cabin,
                offer.fareMinor,
              ]),
            ),
          ),
          updatedAt: new Date(),
        })
        .where(eq(route.id, own_.id));

      faresChanged += 1;
      decisions.push({
        airlineId: carrier.id,
        decidedAt: gameNow,
        kind: 'fare_changed',
        originIcao: own_.originIcao,
        destinationIcao: own_.destinationIcao,
        basis: {
          fareBeforeMinor: current,
          fareAfterMinor: move.fareMinor,
          floorMinor: market.floorMinor,
          variableCostPerSeatMinor: Math.round(market.variableCostPerSeatMinor),
          marketFareMinor: market.incumbents > 0 ? target_ : undefined,
        },
        reason: `Economy fare moved from ${String(current)} to ${String(move.fareMinor)} minor units, against a floor of ${String(market.floorMinor)}.`,
        economyConfigVersion: economy.version,
      });
    }

    // --------------------------------------------------------------- entry
    const flying = new Set(own.map((r) => pairKey(r.originIcao, r.destinationIcao)));
    let openedThisReview = 0;

    for (const market of markets) {
      if (openedThisReview >= economy.npc.behaviour.maxEntriesPerReview) break;

      const key = pairKey(market.originIcao, market.destinationIcao);
      if (flying.has(key)) continue;
      if (market.operatorIds.includes(carrier.id)) continue;

      const verdict = decideEntry(market, profile, economy.npc.behaviour);
      if (!verdict.enter) {
        // Only the near misses are logged. A carrier declines thousands of
        // markets a review for reasons as dull as "that is not in my country",
        // and logging all of them would bury the interesting ones — but a
        // market it *nearly* entered is exactly what an admin asking "why has
        // nobody entered my monopoly?" needs to see.
        if (verdict.code === 'margin-too-low' && verdict.estimatedMargin > 0) {
          decisions.push({
            airlineId: carrier.id,
            decidedAt: gameNow,
            kind: 'entry_declined',
            originIcao: market.originIcao,
            destinationIcao: market.destinationIcao,
            basis: {
              dailyPassengers: Math.round(market.dailyPassengers),
              incumbents: market.incumbents,
              estimatedMargin: verdict.estimatedMargin,
              variableCostPerSeatMinor: Math.round(market.variableCostPerSeatMinor),
              greatCircleNm: Math.round(market.greatCircleNm),
            },
            reason: `Declined: an estimated ${String(Math.round(verdict.estimatedMargin * 100))}% margin against a ${String(Math.round(economy.npc.behaviour.entryMarginThreshold * 100))}% bar, with ${String(market.incumbents)} operators already selling it.`,
            economyConfigVersion: economy.version,
          });
        }
        continue;
      }

      await db
        .insert(route)
        .values({
          worldId,
          airlineId: carrier.id,
          originIcao: market.originIcao,
          destinationIcao: market.destinationIcao,
          greatCircleNm: market.greatCircleNm,
          fares: JSON.stringify(
            Object.fromEntries(
              Object.entries(cabinsFor(profile, verdict.economyFareMinor)).map(([cabin, offer]) => [
                cabin,
                offer.fareMinor,
              ]),
            ),
          ),
        })
        .onConflictDoNothing();

      flying.add(key);
      openedThisReview += 1;
      entered += 1;

      decisions.push({
        airlineId: carrier.id,
        decidedAt: gameNow,
        kind: 'route_opened',
        originIcao: market.originIcao,
        destinationIcao: market.destinationIcao,
        basis: {
          dailyPassengers: Math.round(market.dailyPassengers),
          incumbents: market.incumbents,
          estimatedMargin: verdict.estimatedMargin,
          variableCostPerSeatMinor: Math.round(market.variableCostPerSeatMinor),
          floorMinor: market.floorMinor,
          fareAfterMinor: verdict.economyFareMinor,
          greatCircleNm: Math.round(market.greatCircleNm),
        },
        reason: `Entered: ${String(Math.round(market.dailyPassengers))} passengers a day and ${String(market.incumbents)} operators, at an estimated ${String(Math.round(verdict.estimatedMargin * 100))}% margin over variable cost.`,
        economyConfigVersion: economy.version,
      });
    }
  }

  const logged = await recordDecisions(db, worldId, decisions);

  return {
    worldId,
    carriers: active.length,
    entered,
    exited,
    faresChanged: faresChanged,
    logged,
    reviewed: true,
  };
}

/** The cabins an NPC sells, for a caller that wants the shape without the write. */
export function faresForArchetype(
  economy: PinnedEconomyConfig,
  archetype: NpcArchetype,
  variableCostPerSeatMinor: number,
  floorMinor: number,
): Partial<Record<CabinClass, number>> {
  const profile = economy.npc.archetypes[archetype];
  const fare = fareFor(profile, variableCostPerSeatMinor, floorMinor);
  const cabins = cabinsFor(profile, fare);

  const table: Partial<Record<CabinClass, number>> = {};
  for (const cabin of CABIN_ORDER) {
    const offer = cabins[cabin];
    if (offer) table[cabin] = offer.fareMinor;
  }
  return table;
}

export { frequencyFor };
