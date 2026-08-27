import { and, asc, eq } from 'drizzle-orm';

import {
  EXTENDED_AUTHORITY_ROLE,
  isNeutralSeat,
  isSocialMediaSpecialistId,
  nextExpansionTier,
  OFFICE_ROLES,
  offeredSocialMediaSpecialistId,
  unlockedNeutralSeats,
  type HireOfficeRequest,
  type OfficeHire,
  type OfficeRole,
  type OfficeSeatId,
  type OfficeStateResponse,
} from '@tailfin/shared';

import { officeExpansion, officeHire } from '../db/schema';

import type { ResolvedPlayerAirline } from '../airline/context';
import type { Database } from '../db/client';

/**
 * Office hires (M5-04, §9.1).
 *
 * Every read and write is scoped to the airline resolved from the session
 * (AIR-05, SEC-05): the airline id is never accepted from the client, so a
 * request can only ever reach its own office. There is no state in which a
 * player could hire into, or read, a competitor's seat.
 *
 * A hire's `seat` is where the person sits — one of the six roles, or a neutral
 * expansion seat. The salary is the candidate's *role* salary, snapshotted onto
 * the row. A neutral seat grants no capability: only the real Safety & Compliance
 * seat unlocks extended authority, so a duplicate cannot smuggle the unlock in.
 */

function toWire(row: {
  role: string;
  candidateId: string;
  candidateName: string;
  monthlySalaryMinor: number;
  hiredAt: Date;
}): OfficeHire {
  return {
    seat: row.role as OfficeSeatId,
    candidateId: row.candidateId,
    candidateName: row.candidateName,
    monthlySalaryMinor: row.monthlySalaryMinor,
    hiredAt: row.hiredAt.toISOString(),
  };
}

/** Neutral expansion seats this airline has unlocked (0 when it has never expanded). */
export async function readNeutralSeats(db: Database, airlineId: string): Promise<number> {
  const [row] = await db
    .select({ neutralSeats: officeExpansion.neutralSeats })
    .from(officeExpansion)
    .where(eq(officeExpansion.airlineId, airlineId))
    .limit(1);
  return row?.neutralSeats ?? 0;
}

/** Every seat this airline has filled, its authority standing, and its expansion offer. */
export async function readOfficeState(
  db: Database,
  own: ResolvedPlayerAirline,
): Promise<OfficeStateResponse> {
  const [rows, neutralSeats] = await Promise.all([
    db
      .select({
        role: officeHire.role,
        candidateId: officeHire.candidateId,
        candidateName: officeHire.candidateName,
        monthlySalaryMinor: officeHire.monthlySalaryMinor,
        hiredAt: officeHire.hiredAt,
      })
      .from(officeHire)
      .where(eq(officeHire.airlineId, own.id))
      .orderBy(asc(officeHire.role)),
    readNeutralSeats(db, own.id),
  ]);

  const hires = rows.map(toWire);
  const tier = nextExpansionTier(neutralSeats);
  return {
    hires,
    // Only the real gate seat unlocks authority — never a neutral seat.
    hasExtendedAuthority: hires.some((hire) => hire.seat === EXTENDED_AUTHORITY_ROLE),
    neutralSeats,
    nextExpansion:
      tier === null
        ? null
        : {
            addsSeats: tier.neutralSeats - neutralSeats,
            totalSeats: tier.totalSeats,
            costMinor: tier.costMinor,
          },
    // The world decides which of the two specialists is on the market, so every
    // reader agrees without coordinating.
    offeredSpecialist: offeredSocialMediaSpecialistId(own.worldId),
  };
}

export type HireOfficeResult =
  | { ok: true; hire: OfficeHire }
  | {
      ok: false;
      code:
        | 'unknown_role'
        | 'role_mismatch'
        | 'seat_locked'
        | 'already_seated'
        | 'specialist_unavailable';
    };

