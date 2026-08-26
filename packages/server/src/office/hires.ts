import { and, asc, eq } from 'drizzle-orm';

import {
  OFFICE_ROLES,
  roleGatesExtendedAuthority,
  type HireOfficeRequest,
  type OfficeHire,
  type OfficeRole,
  type OfficeStateResponse,
} from '@tailfin/shared';

import { officeHire } from '../db/schema';

import type { ResolvedPlayerAirline } from '../airline/context';
import type { Database } from '../db/client';

/**
 * Office hires (M5-04, §9.1).
 *
 * Every read and write is scoped to the airline resolved from the session
 * (AIR-05, SEC-05): the airline id is never accepted from the client, so a
 * request can only ever reach its own office. There is no state in which a
 * player could hire into, or read, a competitor's seat.
 */

function toWire(row: {
  role: string;
  candidateId: string;
  candidateName: string;
  monthlySalaryMinor: number;
  hiredAt: Date;
}): OfficeHire {
  return {
    role: row.role as OfficeRole,
    candidateId: row.candidateId,
    candidateName: row.candidateName,
    monthlySalaryMinor: row.monthlySalaryMinor,
    hiredAt: row.hiredAt.toISOString(),
  };
}

/** Every seat this airline has filled, and whether that unlocks extended authority. */
export async function readOfficeState(
  db: Database,
  own: ResolvedPlayerAirline,
): Promise<OfficeStateResponse> {
  const rows = await db
    .select({
      role: officeHire.role,
      candidateId: officeHire.candidateId,
      candidateName: officeHire.candidateName,
      monthlySalaryMinor: officeHire.monthlySalaryMinor,
      hiredAt: officeHire.hiredAt,
    })
    .from(officeHire)
    .where(eq(officeHire.airlineId, own.id))
    .orderBy(asc(officeHire.role));

  const hires = rows.map(toWire);
  return {
    hires,
    hasExtendedAuthority: hires.some((hire) => roleGatesExtendedAuthority(hire.role)),
  };
}

export type HireOfficeResult = { ok: true; hire: OfficeHire } | { ok: false; code: 'unknown_role' };

/**
 * Hire a candidate into a seat, replacing any incumbent.
 *
 * The salary is the seat's, taken from the shared role catalogue and
 * **snapshotted** onto the row — a later retune of the catalogue does not
 * silently re-price a standing hire, exactly as an acquisition pins its
 * commercial terms. The candidate id and name are opaque: the server does not
 * validate them against a market, because the market is the client's for now.
 *
 * One seat, one person: the `(airline_id, role)` unique index makes hiring a
 * rival an upsert, so this cannot stack two people in a seat even under a race.
 */
export async function hireOffice(
  db: Database,
  own: ResolvedPlayerAirline,
  request: HireOfficeRequest,
): Promise<HireOfficeResult> {
  const definition = OFFICE_ROLES[request.role] as (typeof OFFICE_ROLES)[OfficeRole] | undefined;
  if (definition === undefined) return { ok: false, code: 'unknown_role' };

  const [row] = await db
    .insert(officeHire)
    .values({
      worldId: own.worldId,
      airlineId: own.id,
      role: request.role,
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
  role: OfficeRole,
): Promise<{ dismissed: boolean }> {
  const removed = await db
    .delete(officeHire)
    .where(and(eq(officeHire.airlineId, own.id), eq(officeHire.role, role)))
    .returning({ id: officeHire.id });
  return { dismissed: removed.length > 0 };
}
