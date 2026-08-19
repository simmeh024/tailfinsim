import { describe, expect, it } from 'vitest';

import { DEFAULT_TURNAROUND_MINUTES } from './profile';
import {
  computeTurnaround,
  DEFAULT_TURNAROUND,
  NOMINAL_PLAN,
  stackBoosts,
  type TurnaroundAircraft,
  type TurnaroundBoost,
  type TurnaroundContribution,
  type TurnaroundPlan,
  TURNAROUND_SOURCES,
} from './turnaround';

/**
 * The turnaround model (M2-04, §3.3, §9.3, §10.4, App. B.6).
 *
 * Three claims are the issue's acceptance criteria, and the third is the one
 * that will rot quietest:
 *
 *   1. A remote stand costs 10–12 minutes against a contact gate (App. B.6).
 *   2. Stacked boosts never exceed −20% (§10.4).
 *   3. **The answer is broken down by contributor, not a single opaque number**
 *      — and the breakdown reconciles exactly, because one that does not is
 *      worse than none.
 */

/** The unimproved narrowbody: 40 minutes at a 200-seat cabin. */
const NARROWBODY: TurnaroundAircraft = {
  baseTurnaroundMinutes: DEFAULT_TURNAROUND_MINUTES,
  seats: 200,
  referenceSeats: 200,
};

function plan(overrides: Partial<TurnaroundPlan> = {}): TurnaroundPlan {
  return { ...NOMINAL_PLAN, ...overrides };
}

function boost(fraction: number, id = `b-${String(fraction)}`): TurnaroundBoost {
  return { id, fraction };
}

/** The breakdown must add up. Everything else in this file assumes it. */
function sumOf(contributions: readonly TurnaroundContribution[]): number {
  return contributions.reduce((total, c) => total + c.minutes, 0);
}

describe('the breakdown reconciles', () => {
  it('sums to the total on a nominal turn', () => {
    const result = computeTurnaround(NARROWBODY, plan());
    expect(result.minutes).toBe(40);
    expect(sumOf(result.contributions)).toBeCloseTo(result.minutes, 10);
  });

  it('sums to the total with every contributor active at once', () => {
    const result = computeTurnaround(
      { baseTurnaroundMinutes: 40, seats: 244, referenceSeats: 200 },
      plan({
        stand: 'remote',
        vendor: { speedFactor: 1.2 },
        cabinOptionMinutes: 3,
        serviceMinutes: 6,
        congestionFactor: 1.15,
        boosts: [boost(0.1), boost(0.08)],
      }),
    );
    expect(sumOf(result.contributions)).toBeCloseTo(result.minutes, 10);
  });

  it('names a contributor for every line, and never an empty one', () => {
    const result = computeTurnaround(NARROWBODY, plan({ stand: 'remote' }));
    for (const c of result.contributions) {
      expect(c.detail.length).toBeGreaterThan(10);
      expect(TURNAROUND_SOURCES).toContain(c.source);
    }
  });

  it('leaves out contributors that did nothing', () => {
    // A nominal turn is one line, not nine zeroes. A breakdown padded with
    // "congestion: 0.0 min" is the opaque number wearing a disguise.
    const result = computeTurnaround(NARROWBODY, plan());
    expect(result.contributions.map((c) => c.source)).toEqual(['base']);
  });

  it('keeps every source reachable', () => {
    const reached = new Set<TurnaroundContribution['source']>();
    for (const result of [
      computeTurnaround({ baseTurnaroundMinutes: 40, seats: 244, referenceSeats: 200 }, plan()),
      computeTurnaround(
        NARROWBODY,
        plan({
          stand: 'remote',
          vendor: { speedFactor: 1.2 },
          cabinOptionMinutes: 3,
          serviceMinutes: 6,
          congestionFactor: 1.15,
          boosts: [boost(0.1)],
        }),
      ),
      // Small base plus the maximum reduction, so the floor bites.
      computeTurnaround(
        { baseTurnaroundMinutes: 11, seats: 100, referenceSeats: 100 },
        plan({ boosts: [boost(0.2)] }),
      ),
    ]) {
      for (const c of result.contributions) reached.add(c.source);
    }
    expect([...reached].sort()).toEqual([...TURNAROUND_SOURCES].sort());
  });
});

