/**
 * Local ↔ absolute schedule minutes (M3-04a, §8.2).
 *
 * A `schedule_leg.departure_minute` is an **absolute** minute from the cycle
 * anchor, which materialisation places against 00:00 **UTC** — so it is, in
 * effect, minutes-from-UTC-midnight. A player, though, authors and reads a
 * departure in the **local** time of the airport it leaves from. This module is
 * the one place that reconciles the two, using `airport.utc_offset_minutes`
 * (standard time, no DST — the offset the schedule was fixed against).
 *
 * Getting this right is what makes "08:00 at JFK" actually depart at 08:00 in New
 * York and be sized by demand's `SchedFit` curve at 08:00 local, rather than at
 * 08:00 UTC as it was before this existed. It is deliberately small and pure so
 * every boundary — authoring in, the schedule and fleet reads out, the slot band
 * — converts the same way.
 */

import { inArray } from 'drizzle-orm';

import { airport } from '../db/schema';

import type { Database } from '../db/client';

const MINUTES_PER_DAY = 1_440;

/** Fold any minute into a single day, `[0, 1440)`. */
export function minuteOfDay(minute: number): number {
  return ((minute % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

/**
 * The absolute (UTC-anchor) minute-of-day a local time maps to.
 *
 * `local − offset`: an 08:00 departure at UTC−5 is 13:00 UTC, so its absolute
 * minute is `480 − (−300) = 780`. Folded into a day, because the anchor is a
 * day's midnight and a leg's own minute is a minute of that day.
 */
export function absoluteFromLocal(localMinute: number, offsetMinutes: number): number {
  return minuteOfDay(localMinute - offsetMinutes);
}

/** The local minute-of-day an absolute minute reads at an airport `offset` from UTC. */
export function localFromAbsolute(absoluteMinute: number, offsetMinutes: number): number {
  return minuteOfDay(absoluteMinute + offsetMinutes);
}

/**
 * Each airport's standard UTC offset in minutes, keyed by ICAO.
 *
 * A missing airport or a null offset resolves to **0** at the call site rather
 * than here — an airport whose timezone never resolved is treated as UTC, which
 * is the same permissive default the crew duty code takes, and keeps a schedule
 * authorable at a field the timezone importer has not reached.
 */
export async function loadAirportOffsets(
  db: Database,
  icaos: readonly string[],
): Promise<Map<string, number>> {
  const distinct = [...new Set(icaos)];
  if (distinct.length === 0) return new Map();

  const rows = await db
    .select({ icao: airport.icaoCode, offset: airport.utcOffsetMinutes })
    .from(airport)
    .where(inArray(airport.icaoCode, distinct));

  const offsets = new Map<string, number>();
  for (const row of rows) {
    if (row.icao !== null && row.offset !== null) offsets.set(row.icao, row.offset);
  }
  return offsets;
}
