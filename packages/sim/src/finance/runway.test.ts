import { describe, expect, it } from 'vitest';

import { cashRunway, monthBoundariesAhead, type CashCommitment } from './runway';

/**
 * §13.6's runway, and M8-08's first acceptance criterion.
 *
 * > Runway accounts for committed future outflows, not just current burn rate.
 *
 * So the test that matters most is the one where the burn rate and the truth
 * disagree: an airline with months of runway by division and nine days of it in
 * fact, because a bill it has already signed for lands on day ten.
 */

const DAY_MS = 86_400_000;
const NOW = new Date('2027-03-10T00:00:00.000Z');

function at(days: number): Date {
  return new Date(NOW.getTime() + days * DAY_MS);
}

function commitment(days: number, amountMinor: number, label = 'bill'): CashCommitment {
  return { dueAt: at(days), amountMinor, kind: 'crew', label };
}

describe('cash runway', () => {
  it('divides evenly when nothing is committed', () => {
    const projection = cashRunway({
      cashMinor: 1_000_000,
      gameNow: NOW,
      dailyOperatingMinor: -100_000,
      commitments: [],
      horizonDays: 365,
    });
    // Ten days of burn takes it to exactly zero, which is still funded; the
    // eleventh is the one it cannot pay for.
    expect(projection.days).toBe(10);
    expect(projection.tippedBy).toBeNull();
  });

  it('counts a committed bill the burn rate cannot see (AC1)', () => {
    const gentle = {
      cashMinor: 300_000_000,
      gameNow: NOW,
      dailyOperatingMinor: -1_000_000,
      horizonDays: 365,
    };
    // On the burn alone: 300 days.
    expect(cashRunway({ ...gentle, commitments: [] }).days).toBe(300);

    // With a delivery payment already signed for, due on day ten: nine.
    const withDelivery = cashRunway({
      ...gentle,
      commitments: [commitment(10, 295_000_000, 'A320neo delivery')],
    });
    expect(withDelivery.days).toBe(9);
    expect(withDelivery.tippedBy?.label).toBe('A320neo delivery');
  });

  it('names the bill that crossed the line, not the last one of the day', () => {
    const projection = cashRunway({
      cashMinor: 1_000_000,
      gameNow: NOW,
      dailyOperatingMinor: 0,
      commitments: [
        { ...commitment(5, 900_000, 'crew payroll'), kind: 'crew' },
        { ...commitment(5, 200_000, 'office salaries'), kind: 'office' },
        { ...commitment(5, 50_000, 'ground payroll'), kind: 'ground' },
      ],
      horizonDays: 365,
    });
    expect(projection.days).toBe(4);
    expect(projection.tippedBy?.label).toBe('office salaries');
  });

  it('says nothing at all when the airline funds itself', () => {
    const projection = cashRunway({
      cashMinor: 500_000,
      gameNow: NOW,
      dailyOperatingMinor: 20_000,
      commitments: [commitment(30, 100_000)],
      horizonDays: 365,
    });
    // Null rather than 365: "at least a year" and "exactly a year" are
    // different claims, and a strip showing the second would be lying.
    expect(projection.days).toBeNull();
    expect(projection.endingCashMinor).toBeGreaterThan(500_000);
  });

  it('takes what is already owed before the first day is funded', () => {
    const projection = cashRunway({
      cashMinor: 1_000_000,
      gameNow: NOW,
      dailyOperatingMinor: 0,
      // Arrears: dated in the past, so owed now rather than at some future date.
      commitments: [{ ...commitment(-3, 400_000, 'arrears'), kind: 'arrears' }],
      horizonDays: 365,
    });
    expect(projection.owedNowMinor).toBe(400_000);
    expect(projection.days).toBeNull();
    expect(projection.endingCashMinor).toBe(600_000);
  });

  it('gives an already-overdrawn airline no runway, and never a negative one', () => {
    const projection = cashRunway({
      cashMinor: -50_000,
      gameNow: NOW,
      dailyOperatingMinor: -10_000,
      commitments: [],
      horizonDays: 365,
    });
    // There is no such thing as minus five days of runway, and a UI would have
    // to special-case it if there were.
    expect(projection.days).toBe(0);
  });

  it('ignores a commitment beyond the horizon rather than pulling it forward', () => {
    const projection = cashRunway({
      cashMinor: 1_000_000,
      gameNow: NOW,
      dailyOperatingMinor: 0,
      commitments: [commitment(400, 9_000_000, 'far off')],
      horizonDays: 365,
    });
    expect(projection.days).toBeNull();
    expect(projection.committedMinor).toBe(0);
  });

  it('rounds a part-day commitment onto the day it actually falls due', () => {
    const projection = cashRunway({
      cashMinor: 100,
      gameNow: NOW,
      dailyOperatingMinor: 0,
      // Half a day ahead is still tomorrow's problem, not today's.
      commitments: [{ dueAt: at(0.5), amountMinor: 500, kind: 'crew', label: 'half a day' }],
      horizonDays: 30,
    });
    expect(projection.owedNowMinor).toBe(0);
    expect(projection.days).toBe(0);
  });
});

describe('month boundaries', () => {
  it('lists the first of each following game month inside the horizon', () => {
    expect(monthBoundariesAhead(new Date('2027-03-10T00:00:00.000Z'), 100)).toEqual([
      new Date('2027-04-01T00:00:00.000Z'),
      new Date('2027-05-01T00:00:00.000Z'),
      new Date('2027-06-01T00:00:00.000Z'),
    ]);
  });

  it('carries across the year without repeating January', () => {
    const boundaries = monthBoundariesAhead(new Date('2027-11-20T00:00:00.000Z'), 120);
    expect(boundaries).toEqual([
      new Date('2027-12-01T00:00:00.000Z'),
      new Date('2028-01-01T00:00:00.000Z'),
      new Date('2028-02-01T00:00:00.000Z'),
      new Date('2028-03-01T00:00:00.000Z'),
    ]);
  });

  it('returns nothing when the horizon does not reach the next month', () => {
    expect(monthBoundariesAhead(new Date('2027-03-10T00:00:00.000Z'), 5)).toEqual([]);
  });
});
