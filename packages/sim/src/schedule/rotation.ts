/**
 * Rotations — the thing that keeps the airline working while nobody is watching
 * (M2-03, design doc §8.2, App. F.3).
 *
 * §8.2 is one line: *"Assign an aircraft to a rotation; the sim runs it
 * continuously."* App. F.3 makes it the payoff of the whole first session — at
 * minute 75 the player adds a return leg and a second round trip and saves it as
 * a repeating schedule, and the beat it teaches is *"the airline works while
 * you're away."* Everything here exists to make that sentence true.
 *
 * ## A rotation is a cycle, not a list
 *
 * The difference is the whole model. A list of flights runs out; a rotation
 * repeats, which means **the aircraft has to end where it started**. An aircraft
 * that finishes the day somewhere other than where it began cannot fly the same
 * pattern tomorrow, and a schedule that does not close is not a schedule — it is
 * one day of flying followed by a stranded aeroplane. That is `does-not-close`,
 * and it is the check most likely to catch a real player mistake.
 *
 * ## Time is measured from the cycle anchor, not from midnight
 *
 * Every departure is minutes from the start of the rotation's cycle. A minute
 * past 1,440 is the next calendar day, and that is deliberate: a rotation whose
 * last leg lands at 01:30 is perfectly ordinary, and forcing it to be described
 * as two cycles would make the aircraft teleport at midnight. The anchor is a
 * game-time instant; converting to an airport's local clock for curfew purposes
 * is `checkReachability`'s job, which already takes local minutes.
 *
 * ## Pure, and supplied with its inputs
 *
 * The same discipline as M2-01 and M2-02. Slots are M7-05, crew legality is M5,
 * block times are M2-05 and turnarounds are M2-04 — so each arrives as a field
 * rather than as a stub. The checks are correct and ordered now; the milestones
 * that own the data fill them in without touching this file.
 */

/** ISO 8601 weekday numbering — 1 is Monday, 7 is Sunday. */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export const WEEKDAYS: readonly Weekday[] = [1, 2, 3, 4, 5, 6, 7];

const WEEKDAY_NAMES: Record<Weekday, string> = {
  1: 'Monday',
  2: 'Tuesday',
  3: 'Wednesday',
  4: 'Thursday',
  5: 'Friday',
  6: 'Saturday',
  7: 'Sunday',
};

/** Minutes in a day, and the unit the cycle anchor advances by. */
export const MINUTES_PER_DAY = 1_440;

/**
 * How often the rotation runs.
 *
 * The issue asks for daily or specific weekdays and nothing more, which is the
 * right MVP: a pattern language rich enough to express "every second Tuesday in
 * summer" is a feature nobody asked for and a validator nobody can reason about.
 */
export type RepeatPattern = { kind: 'daily' } | { kind: 'weekdays'; days: readonly Weekday[] };

/**
 * One leg of the rotation.
 *
 * `blockMinutes` is off-blocks to on-blocks — M2-05 computes it from distance,
 * cruise speed and the flight profile. `turnaroundMinutes` is the ground time
 * required **after** this leg, which M2-04 computes from cabin config, ground
 * vendor and stand type. Both arrive resolved; nothing here re-derives them
 * (CONTRIBUTING invariant 4).
 */
export interface ScheduledLeg {
  originIcao: string;
  destinationIcao: string;
  /**
   * Off-blocks, in minutes from the cycle anchor.
   *
   * May exceed {@link MINUTES_PER_DAY} for a rotation that runs past midnight.
   */
  departureMinute: number;
  /** Off-blocks to on-blocks. */
  blockMinutes: number;
  /** Ground time required after this leg, before the aircraft can go again. */
  turnaroundMinutes: number;
  /**
   * Whether a slot is held for this departure (M7-05).
   *
   * A boolean because the slot system does not exist. The check is in the right
   * place and in the right order; what feeds it is the part still to be built.
   */
  hasSlot: boolean;
}

