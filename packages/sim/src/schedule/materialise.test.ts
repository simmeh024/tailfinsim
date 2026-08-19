import { describe, expect, it } from 'vitest';

import {
  applyEdit,
  DEFAULT_MATERIALISATION,
  type Horizon,
  horizonFrom,
  materialiseRotation,
  MAX_HORIZON_DAYS,
  rollHorizon,
} from './materialise';
import { MINUTES_PER_DAY, type Rotation, type ScheduledLeg, validateRotation } from './rotation';

/**
 * Rolling a rotation forward into dated flights (M2-03).
 *
 * Three claims are load-bearing here, and they are the issue's three acceptance
 * criteria:
 *
 *   1. **Flights keep appearing with no player action.** Tested by rolling the
 *      horizon day after day and proving the stream never gaps and never
 *      duplicates.
 *   2. **The roll is idempotent.** Every key is a fact about the schedule, never
 *      about the run, so running the same window twice changes nothing.
 *   3. **An edit touches only future unflown legs.** Anything already departed
 *      survives it, and a leg the edit did not change is not churned.
 */

function leg(
  originIcao: string,
  destinationIcao: string,
  departureMinute: number,
  overrides: Partial<ScheduledLeg> = {},
): ScheduledLeg {
  return {
    originIcao,
    destinationIcao,
    departureMinute,
    blockMinutes: 95,
    turnaroundMinutes: 40,
    hasSlot: true,
    ...overrides,
  };
}

/** The App. F.3 double round trip: EHAM–EGLL and back, twice, from 07:00. */
const DAILY: Rotation = {
  id: 'rot-1',
  legs: [
    leg('EHAM', 'EGLL', 420),
    leg('EGLL', 'EHAM', 555),
    leg('EHAM', 'EGLL', 690),
    leg('EGLL', 'EHAM', 825),
  ],
  repeat: { kind: 'daily' },
  crewLegal: true,
};

/** 2026-08-17 is a Monday, which keeps the weekday arithmetic legible. */
const MONDAY = new Date('2026-08-17T00:00:00Z');

function days(n: number): number {
  return n * MINUTES_PER_DAY * 60_000;
}

function window(from: Date, dayCount: number): Horizon {
  return { from, to: new Date(from.getTime() + days(dayCount)) };
}

describe('the fixtures are rotations the model would accept', () => {
  it('validates', () => {
    expect(validateRotation(DAILY)).toEqual({ ok: true });
  });
});

