import { eq } from 'drizzle-orm';

import { socialMediaSpecialistEffect } from '@tailfin/shared';

import { officeHire } from '../db/schema';

import type { Database } from '../db/client';

/**
 * Which social media specialist effects an airline currently has on staff.
 *
 * A specialist is identified by the candidate id on its `office_hire` row, not
 * by the seat — a neutral seat grants no capability of its own, so the effect
 * travels with the person, wherever they sit. `socialMediaSpecialistEffect`
 * maps the id back to its effect and returns null for an ordinary hire.
 *
 * Both flags are read together in one small query, because an airline holds at
 * most a handful of office rows and the two effects are always wanted at once —
 * the reputation sweep asks about one, the demand preview about the other, and
 * neither is worth a second round trip.
 */
export interface ActiveSocialMediaEffects {
  reputation: boolean;
  attractiveness: boolean;
}

export async function activeSocialMediaEffects(
  db: Database,
  airlineId: string,
): Promise<ActiveSocialMediaEffects> {
  const rows = await db
    .select({ candidateId: officeHire.candidateId })
    .from(officeHire)
    .where(eq(officeHire.airlineId, airlineId));

  let reputation = false;
  let attractiveness = false;
  for (const row of rows) {
    const effect = socialMediaSpecialistEffect(row.candidateId);
    if (effect === 'reputation') reputation = true;
    else if (effect === 'attractiveness') attractiveness = true;
  }

  return { reputation, attractiveness };
}
