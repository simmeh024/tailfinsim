import { describe, expect, it } from 'vitest';

import { IsoWeekday, ScheduleProblem } from '@tailfin/shared';

import {
  arrivalMinute,
  isoWeekday,
  MINUTES_PER_DAY,
  repeatsOn,
  ROTATION_PROBLEMS,
  type Rotation,
  type RotationProblem,
  type ScheduledLeg,
  shortestCycleGapMinutes,
  validateRotation,
  type Weekday,
  WEEKDAYS,
} from './rotation';

/**
 * The rotation model and its checks (M2-03, §8.2, App. F.3).
 *
 * Two things are worth protecting, and the second is what the issue actually
 * asks for:
 *
 *   1. A rotation that closes, positions and turns correctly is accepted.
 *   2. **Every rejection names its own reason.** "Invalid rotation" is useless
 *      to a player who has to work out which of nine things they got wrong, so
 *      each problem has a test and one test walks the whole enum to prove none
 *      has quietly become unreachable.
 */

/**
 * The rotation App. F.3 builds at minute 75 of onboarding: an out-and-back from
 * the hub, twice. ATR 72 timings — 95 minutes block, 40 on the ground.
 */
function leg(
  overrides: Partial<ScheduledLeg> &
    Pick<ScheduledLeg, 'originIcao' | 'destinationIcao' | 'departureMinute'>,
): ScheduledLeg {
  return {
    blockMinutes: 95,
    turnaroundMinutes: 40,
    hasSlot: true,
    ...overrides,
  };
}

/** EHAM–EGLL–EHAM–EGLL–EHAM, starting at 07:00. */
const DOUBLE_ROUND_TRIP: readonly ScheduledLeg[] = [
  leg({ originIcao: 'EHAM', destinationIcao: 'EGLL', departureMinute: 420 }),
  leg({ originIcao: 'EGLL', destinationIcao: 'EHAM', departureMinute: 555 }),
  leg({ originIcao: 'EHAM', destinationIcao: 'EGLL', departureMinute: 690 }),
  leg({ originIcao: 'EGLL', destinationIcao: 'EHAM', departureMinute: 825 }),
];

/**
 * A long-haul pairing that genuinely will not fit in a day: 11 hours out, the
 * three-hour turn a widebody actually needs at the far end, 10 hours back, and
 * 40 minutes at home. 1,480 minutes against the 1,440 a daily pattern allows.
 */
const TOO_LONG_FOR_DAILY: readonly ScheduledLeg[] = [
  leg({
    originIcao: 'EHAM',
    destinationIcao: 'KSFO',
    departureMinute: 420,
    blockMinutes: 660,
    turnaroundMinutes: 180,
  }),
  leg({ originIcao: 'KSFO', destinationIcao: 'EHAM', departureMinute: 1_260, blockMinutes: 600 }),
];

function rotation(overrides: Partial<Rotation> = {}): Rotation {
  return {
    id: 'rot-1',
    legs: DOUBLE_ROUND_TRIP,
    repeat: { kind: 'daily' },
    crewLegal: true,
    ...overrides,
  };
}

function reject(r: Rotation): { problem: RotationProblem; detail: string } {
  const result = validateRotation(r);
  if (result.ok) throw new Error('Expected the rotation to be rejected, but it was accepted');
  return { problem: result.problem, detail: result.detail };
}

describe('the wire contract', () => {
  it('uses exactly the same problem tokens as the API', () => {
    // Deliberately identical strings rather than a mapping table. A translation
    // layer between two enums that mean the same thing is a place for them to
    // drift, and this test is what makes the absence of one safe.
    expect([...ROTATION_PROBLEMS].sort()).toEqual([...ScheduleProblem.options].sort());
  });

  it('narrows the shared IsoWeekday rather than renumbering it', () => {
    // `Weekday` is a literal union so the sim gets exhaustiveness checking;
    // shared's `IsoWeekday` is a runtime range. Same numbering, and this is the
    // assertion that keeps it that way.
    for (const day of WEEKDAYS) {
      expect(IsoWeekday.safeParse(day).success).toBe(true);
    }
    expect(IsoWeekday.safeParse(0).success).toBe(false);
    expect(IsoWeekday.safeParse(8).success).toBe(false);
  });
});

