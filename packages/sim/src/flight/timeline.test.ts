import { describe, expect, it } from 'vitest';

import {
  airborneMinutes,
  allocateAirborne,
  DEFAULT_FLIGHT_PROFILE,
  DEFAULT_TURNAROUND_MINUTES,
  type FlightProfile,
} from './profile';
import {
  addMinutes,
  buildTimeline,
  estimatedArrival,
  type FlightPlan,
  phaseAt,
  type RouteLeg,
  shiftFrom,
  trackFraction,
  truncateAt,
  windowIndexAt,
} from './timeline';

const PROFILE: FlightProfile = DEFAULT_FLIGHT_PROFILE;
const CREATED = new Date('2024-10-20T06:00:00.000Z');
const OFF_BLOCKS = new Date('2024-10-20T08:00:00.000Z');

/** EHAM–KJFK, long enough to have a real cruise. */
function longHaul(overrides: Partial<FlightPlan> = {}): FlightPlan {
  return {
    originIcao: 'EHAM',
    destinationIcao: 'KJFK',
    distanceNm: 3157,
    cruiseSpeedKt: 480,
    createdAt: CREATED,
    scheduledDeparture: OFF_BLOCKS,
    turnaroundMinutes: DEFAULT_TURNAROUND_MINUTES,
    ...overrides,
  };
}

const NOMINAL_ORDER = [
  'scheduled',
  'boarding',
  'pushback',
  'taxi_out',
  'departure',
  'climb',
  'cruise',
  'descent',
  'approach',
  'landing',
  'taxi_in',
  'turnaround',
  'idle',
];

describe('airborne time', () => {
  it('is the sector at cruise speed plus the manoeuvre allowance', () => {
    // 3157 nm at 480 kt is 394.6 minutes of arithmetic; the aircraft is up for
    // longer than that because it climbs and is vectored.
    expect(airborneMinutes(3157, 480, PROFILE)).toBeCloseTo((60 * 3157) / 480 + 12, 6);
  });

  it('refuses a non-positive cruise speed', () => {
    expect(() => airborneMinutes(100, 0, PROFILE)).toThrow(/positive/);
    expect(() => airborneMinutes(100, -450, PROFILE)).toThrow(/positive/);
  });

  it('refuses a negative distance', () => {
    expect(() => airborneMinutes(-1, 450, PROFILE)).toThrow(/zero or more/);
  });
});

describe('allocateAirborne', () => {
  it('always splits exactly the airborne time, whatever the sector', () => {
    // The property that matters: no minutes invented, none lost. Checked across
    // four orders of magnitude because the short end takes a different branch.
    for (const distanceNm of [0, 50, 100, 400, 1000, 3157, 7000]) {
      const split = allocateAirborne(distanceNm, 480, PROFILE);
      const sum =
        split.departureMinutes +
        split.climbMinutes +
        split.cruiseMinutes +
        split.descentMinutes +
        split.approachMinutes +
        split.landingMinutes;
      expect(sum).toBeCloseTo(split.totalMinutes, 6);
      expect(split.totalMinutes).toBeCloseTo(airborneMinutes(distanceNm, 480, PROFILE), 6);
    }
  });

  it('gives a long sector its nominal climb and descent, and cruise the rest', () => {
    const split = allocateAirborne(3157, 480, PROFILE);
    expect(split.climbMinutes).toBe(PROFILE.climbMinutes);
    expect(split.descentMinutes).toBe(PROFILE.descentMinutes);
    expect(split.cruiseMinutes).toBeGreaterThan(300);
  });

  it('gives a short sector no cruise at all, and scales climb and descent together', () => {
    // 100 nm at 450 kt is 25 airborne minutes; climb and descent alone want 38.
    // The aircraft levels off briefly or not at all, which is what really happens.
    const split = allocateAirborne(100, 450, PROFILE);
    expect(split.cruiseMinutes).toBe(0);
    expect(split.climbMinutes).toBeLessThan(PROFILE.climbMinutes);
    expect(split.descentMinutes).toBeLessThan(PROFILE.descentMinutes);
    expect(split.climbMinutes / split.descentMinutes).toBeCloseTo(
      PROFILE.climbMinutes / PROFILE.descentMinutes,
      6,
    );
  });

  it('scales even the fixed phases when there is not enough time for them', () => {
    // Needs a profile mean enough to make the airborne time shorter than lining
    // up and landing. Pathological, but it must not produce negative durations.
    const mean: FlightProfile = { ...PROFILE, manoeuvreMinutes: 4 };
    const split = allocateAirborne(0, 480, mean);
    expect(split.totalMinutes).toBeCloseTo(4, 6);
    expect(split.departureMinutes).toBeGreaterThan(0);
    expect(split.climbMinutes).toBe(0);
    expect(split.cruiseMinutes).toBe(0);
    expect(split.departureMinutes + split.approachMinutes + split.landingMinutes).toBeCloseTo(4, 6);
  });

  it('omits takeoff and initial climb for a leg that starts in cruise', () => {
    const split = allocateAirborne(500, 480, PROFILE, { fromCruise: true });
    expect(split.departureMinutes).toBe(0);
    expect(split.climbMinutes).toBe(0);
    expect(split.cruiseMinutes).toBeGreaterThan(0);
    expect(split.descentMinutes).toBe(PROFILE.descentMinutes);
  });
});

