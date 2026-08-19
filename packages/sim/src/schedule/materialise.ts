/**
 * Turning a rotation into concrete flights, a horizon at a time (M2-03).
 *
 * A rotation is a rule. Nothing flies a rule — the queue needs dated flights
 * with instants on them, so something has to walk the rule forward and produce
 * them. Doing that for ever is impossible and doing it on demand is a poll, so
 * it is done to a **fixed horizon** that gets rolled forward.
 *
 * ## Idempotency is the whole design
 *
 * The roll will run more than once over the same window — after a restart, after
 * a retry, or because two workers raced. So every flight it produces carries a
 * key derived only from `(rotation, cycle date, leg index)`, which are facts
 * about the schedule rather than about the run. Roll the same window twice and
 * you get the same keys, and `world_event`'s unique `(world_id,
 * idempotency_key)` refuses the second write at the database rather than in
 * application code that has to be right every time.
 *
 * That is also why the key must not contain a timestamp, a sequence number or
 * anything about *when* the roll happened. It would be the obvious thing to add
 * and it would silently destroy the guarantee.
 *
 * ## Cycles are anchored in UTC, and legs may run past midnight
 *
 * Each run of a rotation is anchored at 00:00 UTC on its cycle date, and a leg's
 * departure is minutes from there. A leg at minute 1,530 belongs to the cycle
 * that started the previous day, not to a new one — an aircraft that lands at
 * 01:30 is still flying yesterday's rotation, and the alternative would make it
 * teleport at midnight.
 */

import { MINUTES_PER_DAY, type Rotation, arrivalMinute, isoWeekday, repeatsOn } from './rotation';

/**
 * How far ahead flights are created.
 *
 * A balance number, so it is retunable without a deploy (CONTRIBUTING invariant
 * 3). The trade runs both ways and neither end is free: a long horizon means
 * more rows to rewrite when a player edits a schedule, and a short one means the
 * roll has to run more often and a player sees less of their own future
 * timetable. Fourteen **game** days is about a week of real time in the flagship
 * world at speed 2.
 */
export interface MaterialisationConfig {
  horizonDays: number;
}

export const DEFAULT_MATERIALISATION: MaterialisationConfig = { horizonDays: 14 };

/**
 * The largest window this will walk, as a guard rather than a setting.
 *
 * Materialising a year of flights is not a long horizon, it is a mistake — a
 * misplaced unit, or a `to` that came from the wrong clock. Failing loudly beats
 * quietly generating a hundred thousand rows.
 */
export const MAX_HORIZON_DAYS = 366;

/** A half-open game-time window: `from` inclusive, `to` exclusive. */
export interface Horizon {
  from: Date;
  to: Date;
}

/** The horizon that should be materialised as of a given game instant. */
export function horizonFrom(
  now: Date,
  config: MaterialisationConfig = DEFAULT_MATERIALISATION,
): Horizon {
  if (!Number.isFinite(config.horizonDays) || config.horizonDays <= 0) {
    throw new Error(`Horizon must be a positive number of days, got ${String(config.horizonDays)}`);
  }
  return { from: now, to: addMinutes(now, config.horizonDays * MINUTES_PER_DAY) };
}

/** One dated flight, ready to become a `flight` row and a `FLIGHT_DEPART` event. */
export interface MaterialisedFlight {
  /**
   * `rotationId:cycleDate:legIndex`. Stable across re-runs and across edits, and
   * unique within a world — which is exactly what `world_event`'s idempotency
   * key needs.
   */
  key: string;
  rotationId: string;
  /** The cycle this belongs to, `YYYY-MM-DD` in UTC. */
  cycleDate: string;
  /** Position in the rotation, from zero. */
  legIndex: number;
  originIcao: string;
  destinationIcao: string;
  /** Game instant, off-blocks. */
  scheduledDeparture: Date;
  /** Game instant, on-blocks. */
  scheduledArrival: Date;
}

function addMinutes(at: Date, minutes: number): Date {
  return new Date(at.getTime() + minutes * 60_000);
}