describe('a rotation that works', () => {
  it('accepts the double round trip App. F.3 builds during onboarding', () => {
    expect(validateRotation(rotation())).toEqual({ ok: true });
  });

  it('accepts a single out-and-back', () => {
    expect(
      validateRotation(
        rotation({
          legs: [
            leg({ originIcao: 'EHAM', destinationIcao: 'EGLL', departureMinute: 420 }),
            leg({ originIcao: 'EGLL', destinationIcao: 'EHAM', departureMinute: 555 }),
          ],
        }),
      ),
    ).toEqual({ ok: true });
  });

  it('accepts a rotation that lands after midnight', () => {
    // Out at 21:00, back at 01:50 the next day. Ordinary, and the reason
    // departures are minutes from the anchor rather than a clock time.
    const late = rotation({
      legs: [
        leg({ originIcao: 'EHAM', destinationIcao: 'LEPA', departureMinute: 1_260 }),
        leg({ originIcao: 'LEPA', destinationIcao: 'EHAM', departureMinute: 1_395 }),
      ],
    });
    expect(validateRotation(late)).toEqual({ ok: true });
    expect(arrivalMinute(late.legs[1]!)).toBe(1_490);
    expect(arrivalMinute(late.legs[1]!)).toBeGreaterThan(MINUTES_PER_DAY);
  });
});