export interface Rotation {
  /**
   * Stable identity, and the first component of every materialised flight's
   * idempotency key. It must survive an edit — an edited rotation is the same
   * rotation, which is what stops a re-roll of the horizon duplicating flights.
   */
  id: string;
  legs: readonly ScheduledLeg[];
  repeat: RepeatPattern;
  /**
   * Whether the crew assigned to this rotation may legally fly it (M5).
   *
   * Duty and rest limits are §9.2's, and App. F.3 shows them *"shown, not yet
   * enforced hard"* during onboarding — so this is a field the caller decides,
   * not a rule this module owns.
   */
  crewLegal: boolean;
  /**
   * Where the assigned aircraft actually is, if it is known (M2-07).
   *
   * The rotation's legs already have to connect to each other; this is the one
   * connection they cannot check among themselves — whether the *first* leg
   * departs from where the aeroplane is standing. An aircraft in Amsterdam
   * cannot begin a rotation at Heathrow, however well the rest of it closes.
   *
   * Optional because it is not always knowable: a rotation can be drafted before
   * an aircraft is assigned, and M4-04's delivery is what first gives an airframe
   * a place to be. Undefined means "not known", which is not the same as "fine" —
   * it means this check does not run, and `@tailfin/sim`'s caller is the one that
   * knows whether it should have.
   */
  aircraftAt?: string;
}

/**
 * Why a rotation cannot be saved. One per check, in the order they run.
 *
 * A closed set rather than a message, for the same reason `ReachabilityReason`
 * is one: the interface has to offer the fix. *"Gap too short"* points at a
 * turnaround, *"aircraft not positioned"* points at a leg's origin, and neither
 * can be driven off prose.
 */
export type RotationProblem =
  | 'empty'
  | 'no_repeat_days'
  | 'leg_order'
  | 'not_positioned'
  | 'does_not_close'
  | 'turn_too_short'
  | 'cycle_overrun'
  | 'no_slot'
  | 'crew_illegal';

export type RotationCheck = { ok: true } | { ok: false; problem: RotationProblem; detail: string };

/**
 * Everything that can stop a schedule being saved — the rules above, plus the
 * ones only a database can answer.
 *
 * Kept apart from `RotationProblem` on purpose, and a failing test is what
 * insisted on it. `ROTATION_PROBLEMS` carries a contract that **every value is
 * reachable from `validateRotation`**, asserted by `rotation.test.ts` so a
 * problem cannot be added without a rule that produces it. `airframe_unavailable`
 * is decided by the server, from a row, so putting it in there broke that
 * contract — the test was right and the first attempt was wrong.
 *
 * The player still meets one vocabulary: `createSchedule` returns this type, so a
 * grounded aeroplane surfaces through the same conflict channel as a rotation that
 * does not close (M4-06, §7.3).
 */
export type SchedulingProblem = RotationProblem | 'airframe_unavailable';

/**
 * Every problem, in the order the checks run.
 *
 * Exported so a test can prove each one is reachable, and so an interface can
 * order a list of complaints the same way the rules do.
 */
export const ROTATION_PROBLEMS: readonly RotationProblem[] = [
  'empty',
  'no_repeat_days',
  'leg_order',
  'not_positioned',
  'does_not_close',
  'turn_too_short',
  'cycle_overrun',
  'no_slot',
  'crew_illegal',
];

function formatMinute(minute: number): string {
  const days = Math.floor(minute / MINUTES_PER_DAY);
  const withinDay = minute - days * MINUTES_PER_DAY;
  const hours = Math.floor(withinDay / 60);
  const minutes = Math.round(withinDay % 60);
  const clock = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  return days === 0 ? clock : `${clock} on day ${String(days + 1)}`;
}

/** On-blocks, in minutes from the cycle anchor. */
export function arrivalMinute(leg: ScheduledLeg): number {
  return leg.departureMinute + leg.blockMinutes;
}

/**
 * The shortest gap between two consecutive runs of the rotation, in minutes.
 *
 * This is what a rotation has to fit inside. A daily pattern gives 24 hours; a
 * Monday-and-Tuesday pattern also gives 24, because *the tightest pair is what
 * binds* — the aircraft has to be home and turned by Tuesday morning even though
 * it then gets five days off. A single-day pattern gives a whole week, which is
 * why a rotation too long to run daily can still run weekly.
 */
