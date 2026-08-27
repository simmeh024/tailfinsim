import { eq } from 'drizzle-orm';

import { socialMediaSpecialistEffect } from '@tailfin/shared';

import { previousMonth } from '../crew/payroll';
import { airline, officeHire, socialMediaReputationGrant } from '../db/schema';
import { loadWorldEconomyConfig } from '../economy/loader';

import type { Database } from '../db/client';

/**
 * The monthly reputation drip from a hired social media specialist (§9.1, §15).
 *
 * The reputation specialist (`social-media-reputation`) earns her keep slowly:
 * `socialMedia.reputationPerMonth` is added to `airline.reputation` once per
 * game month she is on staff, clamped at §15's 1.00 ceiling. It is deliberately
 * tiny — reputation is a compound the whole demand model reads, so this is a
 * nudge over seasons rather than a lever.
 *
 * ## Why it is a sweep, and monthly
 *
 * Reputation is stored state, so something has to move it, and that something
 * runs on the worker against the world's game clock like every other §9 process
 * (ADR-0019). **Production has no worker**, so there an airline paying a
 * specialist would see nothing move at all — the same missing-process trap the
 * crew sweeps carry, and `reputationGrants` is the counter that tells it apart
 * from an airline that simply has no specialist.
 *
 * ## Idempotent by construction, not by a remembered date
 *
 * The engine ticks every second; without a guard this would apply a month's
 * drip sixty times a minute. The guard is `social_media_reputation_grant`: one
 * row per `(airline, period)`, inserted `ON CONFLICT DO NOTHING` in the same
 * transaction as the bump, so a replay or a double tick grants nothing twice.
 * The airline row is taken `FOR UPDATE` first, so two racing workers serialise
 * rather than both drip. This is the used market's shape and the office
 * payroll's month accounting, kept for their reasons: no "last granted" column
 * for a world reset to have to clear (ADR-0005), and the closed month is retried
 * for as long as the next one lasts, so a worker down over a boundary catches up
 * when it returns.
 *
 * The amount stored is what was **actually** applied, which is zero once the
 * airline is already at the ceiling — an honest record rather than the nominal
 * rate, so the audit never claims a point that the clamp swallowed.
 */

export interface ReputationReviewResult {
  /** Airlines whose reputation was dripped this run. Zero on all but the first tick of a month. */
  airlinesGranted: number;
  /** Total reputation actually applied across them, on the 0.00–1.00 scale. */
  totalApplied: number;
}

/** Round to reputation's two-decimal grid, so nothing drifts off `numeric(3,2)`. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export async function reviewSocialMediaReputation(
  db: Database,
  worldId: string,
  gameNow: Date,
): Promise<ReputationReviewResult> {
  const period = previousMonth(gameNow);
  const economy = await loadWorldEconomyConfig(db, worldId);
  const amount = economy.socialMedia.reputationPerMonth;
  if (amount <= 0) return { airlinesGranted: 0, totalApplied: 0 };

  // Every hire in the world in one query, filtered to the reputation specialist
  // by candidate id — the effect travels with the person, not the seat.
  const hires = await db
    .select({ airlineId: officeHire.airlineId, candidateId: officeHire.candidateId })
    .from(officeHire)
    .where(eq(officeHire.worldId, worldId));

  const airlineIds = [
    ...new Set(
      hires
        .filter((row) => socialMediaSpecialistEffect(row.candidateId) === 'reputation')
        .map((row) => row.airlineId),
    ),
  ];
  if (airlineIds.length === 0) return { airlinesGranted: 0, totalApplied: 0 };

  let airlinesGranted = 0;
  let totalApplied = 0;

  for (const airlineId of airlineIds) {
    const outcome = await db.transaction(async (tx) => {
      const [current] = await tx
        .select({ reputation: airline.reputation })
        .from(airline)
        .where(eq(airline.id, airlineId))
        .limit(1)
        .for('update');
      if (!current) return { claimed: false, delta: 0 };

      const before = Number.parseFloat(current.reputation);
      const after = round2(Math.min(1, before + amount));
      const delta = round2(after - before);

      // The claim. A no-op on replay: the second insert conflicts and returns
      // nothing, so the bump below never runs a second time.
      const claimed = await tx
        .insert(socialMediaReputationGrant)
        .values({ worldId, airlineId, period, amount: delta.toFixed(2) })
        .onConflictDoNothing({
          target: [socialMediaReputationGrant.airlineId, socialMediaReputationGrant.period],
        })
        .returning({ id: socialMediaReputationGrant.id });
      if (claimed.length === 0) return { claimed: false, delta: 0 };

      // A fresh claim at the ceiling still marks the month done; it just applies
      // nothing, which is what the recorded amount of 0.00 says.
      if (delta > 0) {
        await tx
          .update(airline)
          .set({ reputation: after.toFixed(2) })
          .where(eq(airline.id, airlineId));
      }
      return { claimed: true, delta };
    });

    if (outcome.claimed) {
      airlinesGranted += 1;
      totalApplied += outcome.delta;
    }
  }

  return { airlinesGranted, totalApplied };
}
