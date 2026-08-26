import { eq } from 'drizzle-orm';

import {
  applicableOutcome,
  deriveRng,
  NO_RISK,
  rollDisruption,
  type DisruptionRoll,
} from '@tailfin/sim';

import { airframeTechnicalRisk } from '../aircraft/maintenance';
import { world } from '../db/schema';

import type { Database } from '../db/client';

/**
 * Whether a flight goes wrong on the ground, and how (M5-05, §8.4, §9.5).
 *
 * M2-08 built the whole disruption model — `rollDisruption`, the cause profiles,
 * the per-flight stream — and `depart.ts` said in as many words that *nothing
 * wired it*, because a departure gate that also decides the weather is two
 * mechanisms in one place. M5-05 wires it, and this is the ground half: the roll
 * a flight faces at the moment it tries to push back.
 *
 * ## One input today, and it is honest about that
 *
 * `DisruptionRisk` has seven severities. Only **technical** — how likely this
 * airframe is to break, from its maintenance condition — comes from a system that
 * exists, so it is the only one supplied; the rest stay 0 until weather (M2-09),
 * ATC (M7) and the ground handler (§9.3) land to fill them in. Crew timeout is a
 * hard rule at the dispatch gate, not a probability rolled here.
 *
 * ## Determinism, and why it is rolled before the crew are committed
 *
 * The stream is `deriveRng(worldSeed, 'disruption', flightId)` — the flight's
 * own, so two workers racing and a replay six months later all agree, and it does
 * not depend on how many flights preceded it. The roll runs **before** the
 * dispatch commit precisely so a cancellation does not strand a crew duty period
 * that was opened for a flight the disruption then killed.
 *
 * The caller rolls this **once** per flight — only while `flight.disruption` is
 * still null — so a delayed flight retried at its new time is not rolled again
 * against the same stream, which would reproduce the same delay for ever.
 */

/** The ground roll, made legal for a stand (delay or cancel), or null for a clean departure. */
export async function rollGroundDisruption(
  db: Database,
  input: { flightId: string; worldId: string; airframeId: string },
): Promise<DisruptionRoll | null> {
  const [worldRow] = await db
    .select({ seed: world.seed })
    .from(world)
    .where(eq(world.id, input.worldId))
    .limit(1);
  if (!worldRow) return null;

  const technical = await airframeTechnicalRisk(db, input.airframeId);
  const rng = deriveRng(worldRow.seed, 'disruption', input.flightId);
  const roll = rollDisruption(rng, { ...NO_RISK, technical });
  if (roll === null) return null;

  // On the stand: an air return or a diversion cannot happen to an aeroplane that
  // has not left, so `applicableOutcome` folds those back to a delay.
  return applicableOutcome(roll, false);
}