describe('every rejection names its own reason', () => {
  it('empty', () => {
    expect(reject(rotation({ legs: [] })).problem).toBe('empty');
  });

  it('no_repeat_days', () => {
    const result = reject(rotation({ repeat: { kind: 'weekdays', days: [] } }));
    expect(result.problem).toBe('no_repeat_days');
    expect(result.detail).toContain('at least one day');
  });

  it('leg_order', () => {
    const result = reject(
      rotation({
        legs: [
          leg({ originIcao: 'EHAM', destinationIcao: 'EGLL', departureMinute: 420 }),
          leg({ originIcao: 'EGLL', destinationIcao: 'EHAM', departureMinute: 300 }),
        ],
      }),
    );
    expect(result.problem).toBe('leg_order');
    expect(result.detail).toContain('05:00');
  });

  it('not-positioned, and it says where the aircraft actually is', () => {
    const result = reject(
      rotation({
        legs: [
          leg({ originIcao: 'EHAM', destinationIcao: 'EGLL', departureMinute: 420 }),
          leg({ originIcao: 'LFPG', destinationIcao: 'EHAM', departureMinute: 555 }),
        ],
      }),
    );
    expect(result.problem).toBe('not_positioned');
    expect(result.detail).toContain('departs LFPG');
    expect(result.detail).toContain('leaves the aircraft at EGLL');
  });

  it('does-not-close, which is the mistake a rotation model exists to catch', () => {
    const result = reject(
      rotation({
        legs: [
          leg({ originIcao: 'EHAM', destinationIcao: 'EGLL', departureMinute: 420 }),
          leg({ originIcao: 'EGLL', destinationIcao: 'LFPG', departureMinute: 555 }),
        ],
      }),
    );
    expect(result.problem).toBe('does_not_close');
    expect(result.detail).toContain('starts at EHAM and ends at LFPG');
    expect(result.detail).toContain('cannot repeat');
  });

  it('turn-too-short, and it says by how much', () => {
    // Lands at 08:35, needs 40 minutes, so 09:00 is 20 minutes early.
    const result = reject(
      rotation({
        legs: [
          leg({ originIcao: 'EHAM', destinationIcao: 'EGLL', departureMinute: 420 }),
          leg({ originIcao: 'EGLL', destinationIcao: 'EHAM', departureMinute: 535 }),
        ],
      }),
    );
    expect(result.problem).toBe('turn_too_short');
    expect(result.detail).toContain('20 minutes before the aircraft is ready');
    expect(result.detail).toContain('needs 40');
  });

  it('cycle-overrun when a rotation is too long to run daily', () => {
    // Home and turned at 07:40 on day two, 40 minutes after tomorrow's 07:00
    // departure is due out. One aircraft cannot be in both places.
    const result = reject(rotation({ legs: TOO_LONG_FOR_DAILY }));
    expect(result.problem).toBe('cycle_overrun');
    expect(result.detail).toContain('40 minutes after the next run is due out');
    expect(result.detail).toContain('EHAM');
  });

  it('cycle-overrun names the days when the rotation is not daily', () => {
    // Monday and Tuesday still leave only one night between runs, so the same
    // pairing overruns — and the message has to say which days, or the player
    // cannot see why a five-day gap did not help.
    const pair = reject(
      rotation({ legs: TOO_LONG_FOR_DAILY, repeat: { kind: 'weekdays', days: [1, 2] } }),
    );
    expect(pair.problem).toBe('cycle_overrun');
    expect(pair.detail).toContain('(it runs on Monday, Tuesday)');

    // A rotation longer than a week overruns even on a single day.
    const enormous = reject(
      rotation({
        repeat: { kind: 'weekdays', days: [3] },
        legs: [
          leg({
            originIcao: 'EHAM',
            destinationIcao: 'NZAA',
            departureMinute: 420,
            blockMinutes: 6_000,
            turnaroundMinutes: 180,
          }),
          leg({
            originIcao: 'NZAA',
            destinationIcao: 'EHAM',
            departureMinute: 6_600,
            blockMinutes: 6_000,
          }),
        ],
      }),
    );
    expect(enormous.problem).toBe('cycle_overrun');
    expect(enormous.detail).toContain('(it runs only on Wednesday)');
  });

  it('no_slot', () => {
    const legs = [...DOUBLE_ROUND_TRIP];
    legs[2] = { ...legs[2]!, hasSlot: false };
    const result = reject(rotation({ legs }));
    expect(result.problem).toBe('no_slot');
    expect(result.detail).toContain('leg 3');
    expect(result.detail).toContain('11:30');
  });

  it('crew_illegal', () => {
    expect(reject(rotation({ crewLegal: false })).problem).toBe('crew_illegal');
  });

  it('keeps every problem reachable', () => {
    const legs = [...DOUBLE_ROUND_TRIP];
    legs[0] = { ...legs[0]!, hasSlot: false };

    const reached = new Set<RotationProblem>([
      reject(rotation({ legs: [] })).problem,
      reject(rotation({ repeat: { kind: 'weekdays', days: [] } })).problem,
      reject(
        rotation({
          legs: [
            leg({ originIcao: 'EHAM', destinationIcao: 'EGLL', departureMinute: 420 }),
            leg({ originIcao: 'EGLL', destinationIcao: 'EHAM', departureMinute: 300 }),
          ],
        }),
      ).problem,
      reject(
        rotation({
          legs: [
            leg({ originIcao: 'EHAM', destinationIcao: 'EGLL', departureMinute: 420 }),
            leg({ originIcao: 'LFPG', destinationIcao: 'EHAM', departureMinute: 555 }),
          ],
        }),
      ).problem,
      reject(
        rotation({
          legs: [
            leg({ originIcao: 'EHAM', destinationIcao: 'EGLL', departureMinute: 420 }),
            leg({ originIcao: 'EGLL', destinationIcao: 'LFPG', departureMinute: 555 }),
          ],
        }),
      ).problem,
      reject(
        rotation({
          legs: [
            leg({ originIcao: 'EHAM', destinationIcao: 'EGLL', departureMinute: 420 }),
            leg({ originIcao: 'EGLL', destinationIcao: 'EHAM', departureMinute: 535 }),
          ],
        }),
      ).problem,
      reject(rotation({ legs: TOO_LONG_FOR_DAILY })).problem,
      reject(rotation({ legs })).problem,
      reject(rotation({ crewLegal: false })).problem,
    ]);

    expect([...reached].sort()).toEqual([...ROTATION_PROBLEMS].sort());
  });
});

