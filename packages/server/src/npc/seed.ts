import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';

import { type NpcArchetype, NPC_ARCHETYPES } from '@tailfin/shared';
import {
  cabinsFor,
  decideEntry,
  deriveRng,
  fareFor,
  frequencyFor,
  intBetween,
  type Rng,
} from '@tailfin/sim';

import { moveAirlineCash } from '../airline/cash';
import { type Database } from '../db/client';
import { airline, airport, route, world } from '../db/schema';
import { type PinnedEconomyConfig } from '../economy/config';
import { loadEconomyConfig } from '../economy/loader';

import { recordDecisions, type PendingDecision } from './decisions';
import { makeIdentity } from './identity';
import { type MarketCandidate, pairKey, topMarkets } from './market';

/**
 * Populating a world with incumbents (M3-12, §24).
 *
 * §24: *"500 players cannot populate 4,000 airports. Without AI incumbents the
 * world is empty and the demand model has nothing to compete against."* This is
 * the job that fixes that, and M3-12's first acceptance criterion is its
 * contract: *"a newly seeded world has plausible incumbent competition on major
 * city pairs."*
 *
 * ## Deterministic from the world's own seed
 *
 * Every choice — which countries get carriers, which archetype each is, what it
 * is called, which markets it opens — is drawn from `deriveRng(world.seed, …)`.
 * Seeding the same world twice produces the same airlines, which is what makes
 * M13-01's replay harness possible and what stops a reset producing a different
 * competitive landscape from the same inputs.
 *
 * ## Hubs come from the data, not from a list
 *
 * A carrier is placed at a real airport chosen by catchment population within
 * its country, and named after that airport's city. There is no table of
 * invented airlines to maintain and no risk of a Portuguese-sounding carrier
 * appearing in Finland after somebody reorders it.
 *
 * ## What an NPC does not have
 *
 * No fleet, no slots, no gates. M4 owns aircraft, §8.1 owns slots and M7-06
 * owns gates, and none of them exist yet — so an NPC operates exactly as a
 * player does today: against `REFERENCE_AIRFRAME`, at an assumed frequency,
 * with routes and fares. When those milestones land, both sides gain them
 * together. Giving NPCs a fleet before players have one would be the very
 * advantage the fourth acceptance criterion forbids.
 */

export interface NpcSeedResult {
  worldId: string;
  /** Carriers created by this run. Zero on a world that already has them. */
  created: number;
  routesOpened: number;
  /** True when the world already had NPCs and this run did nothing. */
  alreadySeeded: boolean;
  /** Countries that got at least one carrier, for the operator running the job. */
  countries: string[];
}

interface HubCandidate {
  icao: string;
  isoCountry: string;
  municipality: string;
  catchment: number;
}

/**
 * Airports worth basing a carrier at, best first within each country.
 *
 * Flagship and large tiers only: M1-02 classified those as the airports with
 * the traffic to support a network, and a charter operator based at a regional
 * strip would be a carrier nobody ever meets.
 */
async function hubCandidates(db: Database, limit: number): Promise<Map<string, HubCandidate[]>> {
  const rows = await db
    .select({
      icao: airport.icaoCode,
      isoCountry: airport.isoCountry,
      municipality: airport.municipality,
      catchment: airport.catchmentPopulation,
    })
    .from(airport)
    .where(
      and(
        isNotNull(airport.icaoCode),
        isNotNull(airport.municipality),
        isNotNull(airport.catchmentPopulation),
        eq(airport.scheduledService, true),
        inArray(airport.tier, ['flagship', 'large']),
      ),
    )
    .orderBy(desc(airport.catchmentPopulation))
    .limit(limit);

  const byCountry = new Map<string, HubCandidate[]>();
  for (const row of rows) {
    if (row.icao === null || row.municipality === null || row.catchment === null) continue;
    const list = byCountry.get(row.isoCountry) ?? [];
    list.push({
      icao: row.icao,
      isoCountry: row.isoCountry,
      municipality: row.municipality,
      catchment: row.catchment,
    });
    byCountry.set(row.isoCountry, list);
  }
  return byCountry;
}

/**
 * Which archetype a carrier at this hub should be.
 *
 * The first carrier in a country is its flag carrier, because every country
 * that has an airline at all has one of those. After that the mix is drawn,
 * weighted toward low-cost — which is both how the industry actually looks and
 * what gives a player entering a market someone to undercut and someone to
 * out-product.
 */
function archetypeFor(rng: Rng, indexInCountry: number): NpcArchetype {
  if (indexInCountry === 0) return 'flag';
  const roll = intBetween(rng, 0, 99);
  if (roll < 45) return 'lcc';
  if (roll < 78) return 'regional';
  return 'charter';
}