describe('buildTimeline', () => {
  it('lays out the thirteen phases of §3.3 in order', () => {
    const { windows } = buildTimeline(longHaul(), PROFILE);
    expect(windows.map((w) => w.phase)).toEqual(NOMINAL_ORDER);
  });

  it('leaves no gap and no overlap between phases', () => {
    const { windows } = buildTimeline(longHaul(), PROFILE);
    for (let i = 0; i < windows.length - 1; i += 1) {
      const here = windows[i];
      const next = windows[i + 1];
      expect(here?.to?.getTime()).toBe(next?.from.getTime());
    }
    expect(windows[windows.length - 1]?.to).toBeNull();
  });

  it('sizes boarding backwards from the scheduled off-blocks time', () => {
    // A timetable shows off-blocks, so that is what `scheduledDeparture` means.
    const { windows } = buildTimeline(longHaul(), PROFILE);
    const boarding = windows.find((w) => w.phase === 'boarding');
    expect(boarding?.to?.toISOString()).toBe(OFF_BLOCKS.toISOString());
    expect(boarding?.from.toISOString()).toBe(
      addMinutes(OFF_BLOCKS, -PROFILE.boardingMinutes).toISOString(),
    );
  });

  it('refuses a flight created after its own boarding should have started', () => {
    // A scheduling bug, not a delay. M2-03 must not be able to produce one quietly.
    expect(() =>
      buildTimeline(longHaul({ createdAt: addMinutes(OFF_BLOCKS, -5) }), PROFILE),
    ).toThrow(/Schedule it earlier/);
  });

  it('refuses a flight from an airport to itself', () => {
    expect(() => buildTimeline(longHaul({ destinationIcao: 'EHAM' }), PROFILE)).toThrow(
      /cannot depart and arrive/,
    );
  });

  it('refuses a negative turnaround', () => {
    expect(() => buildTimeline(longHaul({ turnaroundMinutes: -1 }), PROFILE)).toThrow(
      /zero or more/,
    );
  });

  it('refuses an invalid date', () => {
    expect(() =>
      buildTimeline(longHaul({ scheduledDeparture: new Date('nope') }), PROFILE),
    ).toThrow(/invalid/);
  });

  it('anchors the leg at the start of the takeoff roll and the end of the landing', () => {
    // Track fraction 0 has to mean "at the origin airport", or the map draws the
    // aircraft somewhere it never was.
    const { windows, leg } = buildTimeline(longHaul(), PROFILE);
    const departure = windows.find((w) => w.phase === 'departure');
    const landing = windows.find((w) => w.phase === 'landing');
    expect(leg.startedAt.getTime()).toBe(departure?.from.getTime());
    expect(leg.endsAt.getTime()).toBe(landing?.to?.getTime());
    expect(leg.fromIcao).toBe('EHAM');
    expect(leg.toIcao).toBe('KJFK');
    expect(leg.flownFraction).toBe(1);
  });

  it('still produces all thirteen phases on a sector too short for cruise', () => {
    // The cruise window is zero-length rather than missing: the state machine
    // walks the same ladder however short the hop.
    const { windows } = buildTimeline(longHaul({ distanceNm: 100, cruiseSpeedKt: 450 }), PROFILE);
    expect(windows.map((w) => w.phase)).toEqual(NOMINAL_ORDER);
    const cruise = windows.find((w) => w.phase === 'cruise');
    expect(cruise?.to?.getTime()).toBe(cruise?.from.getTime());
  });
});