/** 00:00 UTC on the day containing `at`. */
function anchorOf(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

function isoDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function assertUsable(horizon: Horizon): void {
  if (Number.isNaN(horizon.from.getTime()) || Number.isNaN(horizon.to.getTime())) {
    throw new Error('Horizon has an invalid instant');
  }
  const days = (horizon.to.getTime() - horizon.from.getTime()) / (MINUTES_PER_DAY * 60_000);
  if (days > MAX_HORIZON_DAYS) {
    throw new Error(
      `Refusing to materialise ${String(Math.round(days))} days of flights; the limit is ${String(MAX_HORIZON_DAYS)}`,
    );
  }
}

/**
 * Every flight the rotation produces whose departure falls inside the horizon.
 *
 * Deterministic and free of any clock: the same rotation and the same window
 * always give the same flights, in the same order, with the same keys. That is
 * what makes rolling the horizon safe to repeat.
 *
 * A rotation is walked from cycles that may start **before** the window, because
 * a leg departing at minute 1,530 belongs to the previous day's cycle and would
 * otherwise be missed at the window's leading edge.
 */
export function materialiseRotation(rotation: Rotation, horizon: Horizon): MaterialisedFlight[] {
  assertUsable(horizon);
  if (horizon.to <= horizon.from) return [];

  const latestDeparture = rotation.legs.reduce(
    (most, leg) => Math.max(most, leg.departureMinute),
    0,
  );
  // How many cycles back a leg can still reach into this window.
  const lookbackDays = Math.floor(latestDeparture / MINUTES_PER_DAY);

  const flights: MaterialisedFlight[] = [];
  const firstAnchor = addMinutes(anchorOf(horizon.from), -lookbackDays * MINUTES_PER_DAY);

  for (
    let anchor = firstAnchor;
    anchor.getTime() < horizon.to.getTime();
    anchor = addMinutes(anchor, MINUTES_PER_DAY)
  ) {
    if (!repeatsOn(rotation.repeat, isoWeekday(anchor))) continue;

    const cycleDate = isoDate(anchor);
    for (const [legIndex, leg] of rotation.legs.entries()) {
      const scheduledDeparture = addMinutes(anchor, leg.departureMinute);
      if (scheduledDeparture < horizon.from || scheduledDeparture >= horizon.to) continue;

      flights.push({
        key: `${rotation.id}:${cycleDate}:${String(legIndex)}`,
        rotationId: rotation.id,
        cycleDate,
        legIndex,
        originIcao: leg.originIcao,
        destinationIcao: leg.destinationIcao,
        scheduledDeparture,
        scheduledArrival: addMinutes(anchor, arrivalMinute(leg)),
      });
    }
  }

  // Cycle order is not departure order once a rotation runs past midnight, and
  // the queue reads this in time order.
  flights.sort((a, b) => a.scheduledDeparture.getTime() - b.scheduledDeparture.getTime());
  return flights;
}

/** What an edit does to the flights already on the books. */
export interface EditPlan {
  /** Left alone: already departed, or before the edit takes effect, or unchanged. */
  keep: MaterialisedFlight[];
  /** To be removed. Their `world_event` rows go with them. */
  cancel: MaterialisedFlight[];
  /** To be written. */
  create: MaterialisedFlight[];
}

function sameFlight(a: MaterialisedFlight, b: MaterialisedFlight): boolean {
  return (
    a.originIcao === b.originIcao &&
    a.destinationIcao === b.destinationIcao &&
    a.scheduledDeparture.getTime() === b.scheduledDeparture.getTime() &&
    a.scheduledArrival.getTime() === b.scheduledArrival.getTime()
  );
}

/**
 * Re-materialise an edited rotation, touching only future unflown legs.
 *
 * Two things are protected here, and they are different things:
 *
 * **A flight that has already gone cannot be un-flown.** `departed` names those,
 * and they are kept whatever the edit says. Editing tomorrow's timetable must
 * not reach back and delete this morning's revenue.
 *
 * **A leg the edit did not change is not churned.** A rotation with four legs
 * where only the third moved should produce one cancellation and one creation,
 * not eight of each. Anything the new rotation reproduces identically moves to
 * `keep`, so `cancel` and `create` are a minimal diff.
 *
 * ## Apply `cancel` before `create`, always
 *
 * A leg that merely *moves* keeps its key — the key names a slot in the
 * schedule, not a set of times, which is exactly what makes rolling the horizon
 * idempotent. So the same key can appear in both lists, and that pair means "this
 * flight was rewritten". Insert first and `world_event`'s unique
 * `(world_id, idempotency_key)` rejects the write; delete first and it is
 * correct. Doing both in one transaction is the point.
 */
export function applyEdit(params: {
  existing: readonly MaterialisedFlight[];
  next: Rotation;
  /** Game instant from which the new rotation applies. */
  effectiveFrom: Date;
  horizon: Horizon;
  /** Keys of flights that have already gone off-blocks. */
  departed?: ReadonlySet<string>;
}): EditPlan {
  const { existing, next, effectiveFrom, horizon } = params;
  const departed = params.departed ?? new Set<string>();

  const keep: MaterialisedFlight[] = [];
  const affected = new Map<string, MaterialisedFlight>();

  for (const flight of existing) {
    if (flight.scheduledDeparture < effectiveFrom || departed.has(flight.key)) {
      keep.push(flight);
    } else {
      affected.set(flight.key, flight);
    }
  }

  // The new rotation only applies from the later of the edit and the horizon's
  // own start: an edit dated in the past does not create flights in the past.
  const window: Horizon = {
    from: effectiveFrom > horizon.from ? effectiveFrom : horizon.from,
    to: horizon.to,
  };
  const proposed = materialiseRotation(next, window);

  const create: MaterialisedFlight[] = [];
  for (const flight of proposed) {
    const existingFlight = affected.get(flight.key);
    if (existingFlight !== undefined && sameFlight(existingFlight, flight)) {
      keep.push(existingFlight);
      affected.delete(flight.key);
      continue;
    }
    create.push(flight);
  }

  keep.sort((a, b) => a.scheduledDeparture.getTime() - b.scheduledDeparture.getTime());
  const cancel = [...affected.values()].sort(
    (a, b) => a.scheduledDeparture.getTime() - b.scheduledDeparture.getTime(),
  );
  return { keep, cancel, create };
}

/**
 * Advance an already-materialised rotation to a new horizon.
 *
 * The continuous case, and the one App. F.3 promises: a worker rolls this
 * forward and flights keep appearing with no player action. It is `applyEdit`
 * with the rotation unchanged and nothing dated in the past, which is why it is
 * three lines rather than its own algorithm — and why it produces no
 * cancellations for a schedule nobody touched.
 */
export function rollHorizon(
  rotation: Rotation,
  existing: readonly MaterialisedFlight[],
  horizon: Horizon,
): MaterialisedFlight[] {
  const known = new Set(existing.map((flight) => flight.key));
  return materialiseRotation(rotation, horizon).filter((flight) => !known.has(flight.key));
}