describe('the remote stand, App. B.6', () => {
  it('costs between 10 and 12 minutes against a contact gate', () => {
    const contact = computeTurnaround(NARROWBODY, plan({ stand: 'contact' }));
    const remote = computeTurnaround(NARROWBODY, plan({ stand: 'remote' }));
    const cost = remote.minutes - contact.minutes;

    expect(cost).toBeGreaterThanOrEqual(10);
    expect(cost).toBeLessThanOrEqual(12);
  });

  it('names the stand in the breakdown rather than folding it into the total', () => {
    const remote = computeTurnaround(NARROWBODY, plan({ stand: 'remote' }));
    const line = remote.contributions.find((c) => c.source === 'stand');
    expect(line?.minutes).toBe(DEFAULT_TURNAROUND.remoteStandMinutes);
    expect(line?.detail).toContain('bussed');
  });

  it('charges a slow handler for the bussing too', () => {
    // Order of operations, made visible. The vendor multiplier applies to
    // everything it is responsible for, and the extra bussing on a remote stand
    // is its work. Applying the vendor before the stand would give 59 minutes
    // rather than 61.2, and would quietly make bad handlers cheaper at exactly
    // the stands where they hurt most.
    const result = computeTurnaround(
      NARROWBODY,
      plan({ stand: 'remote', vendor: { speedFactor: 1.2 } }),
    );
    expect(result.minutes).toBeCloseTo((40 + 11) * 1.2, 10);
    expect(result.minutes).not.toBeCloseTo(40 * 1.2 + 11, 6);
  });
});

describe('the §10.4 ceiling', () => {
  it('stacks multiplicatively, so two boosts are worth less than their sum', () => {
    // Diminishing returns by construction: 10% and 10% is 19%, not 20%.
    expect(stackBoosts([boost(0.1), boost(0.1)]).fraction).toBeCloseTo(0.19, 10);
    expect(stackBoosts([boost(0.1)]).fraction).toBeCloseTo(0.1, 10);
  });

  it('never exceeds 20%, however many are stacked', () => {
    const many = Array.from({ length: 12 }, (_, i) => boost(0.1, `r-${String(i)}`));
    const stacked = stackBoosts(many);

    expect(stacked.fraction).toBe(DEFAULT_TURNAROUND.maxBoostFraction);
    expect(stacked.fraction).toBeLessThanOrEqual(0.2);
    expect(stacked.capped).toBe(true);
  });

  it('says when a further boost would buy nothing', () => {
    const result = computeTurnaround(NARROWBODY, plan({ boosts: [boost(0.15), boost(0.15)] }));
    expect(result.boostCapReached).toBe(true);
    expect(result.boostFraction).toBe(0.2);
    expect(result.contributions.find((c) => c.source === 'boosts')?.detail).toContain(
      'buys nothing',
    );
  });

  it('gives a lone boost its full face value', () => {
    // The reason for multiplicative stacking rather than an asymptotic curve: a
    // player's first node in the branch must be worth what it says.
    const result = computeTurnaround(NARROWBODY, plan({ boosts: [boost(0.05)] }));
    expect(result.boostFraction).toBeCloseTo(0.05, 10);
    expect(result.minutes).toBeCloseTo(38, 10);
    expect(result.boostCapReached).toBe(false);
  });

  it('a capped airline is still only 20% faster than one with nothing', () => {
    // §10.4's whole point: "a year-one player must never face an unbeatable wall
    // of stacked veteran bonuses."
    const rookie = computeTurnaround(NARROWBODY, plan());
    const veteran = computeTurnaround(
      NARROWBODY,
      plan({ boosts: Array.from({ length: 20 }, (_, i) => boost(0.15, `v-${String(i)}`)) }),
    );
    expect(veteran.minutes).toBeCloseTo(rookie.minutes * 0.8, 10);
  });

  it('refuses a boost that is not a fraction of time', () => {
    expect(() => stackBoosts([boost(1)])).toThrow(/between 0% and 100%/);
    expect(() => stackBoosts([boost(-0.1)])).toThrow(/between 0% and 100%/);
    expect(() => stackBoosts([boost(Number.NaN)])).toThrow(/finite/);
  });
});

