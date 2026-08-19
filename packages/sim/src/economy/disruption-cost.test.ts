import { describe, expect, it } from 'vitest';

import type { FlightLoad } from '@tailfin/shared';

import { DEFAULT_DISRUPTION_COST, disruptionCost } from './disruption-cost';

/**
 * What a disruption costs (M2-08, §8.4, §11).
 *
 * §8.4 gives no figures at all, so the calibration is EU261 — the regulation
 * that actually governs the short-haul European operation §13.4 costs out. Two
 * properties matter more than the amounts:
 *
 *   1. **The three-hour cliff is a cliff.** 179 minutes costs nothing and 181
 *      costs €250 a passenger, which is exactly the edge a player should learn.
 *   2. **An empty flight is free to cancel.** Every line is per passenger, and
 *      that is a real strategic fact rather than an accident of the model.
 */

function load(passengers: number, seats = 70): FlightLoad {
  return { economy: { seats, passengers, revenue: passengers * 7_500 } };
}

const FULL = load(47);

describe('disruptionCost', () => {
  it('reconciles — the total is the sum of the lines', () => {
    const cost = disruptionCost('cancel', 0, FULL);

    expect(cost.totalMinor).toBe(cost.lines.reduce((s, l) => s + l.amountMinor, 0));
    expect(Number.isInteger(cost.totalMinor)).toBe(true);
  });

  describe('a cancellation', () => {
    it('pays to rebook everybody and compensates them for the trouble', () => {
      const cost = disruptionCost('cancel', 0, FULL);

      expect(cost.lines.map((l) => l.source)).toEqual(['rebooking', 'compensation']);
      expect(cost.totalMinor).toBe(
        47 * DEFAULT_DISRUPTION_COST.rebookingPerPassengerMinor +
          47 * DEFAULT_DISRUPTION_COST.compensationPerPassengerMinor,
      );
    });

    it('costs far more than the flight would have earned', () => {
      // The whole point of on-time performance as a mechanic. §13.4 sells seats
      // at €75; one compensated passenger costs more than three paid for.
      const revenue = 47 * 7_500;

      expect(disruptionCost('cancel', 0, FULL).totalMinor).toBeGreaterThan(revenue * 2);
    });

    it('costs nothing at all when nobody was booked', () => {
      // The cheapest flight to cancel is the empty one, and a player who works
      // that out has learned something true about airlines.
      const cost = disruptionCost('cancel', 0, load(0));

      expect(cost.totalMinor).toBe(0);
      expect(cost.lines).toEqual([]);
      // Still a full reputational hit, though — the seats were on sale.
      expect(cost.reputationImpact).toBe(1);
    });
  });

  describe('EU261’s three-hour cliff', () => {
    it('pays nothing for a delay just under it', () => {
      const cost = disruptionCost('delay', 179, FULL);

      expect(cost.lines.map((l) => l.source)).not.toContain('compensation');
    });

    it('pays in full for a delay just over it', () => {
      const cost = disruptionCost('delay', 181, FULL);
      const compensation = cost.lines.find((l) => l.source === 'compensation');

      expect(compensation?.amountMinor).toBe(
        47 * DEFAULT_DISRUPTION_COST.compensationPerPassengerMinor,
      );
    });

    it('starts duty of care earlier than compensation', () => {
      // Two hours for meals, three for the cheque. A 150-minute delay owes care
      // and no compensation, which is the awkward middle a real airline lives in.
      const cost = disruptionCost('delay', 150, FULL);
      const sources = cost.lines.map((l) => l.source);

      expect(sources).toContain('care');
      expect(sources).not.toContain('compensation');
    });

    it('charges care by the hour, so a longer wait costs more', () => {
      const careOf = (minutes: number) =>
        disruptionCost('delay', minutes, FULL).lines.find((l) => l.source === 'care')
          ?.amountMinor ?? 0;

      expect(careOf(360)).toBeGreaterThan(careOf(180));
    });

    it('costs nothing for a short delay', () => {
      // A twenty-minute delay is an operational fact, not a financial event.
      expect(disruptionCost('delay', 20, FULL).totalMinor).toBe(0);
    });
  });

  describe('a diversion', () => {
    it('pays to move everybody onward from where the aircraft actually landed', () => {
      const cost = disruptionCost('divert', 0, FULL);
      const recovery = cost.lines.find((l) => l.source === 'recovery');

      expect(recovery?.amountMinor).toBe(47 * DEFAULT_DISRUPTION_COST.recoveryPerPassengerMinor);
    });

    it('charges recovery for an air return too', () => {
      expect(disruptionCost('air_return', 0, FULL).lines.some((l) => l.source === 'recovery')).toBe(
        true,
      );
    });

    it('does not pay compensation unless it also ran long', () => {
      // Being taken to the wrong airport is not itself a 261 event; being four
      // hours late getting there is.
      expect(
        disruptionCost('divert', 30, FULL).lines.some((l) => l.source === 'compensation'),
      ).toBe(false);
      expect(
        disruptionCost('divert', 240, FULL).lines.some((l) => l.source === 'compensation'),
      ).toBe(true);
    });
  });

  describe('the reputation input', () => {
    it('is a magnitude, and stops there', () => {
      // §15 owns what this does to standing. M2-08 says how bad it was, at the
      // moment that is knowable — the same discipline M2-06 used for arrival delay.
      expect(disruptionCost('cancel', 0, FULL).reputationImpact).toBe(1);
      expect(disruptionCost('air_return', 0, FULL).reputationImpact).toBeCloseTo(0.9, 10);
      expect(disruptionCost('divert', 0, FULL).reputationImpact).toBeCloseTo(0.8, 10);
    });

    it('scales a delay by how long it was', () => {
      const short = disruptionCost('delay', 30, FULL).reputationImpact;
      const long = disruptionCost('delay', 300, FULL).reputationImpact;

      expect(long).toBeGreaterThan(short);
      expect(short).toBeLessThan(0.2);
    });

    it('tops out a very long delay at a cancellation’s severity', () => {
      // Past six hours a delay is indistinguishable from a cancellation to the
      // person sitting in the terminal.
      expect(disruptionCost('delay', 600, FULL).reputationImpact).toBe(1);
    });
  });

  it('counts passengers across every cabin', () => {
    const mixed: FlightLoad = {
      economy: { seats: 150, passengers: 120, revenue: 900_000 },
      business: { seats: 20, passengers: 14, revenue: 700_000 },
    };

    expect(disruptionCost('cancel', 0, mixed).passengers).toBe(134);
  });

  it('refuses a negative delay', () => {
    expect(() => disruptionCost('delay', -5, FULL)).toThrow(/[Dd]elay/);
  });

  it('is a pure function — the same disruption always costs the same', () => {
    expect(disruptionCost('cancel', 0, FULL)).toEqual(disruptionCost('cancel', 0, FULL));
  });
});