/** Codes already spoken for in this world, so a seed cannot collide with a player. */
async function takenCodes(
  db: Database,
  worldId: string,
): Promise<{ iata: Set<string>; icao: Set<string> }> {
  const rows = await db
    .select({ iataCode: airline.iataCode, icaoCode: airline.icaoCode })
    .from(airline)
    .where(eq(airline.worldId, worldId));

  return {
    iata: new Set(rows.map((r) => r.iataCode)),
    icao: new Set(rows.map((r) => r.icaoCode)),
  };
}

/**
 * Seed a world's NPC carriers and their opening networks.
 *
 * Idempotent by presence: a world that already has NPC airlines is left alone.
 * That matters because this runs from a CLI a fresh environment invokes, and a
 * second run doubling the world's incumbents would be a very expensive mistake
 * to undo — `economy_config` aside, nothing in this repository can be deleted
 * back to a previous state.
 */
export async function seedNpcCarriers(
  db: Database,
  worldId: string,
  log: (line: string) => void = () => undefined,
): Promise<NpcSeedResult> {
  const worlds = await db
    .select({
      id: world.id,
      seed: world.seed,
      economyConfigVersion: world.economyConfigVersion,
      epoch: world.epoch,
    })
    .from(world)
    .where(eq(world.id, worldId))
    .limit(1);

  const target = worlds[0];
  if (!target) throw new Error(`No world ${worldId}`);

  const existing = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(airline)
    .where(and(eq(airline.worldId, worldId), eq(airline.kind, 'npc')));

  if ((existing[0]?.n ?? 0) > 0) {
    return {
      worldId,
      created: 0,
      routesOpened: 0,
      alreadySeeded: true,
      countries: [],
    };
  }

  const economy = await loadEconomyConfig(db, target.economyConfigVersion);
  const npc = economy.npc;

  const byCountry = await hubCandidates(db, 400);
  const codes = await takenCodes(db, worldId);

  // Countries in a fixed order — most populous hub first — so the seed does not
  // depend on the order Postgres happened to return rows in.
  const countries = [...byCountry.entries()]
    .map(([iso, hubs]) => ({ iso, hubs, top: hubs[0]?.catchment ?? 0 }))
    .sort((a, b) => b.top - a.top || (a.iso < b.iso ? -1 : 1))
    .slice(0, npc.seeding.maxCountries);

  const markets = await topMarkets(
    db,
    worldId,
    economy,
    // Generous: a carrier can only open routes touching its own hub, so the
    // candidate list has to be much longer than the number of routes opened.
    npc.seeding.maxCarriers * npc.seeding.routesPerCarrier * 12,
    npc.seeding.minDailyPassengers,
  );

  if (markets.length === 0) {
    log('  no demand pools in this world — run `pnpm demand:generate` first');
    return { worldId, created: 0, routesOpened: 0, alreadySeeded: false, countries: [] };
  }

  const created: { id: string; country: string }[] = [];
  const decisions: PendingDecision[] = [];
  let routesOpened = 0;
  // Grows as routes are opened, so the second carrier into a market sees the
  // first one — the reason seeding produces contested majors and thin monopolies
  // rather than every carrier piling onto the same twenty pairs.
  const openedBy = new Map<string, string[]>();

  for (const [index, country] of countries.entries()) {
    if (created.length >= npc.seeding.maxCarriers) break;

    // One carrier per country in the first pass, a second for the largest few.
    const slots = index < 8 ? 2 : 1;

    for (let slot = 0; slot < slots; slot += 1) {
      if (created.length >= npc.seeding.maxCarriers) break;

      const hub = country.hubs[slot];
      if (!hub) break;

      const rng = deriveRng(target.seed, 'npc', country.iso, String(slot));
      const archetype = archetypeFor(rng, slot);
      const identity = makeIdentity(rng, archetype, hub.municipality, codes.iata, codes.icao);
      if (!identity) {
        log(`  ${country.iso}: no free code for a carrier at ${hub.icao}, skipped`);
        continue;
      }

      /**
       * Created the way a player's airline is created: inserted with no cash,
       * then granted its opening position through the ledger.
       *
       * Setting `cash_minor` directly is refused by
       * `enforce_airline_cash_reconciliation`, and rightly — an airline's cash
       * is the sum of its movements or it is a number somebody typed. CI caught
       * this on the first run, which is the no-cheating criterion being enforced
       * by the database rather than by anybody remembering it.
       */
      const carrier = await db.transaction(async (tx) => {
        const inserted = await tx
          .insert(airline)
          .values({
            worldId,
            playerId: null,
            kind: 'npc',
            archetype,
            name: identity.name,
            iataCode: identity.iataCode,
            icaoCode: identity.icaoCode,
            callsign: identity.callsign,
            baseCountry: country.iso,
            reputation: npc.archetypes[archetype].reputation.toFixed(2),
          })
          .returning({ id: airline.id, createdAt: airline.createdAt });

        const row = inserted[0];
        if (!row) throw new Error(`NPC insert returned nothing for ${identity.iataCode}`);

        // The same cause and the same amount a founded player receives. An NPC
        // with a bottomless balance would be the clearest possible breach of
        // the fourth acceptance criterion.
        const opening = await moveAirlineCash(tx, {
          airlineId: row.id,
          amountMinor: economy.airlineStartingPosition.openingCashMinor,
          cause: 'airline_founding',
          reference: row.id,
          occurredAt: row.createdAt,
        });
        if (opening.status !== 'applied') {
          throw new Error(`Opening cash already existed for NPC ${row.id}`);
        }

        return row;
      });
      created.push({ id: carrier.id, country: country.iso });

      const opened = await openNetwork({
        db,
        worldId,
        carrierId: carrier.id,
        hubIcao: hub.icao,
        archetype,
        economy,
        markets,
        openedBy,
        decidedAt: target.epoch,
        decisions,
      });
      routesOpened += opened;
      log(
        `  ${identity.iataCode} ${identity.name} (${archetype}, ${hub.icao}) — ${String(opened)} routes`,
      );
    }
  }

  await recordDecisions(db, worldId, decisions);

  return {
    worldId,
    created: created.length,
    routesOpened,
    alreadySeeded: false,
    countries: [...new Set(created.map((c) => c.country))],
  };
}