describe('the cabin drives the turn', () => {
  it('reproduces App. C.3 for the high-density A321neo', () => {
    // C.3 prices high-density exits at "+5 min turnaround", and C.4's build
    // carries 244 seats against the standard 200. 44 seats at 0.11 min each is
    // 4.84 — the documented figure to within ten seconds.
    const standard = computeTurnaround(NARROWBODY, plan());
    const dense = computeTurnaround(
      { baseTurnaroundMinutes: 40, seats: 244, referenceSeats: 200 },
      plan(),
    );

    expect(dense.minutes - standard.minutes).toBeCloseTo(4.84, 2);
    expect(Math.abs(dense.minutes - standard.minutes - 5)).toBeLessThan(0.2);
  });

  it('gives a lighter cabin a faster turn', () => {
    // §6.4: seats ↑ → turnaround ↑. The reverse has to hold too, or a premium
    // cabin gains nothing on the ground for the seats it gives up.
    const premium = computeTurnaround(
      { baseTurnaroundMinutes: 40, seats: 150, referenceSeats: 200 },
      plan(),
    );
    expect(premium.minutes).toBeLessThan(40);
    expect(premium.contributions.find((c) => c.source === 'seats')?.detail).toContain('fewer');
  });

  it('does not charge twice for high-density exits', () => {
    // The trap the module comment names: C.3's "+5 min" is already produced by
    // the seats those exits allow. Passing it again as a cabin option would
    // charge the player twice for one decision — this test states the intended
    // reading so a future caller can check it.
    const seatDriven = computeTurnaround(
      { baseTurnaroundMinutes: 40, seats: 244, referenceSeats: 200 },
      plan(),
    );
    const doubleCharged = computeTurnaround(
      { baseTurnaroundMinutes: 40, seats: 244, referenceSeats: 200 },
      plan({ cabinOptionMinutes: 5 }),
    );
    expect(doubleCharged.minutes - seatDriven.minutes).toBeCloseTo(5, 10);
    expect(seatDriven.contributions.some((c) => c.source === 'cabin')).toBe(false);
  });
});

describe('the handler and the airport', () => {
  it('charges a cheap handler in minutes', () => {
    // §9.3: "cheap ramp handlers = slower turns and more mishandled bags."
    const good = computeTurnaround(NARROWBODY, plan({ vendor: { speedFactor: 0.9 } }));
    const cheap = computeTurnaround(NARROWBODY, plan({ vendor: { speedFactor: 1.25 } }));

    expect(good.minutes).toBeCloseTo(36, 10);
    expect(cheap.minutes).toBeCloseTo(50, 10);
    expect(cheap.contributions.find((c) => c.source === 'vendor')?.detail).toContain('slower');
  });

  it('keeps congestion separate from the handler', () => {
    // They fail independently: a good handler at a congested airport is still
    // waiting for a tug, and a player should be able to tell which is which.
    const result = computeTurnaround(
      NARROWBODY,
      plan({ vendor: { speedFactor: 1.1 }, congestionFactor: 1.2 }),
    );
    const vendor = result.contributions.find((c) => c.source === 'vendor');
    const congestion = result.contributions.find((c) => c.source === 'congestion');

    expect(vendor?.minutes).toBeCloseTo(4, 10);
    expect(congestion?.minutes).toBeCloseTo(44 * 0.2, 10);
    expect(result.minutes).toBeCloseTo(40 * 1.1 * 1.2, 10);
  });

  it('gives a quiet airport back its time, and says so', () => {
    // The other side of congestion. An off-peak stand at a regional field turns
    // faster than the same aircraft at a flagship hub at 08:00, and the readout
    // should credit it rather than only ever charging.
    const result = computeTurnaround(NARROWBODY, plan({ congestionFactor: 0.9 }));

    expect(result.minutes).toBeCloseTo(36, 10);
    expect(result.contributions.find((c) => c.source === 'congestion')?.detail).toContain('saves');
    expect(result.contributions.find((c) => c.source === 'congestion')?.minutes).toBeLessThan(0);
  });

  it('refuses a factor that is not a rate', () => {
    expect(() => computeTurnaround(NARROWBODY, plan({ vendor: { speedFactor: 0 } }))).toThrow(
      /Vendor speed factor/,
    );
    expect(() => computeTurnaround(NARROWBODY, plan({ congestionFactor: -1 }))).toThrow(
      /Congestion factor/,
    );
  });
});

