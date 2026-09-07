import { describe, expect, it } from 'vitest';

import {
  bandCapacity,
  bandOf,
  bandShape,
  nextReleaseWave,
  releasedBandCapacity,
  releasedFraction,
  SLOT_BANDS_PER_DAY,
  SLOT_RELEASE_WAVES,
  worldAgeGameDays,
} from './slots';

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

/**
 * Peak shaping (M7-05). The property that matters is App. B.5's promise: a new
 * entrant at a flagship gets the early morning and the late evening, and nothing
 * else. A uniform capacity across 24 hours cannot keep it.
 */
describe('bandShape and bandCapacity', () => {
  it('calls the morning and evening departure waves peak', () => {
    for (const band of [6, 7, 8, 9, 16, 17, 18, 19]) {
      expect(bandShape(band), `band ${String(band)}`).toBe('peak');
    }
  });

  it('calls the night and the small hours off-peak — B.5’s 05:40 and 23:10', () => {
    for (const band of [22, 23, 0, 1, 2, 3, 4, 5]) {
      expect(bandShape(band), `band ${String(band)}`).toBe('off_peak');
    }
  });

  it('leaves the middle of the day as shoulder', () => {
    for (const band of [10, 11, 12, 13, 14, 15, 20, 21]) {
      expect(bandShape(band), `band ${String(band)}`).toBe('shoulder');
    }
  });

  it('shapes every hour of the day and nothing outside it', () => {
    const shapes = Array.from({ length: SLOT_BANDS_PER_DAY }, (_, b) => bandShape(b));
    expect(shapes.filter((s) => s === 'peak')).toHaveLength(8);
    expect(shapes.filter((s) => s === 'off_peak')).toHaveLength(8);
    expect(shapes.filter((s) => s === 'shoulder')).toHaveLength(8);
  });

  it('makes an off-peak band roomier than peak at the same airport', () => {
    // A flagship base of 8: 4 at 08:00, 14 at 03:00. That gap is the mechanic.
    expect(bandCapacity(8, 8)).toBe(4);
    expect(bandCapacity(8, 12)).toBe(8);
    expect(bandCapacity(8, 3)).toBe(14);
    expect(bandCapacity(8, 3)).toBeGreaterThan(bandCapacity(8, 8));
  });

  it('never shapes a positive base down to nothing', () => {
    for (let base = 1; base <= 12; base += 1) {
      for (let band = 0; band < SLOT_BANDS_PER_DAY; band += 1) {
        expect(
          bandCapacity(base, band),
          `base ${String(base)} band ${String(band)}`,
        ).toBeGreaterThan(0);
      }
    }
  });
});

/**
 * The release waves (M7-05), which exist to answer §21's third open question:
 * *"first-come-first-served creates a permanent land grab"*.
 */
describe('slot release waves', () => {
  it('publishes a schedule that only ever opens more', () => {
    let previous = 0;
    for (const wave of SLOT_RELEASE_WAVES) {
      expect(wave.fraction).toBeGreaterThan(previous);
      previous = wave.fraction;
    }
    expect(SLOT_RELEASE_WAVES[0]?.atGameDay).toBe(0);
    expect(previous).toBe(1);
  });

  it('holds back half the board on opening day', () => {
    // The land grab this exists to prevent: the founding cohort cannot take it all.
    expect(releasedFraction(0)).toBe(0.5);
    expect(releasedBandCapacity(8, 8, 0)).toBe(2);
    expect(releasedBandCapacity(8, 8, 0)).toBeLessThan(bandCapacity(8, 8));
  });

  it('opens the rest on the published days and never before', () => {
    expect(releasedFraction(29)).toBe(0.5);
    expect(releasedFraction(30)).toBe(0.75);
    expect(releasedFraction(89)).toBe(0.75);
    expect(releasedFraction(90)).toBe(1);
    expect(releasedFraction(10_000)).toBe(1);
  });

  it('never releases less as a world ages', () => {
    let previous = 0;
    for (let day = 0; day <= 200; day += 1) {
      const now = releasedFraction(day);
      expect(now, `day ${String(day)}`).toBeGreaterThanOrEqual(previous);
      previous = now;
    }
  });

  it('leaves a newcomer an off-peak slot in a fully mature world', () => {
    // M7-05's first acceptance criterion, as arithmetic. Every peak seat at a
    // mature flagship is gone; the night is still open, exactly as B.5 promises.
    const base = 8;
    const peakSeats = releasedBandCapacity(base, 8, 90);
    const offPeakSeats = releasedBandCapacity(base, 3, 90);
    expect(peakSeats).toBe(4);
    expect(offPeakSeats).toBe(14);
    // A world with 4 established airlines holding every peak band still has room
    // for a fifth at 03:00.
    expect(offPeakSeats - peakSeats).toBeGreaterThan(0);
  });

  it('names the next wave, and stops naming one when the board is fully open', () => {
    expect(nextReleaseWave(0)).toEqual({ atGameDay: 30, fraction: 0.75 });
    expect(nextReleaseWave(30)).toEqual({ atGameDay: 90, fraction: 1 });
    expect(nextReleaseWave(90)).toBeNull();
  });

  it('releases at least one seat wherever the band will ever hold one', () => {
    for (let base = 1; base <= 12; base += 1) {
      for (let band = 0; band < SLOT_BANDS_PER_DAY; band += 1) {
        expect(
          releasedBandCapacity(base, band, 0),
          `base ${String(base)} band ${String(band)}`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it('measures a world’s age in whole game days, never negative', () => {
    const epoch = new Date('1960-01-01T00:00:00.000Z');
    expect(worldAgeGameDays(epoch, epoch)).toBe(0);
    expect(worldAgeGameDays(epoch, new Date('1960-01-31T12:00:00.000Z'))).toBe(30);
    // A clock behind the epoch is a young world, not a negative one.
    expect(worldAgeGameDays(epoch, new Date('1959-12-01T00:00:00.000Z'))).toBe(0);
  });
});
