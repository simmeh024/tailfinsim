import { describe, expect, it } from 'vitest';

import {
  EASY_ELEVATION_FT,
  EASY_RUNWAY_FT,
  HARD_ELEVATION_FT,
  HARD_RUNWAY_FT,
  rateAirport,
} from './rating';
import { loadDifficultyReference } from './reference';

/**
 * Airport difficulty (M9-02, §10.2).
 *
 * AC2 is *"airport difficulty ratings are data, seeded for known hard
 * airports"*, and that has two halves this file checks separately: the rule is
 * uniform and derived from imported geometry, and the list supplies only what
 * the geometry cannot see.
 */

const FLAT = { longestRunwayFt: 12_000, elevationFt: 20 };

describe('the derived rule', () => {
  it('rates an ordinary long field at sea level as nothing at all', () => {
    expect(rateAirport(FLAT, null).difficulty).toBe(0);
  });

  it('rates a short runway as harder, monotonically', () => {
    const long = rateAirport({ ...FLAT, longestRunwayFt: EASY_RUNWAY_FT }, null).difficulty;
    const medium = rateAirport({ ...FLAT, longestRunwayFt: 5_000 }, null).difficulty;
    const short = rateAirport({ ...FLAT, longestRunwayFt: HARD_RUNWAY_FT }, null).difficulty;
    expect(long).toBe(0);
    expect(medium).toBeGreaterThan(long);
    expect(short).toBeGreaterThan(medium);
    // Saturated: a 1,500 ft strip is not twice as hard as a 3,000 ft one on
    // this term, because the term has run out.
    expect(rateAirport({ ...FLAT, longestRunwayFt: 1_500 }, null).runwayTerm).toBe(
      rateAirport({ ...FLAT, longestRunwayFt: HARD_RUNWAY_FT }, null).runwayTerm,
    );
  });

  it('rates a high field as harder, monotonically', () => {
    const low = rateAirport({ ...FLAT, elevationFt: EASY_ELEVATION_FT }, null).difficulty;
    const high = rateAirport({ ...FLAT, elevationFt: 7_000 }, null).difficulty;
    const extreme = rateAirport({ ...FLAT, elevationFt: HARD_ELEVATION_FT }, null).difficulty;
    expect(low).toBe(0);
    expect(high).toBeGreaterThan(low);
    expect(extreme).toBeGreaterThan(high);
  });

  it('adds the two terms — short and high is harder than either', () => {
    const shortOnly = rateAirport({ longestRunwayFt: 4_000, elevationFt: 20 }, null);
    const highOnly = rateAirport({ longestRunwayFt: 12_000, elevationFt: 8_000 }, null);
    const both = rateAirport({ longestRunwayFt: 4_000, elevationFt: 8_000 }, null);
    expect(both.difficulty).toBeGreaterThan(shortOnly.difficulty);
    expect(both.difficulty).toBeGreaterThan(highOnly.difficulty);
  });

  it('never leaves the 0-1 scale, however extreme the field', () => {
    const worst = rateAirport({ longestRunwayFt: 800, elevationFt: 15_000 }, null);
    expect(worst.difficulty).toBeLessThanOrEqual(1);
    expect(worst.difficulty).toBeGreaterThan(0);
  });

  /**
   * The trap this guards: 308 scheduled-service airports have no runway rows at
   * all. Treating "we were not told" as "3,000 ft" would rate a third of Africa
   * as harder than Innsbruck.
   */
  it('treats unknown geometry as unknown, never as the worst case', () => {
    expect(rateAirport({ longestRunwayFt: null, elevationFt: null }, null).difficulty).toBe(0);
    expect(rateAirport({ longestRunwayFt: null, elevationFt: 20 }, null).runwayTerm).toBe(0);
    expect(rateAirport({ longestRunwayFt: 12_000, elevationFt: null }, null).elevationTerm).toBe(0);
  });
});

describe('the seeded list', () => {
  const seeded = { rating: 0.9, reason: 'terrain' as const };

  it('raises a rating the geometry would have missed', () => {
    const result = rateAirport(FLAT, seeded);
    expect(result.difficulty).toBe(0.9);
    expect(result.source).toBe('seeded');
    expect(result.derived).toBe(0);
    expect(result.reason).toBe('terrain');
  });

  it('never lowers one — a listed field is at least as hard as its geometry', () => {
    // A short, high field whose derived rating already exceeds a modest entry.
    const geometry = { longestRunwayFt: 3_000, elevationFt: 12_000 };
    const derivedOnly = rateAirport(geometry, null).difficulty;
    const withEntry = rateAirport(geometry, { rating: 0.2, reason: 'slope' as const });
    expect(withEntry.difficulty).toBe(derivedOnly);
    expect(withEntry.source).toBe('derived');
  });

  it('does not double-count a field that is short, high and terrain-constrained', () => {
    // Lukla's shape. `max` rather than a sum: three terms added would put it far
    // past the top of a scale other airports are measured against.
    const lukla = rateAirport(
      { longestRunwayFt: 1_729, elevationFt: 9_334 },
      { rating: 1.0, reason: 'terrain' },
    );
    expect(lukla.difficulty).toBe(1);
  });
});

/**
 * The committed list itself. It is data, so the checks are about the data.
 */
describe('the reference file', () => {
  const list = loadDifficultyReference();

  it('loads, and is not empty', () => {
    expect(list.size).toBeGreaterThan(30);
  });

  it('keys on four-character ICAO codes', () => {
    for (const icao of list.keys()) {
      expect(icao).toMatch(/^[A-Z0-9]{4}$/);
    }
  });

  it('keeps every rating inside the scale, and above zero', () => {
    for (const [icao, entry] of list) {
      expect(entry.rating, icao).toBeGreaterThan(0);
      expect(entry.rating, icao).toBeLessThanOrEqual(1);
    }
  });

  it('names one of the three reasons the geometry cannot see', () => {
    for (const [icao, entry] of list) {
      expect(['terrain', 'slope', 'steep_approach'], icao).toContain(entry.reason);
    }
  });

  it('carries the famously hard fields §10.2 is written about', () => {
    // Lukla and Courchevel are the canonical extreme cases; if either drops out
    // of the file the seeded half of AC2 has quietly stopped being true.
    expect(list.get('VNLK')?.rating).toBeGreaterThan(0.9);
    expect(list.get('LFLJ')?.rating).toBeGreaterThan(0.8);
  });

  it('carries a winter northern network, which is §10.2’s own example', () => {
    // The acceptance criterion names this network specifically, so the list has
    // to be able to produce one. Svalbard, Greenland and Lapland.
    for (const icao of ['ENSB', 'BGGH', 'EFKT', 'ENTC']) {
      expect(list.get(icao)?.rating, icao).toBeGreaterThan(0);
    }
  });

  it('gives every entry a note, so a rating can be argued with', () => {
    for (const [icao, entry] of list) {
      expect(entry.note.length, icao).toBeGreaterThan(3);
    }
  });
});
