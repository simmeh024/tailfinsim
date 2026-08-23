import { eq } from 'drizzle-orm';

import { checkComplement } from '@tailfin/sim';

import { airframe, aircraftType } from '../db/schema';
import { loadWorldEconomyConfig } from '../economy/loader';

import { readAirlinePools } from './store';

import type { Database } from '../db/client';

/**
 * Whether an airline's crew can legally fly a rotation (M5-01, §9.2).
 *
 * ## Why this is checked where the schedule is written
 *
 * The acceptance criterion says *"every flight validates a legal complement
 * before departure"*, and today nothing departs — `FLIGHT_DEPART` has no handler
 * (SCALE-05). The moment a flight comes into existence is `createSchedule`, so
 * that is where the rule goes. It is checked against the database rather than
 * inside `validateRotation` for the same reason `airframeUnavailability` is: the
 * pools are rows, and the rotation rules are pure.
 *
 * It is still reported as `crew_illegal`, a `RotationProblem`, because to the
 * player that is exactly what it is — the schedule cannot run for a reason about
 * the crew, like `not_positioned` is one about the aeroplane.
 *
 * ## What it does not know yet
 *
 * Nothing about **duty, rest or positioning**. §9.2 calls those the flagship crew
 * mechanic and they are not M5-01, so this answers a narrower question: does the
 * airline hold enough crew, at the right ranks, rated on this aeroplane's family,
 * to staff its longest leg. An airline that passes this can still be building a
 * rotation no real crew could fly, and the field in `validateRotation` is
 * deliberately named `crewLegal` so that when duty limits arrive they tighten
 * this rather than needing a new one.
 *
 * ## Why the longest leg
 *
 * Relief crew are decided by block time, so a rotation's requirement is set by
 * its longest sector. Checking each leg separately would ask the same question
 * repeatedly and answer it most permissively on the shortest; checking the
 * longest asks it once, at the point where it binds.
 */

export interface CrewLegalityLeg {
  blockMinutes: number;
}

/** A sentence for the player, or `null` when the crew can fly it. */
export async function crewIllegality(
  db: Database,
  worldId: string,
  airlineId: string,
  airframeId: string,
  legs: readonly CrewLegalityLeg[],
): Promise<string | null> {
  if (legs.length === 0) return null;

  const frames = await db
    .select({
      catalogueVersion: airframe.catalogueVersion,
      typeDesignation: airframe.typeDesignation,
      effectiveSpec: airframe.effectiveSpec,
    })
    .from(airframe)
    .where(eq(airframe.id, airframeId))
    .limit(1);
  const frame = frames[0];
  // No airframe is not a crew problem. `createSchedule` has its own answer for
  // an aeroplane that is not there, and inventing one here would report the
  // wrong cause for it.
  if (!frame) return null;

  const types = await db
    .select({ family: aircraftType.family })
    .from(aircraftType)
    .where(eq(aircraftType.designation, frame.typeDesignation))
    .limit(1);
  const family = types[0]?.family;
  if (family === undefined) return null;

  const spec = JSON.parse(frame.effectiveSpec) as { seatsTwoClass?: number };
  const seats = spec.seatsTwoClass ?? 0;
  const blockMinutes = Math.max(...legs.map((leg) => leg.blockMinutes));

  const [pools, economy] = await Promise.all([
    readAirlinePools(db, airlineId),
    loadWorldEconomyConfig(db, worldId),
  ]);

  const check = checkComplement({ seats, blockMinutes }, pools, family, economy.crew.regulation);
  if (check.ok) return null;

  /*
   * Name the ranks and the numbers. A refusal that says only "the crew cannot
   * fly this" leaves the player to work out what to hire, and the whole reason
   * `checkComplement` reports every shortfall rather than the first is so this
   * sentence can be actionable in one reading.
   */
  const missing = check.shortfalls
    .map((short) => `${String(short.needed - short.available)} ${short.rank.replace(/_/g, ' ')}`)
    .join(', ');
  return `The airline has no legal crew complement for a ${family} on this rotation: short ${missing}.`;
}
