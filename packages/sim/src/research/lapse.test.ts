import { describe, expect, it } from 'vitest';

import {
  changeDoctrineFunding,
  type DoctrineDecayBalance,
  doctrineFundedDuring,
  doctrineSettlesAt,
  doctrineStrength,
} from './lapse';

/**
 * §10.4's upkeep rule (M9-06): *"Doctrine lapses if you stop funding it"*, and
 * the acceptance criterion *"Ceasing upkeep visibly decays the advantage over
 * game weeks."*
 *
 * Every date here is derived from one injected instant. A literal date in a
 * game-clock test has expired twice in this repository.
 */

const WEEK = 7 * 24 * 60 * 60 * 1000;
const now = new Date(Date.UTC(2031, 2, 3, 12));
const weeksAfter = (weeks: number) => new Date(now.getTime() + weeks * WEEK);
const balance: DoctrineDecayBalance = { lapseWeeks: 8, recoveryWeeks: 4 };

const fullAndFunded = { funded: true, strengthAtChange: 1, changedAt: now };

describe('doctrineStrength', () => {
  it('holds full strength for as long as it is funded', () => {
    for (const weeks of [0, 1, 52, 520]) {
      expect(doctrineStrength(fullAndFunded, weeksAfter(weeks), balance)).toBe(1);
    }
  });

  it('decays over game weeks once funding stops — visibly, not at once', () => {
    const stopped = changeDoctrineFunding(fullAndFunded, false, now, balance);
    const readings = [0, 1, 2, 4, 6, 8, 12].map((weeks) =>
      doctrineStrength(stopped, weeksAfter(weeks), balance),
    );
    expect(readings).toEqual([1, 0.875, 0.75, 0.5, 0.25, 0, 0]);
    // Strictly falling until it is gone: there is a week-by-week readout to see.
    for (let index = 1; index < 6; index += 1) {
      expect(readings[index]).toBeLessThan(readings[index - 1] ?? 1);
    }
  });

  it('recovers over its own, shorter period when funding resumes', () => {
    const stopped = changeDoctrineFunding(fullAndFunded, false, now, balance);
    const lapsedHalf = weeksAfter(4);
    const resumed = changeDoctrineFunding(stopped, true, lapsedHalf, balance);
    expect(resumed.strengthAtChange).toBe(0.5);
    expect(doctrineStrength(resumed, weeksAfter(5), balance)).toBe(0.75);
    expect(doctrineStrength(resumed, weeksAfter(6), balance)).toBe(1);
    expect(doctrineStrength(resumed, weeksAfter(60), balance)).toBe(1);
  });

  it('carries strength across a change, so refunding is never an instant reset', () => {
    // Four weeks unfunded loses half; refunding starts the recovery from that
    // half rather than handing the doctrine back whole.
    const stopped = changeDoctrineFunding(fullAndFunded, false, now, balance);
    const resumed = changeDoctrineFunding(stopped, true, weeksAfter(4), balance);
    expect(doctrineStrength(resumed, weeksAfter(4), balance)).toBe(0.5);
    expect(doctrineStrength(resumed, weeksAfter(5), balance)).toBe(0.75);

    // Switching off and straight back on costs nothing but the instant between:
    // the change itself is not a lever.
    const flicked = changeDoctrineFunding(
      changeDoctrineFunding(fullAndFunded, false, weeksAfter(1), balance),
      true,
      weeksAfter(1),
      balance,
    );
    expect(flicked.strengthAtChange).toBe(1);
  });

  it('never leaves [0, 1], whatever it is handed', () => {
    expect(
      doctrineStrength({ funded: true, strengthAtChange: 7, changedAt: now }, now, balance),
    ).toBe(1);
    expect(
      doctrineStrength({ funded: false, strengthAtChange: -3, changedAt: now }, now, balance),
    ).toBe(0);
  });

  it('reads the stored strength at an instant before the change', () => {
    const stopped = { funded: false, strengthAtChange: 0.6, changedAt: now };
    expect(doctrineStrength(stopped, weeksAfter(-3), balance)).toBe(0.6);
  });

  it('refuses a balance that would divide by nothing', () => {
    expect(() =>
      doctrineStrength(fullAndFunded, now, { lapseWeeks: 0, recoveryWeeks: 4 }),
    ).toThrow();
    expect(() =>
      doctrineStrength(fullAndFunded, now, { lapseWeeks: 8, recoveryWeeks: -1 }),
    ).toThrow();
  });
});

describe('doctrineSettlesAt', () => {
  it('names the game instant a lapsing doctrine is gone', () => {
    const stopped = changeDoctrineFunding(fullAndFunded, false, now, balance);
    expect(doctrineSettlesAt(stopped, balance)).toEqual(weeksAfter(8));
  });

  it('names the instant a recovering one is whole again', () => {
    expect(
      doctrineSettlesAt({ funded: true, strengthAtChange: 0.25, changedAt: now }, balance),
    ).toEqual(weeksAfter(3));
  });

  it('is null when there is nowhere left to go', () => {
    expect(doctrineSettlesAt(fullAndFunded, balance)).toBeNull();
    expect(
      doctrineSettlesAt({ funded: false, strengthAtChange: 0, changedAt: now }, balance),
    ).toBeNull();
  });
});

describe('doctrineFundedDuring — what a month of upkeep is owed for', () => {
  const monthStart = now;
  const monthEnd = weeksAfter(4);

  it('owes a month funded throughout, and not one unfunded throughout', () => {
    expect(
      doctrineFundedDuring({ funded: true, changedAt: weeksAfter(-10) }, monthStart, monthEnd),
    ).toBe(true);
    expect(
      doctrineFundedDuring({ funded: false, changedAt: weeksAfter(-10) }, monthStart, monthEnd),
    ).toBe(false);
  });

  it('owes a month in which funding changed either way', () => {
    // Switched off on the month's last day: the month was used, and is owed.
    expect(
      doctrineFundedDuring({ funded: false, changedAt: weeksAfter(3.9) }, monthStart, monthEnd),
    ).toBe(true);
    // Switched on mid-month: owed too.
    expect(
      doctrineFundedDuring({ funded: true, changedAt: weeksAfter(2) }, monthStart, monthEnd),
    ).toBe(true);
  });

  it('reads the state before a change that came after the month closed', () => {
    expect(
      doctrineFundedDuring({ funded: false, changedAt: weeksAfter(5) }, monthStart, monthEnd),
    ).toBe(true);
    expect(
      doctrineFundedDuring({ funded: true, changedAt: weeksAfter(5) }, monthStart, monthEnd),
    ).toBe(false);
  });
});
