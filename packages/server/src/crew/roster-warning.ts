import { eq, inArray } from 'drizzle-orm';

import { checkRotationDuty, type DutyLeg } from '@tailfin/sim';

import { airport, crewBase } from '../db/schema';
import { loadWorldEconomyConfig } from '../economy/loader';

import type { Database } from '../db/client';

/**
 * The duty warning a player gets when they save a schedule (M5-02).
 *
 * ## Why a warning and not a refusal
 *
 * M5-02's fourth acceptance criterion asks for exactly this split: legality is
 * *"checked at schedule-save time as a warning and at departure as a hard
 * rule"*. It is a good split, and worth stating why rather than only obeying it.
 *
 * A saved rotation is a **plan**, and a plan that would break a duty limit if
 * every leg ran exactly to time is not a lie — airlines roster right up to the
 * line, and the whole texture of §9.2 is that the line is where the interesting
 * decisions live. Refusing it would make the game quietly conservative on the
 * player's behalf and remove the trade. What the player needs is to *know*, once,
 * at the moment they can still change it.
 *
 * At departure the same rotation is no longer a plan, it is an aeroplane with
 * people on it, and there the rule is absolute.
 *
 * ## This is not M5-01's check
 *
 * `crewIllegality` refuses a rotation the airline has **no complement for at
 * all** — it has not hired the crew. That stays a refusal, because it is not a
 * risk the player is taking, it is a schedule that can never run. This one is
 * about whether the crew they *do* have can legally be worked that hard.
 */

export interface DutyWarning {
  /** `tight` is one delay from illegal; `illegal` would break a limit as planned. */
  severity: 'tight' | 'illegal';
  /** One sentence, naming the leg and the numbers. */
  detail: string;
  /** 1-based, for a message a player reads. */
  leg: number;
}

export interface WarningLeg {
  originIcao: string;
  destinationIcao: string;
  /** Minutes past midnight, as `schedule_leg` stores it. */
  departureMinute: number;
  blockMinutes: number;
  turnaroundMinutes: number;
}

/**
 * What a rotation's duty looks like on a representative day.
 *
 * The rotation repeats, so *which* day is arbitrary; what matters is the shape,
 * and the shape is the same every time it runs. A fixed reference date keeps the
 * answer deterministic — a warning that appears on Tuesdays and not Wednesdays
 * would be worse than no warning at all.
 */
export async function dutyWarningFor(
  db: Database,
  input: {
    worldId: string;
    airlineId: string;
    airframeId: string;
    legs: readonly WarningLeg[];
  },
): Promise<DutyWarning | null> {
  if (input.legs.length === 0) return null;

  const bases = await db
    .select({ airportIcao: crewBase.airportIcao })
    .from(crewBase)
    .where(eq(crewBase.airlineId, input.airlineId));
  const baseIcao = bases[0]?.airportIcao;
  // No base is M5-01's refusal to make, not this one's. Warning about duty for
  // crew that do not exist would bury the real problem under a second message.
  if (baseIcao === undefined) return null;

  const [economy, offsets] = await Promise.all([
    loadWorldEconomyConfig(db, input.worldId),
    airportOffsets(db, [baseIcao, ...input.legs.map((leg) => leg.originIcao)]),
  ]);

  const result = checkRotationDuty(toDutyLegs(input.legs), {
    baseIcao,
    utcOffsetMinutes: offsets,
    duty: economy.crew.duty,
  });

  const worst = result.legs.find((entry) => entry.verdict.status === 'illegal');
  const tight = result.legs.find((entry) => entry.verdict.status === 'tight');
  const found = worst ?? tight;
  if (!found || found.verdict.status === 'legal') return null;

  return {
    severity: found.verdict.status,
    detail: `Leg ${String(found.leg + 1)}: ${found.verdict.reason}`,
    leg: found.leg + 1,
  };
}

/**
 * Lay the rotation out on a reference day.
 *
 * `departureMinute` is minutes past midnight and legs after the first follow
 * their predecessor's arrival plus its turnaround — which is how the rotation
 * actually runs, and is why a `departureMinute` that contradicts the turnaround
 * cannot make a day look shorter than it is. A leg that lands after midnight
 * rolls onto the next day rather than wrapping to hour zero, because a duty
 * period does not restart when the date does.
 */
function toDutyLegs(legs: readonly WarningLeg[]): DutyLeg[] {
  const REFERENCE = Date.UTC(2026, 2, 10);
  const first = legs[0];
  if (!first) return [];

  const out: DutyLeg[] = [];
  let departure = REFERENCE + first.departureMinute * 60_000;

  for (const leg of legs) {
    const arrival = departure + leg.blockMinutes * 60_000;
    out.push({
      departure: new Date(departure),
      arrival: new Date(arrival),
      originIcao: leg.originIcao,
      destinationIcao: leg.destinationIcao,
    });
    departure = arrival + leg.turnaroundMinutes * 60_000;
  }
  return out;
}

async function airportOffsets(
  db: Database,
  icaos: readonly string[],
): Promise<Record<string, number>> {
  const unique = [...new Set(icaos)];
  if (unique.length === 0) return {};

  const rows = await db
    .select({ icaoCode: airport.icaoCode, utcOffsetMinutes: airport.utcOffsetMinutes })
    .from(airport)
    .where(inArray(airport.icaoCode, unique));

  const out: Record<string, number> = {};
  for (const row of rows) {
    // Both halves can be absent. `icao_code` is nullable on `airport` and the
    // offset is null wherever timezone resolution fell through; an airport with
    // neither simply does not appear, and `checkRotationDuty` reports it as an
    // assumption rather than guessing at one.
    if (row.icaoCode !== null && row.utcOffsetMinutes !== null) {
      out[row.icaoCode] = row.utcOffsetMinutes;
    }
  }
  return out;
}
