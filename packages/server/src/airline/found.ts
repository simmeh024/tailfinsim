import { count, eq } from 'drizzle-orm';

import {
  INITIAL_AIRLINE_REPUTATION,
  type Airline as AirlineContract,
  type AirlineHub as AirlineHubContract,
  type CreateAirlineInput,
  type WorldStatus,
} from '@tailfin/shared';

import { type Database } from '../db/client';
import { airline, airlineHub, airport, world, type AirlineRow } from '../db/schema';

import { economyConfigFor } from './config';

/**
 * AIR-02 supplies policy behind this seam. The default is deliberately
 * permissive: deterministic shape validation has already happened through the
 * shared schema, while moderation policy is not AIR-01's decision to invent.
 */
export type ModerateAirlineIdentity = (identity: {
  name: string;
  callsign: string;
}) => Promise<{ accepted: true } | { accepted: false; reason: string }>;

const permitIdentity: ModerateAirlineIdentity = () => Promise.resolve({ accepted: true });

export interface FoundAirlineDependencies {
  moderateIdentity?: ModerateAirlineIdentity;
}

export type FoundAirlineResult =
  | { ok: true; airline: AirlineContract; hub: AirlineHubContract }
  | { ok: false; kind: 'world-not-found'; worldId: string }
  | { ok: false; kind: 'world-not-open'; status: WorldStatus }
  | { ok: false; kind: 'world-full'; playerCap: number }
  | { ok: false; kind: 'unknown-hub'; ident: string }
  | { ok: false; kind: 'identity-refused'; reason: string }
  | { ok: false; kind: 'code-taken'; codeKind: 'iata' | 'icao'; code: string }
  | { ok: false; kind: 'already-founded'; worldId: string };

function wireAirline(row: AirlineRow): AirlineContract {
  return {
    id: row.id,
    worldId: row.worldId,
    playerId: row.playerId,
    name: row.name,
    iataCode: row.iataCode,
    icaoCode: row.icaoCode,
    callsign: row.callsign,
    baseCountry: row.baseCountry,
    cash: row.cashMinor,
    // `numeric(3,2)` is a string at the database boundary. The shared wire
    // schema is deliberately a number, so normalise once here.
    reputation: Number(row.reputation),
    createdAt: row.createdAt.toISOString(),
  };
}

/** Walk through Drizzle's wrapper to the Postgres constraint that actually fired. */
function constraintName(error: unknown): string | null {
  let current: unknown = error;
  while (current instanceof Error) {
    const constraint = (current as { constraint?: unknown }).constraint;
    if (typeof constraint === 'string') return constraint;
    current = current.cause;
  }
  return null;
}

/**
 * Found an airline and grant its opening position, all or nothing (AIR-01).
 *
 * The world row is locked before its lifecycle or player cap is read. That
 * serialises founding against both another founder and an admin locking the
 * world, so "open" cannot become stale halfway through the commit.
 *
 * Code availability is intentionally not checked first. The unique constraints
 * are the authority and cannot be raced; the catch below translates whichever
 * one fired into a refusal that names the submitted code.
 */
export async function foundAirline(
  db: Database,
  playerId: string,
  input: CreateAirlineInput,
  dependencies: FoundAirlineDependencies = {},
): Promise<FoundAirlineResult> {
  const moderation = await (dependencies.moderateIdentity ?? permitIdentity)({
    name: input.name,
    callsign: input.callsign,
  });
  if (!moderation.accepted) {
    return { ok: false, kind: 'identity-refused', reason: moderation.reason };
  }

  try {
    return await db.transaction(async (tx): Promise<FoundAirlineResult> => {
      const worlds = await tx
        .select({
          id: world.id,
          status: world.status,
          playerCap: world.playerCap,
          economyConfigVersion: world.economyConfigVersion,
        })
        .from(world)
        .where(eq(world.id, input.worldId))
        .for('update');

      const selectedWorld = worlds[0];
      if (!selectedWorld) {
        return { ok: false, kind: 'world-not-found', worldId: input.worldId };
      }
      if (selectedWorld.status !== 'open') {
        return { ok: false, kind: 'world-not-open', status: selectedWorld.status };
      }

      const config = economyConfigFor(selectedWorld.economyConfigVersion);
      if (!config) {
        throw new Error(
          `World ${selectedWorld.id} pins unknown economy config ${selectedWorld.economyConfigVersion}`,
        );
      }
      if (config.airlineStartingPosition.freeHubAllowance < 1) {
        throw new Error(
          `Economy config ${config.version} grants no founder hub, contrary to App. B.5`,
        );
      }

      if (selectedWorld.playerCap !== null) {
        const counts = await tx
          .select({ value: count(airline.id) })
          .from(airline)
          .where(eq(airline.worldId, selectedWorld.id));
        if ((counts[0]?.value ?? 0) >= selectedWorld.playerCap) {
          return { ok: false, kind: 'world-full', playerCap: selectedWorld.playerCap };
        }
      }

      const hubs = await tx
        .select({ id: airport.id, ident: airport.ident })
        .from(airport)
        .where(eq(airport.ident, input.hubIdent))
        .limit(1);
      const selectedHub = hubs[0];
      if (!selectedHub) {
        return { ok: false, kind: 'unknown-hub', ident: input.hubIdent };
      }

      const createdAirlines = await tx
        .insert(airline)
        .values({
          worldId: selectedWorld.id,
          playerId,
          name: input.name,
          iataCode: input.iataCode,
          icaoCode: input.icaoCode,
          callsign: input.callsign,
          baseCountry: input.baseCountry,
          cashMinor: config.airlineStartingPosition.openingCashMinor,
          // Fixed by §15 and intentionally not economy config (AIR-03). It is
          // supplied explicitly so founding never depends on an omitted field.
          reputation: String(INITIAL_AIRLINE_REPUTATION),
        })
        .returning();
      const createdAirline = createdAirlines[0];
      if (!createdAirline) throw new Error('Founding inserted no airline');

      const createdHubs = await tx
        .insert(airlineHub)
        .values({
          airlineId: createdAirline.id,
          airportId: selectedHub.id,
          founderGrant: true,
        })
        .returning();
      const createdHub = createdHubs[0];
      if (!createdHub) throw new Error('Founding inserted no hub');

      return {
        ok: true,
        airline: wireAirline(createdAirline),
        hub: {
          id: createdHub.id,
          airlineId: createdHub.airlineId,
          airportIdent: selectedHub.ident,
          founderGrant: createdHub.founderGrant,
          createdAt: createdHub.createdAt.toISOString(),
        },
      };
    });
  } catch (error) {
    switch (constraintName(error)) {
      case 'airline_world_id_iata_code_key':
        return { ok: false, kind: 'code-taken', codeKind: 'iata', code: input.iataCode };
      case 'airline_world_id_icao_code_key':
        return { ok: false, kind: 'code-taken', codeKind: 'icao', code: input.icaoCode };
      case 'airline_world_id_player_id_key':
        return { ok: false, kind: 'already-founded', worldId: input.worldId };
      default:
        throw error;
    }
  }
}
