import { describe, expect, it } from 'vitest';

import { absoluteFromLocal, localFromAbsolute, minuteOfDay } from './airport-time';

/**
 * Local ↔ absolute schedule minutes (M3-04a).
 *
 * The pure arithmetic that makes "08:00 at an airport" mean 08:00 there. The
 * database loader is exercised by the schedule and slot DB tests.
 */

const AT = (h: number, m = 0): number => h * 60 + m;

describe('minuteOfDay', () => {
  it('folds any minute into a single day', () => {
    expect(minuteOfDay(0)).toBe(0);
    expect(minuteOfDay(1_440)).toBe(0);
    expect(minuteOfDay(1_500)).toBe(60);
    expect(minuteOfDay(-60)).toBe(1_380);
  });
});

describe('absoluteFromLocal', () => {
  it('shifts a local time west by the (negative) offset', () => {
    // 08:00 at UTC−5 (JFK) is 13:00 UTC.
    expect(absoluteFromLocal(AT(8), -300)).toBe(AT(13));
  });

  it('shifts a local time east, wrapping across midnight', () => {
    // 06:00 at UTC+9 (Tokyo) is 21:00 UTC the previous day → minute-of-day 1,260.
    expect(absoluteFromLocal(AT(6), 540)).toBe(AT(21));
  });

  it('is a no-op at UTC', () => {
    expect(absoluteFromLocal(AT(8), 0)).toBe(AT(8));
  });
});

describe('localFromAbsolute', () => {
  it('inverts absoluteFromLocal for every whole hour and a range of offsets', () => {
    for (const offset of [-720, -300, 0, 330, 540, 780]) {
      for (let h = 0; h < 24; h += 1) {
        const local = AT(h);
        expect(localFromAbsolute(absoluteFromLocal(local, offset), offset)).toBe(local);
      }
    }
  });
});
