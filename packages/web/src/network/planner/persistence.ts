import type { RepeatPattern, ScheduleView } from '@tailfin/shared';

import type { AuthoredLeg, ScheduleDraft } from '../api';
import type { Frequency, PlannedFlight, PlannerAircraft, Weekday } from './types';

/**
 * The planner's timeline, translated to and from a server rotation (IMPROVE-04).
 *
 * ## The shapes do not match, and this is where that is dealt with
 *
 * The timeline is **per route, per aircraft, several flights a day**. A server
 * `schedule` is **one airframe, an ordered cycle of legs, and a repeat pattern**.
 * So one route's timeline with two aircraft on it is *two* rotations, and each
 * aircraft's flights that day are the legs of one.
 *
 * Publishing without that translation is what made "Published" a lie: the button
 * marked the reducer's copy of the draft as clean, and nothing was saved.
 *
 * ## `autoReturn` is false, deliberately
 *
 * The API's `autoReturn` appends the nonstop leg home, which is the shape the
 * `RotationPublisher` panel offers — a player types one destination and ticks a
 * box. The timeline is not that: it already lays the return as its own flight
 * with `direction: 'back'`, so asking the server to add another one would fly the
 * sector twice.
 *
 * ## The fleet pool is not an aircraft
 *
 * `PlannerAircraft.isPool` marks a synthetic row standing for "the unassigned
 * fleet", and it has no `airframeId` the server could accept. Flights laid
 * against it are drafts of an intention, so they are skipped and counted rather
 * than sent — the issue's *"mock/pool entries must not become fabricated server
 * resources"*. The caller says how many were left behind, so the player is told
 * rather than left wondering why a row did not save.
 */

/**
 * The planner's `Weekday` is already `@tailfin/shared`'s `IsoWeekday` — 1 for
 * Monday through 7 for Sunday — so the two patterns differ only in that the
 * contract requires at least one day and the timeline allows none.
 */
export function toRepeat(frequency: Frequency): RepeatPattern {
  if (frequency.kind === 'daily') return { kind: 'daily' };
  const days = [...new Set(frequency.days)].sort((a, b) => a - b);
  // An empty selection is a draft state the timeline allows and the contract
  // does not. Sending it would earn a refusal the player cannot act on, so it
  // becomes daily — which is what an unticked weekday picker means.
  return days.length === 0 ? { kind: 'daily' } : { kind: 'weekdays', days };
}

export function toFrequency(repeat: RepeatPattern): Frequency {
  if (repeat.kind === 'daily') return { kind: 'daily' };
  // `IsoWeekday` and `Weekday` are the same seven numbers; the cast is the
  // boundary between two packages that agree and cannot say so in one type.
  const days = repeat.days as Weekday[];
  return days.length === 0 ? { kind: 'daily' } : { kind: 'weekdays', days: [...days] };
}

/** One aircraft's rotation, ready to POST or PUT. */
export interface PlannerDraft {
  /** The timeline row this came from, so a response can be filed back against it. */
  aircraftId: string;
  draft: ScheduleDraft;
}

export interface PlannerDrafts {
  drafts: PlannerDraft[];
  /** Aircraft rows skipped because they are the fleet pool, not an airframe. */
  skippedPool: number;
}

/**
 * Group a route's timeline into one rotation per real aircraft.
 *
 * Legs are ordered by departure, which is what makes the sequence a cycle rather
 * than a set: the server walks them in order and checks that the aircraft ends
 * where it started.
 */
export function toDrafts(
  flights: readonly PlannedFlight[],
  frequency: Frequency,
  aircraft: readonly PlannerAircraft[],
): PlannerDrafts {
  const pool = new Set(aircraft.filter((a) => a.isPool).map((a) => a.id));
  const byAircraft = new Map<string, PlannedFlight[]>();
  let skippedPool = 0;

  for (const flight of flights) {
    if (pool.has(flight.aircraftId)) {
      skippedPool += 1;
      continue;
    }
    const existing = byAircraft.get(flight.aircraftId);
    if (existing) existing.push(flight);
    else byAircraft.set(flight.aircraftId, [flight]);
  }

  const repeat = toRepeat(frequency);
  const drafts: PlannerDraft[] = [];

  for (const [aircraftId, laid] of byAircraft) {
    const legs: AuthoredLeg[] = [...laid]
      .sort((a, b) => a.departureMinute - b.departureMinute)
      .map((flight) => ({
        originIcao: flight.originIcao.toUpperCase(),
        destinationIcao: flight.destinationIcao.toUpperCase(),
        departureMinuteLocal: flight.departureMinute,
      }));
    if (legs.length === 0) continue;
    drafts.push({ aircraftId, draft: { airframeId: aircraftId, legs, autoReturn: false, repeat } });
  }

  return { drafts, skippedPool };
}

/** A route's persisted rotations, rebuilt as timeline flights. */
export interface RestoredRoute {
  flights: PlannedFlight[];
  frequency: Frequency;
  /** Aircraft id to the schedule that holds it, so the next publish is an edit. */
  scheduleIds: Record<string, string>;
}

/**
 * Rebuild the timeline from what the server actually holds.
 *
 * The criterion this serves is *"reloading restores the persisted schedule rather
 * than regenerating a mock"*, and it is the half that makes the rest worth
 * anything: a save nobody can come back to is barely better than no save.
 *
 * Only schedules whose legs still name a route are restored. `routeId` is
 * nullable because `schedule_leg` stores the airport pair and the join back to a
 * route is deferred — a leg whose route has since been closed has nothing for the
 * timeline to lay it against, and inventing a row would put a flight on a route
 * the airline no longer serves.
 *
 * A schedule spanning several routes contributes a flight to each of them, which
 * is right: the timeline is per route, so a rotation through three airports shows
 * up on all three, and publishing any of them edits the same schedule.
 */
export function restoreFromSchedules(
  schedules: readonly ScheduleView[],
): Map<string, RestoredRoute> {
  const byRoute = new Map<string, RestoredRoute>();

  for (const schedule of schedules) {
    for (const [index, leg] of schedule.legs.entries()) {
      if (leg.routeId === null) continue;

      const route = byRoute.get(leg.routeId) ?? {
        flights: [],
        frequency: toFrequency(schedule.repeat),
        scheduleIds: {},
      };

      route.scheduleIds[schedule.airframeId] = schedule.id;
      route.flights.push({
        // Derived from the schedule rather than random, so a re-restore produces
        // the same ids and React keys stay stable across a refetch.
        id: `sched:${schedule.id}:${String(index)}`,
        aircraftId: schedule.airframeId,
        routeId: leg.routeId,
        originIcao: leg.originIcao,
        destinationIcao: leg.destinationIcao,
        // `departureMinute` is absolute from the cycle anchor and may exceed a
        // day on a late leg; the timeline is one local day wide, so it is folded
        // back into it. The server keeps the absolute value.
        departureMinute: ((leg.departureMinute % 1440) + 1440) % 1440,
        blockMinutes: Math.max(1, Math.round(leg.blockMinutes)),
        direction: index % 2 === 0 ? 'out' : 'back',
        frequency: toFrequency(schedule.repeat),
      });

      byRoute.set(leg.routeId, route);
    }
  }

  return byRoute;
}
