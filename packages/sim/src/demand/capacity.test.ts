import { describe, expect, it } from 'vitest';

import type { DemandSegment } from '@tailfin/shared';

import { allocateCapacity, CAPACITY_PASSES, type CapacityOperator } from './capacity';
import { computeShares } from './logit';

/**
 * Capacity, spill and recapture (M3-05, App. A.5).
 *
 * A.5 has no worked example, so unlike M3-03 there is nothing to reproduce to
 * the digit. What it does have is an unusually specific *procedure* — four
 * numbered steps and an explicit refusal to iterate — so these tests pin the
 * procedure rather than a set of outputs, and the sharpest one asserts what the
 * model deliberately does **not** do.
 */

function op(over: Partial<CapacityOperator> & Pick<CapacityOperator, 'id'>): CapacityOperator {
  return { demand: 100, seats: 100, share: 0.5, ...over };
}

describe('the acceptance criterion: an oversubscribed operator and an undersubscribed competitor', () => {
  // The LCC everybody wants, and the legacy carrier with room.
  const full = op({ id: 'popular', demand: 150, seats: 100, share: 0.75 });
  const roomy = op({ id: 'quiet', demand: 50, seats: 200, share: 0.25 });
  const result = allocateCapacity([full, roomy]);

  const row = (id: string) => result.operators.find((o) => o.operatorId === id);

  it('fills the popular operator and turns away the rest', () => {
    expect(row('popular')?.booked).toBe(100);
    expect(row('popular')?.spilled).toBe(50);
    expect(row('popular')?.emptySeats).toBe(0);
    expect(row('popular')?.loadFactor).toBe(1);
  });

  it('gives the spill to the competitor that had room', () => {
    // Every one of the 50 fits, because `quiet` is the only operator with room
    // and has 150 seats free.
    expect(row('quiet')?.bookedOwn).toBe(50);
    expect(row('quiet')?.recaptured).toBe(50);
    expect(row('quiet')?.booked).toBe(100);
  });

  it('loses nothing, because the market had the capacity', () => {
    expect(result.totalDemand).toBe(200);
    expect(result.totalBooked).toBe(200);
    expect(result.totalSpilled).toBe(50);
    expect(result.totalRecaptured).toBe(50);
    expect(result.lostDemand).toBe(0);
  });

  it('keeps spilled and recaptured apart', () => {
    // A.5 asks the game to say "you turned away 40 passengers a day". Adding
    // the two together would destroy the only two numbers a player can act on:
    // `popular` should still see 50 turned away even though the market kept them.
    expect(row('popular')?.spilled).toBe(50);
    expect(row('popular')?.recaptured).toBe(0);
    expect(row('quiet')?.spilled).toBe(0);
    expect(row('quiet')?.recaptured).toBe(50);
  });
});

describe('two passes, not convergence — the first acceptance criterion', () => {
  it('is two, and says so', () => {
    expect(CAPACITY_PASSES).toBe(2);
  });

  it('loses demand a third pass would have absorbed', () => {
    // The test that a "just loop until it converges" change would break, and
    // the reason this is written as a property rather than a number.
    //
    // A spills 100. B has room for only 10 of it and C, who also has room, is
    // offered more than it can take. After one redistribution there is spill
    // left and there are still empty seats in the market — a third pass would
    // mop them up, and A.5 says it must not.
    const result = allocateCapacity([
      op({ id: 'a', demand: 200, seats: 100, share: 0.8 }),
      op({ id: 'b', demand: 0, seats: 10, share: 0.15 }),
      op({ id: 'c', demand: 0, seats: 100, share: 0.05 }),
    ]);

    const b = result.operators.find((o) => o.operatorId === 'b');
    const c = result.operators.find((o) => o.operatorId === 'c');

    // b is offered 100 × (0.15/0.20) = 75 and can take only 10.
    expect(b?.recaptured).toBe(10);
    expect(b?.emptySeats).toBe(0);
    // c is offered 100 × (0.05/0.20) = 25 and has room for all of it.
    expect(c?.recaptured).toBe(25);
    expect(c?.emptySeats).toBe(75);

    // 65 passengers lost while 75 seats sit empty. That is the point.
    expect(result.lostDemand).toBe(65);
    expect(result.lostDemand).toBeGreaterThan(0);
  });

  it('does not carry lost demand anywhere — it simply goes', () => {
    const result = allocateCapacity([op({ id: 'only', demand: 500, seats: 100, share: 1 })]);

    expect(result.totalBooked).toBe(100);
    expect(result.totalSpilled).toBe(400);
    expect(result.totalRecaptured).toBe(0);
    expect(result.lostDemand).toBe(400);
  });
});

