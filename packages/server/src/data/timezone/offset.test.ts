import { describe, expect, it } from 'vitest';

import { isKnownTimeZone, offsetMinutesAt, standardOffsetMinutes } from './offset';

/**
 * IANA zone → standard UTC offset (M3-04a).
 *
 * These are known answers: every expectation below is a published fact about a
 * real place, not a figure this repository chose. That makes the suite unusual
 * for Tailfin — most of the sim is calibrated against the design doc, and this
 * is checkable against the world.
 */

describe('standardOffsetMinutes', () => {
  it.each([
    ['Europe/Amsterdam', 60],
    ['Europe/Madrid', 60],
    ['Atlantic/Canary', 0],
    ['Asia/Shanghai', 480],
    ['Asia/Kolkata', 330],
    ['Asia/Kathmandu', 345],
    ['America/Denver', -420],
    ['America/New_York', -300],
    ['Australia/Sydney', 600],
    ['Pacific/Chatham', 765],
    ['Pacific/Kiritimati', 840],
    ['UTC', 0],
  ])('resolves %s to %i minutes', (zone, expected) => {
    expect(standardOffsetMinutes(zone)).toBe(expected);
  });

  it('takes standard time in the southern hemisphere too', () => {
    // The reason it is the *minimum* of January and July rather than "January":
    // Sydney's January is its summer, and reading that would store +11 as
    // though it were the standard offset.
    const january = offsetMinutesAt('Australia/Sydney', new Date(Date.UTC(2026, 0, 15, 12)));
    const july = offsetMinutesAt('Australia/Sydney', new Date(Date.UTC(2026, 6, 15, 12)));

    expect(january).toBe(660);
    expect(july).toBe(600);
    expect(standardOffsetMinutes('Australia/Sydney')).toBe(600);
  });

  it('handles Ireland, whose daylight saving runs the other way', () => {
    // Irish Standard Time is legally the *summer* offset, with winter as a
    // negative deviation. Taking the minimum still gives 0, which is what
    // everyone means by Irish winter time — but it is worth pinning, because a
    // "use the January reading" implementation would agree here by luck and
    // disagree in Sydney.
    expect(standardOffsetMinutes('Europe/Dublin')).toBe(0);
  });

  it('gets the half- and quarter-hour offsets exactly right', () => {
    // The cases that made minutes the right unit for the column. An hours
    // column would have been wrong for a tenth of the world on day one.
    expect(standardOffsetMinutes('Asia/Kolkata') % 60).toBe(30);
    expect(standardOffsetMinutes('Asia/Kathmandu') % 60).toBe(45);
    expect(standardOffsetMinutes('Pacific/Chatham') % 60).toBe(45);
  });

  it('separates mainland Spain from the Canaries', () => {
    // The headline failure of longitude ÷ 15: both are Spain, both sit west of
    // Greenwich, and they are an hour apart.
    expect(standardOffsetMinutes('Europe/Madrid')).toBe(60);
    expect(standardOffsetMinutes('Atlantic/Canary')).toBe(0);
  });

  it('refuses a zone ICU does not know', () => {
    expect(() => standardOffsetMinutes('Middle/Earth')).toThrow();
  });
});

describe('offsetMinutesAt', () => {
  it('reads daylight saving correctly when asked for an instant', () => {
    // The function knows about DST; the *stored* offset deliberately does not.
    expect(offsetMinutesAt('Europe/Amsterdam', new Date(Date.UTC(2026, 6, 15, 12)))).toBe(120);
    expect(offsetMinutesAt('Europe/Amsterdam', new Date(Date.UTC(2026, 0, 15, 12)))).toBe(60);
  });

  it('does not fall a day out at midnight', () => {
    // `hour12: false` renders midnight as hour 24 on some ICU builds, which
    // would put the reading 24 hours out. `hourCycle: 'h23'` is why it does not.
    expect(offsetMinutesAt('UTC', new Date(Date.UTC(2026, 0, 15, 0, 0, 0)))).toBe(0);
    expect(offsetMinutesAt('Asia/Tokyo', new Date(Date.UTC(2026, 0, 15, 15, 0, 0)))).toBe(540);
  });

  it('is exact for a whole-minute offset either side of UTC', () => {
    expect(offsetMinutesAt('America/New_York', new Date(Date.UTC(2026, 0, 15, 12)))).toBe(-300);
    expect(offsetMinutesAt('Asia/Tokyo', new Date(Date.UTC(2026, 0, 15, 12)))).toBe(540);
  });
});

describe('isKnownTimeZone', () => {
  it('accepts real zones and rejects nonsense', () => {
    expect(isKnownTimeZone('Europe/Amsterdam')).toBe(true);
    expect(isKnownTimeZone('UTC')).toBe(true);
    expect(isKnownTimeZone('Middle/Earth')).toBe(false);
    expect(isKnownTimeZone('')).toBe(false);
  });

  it('exists so one stale row cannot stop an import', () => {
    // GeoNames is third-party data and may name a zone that has since been
    // renamed or merged away. That has to fall back, not throw.
    expect(isKnownTimeZone('Not/AZone')).toBe(false);
  });
});
