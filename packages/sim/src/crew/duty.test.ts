import { describe, expect, it } from 'vitest';

import { DEFAULT_CREW } from './complement';
import {
  checkRotationDuty,
  crewTimeoutRisk,
  cumulativeVerdict,
  maxFlightDutyMinutes,
  positioningCostMinor,
  positioningFor,
  restRequiredMinutes,
  rollingUsage,
  startsInWocl,
  type DutyLeg,
} from './duty';

/**
 * Duty, rest and fatigue (§9.2, M5-02).
 *
 * The headline is the first block: §9.2 describes one specific failure —
 * *"you built a tight rotation, weather delayed leg two, and now leg four has no
 * legal crew"* — and M5-02's first acceptance criterion is that it works. It is
 * tested by building exactly that rotation and moving exactly that leg, because
 * a mechanic the design doc describes in a sentence should be provable in a
 * test that reads like the sentence.
 */

const DUTY = DEFAULT_CREW.duty;

/** Amsterdam, at UTC+1 standard time; London at UTC. Real offsets, so the WOCL is real. */
const OFFSETS = { EHAM: 60, EGLL: 0 } as const;

const at = (hhmm: string): Date => new Date(`2026-03-10T${hhmm}:00.000Z`);

const leg = (
  departure: string,
  arrival: string,
  originIcao: string,
  destinationIcao: string,
  deadhead = false,
): DutyLeg => ({
  departure: at(departure),
  arrival: at(arrival),
  originIcao,
  destinationIcao,
  ...(deadhead ? { deadhead: true } : {}),
});

/**
 * §13.4's operation, rostered to the edge: four sectors, 45-minute turns, home
 * the same night. Legal, and with three quarters of an hour to spare.
 */
const TIGHT_FOUR_SECTOR_DAY: DutyLeg[] = [
  leg('07:00', '09:00', 'EHAM', 'EGLL'),
  leg('09:45', '11:45', 'EGLL', 'EHAM'),
  leg('12:30', '14:30', 'EHAM', 'EGLL'),
  leg('15:15', '17:15', 'EGLL', 'EHAM'),
];

/** Push every leg after the first later, as a delay on leg two propagates. */
function delayedFrom(legs: readonly DutyLeg[], fromIndex: number, minutes: number): DutyLeg[] {
  const shift = minutes * 60_000;
  return legs.map((entry, index) =>
    index < fromIndex
      ? entry
      : {
          ...entry,
          departure: new Date(entry.departure.getTime() + shift),
          arrival: new Date(entry.arrival.getTime() + shift),
        },
  );
}

describe('the documented failure case (§9.2)', () => {
  const options = { baseIcao: 'EHAM', utcOffsetMinutes: OFFSETS };

  it('a tight four-sector day is legal, and says how little room is left', () => {
    const result = checkRotationDuty(TIGHT_FOUR_SECTOR_DAY, options);

    // One duty period: 45 minutes is a turnaround, not a rest.
    expect(result.periods).toHaveLength(1);
    expect(result.periods[0]?.sectors).toBe(4);
    expect(result.firstIllegalLeg).toBeNull();

    // Four sectors costs two 30-minute reductions off the 13:00 maximum.
    expect(result.legs[3]?.maxFlightDutyMinutes).toBe(720);
    // Report 06:00, last arrival 17:15 — 11h15 of flight duty.
    expect(result.legs[3]?.flightDutyMinutes).toBe(675);

    // Legal, and *tight*, which is the state the whole mechanic turns on.
    expect(result.worst.status).toBe('tight');
    expect(result.legs.map((entry) => entry.verdict.status)).toEqual([
      'legal',
      'legal',
      'legal',
      'tight',
    ]);
  });

  it('a 90-minute weather delay on leg two leaves leg four without legal crew', () => {
    const delayed = delayedFrom(TIGHT_FOUR_SECTOR_DAY, 1, 90);
    const result = checkRotationDuty(delayed, options);

    expect(result.firstIllegalLeg).toBe(3);

    const fourth = result.legs[3];
    expect(fourth?.verdict.status).toBe('illegal');
    // The ceiling did not move: the same four sectors, the same 06:00 report.
    expect(fourth?.maxFlightDutyMinutes).toBe(720);
    expect(fourth?.flightDutyMinutes).toBe(765);

    // And the sentence has to be the reason a player can act on, not "illegal".
    if (fourth?.verdict.status !== 'illegal') throw new Error('expected an illegal verdict');
    expect(fourth.verdict.overMinutes).toBe(45);
    expect(fourth.verdict.reason).toContain('12h45');
    expect(fourth.verdict.reason).toContain('12h');
    expect(fourth.verdict.reason).toContain('4 sectors');
  });

  it('the three legs before it are still legal — only the last one falls off', () => {
    const result = checkRotationDuty(delayedFrom(TIGHT_FOUR_SECTOR_DAY, 1, 90), options);
    expect(result.legs.map((entry) => entry.verdict.status)).toEqual([
      'legal',
      'legal',
      'legal',
      'illegal',
    ]);
    /*
     * This is the part that makes the mechanic fair rather than punitive: the
     * aeroplane flies three of its four sectors and strands itself at the
     * fourth. A model that failed the whole rotation would be easier to write
     * and would teach the player nothing about *where* the plan broke.
     */
  });

  it('the same delay is survivable when the day was not planned to the edge', () => {
    // One sector fewer: 12:30 is the last departure, home at 14:30.
    const roomier = TIGHT_FOUR_SECTOR_DAY.slice(0, 3);
    const result = checkRotationDuty(delayedFrom(roomier, 1, 90), options);
    expect(result.firstIllegalLeg).toBeNull();
    expect(result.worst.status).toBe('legal');
  });
});