describe('the floor', () => {
  it('stops a turn becoming physically impossible', () => {
    const result = computeTurnaround(
      { baseTurnaroundMinutes: 11, seats: 100, referenceSeats: 100 },
      plan({ boosts: [boost(0.2)] }),
    );

    expect(result.minutes).toBe(DEFAULT_TURNAROUND.minimumMinutes);
    // Recorded rather than clamped silently, so the breakdown still reconciles.
    expect(sumOf(result.contributions)).toBeCloseTo(result.minutes, 10);
    expect(result.contributions.find((c) => c.source === 'floor')?.detail).toContain('cleaning');
  });

  it('does not fire on a turn that was never near it', () => {
    const result = computeTurnaround(NARROWBODY, plan());
    expect(result.contributions.some((c) => c.source === 'floor')).toBe(false);
  });
});

describe('what a schedule books', () => {
  it('rounds up, never to nearest', () => {
    // `schedule_leg.turnaround_minutes` is an integer (M2-03). Rounding down
    // would book a turn the model says is not achievable, and the resulting
    // delay would be the scheduler's fault rather than the operation's.
    //
    // The fractional part must be **below** a half, or the test cannot tell
    // `ceil` from `round` — 44.84 rounds to 45 either way. 38 extra seats give
    // 44.18, where the two disagree.
    const result = computeTurnaround(
      { baseTurnaroundMinutes: 40, seats: 238, referenceSeats: 200 },
      plan(),
    );
    expect(result.minutes).toBeCloseTo(44.18, 2);
    expect(result.scheduleMinutes).toBe(45);
    expect(result.scheduleMinutes).not.toBe(Math.round(result.minutes));
  });

  it('books at least the exact figure, whatever the fraction', () => {
    for (const seats of [200, 201, 205, 213, 238, 244, 260]) {
      const result = computeTurnaround(
        { baseTurnaroundMinutes: 40, seats, referenceSeats: 200 },
        plan(),
      );
      expect(result.scheduleMinutes).toBeGreaterThanOrEqual(result.minutes);
      expect(result.scheduleMinutes - result.minutes).toBeLessThan(1);
    }
  });

  it('leaves a whole number alone', () => {
    expect(computeTurnaround(NARROWBODY, plan()).scheduleMinutes).toBe(40);
  });
});

describe('purity', () => {
  it('gives the same answer every time and mutates nothing', () => {
    const aircraft: TurnaroundAircraft = {
      baseTurnaroundMinutes: 40,
      seats: 244,
      referenceSeats: 200,
    };
    const boosts = [boost(0.1), boost(0.05)];
    const p = plan({ stand: 'remote', boosts });

    const first = computeTurnaround(aircraft, p);
    const second = computeTurnaround(aircraft, p);

    expect(second).toEqual(first);
    expect(aircraft).toEqual({ baseTurnaroundMinutes: 40, seats: 244, referenceSeats: 200 });
    expect(boosts).toEqual([
      { id: 'b-0.1', fraction: 0.1 },
      { id: 'b-0.05', fraction: 0.05 },
    ]);
    expect(NOMINAL_PLAN.stand).toBe('contact');
    expect(DEFAULT_TURNAROUND.maxBoostFraction).toBe(0.2);
  });

  it('refuses an aircraft that is not one', () => {
    expect(() =>
      computeTurnaround({ baseTurnaroundMinutes: 0, seats: 200, referenceSeats: 200 }, plan()),
    ).toThrow(/Base turnaround/);
    expect(() =>
      computeTurnaround({ baseTurnaroundMinutes: 40, seats: -1, referenceSeats: 200 }, plan()),
    ).toThrow(/Seat count/);
    expect(() =>
      computeTurnaround({ baseTurnaroundMinutes: 40, seats: 200, referenceSeats: 0 }, plan()),
    ).toThrow(/Reference seat count/);
  });
});