describe('the order the checks run in', () => {
  it('reports the broken chain before the missing slot', () => {
    // A rotation with both faults. Fixing the slot first would leave the player
    // with a rotation that still cannot fly, which is why position comes first.
    const result = reject(
      rotation({
        legs: [
          leg({ originIcao: 'EHAM', destinationIcao: 'EGLL', departureMinute: 420 }),
          leg({
            originIcao: 'LFPG',
            destinationIcao: 'EHAM',
            departureMinute: 555,
            hasSlot: false,
          }),
        ],
      }),
    );
    expect(result.problem).toBe('not_positioned');
  });

  it('reports the open cycle before the crew', () => {
    const result = reject(
      rotation({
        crewLegal: false,
        legs: [
          leg({ originIcao: 'EHAM', destinationIcao: 'EGLL', departureMinute: 420 }),
          leg({ originIcao: 'EGLL', destinationIcao: 'LFPG', departureMinute: 555 }),
        ],
      }),
    );
    expect(result.problem).toBe('does_not_close');
  });
});

describe('the cycle gap', () => {
  it('is a day for a daily rotation', () => {
    expect(shortestCycleGapMinutes({ kind: 'daily' })).toBe(MINUTES_PER_DAY);
  });

  it('is a week for a rotation that runs on one day', () => {
    expect(shortestCycleGapMinutes({ kind: 'weekdays', days: [3] })).toBe(7 * MINUTES_PER_DAY);
  });

  it('is the tightest pair, not the average', () => {
    // Monday and Tuesday give the aircraft five days off and one night. The one
    // night is what binds.
    expect(shortestCycleGapMinutes({ kind: 'weekdays', days: [1, 2] })).toBe(MINUTES_PER_DAY);
    // Monday, Wednesday, Friday: two days, two days, then three across the
    // weekend. Two is the constraint.
    expect(shortestCycleGapMinutes({ kind: 'weekdays', days: [1, 3, 5] })).toBe(
      2 * MINUTES_PER_DAY,
    );
  });

  it('wraps around the end of the week', () => {
    // Sunday to Monday is one day, not six.
    expect(shortestCycleGapMinutes({ kind: 'weekdays', days: [1, 7] })).toBe(MINUTES_PER_DAY);
  });

  it('is nothing for a pattern with no days, which never runs', () => {
    expect(shortestCycleGapMinutes({ kind: 'weekdays', days: [] })).toBe(0);
  });

  it('ignores a repeated day', () => {
    expect(shortestCycleGapMinutes({ kind: 'weekdays', days: [3, 3] })).toBe(7 * MINUTES_PER_DAY);
  });

  it('lets a weekly pattern fly a rotation too long to run daily', () => {
    expect(reject(rotation({ legs: TOO_LONG_FOR_DAILY, repeat: { kind: 'daily' } })).problem).toBe(
      'cycle_overrun',
    );
    // The same pairing on Mondays only has a week of slack and is fine. This is
    // how ultra-long-haul is actually scheduled.
    expect(
      validateRotation(
        rotation({ legs: TOO_LONG_FOR_DAILY, repeat: { kind: 'weekdays', days: [1] } }),
      ),
    ).toEqual({ ok: true });
  });
});

