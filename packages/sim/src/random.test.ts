import { describe, expect, it } from 'vitest';

import { chance, createRng, deriveRng, hashSeed, intBetween, weightedPick } from './random';

/**
 * Seeded randomness (M2-08, invariant 2, M13-01).
 *
 * The statistical quality of `mulberry32` is not what these tests are about —
 * that is the algorithm's problem and it is well studied. What is tested here is
 * the property the rest of the game rests on, and which a hand-rolled
 * alternative would break silently:
 *
 *   **A stream depends on what it is for, and on nothing else.**
 *
 * Not on how many streams were made before it, not on the order flights were
 * handled in, not on which worker got there first. That is what makes replay
 * reproducible in a world where flights are materialised in batches and drained
 * by a queue that may run two workers.
 */

describe('hashSeed', () => {
  it('is stable — the same parts always give the same seed', () => {
    expect(hashSeed('world-1', 'flight', 'abc')).toBe(hashSeed('world-1', 'flight', 'abc'));
  });

  it('separates parts, so the same characters split differently do not collide', () => {
    expect(hashSeed('ab', 'c')).not.toBe(hashSeed('a', 'bc'));
  });

  it('avalanches — neighbouring ids give unrelated seeds', () => {
    // The trap this exists to avoid: seeding from a uuid's leading characters
    // would make a batch of flights created together disrupt together.
    const a = hashSeed('world-1', 'flight', 'aaaaaaaa-0000-0000-0000-000000000001');
    const b = hashSeed('world-1', 'flight', 'aaaaaaaa-0000-0000-0000-000000000002');

    expect(a).not.toBe(b);
    // Not merely different — far apart. Adjacent seeds would give correlated
    // early draws from mulberry32.
    expect(Math.abs(a - b)).toBeGreaterThan(1_000_000);
  });

  it('is a usable seed even for no parts at all', () => {
    expect(Number.isInteger(hashSeed())).toBe(true);
    expect(hashSeed()).toBeGreaterThan(0);
  });
});

describe('createRng', () => {
  it('produces the same sequence from the same seed, for ever', () => {
    const a = createRng(12_345);
    const b = createRng(12_345);

    expect([a(), a(), a(), a(), a()]).toEqual([b(), b(), b(), b(), b()]);
  });

  it('produces different sequences from different seeds', () => {
    const a = createRng(1);
    const b = createRng(2);

    expect(a()).not.toBe(b());
  });

  it('stays inside [0, 1)', () => {
    const rng = createRng(99);
    for (let i = 0; i < 2_000; i += 1) {
      const value = rng();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('is not obviously biased', () => {
    // A crude sanity check, not a statistical test suite: 10,000 draws should
    // average near 0.5 and fill both halves. It would catch a stream stuck in a
    // corner of the range, which is the failure that would matter here.
    const rng = createRng(7);
    let total = 0;
    let low = 0;
    for (let i = 0; i < 10_000; i += 1) {
      const value = rng();
      total += value;
      if (value < 0.5) low += 1;
    }

    expect(total / 10_000).toBeGreaterThan(0.48);
    expect(total / 10_000).toBeLessThan(0.52);
    expect(low).toBeGreaterThan(4_700);
    expect(low).toBeLessThan(5_300);
  });
});

describe('deriveRng', () => {
  it('gives one thing the same stream however many others were derived first', () => {
    // **The property the whole design exists for.** Under a single sequential
    // generator this test is impossible to pass.
    const first = deriveRng('world-seed', 'flight', 'target');

    // Derive a hundred other streams and draw from them, as a busy world would.
    for (let i = 0; i < 100; i += 1) {
      const other = deriveRng('world-seed', 'flight', `noise-${String(i)}`);
      other();
      other();
    }

    const again = deriveRng('world-seed', 'flight', 'target');
    expect(first()).toBe(again());
  });

  it('gives different things different streams', () => {
    const a = deriveRng('world-seed', 'flight', 'one');
    const b = deriveRng('world-seed', 'flight', 'two');

    expect(a()).not.toBe(b());
  });

  it('gives the same thing in different worlds different streams', () => {
    // Two worlds must not suffer the same weather on the same flight id.
    const a = deriveRng('world-a', 'flight', 'same-id');
    const b = deriveRng('world-b', 'flight', 'same-id');

    expect(a()).not.toBe(b());
  });

  it('keeps unrelated systems uncorrelated for the same subject', () => {
    // Without the label, an airframe would draw identical numbers for its
    // disruption and its maintenance, and the two would move together.
    const disruption = deriveRng('world-seed', 'flight', 'id');
    const maintenance = deriveRng('world-seed', 'maintenance', 'id');

    expect(disruption()).not.toBe(maintenance());
  });
});

describe('chance', () => {
  it('never fires at zero and always fires at one', () => {
    const rng = createRng(3);
    expect(chance(rng, 0)).toBe(false);
    expect(chance(rng, 1)).toBe(true);
    // Out of range clamps rather than throwing: a probability of 1.2 means
    // "certainly", which is a coherent thing for a caller to have computed.
    expect(chance(rng, -1)).toBe(false);
    expect(chance(rng, 5)).toBe(true);
  });

  it('fires about as often as asked', () => {
    const rng = createRng(11);
    let hits = 0;
    for (let i = 0; i < 10_000; i += 1) if (chance(rng, 0.25)) hits += 1;

    expect(hits).toBeGreaterThan(2_300);
    expect(hits).toBeLessThan(2_700);
  });

  it('refuses a probability that is not a number', () => {
    expect(() => chance(createRng(1), Number.NaN)).toThrow(/[Pp]robability/);
  });
});

describe('intBetween', () => {
  it('includes both ends', () => {
    const rng = createRng(5);
    const seen = new Set<number>();
    for (let i = 0; i < 500; i += 1) seen.add(intBetween(rng, 1, 3));

    expect([...seen].sort()).toEqual([1, 2, 3]);
  });

  it('handles a single-value range', () => {
    expect(intBetween(createRng(1), 7, 7)).toBe(7);
  });

  it('refuses bounds the wrong way round, rather than returning nonsense', () => {
    expect(() => intBetween(createRng(1), 10, 5)).toThrow(/wrong way round/);
  });

  it('refuses fractional bounds', () => {
    expect(() => intBetween(createRng(1), 1.5, 3)).toThrow(/whole numbers/);
  });
});

describe('weightedPick', () => {
  it('always returns the only option with weight', () => {
    const rng = createRng(2);
    for (let i = 0; i < 50; i += 1) {
      expect(
        weightedPick(rng, [
          ['yes', 1],
          ['no', 0],
        ]),
      ).toBe('yes');
    }
  });

  it('picks roughly in proportion to the weights', () => {
    const rng = createRng(13);
    let a = 0;
    for (let i = 0; i < 10_000; i += 1) {
      if (
        weightedPick(rng, [
          ['a', 3],
          ['b', 1],
        ]) === 'a'
      ) {
        a += 1;
      }
    }

    expect(a / 10_000).toBeGreaterThan(0.72);
    expect(a / 10_000).toBeLessThan(0.78);
  });

  it('refuses a negative weight', () => {
    expect(() =>
      weightedPick(createRng(1), [
        ['a', -1],
        ['b', 1],
      ]),
    ).toThrow(/zero or more/);
  });

  it('refuses a list that cannot be picked from', () => {
    expect(() => weightedPick(createRng(1), [])).toThrow();
    expect(() =>
      weightedPick(createRng(1), [
        ['a', 0],
        ['b', 0],
      ]),
    ).toThrow(/all zero/);
  });
});
