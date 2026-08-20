import { and, eq } from 'drizzle-orm';

import type {
  Airline as AirlineContract,
  OwnAirlineResponse,
  UpdateOwnAirlineInput,
} from '@tailfin/shared';
import { gameTime } from '@tailfin/sim';

import { type Database } from '../db/client';
import { airline, airlineIdentityChange, world } from '../db/schema';
import { economyConfigFor } from '../economy/config';

import { moveAirlineCash } from './cash';
import { resolvePlayerAirline, type ResolvedPlayerAirline } from './context';
import {
  moderateAirlineIdentity,
  type AirlineIdentityModerationDependencies,
  type ModeratedAirlineIdentityField,
} from './moderation';
import { wireAirline } from './wire';

const MUTABLE_FIELDS = ['name', 'callsign', 'baseCountry'] as const;
const IMMUTABLE_FIELDS = ['iataCode', 'icaoCode', 'cash', 'reputation'] as const;

function rebrandTerms(economyConfigVersion: string): NonNullable<OwnAirlineResponse['rebrand']> {
  const config = economyConfigFor(economyConfigVersion);
  if (!config) {
    throw new Error(`Airline world pins unknown economy config ${economyConfigVersion}`);
  }
  return {
    costMinor: config.airlineIdentity.rebrandCostMinor,
    mutableFields: [...MUTABLE_FIELDS],
    immutableFields: [...IMMUTABLE_FIELDS],
  };
}

export type ReadOwnAirlineResult =
  { kind: 'found'; response: OwnAirlineResponse } | { kind: 'active-world-required' };

/**
 * Read the caller's airline without turning the expected pre-founding state
 * into an error. Ambiguous multi-world state is still refused rather than
 * choosing an airline the player did not select (ADR-0010).
 */
export async function readOwnAirline(
  db: Database,
  playerId: string,
  activeWorldId: string | undefined,
): Promise<ReadOwnAirlineResult> {
  const resolved = await resolvePlayerAirline(db, playerId, activeWorldId);
  if (resolved.kind === 'airline-required') {
    return { kind: 'found', response: { airline: null, rebrand: null } };
  }
  if (resolved.kind === 'active-world-required') return resolved;

  const rows = await db
    .select({ row: airline, economyConfigVersion: world.economyConfigVersion })
    .from(airline)
    .innerJoin(world, eq(world.id, airline.worldId))
    .where(eq(airline.id, resolved.airline.id))
    .limit(1);
  const own = rows[0];
  if (!own) {
    // A reset may remove the row between resolution and this read. That is the
    // same normal state as not having founded yet.
    return { kind: 'found', response: { airline: null, rebrand: null } };
  }

  return {
    kind: 'found',
    response: {
      airline: wireAirline(own.row),
      rebrand: rebrandTerms(own.economyConfigVersion),
    },
  };
}

export type UpdateOwnAirlineResult =
  | {
      ok: true;
      changed: boolean;
      chargedMinor: number;
      identityChangeId: string | null;
      airline: AirlineContract;
    }
  | {
      ok: false;
      kind: 'identity-refused';
      field: ModeratedAirlineIdentityField;
      reason: string;
    };

/**
 * Apply one paid ordinary-player rebrand (§15).
 *
 * Scarce designators never enter this input; AIR-09 owns lifecycle and release.
 * Cash and reputation likewise have their own authoritative systems. The event,
 * identity update and immutable AIR-06 movement commit together or not at all.
 */
export async function updateOwnAirline(
  db: Database,
  own: ResolvedPlayerAirline,
  input: UpdateOwnAirlineInput,
  realNow: Date,
  dependencies: AirlineIdentityModerationDependencies = {},
): Promise<UpdateOwnAirlineResult> {
  const moderation = await moderateAirlineIdentity(
    { name: input.name, callsign: input.callsign },
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

  return db.transaction(async (tx): Promise<UpdateOwnAirlineResult> => {
    const rows = await tx
      .select({ row: airline, world })
      .from(airline)
      .innerJoin(world, eq(world.id, airline.worldId))
      .where(and(eq(airline.id, own.id), eq(airline.worldId, own.worldId)))
      .limit(1)
      .for('update');
    const current = rows[0];
    if (!current) throw new Error(`Resolved airline ${own.id} vanished during its rebrand`);

    const changed =
      current.row.name !== input.name ||
      current.row.callsign !== input.callsign ||
      current.row.baseCountry !== input.baseCountry;
    if (!changed) {
      return {
        ok: true,
        changed: false,
        chargedMinor: 0,
        identityChangeId: null,
        airline: wireAirline(current.row),
      };
    }

    const terms = rebrandTerms(current.world.economyConfigVersion);
    const occurredAt = gameTime(
      {
        epoch: current.world.epoch,
        launchDate: current.world.launchDate,
        speedMultiplier: Number(current.world.speedMultiplier),
      },
      realNow,
    );

    const changes = await tx
      .insert(airlineIdentityChange)
      .values({
        airlineId: current.row.id,
        beforeName: current.row.name,
        afterName: input.name,
        beforeCallsign: current.row.callsign,
        afterCallsign: input.callsign,
        beforeBaseCountry: current.row.baseCountry,
        afterBaseCountry: input.baseCountry,
        costMinor: terms.costMinor,
        occurredAt,
      })
      .returning();
    const identityChange = changes[0];
    if (!identityChange) throw new Error(`Could not record rebrand event for ${current.row.id}`);

    const updatedRows = await tx
      .update(airline)
      .set({ name: input.name, callsign: input.callsign, baseCountry: input.baseCountry })
      .where(eq(airline.id, current.row.id))
      .returning();
    const updated = updatedRows[0];
    if (!updated) throw new Error(`Airline ${current.row.id} vanished mid-rebrand`);

    const movement = await moveAirlineCash(tx, {
      airlineId: current.row.id,
      amountMinor: -terms.costMinor,
      cause: 'airline_rebrand',
      reference: identityChange.id,
      occurredAt,
    });
    if (movement.status !== 'applied') {
      throw new Error(`New identity event ${identityChange.id} replayed its cash movement`);
    }

    return {
      ok: true,
      changed: true,
      chargedMinor: terms.costMinor,
      identityChangeId: identityChange.id,
      airline: wireAirline({ ...updated, cashMinor: movement.movement.balanceAfterMinor }),
    };
  });
}
