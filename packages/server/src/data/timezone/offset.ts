/**
 * What an IANA timezone's standard offset actually is (M3-04a).
 *
 * ## Why this runs at import and not in the simulation
 *
 * `Intl.DateTimeFormat` knows every timezone rule, including daylight saving,
 * and needs no dependency — Node ships full ICU. It is also the wrong thing to
 * call from `packages/sim`, and the reason is invariant 2 rather than purity
 * pedantry: ICU carries a snapshot of the IANA tz database, that snapshot
 * changes when Node is upgraded, and a world replayed after a Node upgrade
 * would then produce different departures than the one that was recorded.
 * M13-01's replay harness exists to prove that cannot happen.
 *
 * So the offset is resolved **once, here, at import**, written to the database
 * as an integer, and the simulation reads a number. A tzdata change then moves
 * airports only when somebody re-runs the import, which is already a versioned,
 * deliberate operation with a `dataset_version` row to say so.
 *
 * ## Standard time, not daylight saving
 *
 * The stored offset is the zone's **standard** offset, taken as the smaller of
 * its January and July offsets. Taking the minimum rather than "January" is
 * what makes it work in both hemispheres: Sydney's January is its summer.
 *
 * Not modelling DST is a deliberate limitation with a specific reason. Tailfin
 * has no summer/winter timetable — `ScheduledLeg.departureMinute` is fixed in
 * absolute time — so a DST-aware offset would move a player's departure an hour
 * along the SchedFit curve twice a year without them touching anything, and
 * hand them a share change they did not cause and cannot explain. Real airlines
 * answer this by rescheduling; Tailfin has nowhere to put that yet.
 */

/**
 * The offset, in minutes east of UTC, that a zone was at a given instant.
 *
 * Formats the instant into the zone and compares the wall-clock reading back
 * against UTC. That is the standard way to get this out of `Intl` — there is no
 * API that returns an offset directly.
 */
export function offsetMinutesAt(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    // `h23` rather than `hour12: false`: the latter can render midnight as hour
    // 24 depending on the ICU build, which would silently put the reading a day
    // out.
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);

  const field = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((part) => part.type === type);
    if (found === undefined) {
      throw new Error(`Intl gave no ${type} for ${timeZone}`);
    }
    return Number.parseInt(found.value, 10);
  };

  const asUtc = Date.UTC(
    field('year'),
    field('month') - 1,
    field('day'),
    field('hour'),
    field('minute'),
    field('second'),
  );

  // Both sides are whole seconds, so this is exact. Rounded rather than
  // truncated because a negative offset would otherwise round towards zero.
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/**
 * The year the offsets are sampled in.
 *
 * Pinned rather than taken from the clock, because "the current year" would
 * make the import non-reproducible: the same dataset imported on either side of
 * a new year could produce different offsets for a zone whose rules changed.
 * Bumping it is a deliberate data change.
 */
export const OFFSET_REFERENCE_YEAR = 2026;

/** The furthest east and west any real zone goes: UTC−12 to UTC+14. */
const MIN_OFFSET = -12 * 60;
const MAX_OFFSET = 14 * 60;

/**
 * A zone's standard-time offset in minutes east of UTC.
 *
 * The smaller of the January and July readings — see the module note on why the
 * minimum, and why not DST.
 */
export function standardOffsetMinutes(timeZone: string): number {
  const january = offsetMinutesAt(timeZone, new Date(Date.UTC(OFFSET_REFERENCE_YEAR, 0, 15, 12)));
  const july = offsetMinutesAt(timeZone, new Date(Date.UTC(OFFSET_REFERENCE_YEAR, 6, 15, 12)));
  const offset = Math.min(january, july);

  if (offset < MIN_OFFSET || offset > MAX_OFFSET) {
    throw new Error(`${timeZone} resolved to an impossible offset of ${String(offset)} minutes`);
  }
  return offset;
}

/**
 * Whether ICU recognises a zone name.
 *
 * The GeoNames dump is third-party data and a zone it names may have been
 * renamed or removed since the ICU build was cut — `Asia/Calcutta` against
 * `Asia/Kolkata`, and the handful of zones that have been merged away. An
 * unrecognised name must fall back rather than throw, or one stale row in a
 * 24,000-line file stops the whole import.
 */
export function isKnownTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}
