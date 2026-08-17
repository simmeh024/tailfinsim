import { type NormalisedAirport, type NormalisedRunway } from './normalise';

/**
 * Sanity checks against the layered table in App. B.1.
 *
 * M1-01 asks for row counts to be "sanity-checked against the layered table in
 * App. B.1". This is that check with teeth: it runs inside the import
 * transaction, and a failure rolls the whole thing back.
 *
 * The point is not to assert the doc's figures exactly — they are approximations
 * of a dataset that grows every week, and pinning them would mean the import
 * breaking on ordinary upstream churn. The point is to catch the failure that
 * actually happens: a truncated download, a mirror serving an error page as CSV,
 * or a schema change upstream that silently empties a column. Each bound below is
 * wide enough to be quiet for years and tight enough to catch a file that is half
 * the size it should be.
 */

export interface SanityCheck {
  label: string;
  /** What App. B.1 leads you to expect, for the report. */
  expected: string;
  actual: number;
  min: number;
  max: number;
  passed: boolean;
}

/**
 * The bounds, as data rather than as literals inside the check.
 *
 * A parameter and not a constant because the bounds are a statement *about a
 * dataset*, and a test fixture of thirty airports is a different dataset with
 * different legitimate expectations. Tightening them later is then an edit to
 * one object rather than to the logic. The CLI never passes anything here.
 */
export interface SanityBounds {
  airportsTotal: [number, number];
  airportsOpen: [number, number];
  scheduledService: [number, number];
  largeAirports: [number, number];
  mediumAirports: [number, number];
  countries: [number, number];
  withIata: [number, number];
  runways: [number, number];
}

/** What App. B.1 and the 2026-08-17 file lead you to expect. */
export const DEFAULT_SANITY_BOUNDS: SanityBounds = {
  airportsTotal: [60_000, 200_000],
  airportsOpen: [50_000, 150_000],
  scheduledService: [3_000, 6_000],
  largeAirports: [700, 2_500],
  mediumAirports: [2_500, 8_000],
  countries: [200, 300],
  withIata: [6_000, 14_000],
  runways: [30_000, 120_000],
};

export interface SanityReport {
  checks: SanityCheck[];
  passed: boolean;
  failures: SanityCheck[];
}

function check(
  label: string,
  expected: string,
  actual: number,
  min: number,
  max: number,
): SanityCheck {
  return { label, expected, actual, min, max, passed: actual >= min && actual <= max };
}

export function sanityCheck(
  airports: readonly NormalisedAirport[],
  runways: readonly NormalisedRunway[],
  bounds: SanityBounds = DEFAULT_SANITY_BOUNDS,
): SanityReport {
  const open = airports.filter((a) => a.kind !== 'closed');
  const scheduled = open.filter((a) => a.scheduledService);
  const large = airports.filter((a) => a.kind === 'large_airport');
  const medium = airports.filter((a) => a.kind === 'medium_airport');
  const countries = new Set(airports.map((a) => a.isoCountry));
  const withIata = airports.filter((a) => a.iataCode !== null);

  const checks: SanityCheck[] = [
    // B.1 "Full dataset ~75,000. Everything with an ICAO code."
    check('airports, all', '≈ 86,000 rows in the file', airports.length, ...bounds.airportsTotal),
    check('airports, not closed', 'B.1 full dataset ≈ 75,000', open.length, ...bounds.airportsOpen),
    // B.1 "Scheduled-service airports ~4,000 — the playable world."
    check('scheduled service', 'B.1 ≈ 4,000', scheduled.length, ...bounds.scheduledService),
    // Not a B.1 layer, but the closest upstream proxy for one, and a good
    // tripwire for the `type` column changing meaning.
    check('large_airport', 'upstream type, ≈ 1,200', large.length, ...bounds.largeAirports),
    check('medium_airport', 'upstream type, ≈ 4,100', medium.length, ...bounds.mediumAirports),
    check(
      'countries represented',
      'essentially every country',
      countries.size,
      ...bounds.countries,
    ),
    check('airports with an IATA code', '≈ 9,000', withIata.length, ...bounds.withIata),
    check('runways', '≈ 48,000', runways.length, ...bounds.runways),
  ];

  const failures = checks.filter((c) => !c.passed);
  return { checks, passed: failures.length === 0, failures };
}

/**
 * Thousands separators, pinned to one locale.
 *
 * `toLocaleString()` with no argument follows the machine's locale, so the same
 * import would print `85,915` on the server and `85.915` on a Dutch laptop. Log
 * output that changes shape with the operator's locale is not something to
 * discover while comparing two runs.
 */
export function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

/** Renders the report as a fixed-width table for the import log. */
export function formatSanityReport(report: SanityReport): string {
  const width = Math.max(...report.checks.map((c) => c.label.length));
  const lines = report.checks.map((c) => {
    const mark = c.passed ? 'ok  ' : 'FAIL';
    const range = `expected ${formatCount(c.min)}–${formatCount(c.max)}`;
    return `  ${mark} ${c.label.padEnd(width)}  ${formatCount(c.actual).padStart(9)}   ${range}  (${c.expected})`;
  });
  return lines.join('\n');
}
