import { describe, expect, it } from 'vitest';

import { isCoordinated, slotCapacityPerHour } from './slots';

/**
 * The slot rules that need no database (M7-05).
 *
 * Which airports require a slot, and how many holders a band takes. Claiming,
 * releasing and the authoring resolver all touch rows, so they are proved in
 * `slots-db.test.ts`.
 */
describe('isCoordinated', () => {
  it('is true only at IATA Level 3', () => {
    expect(isCoordinated(3)).toBe(true);
    expect(isCoordinated(2)).toBe(false);
    expect(isCoordinated(1)).toBe(false);
    expect(isCoordinated(null)).toBe(false);
  });
});

describe('slotCapacityPerHour', () => {
  it('caps a flagship harder to reach than a large airport', () => {
    expect(slotCapacityPerHour('flagship')).toBeGreaterThan(slotCapacityPerHour('large'));
  });

  it('gives any other coordinated tier a positive fallback capacity', () => {
    // A medium/small airport forced to Level 3 by the override list still needs a
    // finite cap rather than crashing or being uncapped.
    expect(slotCapacityPerHour('medium')).toBeGreaterThan(0);
    expect(slotCapacityPerHour(null)).toBeGreaterThan(0);
  });
});