describe('maximum flight duty period', () => {
  const MORNING = 9 * 60;

  it('is EASA’s 13:00 for one or two sectors from a favourable start', () => {
    expect(maxFlightDutyMinutes(MORNING, 1, DUTY)).toBe(780);
    expect(maxFlightDutyMinutes(MORNING, 2, DUTY)).toBe(780);
  });

  it('loses half an hour for every sector past the second', () => {
    expect(maxFlightDutyMinutes(MORNING, 3, DUTY)).toBe(750);
    expect(maxFlightDutyMinutes(MORNING, 4, DUTY)).toBe(720);
    expect(maxFlightDutyMinutes(MORNING, 6, DUTY)).toBe(660);
  });

  it('floors at 9:00 however many sectors are flown', () => {
    expect(maxFlightDutyMinutes(MORNING, 10, DUTY)).toBe(540);
    // The floor is a floor, not a hinge: twenty sectors is not negative duty.
    expect(maxFlightDutyMinutes(MORNING, 20, DUTY)).toBe(540);
  });

  it('is shorter for a report inside the window of circadian low', () => {
    const threeAm = 3 * 60;
    expect(startsInWocl(threeAm, DUTY)).toBe(true);
    expect(maxFlightDutyMinutes(threeAm, 2, DUTY)).toBe(780 - 120);
  });

  it('treats 02:00 as inside the WOCL and 06:00 as outside it', () => {
    expect(startsInWocl(2 * 60, DUTY)).toBe(true);
    expect(startsInWocl(6 * 60 - 1, DUTY)).toBe(true);
    expect(startsInWocl(6 * 60, DUTY)).toBe(false);
    expect(startsInWocl(2 * 60 - 1, DUTY)).toBe(false);
  });

  it('normalises a local minute that has wrapped past midnight', () => {
    // A UTC instant plus a positive offset can land past 1440; that is a 03:00
    // local report, not an out-of-range one.
    expect(startsInWocl(1440 + 3 * 60, DUTY)).toBe(true);
    expect(startsInWocl(-1440 + 3 * 60, DUTY)).toBe(true);
  });
});

describe('minimum rest', () => {
  it('is twelve hours at base and ten away', () => {
    expect(restRequiredMinutes(300, true, DUTY)).toBe(720);
    expect(restRequiredMinutes(300, false, DUTY)).toBe(600);
  });

  it('is never shorter than the duty it follows', () => {
    // A thirteen-hour day does not buy back a twelve-hour night.
    expect(restRequiredMinutes(800, true, DUTY)).toBe(800);
    expect(restRequiredMinutes(800, false, DUTY)).toBe(800);
  });
});