export function shortestCycleGapMinutes(repeat: RepeatPattern): number {
  if (repeat.kind === 'daily') return MINUTES_PER_DAY;

  const days = [...new Set(repeat.days)].sort((a, b) => a - b);
  const first = days[0];
  // A pattern with no days never runs, so there is no gap between runs.
  // `validateRotation` refuses it as `no-repeat-days` before reaching this.
  if (first === undefined) return 0;
  if (days.length === 1) return 7 * MINUTES_PER_DAY;

  let shortest = Number.POSITIVE_INFINITY;
  for (const [i, current] of days.entries()) {
    const next = days[i + 1];
    // The last day wraps to the first of the following week.
    const gapDays = next === undefined ? first + 7 - current : next - current;
    shortest = Math.min(shortest, gapDays);
  }
  return shortest * MINUTES_PER_DAY;
}

/**
 * The checks, in order, stopping at the first failure.
 *
 * The order runs from the structural to the administrative, the same way App.
 * B.4's reachability checks do. There is no point telling a player they are
 * missing an 08:00 slot for a rotation whose aircraft ends the day in the wrong
 * country — they would fix the slot and still be stuck.
 */
export function validateRotation(rotation: Rotation): RotationCheck {
  const { legs, repeat } = rotation;

  // 1. Something to fly.
  const first = legs[0];
  if (first === undefined) {
    return { ok: false, problem: 'empty', detail: 'A rotation needs at least one leg.' };
  }

  // 2. Some day to fly it on. An empty weekday list is a rotation that never
  //    runs, which is a saved schedule that silently does nothing.
  if (repeat.kind === 'weekdays' && new Set(repeat.days).size === 0) {
    return {
      ok: false,
      problem: 'no_repeat_days',
      detail: 'A rotation repeating on chosen weekdays needs at least one day chosen.',
    };
  }

  // 2b. The aircraft is where the rotation starts (M2-07).
  //
  //     Before the leg walk, deliberately. A rotation whose aircraft is in the
  //     wrong country is not improved by being told its third turnaround is two
  //     minutes short — the same ordering argument the rest of these checks are
  //     built on. And the fix is different in kind: every other problem here is
  //     mended by editing the schedule, this one by flying the aeroplane there.
  if (rotation.aircraftAt !== undefined && rotation.aircraftAt !== first.originIcao) {
    return {
      ok: false,
      problem: 'not_positioned',
      detail:
        `The rotation starts at ${first.originIcao}, but the aircraft is at ` +
        `${rotation.aircraftAt}. Ferry it to ${first.originIcao} first.`,
    };
  }

  // `previous` is carried rather than indexed backwards, which keeps every leg
  // in this walk a defined value and leaves no unreachable branch behind.
  let previous = first;

  for (const [i, leg] of legs.entries()) {
    if (leg.originIcao === leg.destinationIcao) {
      return {
        ok: false,
        problem: 'not_positioned',
        detail: `Leg ${String(i + 1)} departs and arrives at ${leg.originIcao}.`,
      };
    }
    if (!Number.isFinite(leg.departureMinute) || leg.departureMinute < 0) {
      return {
        ok: false,
        problem: 'leg_order',
        detail: `Leg ${String(i + 1)} departs at minute ${String(leg.departureMinute)}, which is not a time.`,
      };
    }
    if (!Number.isFinite(leg.blockMinutes) || leg.blockMinutes <= 0) {
      return {
        ok: false,
        problem: 'leg_order',
        detail: `Leg ${String(i + 1)} has a block time of ${String(leg.blockMinutes)} minutes.`,
      };
    }
    if (!Number.isFinite(leg.turnaroundMinutes) || leg.turnaroundMinutes < 0) {
      return {
        ok: false,
        problem: 'turn_too_short',
        detail: `Leg ${String(i + 1)} has a turnaround of ${String(leg.turnaroundMinutes)} minutes.`,
      };
    }

    if (i === 0) {
      previous = leg;
      continue;
    }

    // 3. Order. Checked before position, because a rotation whose legs are out
    //    of sequence produces a nonsense positioning message.
    if (leg.departureMinute <= previous.departureMinute) {
      return {
        ok: false,
        problem: 'leg_order',
        detail:
          `Leg ${String(i + 1)} departs at ${formatMinute(leg.departureMinute)}, ` +
          `which is not after leg ${String(i)} at ${formatMinute(previous.departureMinute)}.`,
      };
    }

    // 4. Position. The aircraft is a physical object and cannot start a leg
    //    somewhere it is not.
    if (leg.originIcao !== previous.destinationIcao) {
      return {
        ok: false,
        problem: 'not_positioned',
        detail:
          `Leg ${String(i + 1)} departs ${leg.originIcao}, but leg ${String(i)} ` +
          `leaves the aircraft at ${previous.destinationIcao}.`,
      };
    }

    // 5. Turn time. The gap has to cover servicing, not just the block.
    const readyAt = arrivalMinute(previous) + previous.turnaroundMinutes;
    if (leg.departureMinute < readyAt) {
      const short = readyAt - leg.departureMinute;
      return {
        ok: false,
        problem: 'turn_too_short',
        detail:
          `Leg ${String(i + 1)} departs ${leg.originIcao} at ${formatMinute(leg.departureMinute)}, ` +
          `${String(Math.round(short))} minutes before the aircraft is ready — it lands at ` +
          `${formatMinute(arrivalMinute(previous))} and needs ${String(Math.round(previous.turnaroundMinutes))} ` +
          `minutes on the ground.`,
      };
    }

    previous = leg;
  }

  // 6. The cycle closes. Checked after the per-leg walk so a broken chain is
  //    reported at the leg that broke it rather than at the end. `previous` is
  //    the last leg by the time the walk finishes.
  const last = previous;
  if (last.destinationIcao !== first.originIcao) {
    return {
      ok: false,
      problem: 'does_not_close',
      detail:
        `The rotation starts at ${first.originIcao} and ends at ${last.destinationIcao}, ` +
        `so it cannot repeat — the aircraft would have to be somewhere it is not.`,
    };
  }

  // 7. It fits in its own cycle. A rotation that overruns is one whose next run
  //    would need the aircraft before this run has given it back.
  const gap = shortestCycleGapMinutes(repeat);
  const homeAt = arrivalMinute(last) + last.turnaroundMinutes;
  const nextDeparture = gap + first.departureMinute;
  if (homeAt > nextDeparture) {
    const over = homeAt - nextDeparture;
    return {
      ok: false,
      problem: 'cycle_overrun',
      detail:
        `The rotation is not back and turned at ${first.originIcao} until ` +
        `${formatMinute(homeAt)}, ${String(Math.round(over))} minutes after the next run ` +
        `is due out${describeGap(repeat)}.`,
    };
  }

  // 8. Slots. Administrative, cheap to fix, and last of the physical order.
  for (const [i, leg] of legs.entries()) {
    if (!leg.hasSlot) {
      return {
        ok: false,
        problem: 'no_slot',
        detail:
          `No slot is held at ${leg.originIcao} for leg ${String(i + 1)} ` +
          `in the ${formatMinute(leg.departureMinute)} band.`,
      };
    }
  }

  // 9. Crew. Last, because a rotation can be re-crewed without redesigning it.
  if (!rotation.crewLegal) {
    return {
      ok: false,
      problem: 'crew_illegal',
      detail: 'The assigned crew cannot legally fly this rotation within their duty limits.',
    };
  }

  return { ok: true };
}

function describeGap(repeat: RepeatPattern): string {
  if (repeat.kind === 'daily') return '';
  const names = [...new Set(repeat.days)].sort((a, b) => a - b).map((d) => WEEKDAY_NAMES[d]);
  return names.length === 1
    ? ` (it runs only on ${names.join('')})`
    : ` (it runs on ${names.join(', ')})`;
}

/** Whether the pattern runs on a given ISO weekday. */
export function repeatsOn(repeat: RepeatPattern, weekday: Weekday): boolean {
  return repeat.kind === 'daily' || repeat.days.includes(weekday);
}

/** ISO weekday of a game-time instant, read in UTC — the frame cycle anchors use. */
export function isoWeekday(at: Date): Weekday {
  const day = at.getUTCDay();
  return (day === 0 ? 7 : day) as Weekday;
}