describe('weekdays', () => {
  it('numbers Monday 1 and Sunday 7, ISO style', () => {
    // 2026-08-17 is a Monday, so the week runs to Sunday the 23rd.
    expect(isoWeekday(new Date('2026-08-17T00:00:00Z'))).toBe(1);
    expect(isoWeekday(new Date('2026-08-23T00:00:00Z'))).toBe(7);
    expect(WEEKDAYS).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('reads a UTC weekday, not a local one', () => {
    // Late on Sunday in UTC is already Monday in some zones. The anchor frame is
    // UTC, so this must stay Sunday.
    expect(isoWeekday(new Date('2026-08-23T23:59:00Z'))).toBe(7);
  });

  it('says a daily pattern runs every day', () => {
    for (const day of WEEKDAYS) {
      expect(repeatsOn({ kind: 'daily' }, day)).toBe(true);
    }
  });

  it('says a weekday pattern runs only on its days', () => {
    const weekend: Weekday[] = [6, 7];
    for (const day of WEEKDAYS) {
      expect(repeatsOn({ kind: 'weekdays', days: weekend }, day)).toBe(weekend.includes(day));
    }
  });
});

describe('legs that are not times', () => {
  it('refuses a leg that departs and arrives at the same airport', () => {
    const result = reject(
      rotation({
        legs: [leg({ originIcao: 'EHAM', destinationIcao: 'EHAM', departureMinute: 420 })],
      }),
    );
    expect(result.problem).toBe('not_positioned');
    expect(result.detail).toContain('departs and arrives at EHAM');
  });

  it('refuses a negative departure, a zero block and a negative turnaround', () => {
    expect(
      reject(
        rotation({
          legs: [leg({ originIcao: 'EHAM', destinationIcao: 'EGLL', departureMinute: -1 })],
        }),
      ).problem,
    ).toBe('leg_order');
    expect(
      reject(
        rotation({
          legs: [
            leg({
              originIcao: 'EHAM',
              destinationIcao: 'EGLL',
              departureMinute: 420,
              blockMinutes: 0,
            }),
          ],
        }),
      ).problem,
    ).toBe('leg_order');
    expect(
      reject(
        rotation({
          legs: [
            leg({
              originIcao: 'EHAM',
              destinationIcao: 'EGLL',
              departureMinute: 420,
              turnaroundMinutes: -5,
            }),
          ],
        }),
      ).problem,
    ).toBe('turn_too_short');
  });
});

describe('where the aircraft actually is (M2-07)', () => {
  it('accepts a rotation that starts where the aircraft is standing', () => {
    expect(validateRotation(rotation({ aircraftAt: 'EHAM' })).ok).toBe(true);
  });

  it('refuses a rotation that starts somewhere the aircraft is not', () => {
    // M2-07's acceptance criterion. The legs connect perfectly to each other and
    // the rotation closes — it is only impossible because the aeroplane is in a
    // different country.
    const result = validateRotation(rotation({ aircraftAt: 'LFPG' }));

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problem).toBe('not_positioned');
  });

  it('names both airports and the fix, because the fix is not an edit', () => {
    // Every other problem here is mended by changing the schedule. This one is
    // mended by flying the aeroplane, so the message has to say so.
    const result = validateRotation(rotation({ aircraftAt: 'LFPG' }));

    expect(result.ok === false && result.detail).toContain('LFPG');
    expect(result.ok === false && result.detail).toContain('EHAM');
    expect(result.ok === false && result.detail).toMatch(/[Ff]erry/);
  });

  it('does not run the check when the position is unknown', () => {
    // A rotation can be drafted before an aircraft is assigned, and M4-04's
    // delivery is what first gives an airframe a place to be. Undefined means
    // "not known", which is not the same as "wrong".
    expect(validateRotation(rotation({ aircraftAt: undefined })).ok).toBe(true);
  });

  it('is checked before the leg walk, so the message is the useful one', () => {
    // A rotation with both a positioning problem and a short turn should report
    // the position: fixing the turn would leave the player no better off.
    const stranded = rotation({
      aircraftAt: 'LFPG',
      legs: [
        leg({ originIcao: 'EHAM', destinationIcao: 'EGLL', departureMinute: 420 }),
        // Departs before the aircraft could possibly be ready.
        leg({ originIcao: 'EGLL', destinationIcao: 'EHAM', departureMinute: 520 }),
      ],
    });

    const result = validateRotation(stranded);

    expect(result.ok === false && result.problem).toBe('not_positioned');
    expect(result.ok === false && result.detail).toContain('LFPG');
  });
});
