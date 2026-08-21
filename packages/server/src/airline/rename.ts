import { eq } from 'drizzle-orm';

import { type Airline as AirlineContract, type ForceRenameAirlineInput } from '@tailfin/shared';

import { writeAudit } from '../admin/audit';
import { type Actor } from '../admin/grants';
import { type Database } from '../db/client';
import { airline } from '../db/schema';

import {
  moderateAirlineIdentity,
  type AirlineIdentityModerationDependencies,
  type ModeratedAirlineIdentityField,
} from './moderation';
import { wireAirline } from './wire';

export type ForceRenameAirlineResult =
  | { ok: true; changed: boolean; airline: AirlineContract }
  | { ok: false; kind: 'airline-not-found'; airlineId: string }
  | {
      ok: false;
      kind: 'identity-refused';
      field: ModeratedAirlineIdentityField;
      reason: string;
    };

/**
 * Apply a moderation rename without replacing the airline (AIR-02).
 *
 * The stable airline UUID is what schedules, flights and financial history
 * reference, so those rows survive untouched and resolve to the new current
 * identity. The append-only admin audit row is the historical record of the
 * old label, the new label, who changed it and why.
 *
 * This is the moderation remedy, not AIR-08's player rebrand flow: codes stay
 * allocated and the unresolved player-facing rebrand cost is not bypassed.
 */
export async function forceRenameAirline(
  db: Database,
  airlineId: string,
  input: ForceRenameAirlineInput,
  actor: Actor,
  dependencies: AirlineIdentityModerationDependencies = {},
): Promise<ForceRenameAirlineResult> {
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

  return db.transaction(async (tx): Promise<ForceRenameAirlineResult> => {
    const rows = await tx.select().from(airline).where(eq(airline.id, airlineId)).for('update');
    const before = rows[0];
    if (!before) return { ok: false, kind: 'airline-not-found', airlineId };

    if (before.name === input.name && before.callsign === input.callsign) {
      return { ok: true, changed: false, airline: wireAirline(before) };
    }

    const updatedRows = await tx
      .update(airline)
      .set({ name: input.name, callsign: input.callsign })
      .where(eq(airline.id, airlineId))
      .returning();
    const updated = updatedRows[0];
    if (!updated) throw new Error(`Airline ${airlineId} vanished mid-rename`);

    await writeAudit(tx, {
      actorPlayerId: actor.playerId,
      actorLabel: actor.label,
      action: 'airline.identity_changed',
      subjectType: 'airline',
      subjectId: airlineId,
      before: {
        name: before.name,
        callsign: before.callsign,
        iataCode: before.iataCode,
        icaoCode: before.icaoCode,
      },
      after: {
        name: updated.name,
        callsign: updated.callsign,
        iataCode: updated.iataCode,
        icaoCode: updated.icaoCode,
        reason: input.reason.trim(),
      },
      requestId: actor.requestId,
    });

    return { ok: true, changed: true, airline: wireAirline(updated) };
  });
}
