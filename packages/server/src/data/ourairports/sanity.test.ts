import { describe, expect, it } from 'vitest';

import { type NormalisedAirport, type NormalisedRunway } from './normalise';
import { DEFAULT_SANITY_BOUNDS, formatCount, formatSanityReport, sanityCheck } from './sanity';

/**
 * The B.1 guard rails.
 *
 * The bounds are deliberately wide — they exist to catch a truncated download or
 * a mirror serving an error page, not to pin figures that grow every week. These
 * tests check that they are wide enough to be quiet on the real shape of the
 * data and tight enough to catch the failures that matter.
 */

function airports(spec: {
  total: number;
  closed?: number;
  scheduled?: number;
  large?: number;
  medium?: number;
  countries?: number;
  withIata?: number;
}): NormalisedAirport[] {
  const {
    total,
    closed = 0,
    scheduled = 0,
    large = 0,
    medium = 0,
    countries = 250,
    withIata = 0,
  } = spec;

  return Array.from({ length: total }, (_, i) => {
    const kind =
      i < closed
        ? 'closed'
        : i < closed + large
          ? 'large_airport'
          : i < closed + large + medium
            ? 'medium_airport'
            : 'small_airport';
    // Spread across `countries` distinct two-letter codes.
    const code = i % countries;
    return {
      sourceId: i,
      ident: `X${String(i)}`,
      icaoCode: null,
      iataCode: i < withIata ? `I${String(i)}` : null,
      name: `Airport ${String(i)}`,
      municipality: null,
      isoCountry: `${String.fromCharCode(65 + Math.floor(code / 26))}${String.fromCharCode(65 + (code % 26))}`,
      isoRegion: null,
      continent: null,
      kind,
      latitude: 1,
      longitude: 1,
      elevationFt: 0,
      // Scheduled ones are taken from the not-closed end so they count.
      scheduledService: i >= closed && i < closed + scheduled,
    } satisfies NormalisedAirport;
  });
}

function runways(count: number): NormalisedRunway[] {
  return Array.from({ length: count }, (_, i) => ({
    sourceId: i,
    airportIdent: `X${String(i)}`,
    identifier: '09/27',
    lengthFt: 8000,
    widthFt: 150,
    surfaceRaw: 'ASP',
    surface: 'asphalt' as const,
    lighted: true,
    closed: false,
  }));
}

/** Roughly the shape of the real 2026-08-17 file. */
const REALISTIC = {
  airports: airports({
    total: 85_915,
    closed: 13_442,
    scheduled: 4_359,
    large: 1_173,
    medium: 4_100,
    countries: 250,
    withIata: 9_052,
  }),
  runways: runways(48_167),
};

describe('sanityCheck', () => {
  it('passes on the real shape of the dataset', () => {
    const report = sanityCheck(REALISTIC.airports, REALISTIC.runways);
    expect(report.passed).toBe(true);
    expect(report.failures).toEqual([]);
  });

  it('has headroom above and below the current figures', () => {
    // The bounds must not need editing on ordinary upstream growth. Every actual
    // should sit clear of both ends of its range.
    for (const check of sanityCheck(REALISTIC.airports, REALISTIC.runways).checks) {
      expect(check.actual).toBeGreaterThan(check.min);
      expect(check.actual).toBeLessThan(check.max);
    }
  });

  it('catches a truncated download', () => {
    // The failure that actually happens: a mirror hiccup halfway through.
    const report = sanityCheck(REALISTIC.airports.slice(0, 20_000), REALISTIC.runways);
    expect(report.passed).toBe(false);
    expect(report.failures.map((f) => f.label)).toContain('airports, all');
  });

  it('catches an empty file', () => {
    const report = sanityCheck([], []);
    expect(report.passed).toBe(false);
    expect(report.failures.length).toBeGreaterThan(4);
  });

  it('catches scheduled service collapsing to nothing', () => {
    // The column changing meaning upstream would empty the playable world while
    // leaving the row count untouched.
    const noScheduled = airports({
      total: 85_915,
      closed: 13_442,
      scheduled: 0,
      large: 1_173,
      medium: 4_100,
      withIata: 9_052,
    });
    const report = sanityCheck(noScheduled, REALISTIC.runways);
    expect(report.passed).toBe(false);
    expect(report.failures.map((f) => f.label)).toContain('scheduled service');
  });

  it('catches runways going missing while airports stay', () => {
    const report = sanityCheck(REALISTIC.airports, runways(12));
    expect(report.passed).toBe(false);
    expect(report.failures.map((f) => f.label)).toContain('runways');
  });

  it('reports every check, not only the failures', () => {
    // The report is read when something has gone wrong; the passing lines are
    // what tell you how far off the failing one is.
    expect(sanityCheck([], []).checks).toHaveLength(8);
  });

  it('accepts explicit bounds so a fixture can state its own expectations', () => {
    const tiny = airports({ total: 3, countries: 2 });
    expect(sanityCheck(tiny, []).passed).toBe(false);
    expect(
      sanityCheck(tiny, [], {
        ...DEFAULT_SANITY_BOUNDS,
        airportsTotal: [1, 10],
        airportsOpen: [1, 10],
        scheduledService: [0, 10],
        largeAirports: [0, 10],
        mediumAirports: [0, 10],
        countries: [1, 10],
        withIata: [0, 10],
        runways: [0, 10],
      }).passed,
    ).toBe(true);
  });
});

describe('formatSanityReport', () => {
  it('marks failures distinctly from passes', () => {
    const report = sanityCheck(REALISTIC.airports.slice(0, 100), REALISTIC.runways);
    const text = formatSanityReport(report);
    expect(text).toMatch(/FAIL airports, all/);
    expect(text).toMatch(/ok\s+runways/);
  });

  it('formats counts in one fixed locale, not the operator machine locale', () => {
    // Caught for real: `toLocaleString()` with no argument printed 85.915 on a
    // Dutch laptop and 85,915 on the server, for the same import.
    expect(formatCount(85_915)).toBe('85,915');
  });

  it('shows the expected range alongside the actual', () => {
    const text = formatSanityReport(sanityCheck(REALISTIC.airports, REALISTIC.runways));
    expect(text).toMatch(/expected 60,000–200,000/);
  });
});
