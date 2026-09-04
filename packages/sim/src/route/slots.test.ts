import { describe, expect, it } from 'vitest';

import { bandOf, SLOT_BANDS_PER_DAY } from './slots';

/** The band arithmetic (M7-05) — the one pure fact in the slot model. */
describe('bandOf', () => {
  it('maps a minute of the day to its hour', () => {
    expect(bandOf(0)).toBe(0); // midnight
    expect(bandOf(59)).toBe(0);
    expect(bandOf(60)).toBe(1); // 01:00
    expect(bandOf(8 * 60)).toBe(8); // 08:00
    expect(bandOf(8 * 60 + 30)).toBe(8); // 08:30 is still the 08:00 band
    expect(bandOf(23 * 60 + 59)).toBe(23);
  });

  it('folds a rotation minute past midnight back into the day', () => {
    // A leg at 1,530 lands at 01:30 the next morning — the 01:00 band.
    expect(bandOf(1_530)).toBe(1);
    expect(bandOf(1_440)).toBe(0); // exactly midnight, next day
  });

  it('folds a negative minute forward, never out of range', () => {
    expect(bandOf(-30)).toBe(23); // 23:30 the day before
    expect(bandOf(-1_440)).toBe(0);
  });

  it('never leaves the day', () => {
    for (let m = -3_000; m <= 3_000; m += 7) {
      const band = bandOf(m);
      expect(band).toBeGreaterThanOrEqual(0);
      expect(band).toBeLessThan(SLOT_BANDS_PER_DAY);
    }
  });
});
