import { and, asc, count, eq, ilike, isNotNull, or, sql } from 'drizzle-orm';

import type {
  AirlineFoundingAirport,
  AirlineFoundingOptionsResponse,
  AirportTier,
  SlotLevel,
} from '@tailfin/shared';

import { type Database } from '../db/client';
import { airline, airport, world } from '../db/schema';
import { economyConfigFor } from '../economy/config';

/**
 * The warning is qualitative because exact airport facility fees are not in the
 * database yet. Inventing a price in the client would violate the balance and
 * server-authority invariants; omitting the risk would violate App. B.5.
 */
export function founderHubFeeWarning(
  tier: AirportTier,
  slotLevel: SlotLevel | null,
): string | null {
  if (tier === 'flagship') {
    return (
      'Flagship hub: the founder grant covers acquisition, but this tier carries the highest ' +
      `${slotLevel === 3 ? 'ongoing facility fees and Level 3 slot scarcity' : 'ongoing facility fees'}. ` +
      'This ambitious choice is allowed.'
    );
  }
  if (tier === 'large') {
    return (
      'Large hub: the founder grant covers acquisition, but ongoing facility fees are high' +
      `${slotLevel === 3 ? ' and Level 3 slots are coordinated' : ''}. This choice is allowed.`
    );
  }
  if (slotLevel === 3) {
    return 'Level 3 airport: coordinated slots will be scarce. This choice is allowed.';
  }
  return null;
}

/** Open worlds and their pinned starting terms, scoped to one authenticated player. */
export async function listAirlineFoundingOptions(
  db: Database,
  playerId: string,
): Promise<AirlineFoundingOptionsResponse> {
  const [openWorlds, memberships, totals] = await Promise.all([
    db
      .select({
        id: world.id,
        name: world.name,
        economyConfigVersion: world.economyConfigVersion,
        playerCap: world.playerCap,
        createdAt: world.createdAt,
      })
      .from(world)
      .where(eq(world.status, 'open'))
      .orderBy(asc(world.createdAt)),
    db
      .select({ id: airline.id, worldId: airline.worldId })
      .from(airline)
      .where(eq(airline.playerId, playerId))
      .orderBy(asc(airline.createdAt)),
    db
      .select({ worldId: airline.worldId, airlines: count(airline.id) })
      .from(airline)
      .groupBy(airline.worldId),
  ]);

  const ownedWorlds = new Set(memberships.map((membership) => membership.worldId));
  const airlinesByWorld = new Map(totals.map((total) => [total.worldId, total.airlines]));

  return {
    memberships,
    worlds: openWorlds.map((row) => {
      const config = economyConfigFor(row.economyConfigVersion);
      if (!config) {
        throw new Error(`World ${row.id} pins unknown economy config ${row.economyConfigVersion}`);
      }
      const airlines = airlinesByWorld.get(row.id) ?? 0;
      const availability = ownedWorlds.has(row.id)
        ? ('already-founded' as const)
        : row.playerCap !== null && airlines >= row.playerCap
          ? ('full' as const)
          : ('available' as const);

      return {
        id: row.id,
        name: row.name,
        openingCashMinor: config.airlineStartingPosition.openingCashMinor,
        freeHubAllowance: config.airlineStartingPosition.freeHubAllowance,
        playerCap: row.playerCap,
        airlines,
        availability,
      };
    }),
  };
}

function wireFoundingAirport(row: {
  ident: string;
  icao: string | null;
  iata: string | null;
  name: string;
  city: string | null;
  country: string;
  tier: AirportTier | null;
  slotLevel: number | null;
}): AirlineFoundingAirport {
  if (row.tier === null) {
    throw new Error(`Untiered airport ${row.ident} escaped the founder-hub query`);
  }
  const parsedSlot =
    row.slotLevel === 1 || row.slotLevel === 2 || row.slotLevel === 3 ? row.slotLevel : null;
  return {
    ident: row.ident,
    icao: row.icao,
    iata: row.iata,
    name: row.name,
    city: row.city,
    country: row.country,
    tier: row.tier,
    slotLevel: parsedSlot,
    foundingCostMinor: 0,
    feeWarning: founderHubFeeWarning(row.tier, parsedSlot),
  };
}

const AIRPORT_SELECTION = {
  ident: airport.ident,
  icao: airport.icaoCode,
  iata: airport.iataCode,
  name: airport.name,
  city: airport.municipality,
  country: airport.isoCountry,
  tier: airport.tier,
  slotLevel: airport.slotLevel,
} as const;

/**
 * Search the scheduled, tiered airport set used by the founder-hub picker.
 * An empty query returns three high-catchment medium recommendations; a typed
 * query searches the full playable set and gives exact identifiers priority.
 */
export async function searchAirlineFoundingAirports(
  db: Database,
  input: string | undefined,
): Promise<{ airports: AirlineFoundingAirport[]; query: string }> {
  const query = (input ?? '').trim().slice(0, 80);
  if (query === '') {
    const rows = await db
      .select(AIRPORT_SELECTION)
      .from(airport)
      .where(
        and(
          eq(airport.scheduledService, true),
          isNotNull(airport.tier),
          eq(airport.tier, 'medium'),
        ),
      )
      .orderBy(sql`${airport.catchmentPopulation} desc nulls last`, asc(airport.name))
      .limit(3);
    return { airports: rows.map(wireFoundingAirport), query };
  }

  const pattern = `%${query}%`;
  const exact = query.toUpperCase();
  const rows = await db
    .select(AIRPORT_SELECTION)
    .from(airport)
    .where(
      and(
        eq(airport.scheduledService, true),
        isNotNull(airport.tier),
        or(
          ilike(airport.ident, pattern),
          ilike(airport.icaoCode, pattern),
          ilike(airport.iataCode, pattern),
          ilike(airport.name, pattern),
          ilike(airport.municipality, pattern),
        ),
      ),
    )
    .orderBy(
      sql`case
        when upper(${airport.ident}) = ${exact} then 0
        when upper(coalesce(${airport.icaoCode}, '')) = ${exact} then 1
        when upper(coalesce(${airport.iataCode}, '')) = ${exact} then 2
        else 3
      end`,
      asc(airport.name),
    )
    .limit(20);

  return { airports: rows.map(wireFoundingAirport), query };
}
