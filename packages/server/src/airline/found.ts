import { count, eq } from 'drizzle-orm';

import {
  INITIAL_AIRLINE_REPUTATION,
  type Airline as AirlineContract,
  type AirlineCodeAvailabilityAdvisory,
  type AirlineCodeKind,
  type AirlineHub as AirlineHubContract,
  type CreateAirlineInput,
  type WorldStatus,
} from '@tailfin/shared';

import { type Database } from '../db/client';
import { airline, airlineHub, airport, world } from '../db/schema';
import { economyConfigFor } from '../economy/config';

import { moveAirlineCash } from './cash';
import {
  airlineCodeAvailabilityAdvisory,
  availableAirlineCodeAlternatives,
  tailfinAirlineCodePolicy,
  type AirlineCodeAllocationPolicy,
} from './codes';
import {
  moderateAirlineIdentity,
  type AirlineIdentityModerationDependencies,
  type ModeratedAirlineIdentityField,
} from './moderation';
import { wireAirline } from './wire';

export interface FoundAirlineDependencies extends AirlineIdentityModerationDependencies {
  codePolicy?: AirlineCodeAllocationPolicy;
}

export type FoundAirlineResult =
  | { ok: true; airline: AirlineContract; hub: AirlineHubContract }
  | { ok: false; kind: 'world-not-found'; worldId: string }
  | { ok: false; kind: 'world-not-open'; status: WorldStatus }
  | { ok: false; kind: 'world-full'; playerCap: number }
  | { ok: false; kind: 'unknown-hub'; ident: string }
  | {
      ok: false;
      kind: 'identity-refused';
      field: ModeratedAirlineIdentityField;
      reason: string;
    }
  | {
      ok: false;
      kind: 'code-taken';
      codeKind: AirlineCodeKind;
      code: string;
      alternatives: string[];
      advisory: AirlineCodeAvailabilityAdvisory;
    }
  | {
      ok: false;
      kind: 'code-reserved';
      codeKind: AirlineCodeKind;
      code: string;
      alternatives: string[];
      advisory: AirlineCodeAvailabilityAdvisory;
    }
  | { ok: false; kind: 'already-founded'; worldId: string };

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
  const codePolicy = dependencies.codePolicy ?? tailfinAirlineCodePolicy;
  const moderation = await moderateAirlineIdentity(
    {
      name: input.name,
      callsign: input.callsign,
    },
    dependencies,
  );
  if (!moderation.accepted) {
    return {
      ok: false,
      kind: 'identity-refused',
      field: moderation.field,
      reason: moderation.reason,
    };
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
      const { openingCashMinor, freeHubAllowance } = config.airlineStartingPosition;
      if (freeHubAllowance !== 1) {
        throw new Error(
          `Economy config ${config.version} grants ${String(freeHubAllowance)} ` +
            'founder hubs, but the founding flow currently consumes exactly one (AIR-03)',
        );
      }

      for (const [codeKind, code] of [
        ['iata', input.iataCode],
        ['icao', input.icaoCode],
      ] as const) {
        if (codePolicy.isReserved(codeKind, code)) {
          return {
            ok: false,
            kind: 'code-reserved',
            codeKind,
            code,
            alternatives: await availableAirlineCodeAlternatives(
              tx,
              input.worldId,
              input.name,
              codeKind,
              [code],
              codePolicy,
            ),
            advisory: airlineCodeAvailabilityAdvisory(codePolicy),
          };
        }
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
          // Fixed by §15 and intentionally not economy config (AIR-03). It is
          // supplied explicitly so founding never depends on an omitted field.
          reputation: String(INITIAL_AIRLINE_REPUTATION),
        })
        .returning();
      const createdAirline = createdAirlines[0];
      if (!createdAirline) throw new Error('Founding inserted no airline');

      const openingMovement = await moveAirlineCash(tx, {
        airlineId: createdAirline.id,
        amountMinor: openingCashMinor,
        cause: 'airline_founding',
        reference: createdAirline.id,
        occurredAt: createdAirline.createdAt,
      });
      if (openingMovement.status !== 'applied') {
        throw new Error(`Founding cash already existed for new airline ${createdAirline.id}`);
      }

      const createdHubs = await tx
        .insert(airlineHub)
        .values({
          airlineId: createdAirline.id,
          airportId: selectedHub.id,
          founderGrant: freeHubAllowance === 1,
        })
        .returning();
      const createdHub = createdHubs[0];
      if (!createdHub) throw new Error('Founding inserted no hub');

      return {
        ok: true,
        airline: wireAirline({
          ...createdAirline,
          cashMinor: openingMovement.movement.balanceAfterMinor,
        }),
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
    const constraint = constraintName(error);
    if (
      constraint === 'airline_world_id_iata_code_key' ||
      constraint === 'airline_world_id_icao_code_key'
    ) {
      const codeKind = constraint === 'airline_world_id_iata_code_key' ? 'iata' : 'icao';
      const code = codeKind === 'iata' ? input.iataCode : input.icaoCode;
      return {
        ok: false,
        kind: 'code-taken',
        codeKind,
        code,
        alternatives: await availableAirlineCodeAlternatives(
          db,
          input.worldId,
          input.name,
          codeKind,
          [code],
          codePolicy,
        ),
        advisory: airlineCodeAvailabilityAdvisory(codePolicy),
      };
    }
    switch (constraint) {
      case 'airline_world_id_player_id_key':
        return { ok: false, kind: 'already-founded', worldId: input.worldId };
      default:
        throw error;
    }
  }
}