describe('materialising a horizon', () => {
  it('produces every leg of every day in the window', () => {
    const flights = materialiseRotation(DAILY, window(MONDAY, 7));
    expect(flights).toHaveLength(4 * 7);
    expect(flights[0]?.scheduledDeparture.toISOString()).toBe('2026-08-17T07:00:00.000Z');
    expect(flights[0]?.scheduledArrival.toISOString()).toBe('2026-08-17T08:35:00.000Z');
    expect(flights.at(-1)?.scheduledDeparture.toISOString()).toBe('2026-08-23T13:45:00.000Z');
  });

  it('returns them in departure order', () => {
    const flights = materialiseRotation(DAILY, window(MONDAY, 3));
    const times = flights.map((f) => f.scheduledDeparture.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('carries the leg the flight came from', () => {
    const [first, second] = materialiseRotation(DAILY, window(MONDAY, 1));
    expect(first).toMatchObject({
      rotationId: 'rot-1',
      cycleDate: '2026-08-17',
      legIndex: 0,
      originIcao: 'EHAM',
      destinationIcao: 'EGLL',
      key: 'rot-1:2026-08-17:0',
    });
    expect(second?.originIcao).toBe('EGLL');
  });

  it('treats the window as half-open: from is in, to is out', () => {
    // A window that starts exactly on the first departure includes it.
    const onTheNose = materialiseRotation(DAILY, {
      from: new Date('2026-08-17T07:00:00Z'),
      to: new Date('2026-08-17T09:15:00Z'),
    });
    expect(onTheNose.map((f) => f.legIndex)).toEqual([0]);

    // One that ends exactly on a departure excludes it, so two adjacent windows
    // never produce the same flight twice.
    const upTo = materialiseRotation(DAILY, {
      from: new Date('2026-08-17T00:00:00Z'),
      to: new Date('2026-08-17T09:15:00Z'),
    });
    expect(upTo.map((f) => f.legIndex)).toEqual([0]);
  });

  it('returns nothing for an empty or backwards window', () => {
    expect(materialiseRotation(DAILY, { from: MONDAY, to: MONDAY })).toEqual([]);
    expect(
      materialiseRotation(DAILY, { from: MONDAY, to: new Date(MONDAY.getTime() - 1) }),
    ).toEqual([]);
  });
});

describe('rotations that run past midnight', () => {
  /** Out at 22:00, back at 00:15 the next day — minute 1,455 of its own cycle. */
  const REDEYE: Rotation = {
    id: 'redeye',
    legs: [leg('EHAM', 'LEPA', 1_320), leg('LEPA', 'EHAM', 1_455)],
    repeat: { kind: 'daily' },
    crewLegal: true,
  };

  it('is a rotation the model accepts', () => {
    expect(validateRotation(REDEYE)).toEqual({ ok: true });
  });

  it('keeps the return leg in the cycle it belongs to', () => {
    const flights = materialiseRotation(REDEYE, window(MONDAY, 1));
    // Monday's outbound is in the window; Monday's return departs on Tuesday and
    // is not. The one return that *is* in the window belongs to Sunday's cycle.
    const sundayReturn = flights.find((f) => f.legIndex === 1);
    expect(sundayReturn?.cycleDate).toBe('2026-08-16');
    expect(sundayReturn?.scheduledDeparture.toISOString()).toBe('2026-08-17T00:15:00.000Z');
    expect(sundayReturn?.key).toBe('redeye:2026-08-16:1');
  });

  it('finds it at the leading edge of a window it would otherwise miss', () => {
    // The window opens after midnight, so the only way to see this flight is to
    // walk back into the previous day's cycle.
    const flights = materialiseRotation(REDEYE, {
      from: new Date('2026-08-17T00:00:00Z'),
      to: new Date('2026-08-17T01:00:00Z'),
    });
    expect(flights).toHaveLength(1);
    expect(flights[0]?.cycleDate).toBe('2026-08-16');
  });
});

describe('weekday patterns', () => {
  const WEEKENDS: Rotation = { ...DAILY, id: 'we', repeat: { kind: 'weekdays', days: [6, 7] } };

  it('runs only on the chosen days', () => {
    const flights = materialiseRotation(WEEKENDS, window(MONDAY, 7));
    const dates = [...new Set(flights.map((f) => f.cycleDate))].sort();
    // The week from Monday 17 August contains one Saturday and one Sunday.
    expect(dates).toEqual(['2026-08-22', '2026-08-23']);
    expect(flights).toHaveLength(8);
  });

  it('produces nothing in a window that misses its days', () => {
    const midweek = {
      from: new Date('2026-08-18T00:00:00Z'),
      to: new Date('2026-08-21T00:00:00Z'),
    };
    expect(materialiseRotation(WEEKENDS, midweek)).toEqual([]);
  });
});

describe('idempotency', () => {
  it('gives the same keys for the same window, every time', () => {
    const once = materialiseRotation(DAILY, window(MONDAY, 5));
    const twice = materialiseRotation(DAILY, window(MONDAY, 5));
    expect(twice).toEqual(once);
  });

  it('never repeats a key within a window', () => {
    const flights = materialiseRotation(DAILY, window(MONDAY, 30));
    expect(new Set(flights.map((f) => f.key)).size).toBe(flights.length);
  });

  it('builds the key from the schedule, not from the run', () => {
    // The guarantee in one assertion: nothing about *when* the roll happened is
    // in the key, so overlapping windows agree about the flights they share.
    const early = materialiseRotation(DAILY, window(MONDAY, 3));
    const late = materialiseRotation(DAILY, window(new Date(MONDAY.getTime() + days(1)), 3));
    const shared = early.filter((f) => late.some((other) => other.key === f.key));

    expect(shared.length).toBeGreaterThan(0);
    for (const flight of shared) {
      expect(late.find((other) => other.key === flight.key)).toEqual(flight);
    }
  });
});

describe('rolling the horizon forward', () => {
  it('generates flights continuously with no player action', () => {
    // The App. F.3 promise, tested the way it is actually operated: a worker
    // rolls a 14-day window forward a day at a time, for a fortnight.
    let booked: ReturnType<typeof materialiseRotation> = [];
    let now = MONDAY;

    for (let day = 0; day < 14; day += 1) {
      const fresh = rollHorizon(DAILY, booked, horizonFrom(now));
      booked = [...booked, ...fresh];
      now = new Date(now.getTime() + days(1));
      // Every roll after the first adds exactly one new day of flying: the day
      // that just came into view at the far edge.
      if (day > 0) expect(fresh).toHaveLength(4);
    }

    expect(new Set(booked.map((f) => f.key)).size).toBe(booked.length);
    // 14 days of horizon plus 13 days of rolling, four legs a day.
    expect(booked).toHaveLength(4 * 27);
  });

  it('leaves the stream unbroken — every day between the first and last is flown', () => {
    let booked: ReturnType<typeof materialiseRotation> = [];
    let now = MONDAY;
    for (let day = 0; day < 10; day += 1) {
      booked = [...booked, ...rollHorizon(DAILY, booked, horizonFrom(now))];
      now = new Date(now.getTime() + days(1));
    }

    const flownDates = [...new Set(booked.map((f) => f.cycleDate))].sort();
    const first = flownDates[0];
    const last = flownDates.at(-1);
    expect(first).toBe('2026-08-17');
    expect(last).toBeDefined();

    const span = (Date.parse(`${last!}T00:00:00Z`) - Date.parse(`${first!}T00:00:00Z`)) / days(1);
    expect(flownDates).toHaveLength(span + 1);
  });

  it('adds nothing when the horizon has not moved', () => {
    const horizon = horizonFrom(MONDAY);
    const booked = materialiseRotation(DAILY, horizon);
    expect(rollHorizon(DAILY, booked, horizon)).toEqual([]);
  });
});

describe('the horizon itself', () => {
  it('defaults to a fortnight of game time', () => {
    expect(DEFAULT_MATERIALISATION.horizonDays).toBe(14);
    const horizon = horizonFrom(MONDAY);
    expect(horizon.to.getTime() - horizon.from.getTime()).toBe(days(14));
  });

  it('refuses a horizon that is not a length of time', () => {
    expect(() => horizonFrom(MONDAY, { horizonDays: 0 })).toThrow(/positive number of days/);
    expect(() => horizonFrom(MONDAY, { horizonDays: -3 })).toThrow(/positive number of days/);
    expect(() => horizonFrom(MONDAY, { horizonDays: Number.NaN })).toThrow(/positive number/);
  });

  it('refuses to walk a window that is obviously a mistake', () => {
    // A year of flights is not a long horizon, it is a unit error.
    expect(() => materialiseRotation(DAILY, window(MONDAY, MAX_HORIZON_DAYS + 1))).toThrow(
      /Refusing to materialise/,
    );
    expect(() => materialiseRotation(DAILY, window(MONDAY, MAX_HORIZON_DAYS))).not.toThrow();
  });

  it('refuses an invalid instant', () => {
    expect(() => materialiseRotation(DAILY, { from: new Date(Number.NaN), to: MONDAY })).toThrow(
      /invalid instant/,
    );
  });
});

describe('editing a schedule', () => {
  const horizon = horizonFrom(MONDAY);
  const existing = materialiseRotation(DAILY, horizon);
  /** Thursday morning — three days of flying already on the books behind it. */
  const effectiveFrom = new Date('2026-08-20T00:00:00Z');

  /** The last leg moves 15 minutes later. Legs 1 to 3 are untouched. */
  const EDITED: Rotation = {
    ...DAILY,
    legs: [
      leg('EHAM', 'EGLL', 420),
      leg('EGLL', 'EHAM', 555),
      leg('EHAM', 'EGLL', 690),
      leg('EGLL', 'EHAM', 840),
    ],
  };

  it('is still a rotation the model accepts', () => {
    expect(validateRotation(EDITED)).toEqual({ ok: true });
  });

  it('leaves everything before the edit alone', () => {
    const plan = applyEdit({ existing, next: EDITED, effectiveFrom, horizon });
    for (const flight of plan.cancel) {
      expect(flight.scheduledDeparture.getTime()).toBeGreaterThanOrEqual(effectiveFrom.getTime());
    }
    for (const flight of plan.create) {
      expect(flight.scheduledDeparture.getTime()).toBeGreaterThanOrEqual(effectiveFrom.getTime());
    }
    expect(plan.keep.filter((f) => f.scheduledDeparture < effectiveFrom)).toHaveLength(4 * 3);
  });

  it('churns only the leg that changed', () => {
    const plan = applyEdit({ existing, next: EDITED, effectiveFrom, horizon });

    // Eleven days from Thursday to the end of the fortnight, one leg each.
    expect(plan.cancel).toHaveLength(11);
    expect(plan.create).toHaveLength(11);
    expect(new Set(plan.cancel.map((f) => f.legIndex))).toEqual(new Set([3]));
    expect(new Set(plan.create.map((f) => f.legIndex))).toEqual(new Set([3]));

    // Legs 0 to 2 after the edit are kept rather than rewritten, which is the
    // difference between a diff and a rebuild.
    expect(plan.keep.filter((f) => f.scheduledDeparture >= effectiveFrom)).toHaveLength(11 * 3);
    expect(plan.keep).toHaveLength(existing.length - 11);
  });

  it('reuses the key when a leg merely moves, which is why order matters', () => {
    // The key names a slot in the schedule, not a set of times — that is what
    // makes the roll idempotent, and it is why a moved leg appears in both
    // lists. A caller that inserted before deleting would be rejected by
    // `world_event`'s unique idempotency key.
    const plan = applyEdit({ existing, next: EDITED, effectiveFrom, horizon });
    const cancelled = new Map(plan.cancel.map((f) => [f.key, f]));

    const rewritten = plan.create.filter((f) => cancelled.has(f.key));
    expect(rewritten).toHaveLength(plan.create.length);
    for (const flight of rewritten) {
      const before = cancelled.get(flight.key);
      expect(before?.scheduledDeparture.getTime()).not.toBe(flight.scheduledDeparture.getTime());
      // 13:45 becomes 14:00 — the fifteen minutes the edit moved it.
      expect(
        flight.scheduledDeparture.getTime() - (before?.scheduledDeparture.getTime() ?? 0),
      ).toBe(15 * 60_000);
    }
  });

  it('accounts for every flight exactly once', () => {
    const plan = applyEdit({ existing, next: EDITED, effectiveFrom, horizon });
    const accounted = [...plan.keep, ...plan.cancel].map((f) => f.key).sort();
    expect(accounted).toEqual(existing.map((f) => f.key).sort());
  });

  it('will not un-fly a flight that has already gone', () => {
    // The dangerous case: an edit dated in the past. Without the departed set it
    // would delete this morning's revenue.
    const alreadyGone = existing.filter(
      (f) => f.scheduledDeparture < new Date('2026-08-18T12:00:00Z'),
    );
    const plan = applyEdit({
      existing,
      next: EDITED,
      effectiveFrom: MONDAY,
      horizon,
      departed: new Set(alreadyGone.map((f) => f.key)),
    });

    for (const flight of alreadyGone) {
      expect(plan.keep.map((f) => f.key)).toContain(flight.key);
      expect(plan.cancel.map((f) => f.key)).not.toContain(flight.key);
    }
  });

  it('does not create flights in the past for an edit dated in the past', () => {
    const plan = applyEdit({
      existing,
      next: EDITED,
      effectiveFrom: new Date('2026-08-01T00:00:00Z'),
      horizon,
    });
    for (const flight of plan.create) {
      expect(flight.scheduledDeparture.getTime()).toBeGreaterThanOrEqual(horizon.from.getTime());
    }
  });

  it('changes nothing when the rotation did not change', () => {
    const plan = applyEdit({ existing, next: DAILY, effectiveFrom, horizon });
    expect(plan.cancel).toEqual([]);
    expect(plan.create).toEqual([]);
    expect(plan.keep).toHaveLength(existing.length);
  });

  it('cancels a leg the new rotation drops entirely', () => {
    const shorter: Rotation = { ...DAILY, legs: DAILY.legs.slice(0, 2) };
    const plan = applyEdit({ existing, next: shorter, effectiveFrom, horizon });

    expect(new Set(plan.cancel.map((f) => f.legIndex))).toEqual(new Set([2, 3]));
    expect(plan.create).toEqual([]);
  });

  it('returns cancellations and creations in departure order', () => {
    const plan = applyEdit({ existing, next: EDITED, effectiveFrom, horizon });
    for (const list of [plan.keep, plan.cancel, plan.create]) {
      const times = list.map((f) => f.scheduledDeparture.getTime());
      expect([...times].sort((a, b) => a - b)).toEqual(times);
    }
  });
});

describe('purity', () => {
  it('gives the same answer every time and mutates nothing', () => {
    const horizon = horizonFrom(MONDAY);
    const existing = materialiseRotation(DAILY, horizon);
    const snapshot = JSON.stringify(DAILY);

    const first = applyEdit({ existing, next: DAILY, effectiveFrom: MONDAY, horizon });
    const second = applyEdit({ existing, next: DAILY, effectiveFrom: MONDAY, horizon });

    expect(second).toEqual(first);
    expect(JSON.stringify(DAILY)).toBe(snapshot);
    expect(existing).toEqual(materialiseRotation(DAILY, horizon));
  });
});
