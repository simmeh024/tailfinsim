import { and, asc, eq } from 'drizzle-orm';

import {
  EXTENDED_AUTHORITY_ROLE,
  isNeutralSeat,
  isSocialMediaSpecialistId,
  nextExpansionTier,
  officeCandidate,
  offeredSocialMediaSpecialistId,
  unlockedNeutralSeats,
  type HireOfficeRequest,
  type OfficeHire,
  type OfficeSeatId,
  type OfficeStateResponse,
} from '@tailfin/shared';

import { officeExpansion, officeHire } from '../db/schema';
import { worldGameNow } from '../world/game-now';

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
        | 'unknown_candidate'
        | 'role_mismatch'
        | 'seat_locked'
        | 'already_seated'
        | 'specialist_unavailable';
    };

/**
 * Hire a candidate into a seat, replacing any incumbent.
 *
 * The candidate is resolved from the shared `OFFICE_CANDIDATES` market by id, so
 * its **salary and name come from the catalogue, not the request** — a player
 * cannot hire a Director at an Analyst's rate, and an unknown id is refused. The
 * pay is **snapshotted** onto the row, so a later catalogue change does not
 * silently re-price a standing hire.
 *
 * A role seat must match the candidate's own role; a neutral seat takes anyone but
 * must already be unlocked by expansion. One seat, one person — the
 * `(airline_id, role)` unique index makes hiring a rival an upsert, so this cannot
 * stack two people in a seat even under a race.
 */
export async function hireOffice(
  db: Database,
  own: ResolvedPlayerAirline,
  request: HireOfficeRequest,
): Promise<HireOfficeResult> {
  // The candidate is resolved from the shared catalogue by id, and everything
  // billable — the salary, and the role the seat is checked against — comes from
  // there rather than from the request. A client cannot name its own price or
  // claim a cheaper role: an id that is not in the market is refused outright.
  const candidate = officeCandidate(request.candidateId);
  if (candidate === undefined) return { ok: false, code: 'unknown_candidate' };

  if (isNeutralSeat(request.seat)) {
    const neutralSeats = await readNeutralSeats(db, own.id);
    if (!unlockedNeutralSeats(neutralSeats).includes(request.seat)) {
      return { ok: false, code: 'seat_locked' };
    }
  } else if (request.seat !== candidate.role) {
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

  // The hire date is the world's, not the wall clock's (TIME-02): the salary it
  // snapshots is per *game* month, and the Office page shows the two together.
  // Passed explicitly on the insert as well as the upsert, so the column's
  // `defaultNow()` -- a wall-clock fallback -- is never the value that lands.
  const gameNow = await worldGameNow(db, own.worldId);

  const [row] = await db
    .insert(officeHire)
    .values({
      worldId: own.worldId,
      airlineId: own.id,
      role: request.seat,
      candidateId: request.candidateId,
      candidateName: candidate.name,
      monthlySalaryMinor: candidate.monthlySalaryMinor,
      hiredAt: gameNow,
    })
    .onConflictDoUpdate({
      target: [officeHire.airlineId, officeHire.role],
      set: {
        candidateId: request.candidateId,
        candidateName: candidate.name,
        monthlySalaryMinor: candidate.monthlySalaryMinor,
        hiredAt: gameNow,
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