describe('phaseAt', () => {
  const { windows } = buildTimeline(longHaul(), PROFILE);

  it('answers scheduled before the flight exists and idle long after', () => {
    expect(phaseAt(windows, new Date('2020-01-01T00:00:00.000Z'))).toBe('scheduled');
    expect(phaseAt(windows, new Date('2030-01-01T00:00:00.000Z'))).toBe('idle');
  });

  it('treats a boundary instant as the start of the later phase', () => {
    expect(phaseAt(windows, OFF_BLOCKS)).toBe('pushback');
    expect(phaseAt(windows, addMinutes(OFF_BLOCKS, -1))).toBe('boarding');
  });

  it('passes through a zero-length phase rather than parking in it', () => {
    const short = buildTimeline(longHaul({ distanceNm: 100, cruiseSpeedKt: 450 }), PROFILE);
    const cruise = short.windows.find((w) => w.phase === 'cruise');
    expect(cruise).toBeDefined();
    if (cruise) expect(phaseAt(short.windows, cruise.from)).toBe('descent');
  });

  it('gives the same answer whatever order the instants are asked in', () => {
    // The M1-07 criterion, as a property: position is derivable from the state
    // alone, with no stored per-tick history. If anything accumulated, asking
    // out of order would disagree with asking in order.
    const start = windows[0]?.from.getTime() ?? 0;
    const instants = Array.from({ length: 200 }, (_, i) => new Date(start + i * 5 * 60_000));
    const forwards = instants.map((t) => phaseAt(windows, t));
    const shuffled = [...instants.keys()].sort((a, b) => ((a * 7919) % 200) - ((b * 7919) % 200));
    for (const i of shuffled) {
      const t = instants[i];
      if (t) expect(phaseAt(windows, t)).toBe(forwards[i]);
    }
  });
});

describe('windowIndexAt', () => {
  it('answers the first window for an empty-ish query before the flight', () => {
    const { windows } = buildTimeline(longHaul(), PROFILE);
    expect(windowIndexAt(windows, new Date('2000-01-01T00:00:00.000Z'))).toBe(0);
  });
});

describe('truncateAt', () => {
  it('keeps what happened and closes the phase it happened in', () => {
    const { windows } = buildTimeline(longHaul(), PROFILE);
    const at = addMinutes(OFF_BLOCKS, 3);
    const kept = truncateAt(windows, at);

    expect(kept.map((w) => w.phase)).toEqual(['scheduled', 'boarding', 'pushback']);
    expect(kept[kept.length - 1]?.to?.getTime()).toBe(at.getTime());
    // The original is untouched — every builder here returns new windows.
    expect(windows.map((w) => w.phase)).toEqual(NOMINAL_ORDER);
  });
});