describe('redistribution follows the market’s preferences', () => {
  it('splits spill by re-normalised share, not evenly', () => {
    // A.5: "using shares re-normalised over that subset". The two operators
    // with room hold shares of 0.3 and 0.1, so the spill splits 3:1 — an even
    // split would give 50/50 and is the obvious wrong implementation.
    const result = allocateCapacity([
      op({ id: 'full', demand: 200, seats: 100, share: 0.6 }),
      op({ id: 'big-share', demand: 0, seats: 500, share: 0.3 }),
      op({ id: 'small-share', demand: 0, seats: 500, share: 0.1 }),
    ]);

    expect(result.operators.find((o) => o.operatorId === 'big-share')?.recaptured).toBeCloseTo(
      75,
      9,
    );
    expect(result.operators.find((o) => o.operatorId === 'small-share')?.recaptured).toBeCloseTo(
      25,
      9,
    );
  });

  it('excludes operators with no room from the re-normalisation', () => {
    // A full operator must not be offered spill and then silently drop it —
    // that would lose the passengers to a rounding of the share denominator
    // rather than to a real capacity limit.
    const result = allocateCapacity([
      op({ id: 'full-a', demand: 200, seats: 100, share: 0.5 }),
      op({ id: 'full-b', demand: 100, seats: 100, share: 0.4 }),
      op({ id: 'roomy', demand: 0, seats: 500, share: 0.1 }),
    ]);

    // `roomy` holds a tenth of the market but is the only one with space, so it
    // takes all 100 of the spill rather than a tenth of it.
    expect(result.operators.find((o) => o.operatorId === 'roomy')?.recaptured).toBe(100);
    expect(result.operators.find((o) => o.operatorId === 'full-b')?.recaptured).toBe(0);
    expect(result.lostDemand).toBe(0);
  });

  it('loses everything when the whole market is full', () => {
    const result = allocateCapacity([
      op({ id: 'a', demand: 150, seats: 100, share: 0.5 }),
      op({ id: 'b', demand: 150, seats: 100, share: 0.5 }),
    ]);

    expect(result.totalBooked).toBe(200);
    expect(result.totalSpilled).toBe(100);
    expect(result.totalRecaptured).toBe(0);
    expect(result.lostDemand).toBe(100);
  });
});

describe('the arithmetic reconciles', () => {
  const markets: CapacityOperator[][] = [
    [
      op({ id: 'a', demand: 150, seats: 100, share: 0.6 }),
      op({ id: 'b', demand: 40, seats: 90, share: 0.4 }),
    ],
    [
      op({ id: 'a', demand: 0, seats: 0, share: 0.5 }),
      op({ id: 'b', demand: 10, seats: 5, share: 0.5 }),
    ],
    [op({ id: 'solo', demand: 33.3, seats: 100, share: 1 })],
    [
      op({ id: 'a', demand: 90, seats: 20, share: 0.45 }),
      op({ id: 'b', demand: 5, seats: 300, share: 0.35 }),
      op({ id: 'c', demand: 60, seats: 40, share: 0.2 }),
    ],
  ];

  it('books everything that was not lost', () => {
    for (const [i, market] of markets.entries()) {
      const result = allocateCapacity(market);
      expect(result.totalBooked + result.lostDemand, `market ${String(i)}`).toBeCloseTo(
        result.totalDemand,
        9,
      );
    }
  });

  it('never books more than there are seats', () => {
    for (const [i, market] of markets.entries()) {
      for (const row of allocateCapacity(market).operators) {
        expect(row.booked, `market ${String(i)} / ${row.operatorId}`).toBeLessThanOrEqual(
          row.seats,
        );
        expect(row.emptySeats).toBeGreaterThanOrEqual(0);
        expect(row.loadFactor).toBeLessThanOrEqual(1);
      }
    }
  });

  it('splits each operator’s bookings into its own and its recapture', () => {
    for (const market of markets) {
      for (const row of allocateCapacity(market).operators) {
        expect(row.bookedOwn + row.recaptured).toBeCloseTo(row.booked, 9);
        expect(row.bookedOwn).toBeLessThanOrEqual(row.demand + 1e-9);
      }
    }
  });

  it('accounts for spill as recaptured or lost, never both', () => {
    for (const market of markets) {
      const result = allocateCapacity(market);
      expect(result.totalRecaptured + result.lostDemand).toBeCloseTo(result.totalSpilled, 9);
    }
  });
});