describe('duty periods are derived from the gaps, not declared', () => {
  const options = { baseIcao: 'EHAM', utcOffsetMinutes: OFFSETS };

  it('a turnaround keeps one period; a night makes two', () => {
    const sameDay = checkRotationDuty(
      [leg('07:00', '09:00', 'EHAM', 'EGLL'), leg('10:00', '12:00', 'EGLL', 'EHAM')],
      options,
    );
    expect(sameDay.periods).toHaveLength(1);

    const overnight = checkRotationDuty(
      [
        leg('07:00', '09:00', 'EHAM', 'EGLL'),
        {
          ...leg('08:00', '10:00', 'EGLL', 'EHAM'),
          departure: nextDay('08:00'),
          arrival: nextDay('10:00'),
        },
      ],
      options,
    );
    expect(overnight.periods).toHaveLength(2);
  });

  it('a gap one minute short of the required rest does not end the period', () => {
    /*
     * The boundary matters more than it looks. This is the case that lets a
     * player tighten a turnaround and discover that two comfortable days have
     * silently become one that breaks — and the reason the split is computed
     * rather than taken from the schedule.
     */
    const first = leg('07:00', '09:00', 'EHAM', 'EGLL');
    const provisionalDuty = 60 + 120 + 30; // report + block + off duty
    const needed = 30 + restRequiredMinutes(provisionalDuty, false, DUTY) + 60;

    const justShort = new Date(first.arrival.getTime() + (needed - 1) * 60_000);
    const justEnough = new Date(first.arrival.getTime() + needed * 60_000);

    const merged = checkRotationDuty(
      [
        first,
        {
          ...first,
          departure: justShort,
          arrival: new Date(justShort.getTime() + 7_200_000),
          originIcao: 'EGLL',
          destinationIcao: 'EHAM',
        },
      ],
      options,
    );
    expect(merged.periods).toHaveLength(1);

    const split = checkRotationDuty(
      [
        first,
        {
          ...first,
          departure: justEnough,
          arrival: new Date(justEnough.getTime() + 7_200_000),
          originIcao: 'EGLL',
          destinationIcao: 'EHAM',
        },
      ],
      options,
    );
    expect(split.periods).toHaveLength(2);
  });

  it('counts report and shutdown as duty, so duty always exceeds block time', () => {
    const result = checkRotationDuty([leg('07:00', '09:00', 'EHAM', 'EGLL')], options);
    const period = result.periods[0];
    expect(period?.blockMinutes).toBe(120);
    expect(period?.dutyMinutes).toBe(120 + 60 + 30);
    // Flight duty stops at the last arrival; duty runs on to off-duty.
    expect(period?.flightDutyMinutes).toBe(180);
  });

  it('an empty rotation has no periods and no verdict to give', () => {
    const result = checkRotationDuty([], options);
    expect(result.periods).toEqual([]);
    expect(result.firstIllegalLeg).toBeNull();
    expect(result.worst).toEqual({ status: 'legal', marginMinutes: 0 });
  });
});

