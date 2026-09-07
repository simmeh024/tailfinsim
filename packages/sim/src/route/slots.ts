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

/* -- The two things that make a slot obtainable, or not (M7-05) -------------- */

/**
 * How contested an hour of the day is.
 *
 * A coordinated airport is not equally scarce for 24 hours; it is nearly
 * impossible at 08:00 and half empty at 03:00. App. B.5 states the intended
 * experience exactly — *"as a new entrant at LHR you get 05:40 and 23:10, and
 * nothing else"* — and a uniform capacity across the day cannot produce it,
 * because the only thing a newcomer could find would be nothing at all.
 */
export type SlotBandShape = 'peak' | 'shoulder' | 'off_peak';

/** Departure peaks: the morning wave out, and the evening wave out. */
const PEAK_BANDS = new Set([6, 7, 8, 9, 16, 17, 18, 19]);
/** The quiet end of the day, when a new entrant can still find room. */
const OFF_PEAK_BANDS = new Set([22, 23, 0, 1, 2, 3, 4, 5]);

export function bandShape(band: number): SlotBandShape {
  if (PEAK_BANDS.has(band)) return 'peak';
  if (OFF_PEAK_BANDS.has(band)) return 'off_peak';
  return 'shoulder';
}

/**
 * Multiplier on the airport's base capacity, by how contested the hour is.
 *
 * Peak is halved and off-peak nearly doubled around the airport's tier capacity,
 * so a flagship runs 4 holders at 08:00 and 14 at 03:00. Those are the numbers
 * that make B.5's promise true: in a mature world the morning is gone and the
 * night is not.
 */
const SHAPE_FACTOR: Record<SlotBandShape, number> = {
  peak: 0.5,
  shoulder: 1,
  off_peak: 1.75,
};

/** The eventual capacity of one band, once every release wave has landed. */
export function bandCapacity(baseCapacity: number, band: number): number {
  return Math.round(baseCapacity * SHAPE_FACTOR[bandShape(band)]);
}

/**
 * The slot release schedule (§21, open question 3).
 *
 * > *"Slot allocation at world launch: first-come-first-served creates a
 * > permanent land grab. Consider scheduled slot release waves."*
 *
 * That is the whole reason this exists. Every band's capacity available on
 * opening day is a fraction of its eventual capacity, and the rest arrives on a
 * published schedule measured in **game days since the world's epoch**. A player
 * who founds an airline three game months after launch still meets an
 * unallocated wave, instead of a board that was carved up on day one by whoever
 * happened to be there.
 *
 * Fractions rather than absolute counts because capacity already varies by tier
 * and by hour; a wave is *"a quarter of everything opens now"*, which stays true
 * at a flagship's 08:00 and a regional's 03:00 alike.
 *
 * Deliberately **not** an `EconomyConfig` coefficient, for ADR-0025's stated
 * reason: it prices nothing. It is an allocation-fairness policy, and putting it
 * in the balance payload would drag the immutable-version machinery into a number
 * that is really a rule about queueing.
 */
export interface SlotReleaseWave {
  /** Game days after the world's epoch at which this wave opens. */
  atGameDay: number;
  /** Cumulative fraction of every band's capacity released once it has. */
  fraction: number;
}

export const SLOT_RELEASE_WAVES: readonly SlotReleaseWave[] = [
  // Half on opening day: enough that the world is playable immediately, not
  // enough that the first cohort can hold everything.
  { atGameDay: 0, fraction: 0.5 },
  // A game month in — roughly when a founding cohort has settled and the second
  // wave of players is arriving.
  { atGameDay: 30, fraction: 0.75 },
  // A game quarter. Everything is on the table; from here scarcity is real and
  // permanent, and losing a slot needs use-it-or-lose-it (SEASON-09).
  { atGameDay: 90, fraction: 1 },
];

const GAME_DAY_MS = 86_400_000;

/** Whole game days from the world's epoch to `gameNow`. Never negative. */
export function worldAgeGameDays(epoch: Date, gameNow: Date): number {
  return Math.max(0, Math.floor((gameNow.getTime() - epoch.getTime()) / GAME_DAY_MS));
}

/** The cumulative fraction released by a given world age. */
export function releasedFraction(ageGameDays: number): number {
  let fraction = 0;
  for (const wave of SLOT_RELEASE_WAVES) {
    if (ageGameDays >= wave.atGameDay) fraction = wave.fraction;
  }
  return fraction;
}

/** The next wave still to come, or null once the last one has landed. */
export function nextReleaseWave(ageGameDays: number): SlotReleaseWave | null {
  return SLOT_RELEASE_WAVES.find((wave) => ageGameDays < wave.atGameDay) ?? null;
}

/**
 * How many holders one band accepts **today**.
 *
 * `Math.ceil` so a band that will eventually hold one still releases that one on
 * opening day rather than rounding it out of existence — a band with a capacity
 * nobody can ever claim is worse than no band.
 *
 * This can be **lower than the number already held**, and that is deliberate: a
 * world whose slots were claimed before the waves existed keeps every holding.
 * The caller reports `max(released − held, 0)` as available, so a wave only ever
 * adds. ADR-0025's "no retroactive grounding" is not weakened by this.
 */
export function releasedBandCapacity(
  baseCapacity: number,
  band: number,
  ageGameDays: number,
): number {
  const full = bandCapacity(baseCapacity, band);
  if (full <= 0) return 0;
  return Math.ceil(full * releasedFraction(ageGameDays));
}