describe('edge cases', () => {
  it('does nothing to a market nobody wants', () => {
    const result = allocateCapacity([op({ id: 'a', demand: 0, seats: 100, share: 1 })]);

    expect(result.totalBooked).toBe(0);
    expect(result.totalSpilled).toBe(0);
    expect(result.lostDemand).toBe(0);
    expect(result.operators[0]?.loadFactor).toBe(0);
  });

  it('handles an operator flying with no seats at all', () => {
    // A freighter in a passenger market. Everything it was allocated spills.
    const result = allocateCapacity([
      op({ id: 'freighter', demand: 40, seats: 0, share: 0.5 }),
      op({ id: 'pax', demand: 10, seats: 200, share: 0.5 }),
    ]);

    expect(result.operators.find((o) => o.operatorId === 'freighter')?.spilled).toBe(40);
    expect(result.operators.find((o) => o.operatorId === 'freighter')?.loadFactor).toBe(0);
    expect(result.operators.find((o) => o.operatorId === 'pax')?.recaptured).toBe(40);
  });

  it('loses the spill when every remaining operator holds no share', () => {
    // Degenerate, but it must not divide by zero and must not invent a split.
    const result = allocateCapacity([
      op({ id: 'a', demand: 200, seats: 100, share: 1 }),
      op({ id: 'b', demand: 0, seats: 500, share: 0 }),
    ]);

    expect(result.lostDemand).toBe(100);
    expect(result.operators.find((o) => o.operatorId === 'b')?.recaptured).toBe(0);
  });

  it('keeps fractional passengers fractional', () => {
    // The logit allocates fractions and so does this. Rounding here and then
    // dividing across a day's departures would compound the error twice; the
    // rounding belongs to M3-08's booking curve.
    const result = allocateCapacity([op({ id: 'a', demand: 33.3, seats: 100, share: 1 })]);

    expect(result.totalBooked).toBeCloseTo(33.3, 9);
    expect(Number.isInteger(result.totalBooked)).toBe(false);
  });

  it('is pure — the same market always clears the same way', () => {
    const market = [
      op({ id: 'a', demand: 150, seats: 100, share: 0.6 }),
      op({ id: 'b', demand: 40, seats: 90, share: 0.4 }),
    ];

    expect(allocateCapacity(market)).toEqual(allocateCapacity(market));
  });

  it('refuses inputs that cannot mean anything', () => {
    expect(() => allocateCapacity([op({ id: 'a', demand: -1 })])).toThrow(/demand/);
    expect(() => allocateCapacity([op({ id: 'a', seats: -1 })])).toThrow(/seats/);
    expect(() => allocateCapacity([op({ id: 'a', share: -1 })])).toThrow(/share/);
    expect(() => allocateCapacity([op({ id: 'a' }), op({ id: 'a' })])).toThrow(/[Dd]uplicate/);
  });

  it('is content with an empty market', () => {
    const result = allocateCapacity([]);

    expect(result.operators).toHaveLength(0);
    expect(result.totalDemand).toBe(0);
    expect(result.lostDemand).toBe(0);
  });
});

describe('downstream of the logit', () => {
  it('takes A.4’s shares and turns them into bookings', () => {
    // The seam that matters: A.4's output is A.5's input, with no adapter
    // between them beyond attaching seats.
    const pools: Record<DemandSegment, number> = { business: 240, leisure: 720, vfr: 240 };
    const shares = computeShares({
      operators: [
        { id: 'you', fareMinor: 9_500, frequency: 3, productScore: 0.62, reputation: 0.55 },
        { id: 'lcc', fareMinor: 6_900, frequency: 5, productScore: 0.38, reputation: 0.45 },
      ],
      segmentPools: pools,
    });

    // A 180-seat aircraft each: three rotations against five.
    const seats: Record<string, number> = { you: 3 * 180, lcc: 5 * 180 };
    const marketShare = (id: string) =>
      (shares.totalPassengers[id] ?? 0) /
      Object.values(shares.totalPassengers).reduce((a, b) => a + b, 0);

    const result = allocateCapacity(
      Object.entries(shares.totalPassengers).map(([id, demand]) => ({
        id,
        demand,
        seats: seats[id] ?? 0,
        share: marketShare(id),
      })),
    );

    expect(result.totalDemand).toBeCloseTo(1_200, 6);
    // Nobody is short of seats on this route, so nothing spills.
    expect(result.totalSpilled).toBe(0);
    expect(result.lostDemand).toBe(0);
    for (const row of result.operators) {
      expect(row.loadFactor).toBeGreaterThan(0);
      expect(row.loadFactor).toBeLessThan(1);
    }
  });

  it('spills when the aircraft is too small for the share it won', () => {
    const pools: Record<DemandSegment, number> = { business: 240, leisure: 720, vfr: 240 };
    const shares = computeShares({
      operators: [
        { id: 'you', fareMinor: 9_500, frequency: 3, productScore: 0.62, reputation: 0.55 },
        { id: 'lcc', fareMinor: 6_900, frequency: 5, productScore: 0.38, reputation: 0.45 },
      ],
      segmentPools: pools,
    });

    const total = Object.values(shares.totalPassengers).reduce((a, b) => a + b, 0);
    // The LCC wins most of this market on price and flies 50-seaters at it.
    const result = allocateCapacity([
      {
        id: 'you',
        demand: shares.totalPassengers.you ?? 0,
        seats: 3 * 180,
        share: (shares.totalPassengers.you ?? 0) / total,
      },
      {
        id: 'lcc',
        demand: shares.totalPassengers.lcc ?? 0,
        seats: 5 * 50,
        share: (shares.totalPassengers.lcc ?? 0) / total,
      },
    ]);

    const lcc = result.operators.find((o) => o.operatorId === 'lcc');
    const you = result.operators.find((o) => o.operatorId === 'you');

    expect(lcc?.spilled).toBeGreaterThan(0);
    expect(lcc?.loadFactor).toBe(1);
    // And the spill is exactly the strategic signal A.5 describes: the player
    // with the bigger aeroplanes picks up traffic they did not win on merit.
    expect(you?.recaptured).toBeGreaterThan(0);
  });
});