describe('deadheading', () => {
  const options = { baseIcao: 'EHAM', utcOffsetMinutes: OFFSETS };

  it('is duty but not a sector, so it does not shorten the day’s ceiling', () => {
    const operating = [
      leg('09:00', '11:00', 'EHAM', 'EGLL'),
      leg('11:45', '13:45', 'EGLL', 'EHAM'),
      leg('14:30', '16:30', 'EHAM', 'EGLL'),
    ];
    const withDeadhead = [leg('07:30', '08:30', 'EHAM', 'EHAM', true), ...operating];

    expect(checkRotationDuty(operating, options).legs[0]?.maxFlightDutyMinutes).toBe(750);
    // Still three sectors, so still 12:30 — the deadhead added time, not a sector.
    expect(checkRotationDuty(withDeadhead, options).legs[0]?.maxFlightDutyMinutes).toBe(750);
  });

  it('still shortens the day if it drags the report into the WOCL', () => {
    /*
     * Found by getting a fixture wrong, and worth keeping. A deadhead does not
     * cost a sector, but it does move the *report*, and an early enough one puts
     * the report inside the window of circadian low — which takes two hours off
     * the ceiling that the sector count never touched.
     *
     * It is the right answer, and it is the kind of interaction a player would
     * reasonably not expect: positioning crew out the night before is cheaper
     * than positioning them at dawn, for a reason that has nothing to do with
     * hotels.
     */
    const operating = [
      leg('09:00', '11:00', 'EHAM', 'EGLL'),
      leg('11:45', '13:45', 'EGLL', 'EHAM'),
      leg('14:30', '16:30', 'EHAM', 'EGLL'),
    ];
    const dawnDeadhead = [leg('05:30', '06:30', 'EHAM', 'EHAM', true), ...operating];

    const result = checkRotationDuty(dawnDeadhead, options);
    // Report 04:30Z is 05:30 at Schiphol: inside the WOCL, so 12:30 becomes 10:30.
    expect(result.legs[0]?.maxFlightDutyMinutes).toBe(750 - 120);
    expect(result.periods[0]?.sectors).toBe(3);
  });

  it('does not add to the block time the 28-day flight-time limit counts', () => {
    const result = checkRotationDuty(
      [leg('07:00', '09:00', 'EHAM', 'EGLL', true), leg('09:45', '11:45', 'EGLL', 'EHAM')],
      options,
    );
    expect(result.periods[0]?.blockMinutes).toBe(120);
    expect(result.periods[0]?.sectors).toBe(1);
  });
});

describe('crew timeout risk, as the 0–1 M2-08 left for M5', () => {
  it('is zero while there is more slack than the warning margin', () => {
    expect(crewTimeoutRisk(DUTY.timeoutWarningMarginMinutes, DUTY)).toBe(0);
    expect(crewTimeoutRisk(DUTY.timeoutWarningMarginMinutes + 120, DUTY)).toBe(0);
  });

  it('rises to one as the margin closes', () => {
    expect(crewTimeoutRisk(0, DUTY)).toBe(1);
    expect(crewTimeoutRisk(-30, DUTY)).toBe(1);
    expect(crewTimeoutRisk(DUTY.timeoutWarningMarginMinutes / 2, DUTY)).toBeCloseTo(0.5, 6);
  });

  it('is monotonic, so a tighter day is never reported as safer', () => {
    let previous = -1;
    for (let margin = DUTY.timeoutWarningMarginMinutes; margin >= 0; margin -= 5) {
      const risk = crewTimeoutRisk(margin, DUTY);
      expect(risk).toBeGreaterThanOrEqual(previous);
      previous = risk;
    }
  });
});

describe('cumulative limits over rolling windows', () => {
  const now = new Date('2026-03-10T12:00:00.000Z');
  const daysAgo = (days: number): Date => new Date(now.getTime() - days * 86_400_000);

  it('counts any seven consecutive days, not a calendar week', () => {
    const history = [
      { offDutyAt: daysAgo(1), dutyMinutes: 600, blockMinutes: 400 },
      { offDutyAt: daysAgo(6.5), dutyMinutes: 600, blockMinutes: 400 },
      { offDutyAt: daysAgo(8), dutyMinutes: 600, blockMinutes: 400 },
    ];
    const usage = rollingUsage(history, now);
    expect(usage.dutyMinutes7Days).toBe(1200);
    expect(usage.dutyMinutes14Days).toBe(1800);
    expect(usage.dutyMinutes28Days).toBe(1800);
  });

  it('forgets what fell out of the 28-day window', () => {
    const usage = rollingUsage(
      [{ offDutyAt: daysAgo(29), dutyMinutes: 600, blockMinutes: 400 }],
      now,
    );
    expect(usage.dutyMinutes28Days).toBe(0);
  });

  it('refuses a duty that would break the 7-day ceiling, naming it', () => {
    const history = [
      { offDutyAt: daysAgo(1), dutyMinutes: DUTY.maxDutyMinutesPer7Days, blockMinutes: 0 },
    ];
    const verdict = cumulativeVerdict(
      history,
      { at: now, dutyMinutes: 60, blockMinutes: 60 },
      DUTY,
    );
    expect(verdict.status).toBe('illegal');
    if (verdict.status !== 'illegal') throw new Error('expected illegal');
    expect(verdict.reason).toContain('7 days');
    expect(verdict.overMinutes).toBe(60);
  });

  it('reports the tightest window rather than the first', () => {
    // Comfortably inside 7 days, right up against the 28-day block-time limit.
    const history = [
      {
        offDutyAt: daysAgo(20),
        dutyMinutes: 60,
        blockMinutes: DUTY.maxBlockMinutesPer28Days - 30,
      },
    ];
    const verdict = cumulativeVerdict(
      history,
      { at: now, dutyMinutes: 60, blockMinutes: 60 },
      DUTY,
    );
    expect(verdict.status).toBe('illegal');
    if (verdict.status !== 'illegal') throw new Error('expected illegal');
    expect(verdict.reason).toContain('block time');
  });

  it('warns before it refuses', () => {
    const history = [
      {
        offDutyAt: daysAgo(1),
        dutyMinutes: DUTY.maxDutyMinutesPer7Days - 60 - DUTY.timeoutWarningMarginMinutes,
        blockMinutes: 0,
      },
    ];
    const verdict = cumulativeVerdict(
      history,
      { at: now, dutyMinutes: 60, blockMinutes: 60 },
      DUTY,
    );
    expect(verdict.status).toBe('tight');
  });

  it('an airline with no history is simply legal', () => {
    expect(
      cumulativeVerdict([], { at: now, dutyMinutes: 600, blockMinutes: 400 }, DUTY).status,
    ).toBe('legal');
  });
});