describe('shiftFrom', () => {
  it('extends the phase in progress and moves everything after it', () => {
    const { windows } = buildTimeline(longHaul(), PROFILE);
    const at = addMinutes(OFF_BLOCKS, -10);
    const shifted = shiftFrom(windows, at, 30);

    const boardingBefore = windows.find((w) => w.phase === 'boarding');
    const boardingAfter = shifted.find((w) => w.phase === 'boarding');
    expect(boardingAfter?.from.getTime()).toBe(boardingBefore?.from.getTime());
    expect(boardingAfter?.to?.getTime()).toBe((boardingBefore?.to?.getTime() ?? 0) + 30 * 60_000);

    const pushbackBefore = windows.find((w) => w.phase === 'pushback');
    const pushbackAfter = shifted.find((w) => w.phase === 'pushback');
    expect(pushbackAfter?.from.getTime()).toBe((pushbackBefore?.from.getTime() ?? 0) + 30 * 60_000);
  });

  it('leaves phases that already finished exactly where they happened', () => {
    const { windows } = buildTimeline(longHaul(), PROFILE);
    const shifted = shiftFrom(windows, addMinutes(OFF_BLOCKS, -10), 30);
    expect(shifted[0]?.from.getTime()).toBe(windows[0]?.from.getTime());
    expect(shifted[0]?.to?.getTime()).toBe(windows[0]?.to?.getTime());
  });

  it('keeps the terminal window open', () => {
    const { windows } = buildTimeline(longHaul(), PROFILE);
    const shifted = shiftFrom(windows, CREATED, 30);
    expect(shifted[shifted.length - 1]?.to).toBeNull();
  });
});

describe('estimatedArrival', () => {
  it('is on-blocks — the start of the turnaround', () => {
    const { windows } = buildTimeline(longHaul(), PROFILE);
    const turnaround = windows.find((w) => w.phase === 'turnaround');
    expect(estimatedArrival(windows)?.getTime()).toBe(turnaround?.from.getTime());
  });

  it('is null for a flight with no turnaround left in its timeline', () => {
    expect(estimatedArrival([{ phase: 'idle', from: CREATED, to: null }])).toBeNull();
  });
});

describe('trackFraction', () => {
  const { leg } = buildTimeline(longHaul(), PROFILE);
  const legs: RouteLeg[] = [leg];

  it('is null while the aircraft is still on the ground', () => {
    expect(trackFraction(legs, CREATED)).toBeNull();
  });

  it('is zero at the start of the takeoff roll and one at touchdown', () => {
    expect(trackFraction(legs, leg.startedAt)?.fraction).toBe(0);
    expect(trackFraction(legs, leg.endsAt)?.fraction).toBe(1);
  });

  it('stays at one after the flight has landed', () => {
    expect(trackFraction(legs, addMinutes(leg.endsAt, 500))?.fraction).toBe(1);
  });

  it('scales by how much of the track the leg actually covered', () => {
    // A leg cut short by a diversion covers only part of its own track, so being
    // halfway through its time means halfway to where it turned — not halfway
    // to the airport it never reached.
    const cut: RouteLeg = { ...leg, flownFraction: 0.4 };
    const midpoint = new Date((cut.startedAt.getTime() + cut.endsAt.getTime()) / 2);
    expect(trackFraction([cut], midpoint)?.fraction).toBeCloseTo(0.2, 10);
  });

  it('reports the latest leg once a replan has started one', () => {
    const second: RouteLeg = {
      fromIcao: null,
      toIcao: 'EGLL',
      distanceNm: 300,
      startedAt: addMinutes(leg.startedAt, 60),
      endsAt: addMinutes(leg.startedAt, 120),
      flownFraction: 1,
    };
    const found = trackFraction([{ ...leg, endsAt: second.startedAt }, second], second.endsAt);
    expect(found?.leg.toIcao).toBe('EGLL');
    expect(found?.fraction).toBe(1);
  });

  it('treats a zero-length leg as flown out rather than dividing by zero', () => {
    const instant: RouteLeg = { ...leg, endsAt: leg.startedAt };
    expect(trackFraction([instant], leg.startedAt)?.fraction).toBe(1);
  });
});
