import { and, eq } from 'drizzle-orm';

import { EXTENDED_AUTHORITY_ROLE, LONG_HAUL_THRESHOLD_NM } from '@tailfin/shared';

import { officeHire } from '../db/schema';

import type { Database } from '../db/client';

/**
 * Extended operating authority (M5-04, §9.1).
 *
 * The one office hire that changes what the **simulation** will permit. §9.1:
 * Safety & Compliance is *"required for long-haul/ETOPS authority and
 * international rights"*, and M5-04's first acceptance criterion is that
 * long-haul authority is unreachable without that hire. This is where that is
 * decided — not as a percentage on a number, but as a capability a route either
 * has or does not.
 */

/** A route needs extended authority if it leaves the country, or if it is long-haul. */
export function requiresExtendedAuthority(input: {
  originCountry: string;
  destinationCountry: string;
  greatCircleNm: number;
}): boolean {
  const international = input.originCountry !== input.destinationCountry;
  const longHaul = input.greatCircleNm >= LONG_HAUL_THRESHOLD_NM;
  return international || longHaul;
}

/**
 * Whether this airline holds the Safety & Compliance seat.
 *
 * Scoped to the airline, so the answer is that airline's office and no other's.
 * A single indexed existence check rather than loading the office.
 */
export async function hasExtendedAuthority(db: Database, airlineId: string): Promise<boolean> {
  const rows = await db
    .select({ id: officeHire.id })
    .from(officeHire)
    .where(and(eq(officeHire.airlineId, airlineId), eq(officeHire.role, EXTENDED_AUTHORITY_ROLE)))
    .limit(1);
  return rows.length > 0;
}