describe('positioning', () => {
  const options = { baseIcao: 'EHAM', utcOffsetMinutes: OFFSETS };

  it('bills a hotel when the day ends away from base', () => {
    const nightStop = checkRotationDuty(
      [
        leg('07:00', '09:00', 'EHAM', 'EGLL'),
        {
          ...leg('08:00', '10:00', 'EGLL', 'EHAM'),
          departure: nextDay('08:00'),
          arrival: nextDay('10:00'),
        },
      ],
      options,
    );
    const needs = positioningFor(nightStop.periods, 'EHAM');
    expect(needs).toHaveLength(1);
    expect(needs[0]).toMatchObject({ kind: 'hotel', icao: 'EGLL', nights: 1 });
  });

  it('bills nothing for a rotation that gets home', () => {
    const result = checkRotationDuty(TIGHT_FOUR_SECTOR_DAY, options);
    expect(positioningFor(result.periods, 'EHAM')).toEqual([]);
  });

  it('bills a deadhead when a day starts where the crew are not', () => {
    // One period that begins at Heathrow with the crew still at Schiphol.
    const result = checkRotationDuty([leg('07:00', '09:00', 'EGLL', 'EHAM')], options);
    const needs = positioningFor(result.periods, 'EHAM');
    expect(needs).toHaveLength(1);
    expect(needs[0]).toMatchObject({ kind: 'deadhead', icao: 'EGLL' });
  });

  it('costs per head, which is what makes a wide cabin expensive to strand', () => {
    const needs = [{ kind: 'hotel' as const, icao: 'EGLL', nights: 2, period: 0 }];
    expect(positioningCostMinor(needs, 6, DUTY)).toBe(DUTY.hotelCostPerHeadPerNightMinor * 2 * 6);
    expect(positioningCostMinor(needs, 12, DUTY)).toBe(DUTY.hotelCostPerHeadPerNightMinor * 2 * 12);
  });
});

describe('honesty about missing airport data', () => {
  it('names the airports whose local time had to be assumed', () => {
    const result = checkRotationDuty(TIGHT_FOUR_SECTOR_DAY, { baseIcao: 'EHAM' });
    // Only the reporting airport is looked up, so only it can be reported.
    expect(result.unknownOffsets).toEqual(['EHAM']);
  });

  it('reports nothing when every offset it needed was supplied', () => {
    const result = checkRotationDuty(TIGHT_FOUR_SECTOR_DAY, {
      baseIcao: 'EHAM',
      utcOffsetMinutes: OFFSETS,
    });
    expect(result.unknownOffsets).toEqual([]);
  });
});

function nextDay(hhmm: string): Date {
  return new Date(`2026-03-11T${hhmm}:00.000Z`);
}