/**
 * Hire a candidate into a seat, replacing any incumbent.
 *
 * The salary is the candidate's role salary, taken from the shared catalogue and
 * **snapshotted** onto the row — a later retune does not silently re-price a
 * standing hire. The candidate id and name are opaque: the server does not
 * validate them against a market, because the market is the client's for now.
 *
 * The seat is checked, not the candidate: a role seat must match the candidate's
 * role, and a neutral seat must already be unlocked by expansion. One seat, one
 * person — the `(airline_id, role)` unique index makes hiring a rival an upsert,
 * so this cannot stack two people in a seat even under a race.
 */
export async function hireOffice(
  db: Database,
  own: ResolvedPlayerAirline,
  request: HireOfficeRequest,
): Promise<HireOfficeResult> {
  const definition = OFFICE_ROLES[request.candidateRole] as
    (typeof OFFICE_ROLES)[OfficeRole] | undefined;
  if (definition === undefined) return { ok: false, code: 'unknown_role' };

  if (isNeutralSeat(request.seat)) {
    const neutralSeats = await readNeutralSeats(db, own.id);
    if (!unlockedNeutralSeats(neutralSeats).includes(request.seat)) {
      return { ok: false, code: 'seat_locked' };
    }
  } else if (request.seat !== request.candidateRole) {
    return { ok: false, code: 'role_mismatch' };
  }

  // A social media specialist may only be the one this world puts on the market.
  // The seat rules above already keep any specialist out of a role seat (its
  // role is `social-media`, which is not a seat), so this is the only extra gate:
  // you get the world's specialist, or none. Combined with one-person-one-office
  // below, that means at most one specialist is ever employed.
  if (
    isSocialMediaSpecialistId(request.candidateId) &&
    request.candidateId !== offeredSocialMediaSpecialistId(own.worldId)
  ) {
    return { ok: false, code: 'specialist_unavailable' };
  }

  // One person, one office. The neutral seats made it possible to sit the same
  // candidate in several rooms at once; a face cannot be in two rooms, so a
  // candidate already holding another seat for this airline is refused. Re-hiring
  // into the same seat is still an upsert, so this only guards a genuine double.
  const [elsewhere] = await db
    .select({ role: officeHire.role })
    .from(officeHire)
    .where(and(eq(officeHire.airlineId, own.id), eq(officeHire.candidateId, request.candidateId)))
    .limit(1);
  if (elsewhere !== undefined && elsewhere.role !== request.seat) {
    return { ok: false, code: 'already_seated' };
  }

  const [row] = await db
    .insert(officeHire)
    .values({
      worldId: own.worldId,
      airlineId: own.id,
      role: request.seat,
      candidateId: request.candidateId,
      candidateName: request.candidateName,
      monthlySalaryMinor: definition.monthlySalaryMinor,
    })
    .onConflictDoUpdate({
      target: [officeHire.airlineId, officeHire.role],
      set: {
        candidateId: request.candidateId,
        candidateName: request.candidateName,
        monthlySalaryMinor: definition.monthlySalaryMinor,
        hiredAt: new Date(),
      },
    })
    .returning({
      role: officeHire.role,
      candidateId: officeHire.candidateId,
      candidateName: officeHire.candidateName,
      monthlySalaryMinor: officeHire.monthlySalaryMinor,
      hiredAt: officeHire.hiredAt,
    });

  if (!row) throw new Error(`Office hire for ${own.id} returned no row`);
  return { ok: true, hire: toWire(row) };
}

/** Empty a seat. Idempotent: dismissing a vacant seat is a no-op, not an error. */
export async function dismissOffice(
  db: Database,
  own: ResolvedPlayerAirline,
  seat: OfficeSeatId,
): Promise<{ dismissed: boolean }> {
  const removed = await db
    .delete(officeHire)
    .where(and(eq(officeHire.airlineId, own.id), eq(officeHire.role, seat)))
    .returning({ id: officeHire.id });
  return { dismissed: removed.length > 0 };
}