interface OpenNetworkArgs {
  db: Database;
  worldId: string;
  carrierId: string;
  hubIcao: string;
  archetype: NpcArchetype;
  economy: PinnedEconomyConfig;
  markets: readonly MarketCandidate[];
  openedBy: Map<string, string[]>;
  decidedAt: Date;
  decisions: PendingDecision[];
}

/**
 * Open one carrier's initial network.
 *
 * Every route goes through the **same `decideEntry`** the weekly review uses.
 * A seeding path that placed routes by a different rule would produce a world
 * whose incumbents would immediately want to leave half their own markets, and
 * the first review after launch would undo the seed.
 */
async function openNetwork(args: OpenNetworkArgs): Promise<number> {
  const { db, worldId, carrierId, hubIcao, archetype, economy, markets, openedBy } = args;
  const profile = economy.npc.archetypes[archetype];

  const reachable = markets.filter(
    (m) => m.originIcao === hubIcao || m.destinationIcao === hubIcao,
  );

  let opened = 0;
  for (const market of reachable) {
    if (opened >= economy.npc.seeding.routesPerCarrier) break;

    const key = pairKey(market.originIcao, market.destinationIcao);
    const already = openedBy.get(key) ?? [];
    const verdict = decideEntry(
      { ...market, incumbents: market.incumbents + already.length },
      profile,
      economy.npc.behaviour,
    );

    if (!verdict.enter) continue;

    const fare = fareFor(profile, market.variableCostPerSeatMinor, market.floorMinor);
    await db
      .insert(route)
      .values({
        worldId,
        airlineId: carrierId,
        originIcao: market.originIcao,
        destinationIcao: market.destinationIcao,
        greatCircleNm: market.greatCircleNm,
        fares: JSON.stringify(
          Object.fromEntries(
            Object.entries(cabinsFor(profile, fare)).map(([cabin, offer]) => [
              cabin,
              offer.fareMinor,
            ]),
          ),
        ),
      })
      .onConflictDoNothing();

    already.push(carrierId);
    openedBy.set(key, already);
    opened += 1;

    args.decisions.push({
      airlineId: carrierId,
      decidedAt: args.decidedAt,
      kind: 'route_opened',
      originIcao: market.originIcao,
      destinationIcao: market.destinationIcao,
      basis: {
        dailyPassengers: Math.round(market.dailyPassengers),
        incumbents: market.incumbents + already.length - 1,
        variableCostPerSeatMinor: Math.round(market.variableCostPerSeatMinor),
        floorMinor: market.floorMinor,
        fareAfterMinor: fare,
        estimatedMargin: verdict.estimatedMargin,
        greatCircleNm: Math.round(market.greatCircleNm),
      },
      reason: `Opened at world creation: ${String(Math.round(market.dailyPassengers))} passengers a day, ${String(frequencyFor(profile, market.dailyPassengers))} daily departures planned.`,
      economyConfigVersion: economy.version,
    });
  }

  return opened;
}

/** Whether a world has any NPC carriers at all. */
export async function worldHasNpcs(db: Database, worldId: string): Promise<boolean> {
  const rows = await db
    .select({ id: airline.id })
    .from(airline)
    .where(and(eq(airline.worldId, worldId), eq(airline.kind, 'npc')))
    .limit(1);
  return rows.length > 0;
}

export { NPC_ARCHETYPES };
