/**
 * Slot bands (M7-05, §"Slots").
 *
 * A coordinated airport's day is divided into hourly **bands**, and a slot is
 * held for one of them. This is the one piece of the slot model that is pure
 * arithmetic — which band a departure minute falls in — so it lives here, beside
 * `checkReachability`, whose seventh check is the slot gate. Everything about
 * *holding* a band (capacity, who holds what) is database state and lives in the
 * server.
 */

/** How many bands a day has — one per hour. */
export const SLOT_BANDS_PER_DAY = 24;

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 1_440;

/**
 * The band a local off-blocks minute falls in, 0–23.
 *
 * A rotation minute can run past midnight (a leg at 1,530 belongs to the next
 * morning), and it can be negative if a caller subtracts, so the minute is
 * folded into a single day before it is divided — the band is a property of the
 * clock time, not of which cycle the leg is counted in.
 */
export function bandOf(departureMinute: number): number {
  const withinDay = ((departureMinute % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return Math.floor(withinDay / MINUTES_PER_HOUR);
}
