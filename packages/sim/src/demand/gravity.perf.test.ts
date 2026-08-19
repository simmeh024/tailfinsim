import { describe, expect, it } from 'vitest';

import { haversineNm } from '../distance';

import { type DemandEndpoint, demandPool, isViablePair } from './gravity';

/**
 * Generating every viable pool inside M3-01's budget (App. A.2).
 *
 * *"Pool generation for all viable city pairs completes in under 5 minutes."*
 *
 * ## What "all pairs" actually means
 *
 * About **4,400 airports carry scheduled service**, which is ~9.7 million
 * unordered pairs. A market is the same market in both directions — the segment
 * split is symmetric and so is the affinity — so the ordered count would be
 * double-counting rather than thoroughness.
 *
 * The test measures a representative slice and extrapolates, rather than running
 * the whole thing: a unit test that takes five minutes to prove something takes
 * under five minutes has failed at being a test.
 *
 * ## Measured here, not where it counts
 *
 * CLAUDE.md is explicit that a laptop is not the criterion — the production box
 * is a 2-core Xeon E5-2620 v4, roughly **five times slower** than a development
 * machine. So the budget asserted below is the real one divided by five, and the
 * headroom is stated rather than assumed. If this ever gets close, measure it on
 * the box before deciding it is fine.
 *
 * Measured on the development machine at the time of writing: **0.42 µs a pair**,
 * so 9.7 million pairs is about 4 seconds here and an estimated 20 on the box,
 * against a 300-second budget. Fifteen times the headroom, which is the sort of
 * margin that survives a model growing another term or two.
 */

const clock = (globalThis as unknown as { performance: { now: () => number } }).performance;

function coverageInstrumented(): boolean {
  const worker = (globalThis as Record<string, unknown>).__vitest_worker__ as
    { config?: { coverage?: { enabled?: boolean } } } | undefined;
  return worker?.config?.coverage?.enabled === true;
}

/** Airports carrying scheduled service, from M1-01's import. */
const WORLD_AIRPORTS = 4_400;
const WORLD_PAIRS = (WORLD_AIRPORTS * (WORLD_AIRPORTS - 1)) / 2;

/** The production box is about five times slower than a development machine. */
const SERVER_SLOWDOWN = 5;
const BUDGET_MS = 5 * 60 * 1_000;

/**
 * A spread of synthetic airports covering the range the real set does.
 *
 * Varied deliberately: a thousand identical airports would measure the branch
 * predictor rather than the model, and the affinity terms have branches in them
 * that a uniform sample would never take.
 */
function buildAirports(count: number): DemandEndpoint[] {
  const countries = ['NL', 'GB', 'ES', 'US', 'DE', 'FR', 'IT', 'BR', 'JP', 'AU'];
  const languages = ['nl', 'en', 'es', 'en', 'de', 'fr', 'it', 'pt', 'ja', 'en'];
  const airports: DemandEndpoint[] = [];

  for (let i = 0; i < count; i += 1) {
    // A golden-angle spiral, so the points are spread over the sphere rather
    // than clustered at the poles the way a naive lat/lon grid would be.
    const t = (i + 0.5) / count;
    const latitude = Math.asin(2 * t - 1) * (180 / Math.PI);
    const longitude = ((i * 137.508) % 360) - 180;
    const country = i % countries.length;

    airports.push({
      icaoCode: `A${String(i).padStart(4, '0')}`,
      // Log-uniform from 2,000 to about 9 million. The real set is dominated by
      // small regional fields with a handful of enormous ones, and a uniform
      // spread would make every pair viable — which would leave the filter
      // branch untested and the measurement unrepresentative.
      population: Math.round(2_000 * 1.08 ** (i % 110)),
      wealthIndex: 0.4 + ((i * 7) % 30) / 10,
      tourismIndex: 0.3 + ((i * 13) % 35) / 10,
      businessIndex: 0.3 + ((i * 19) % 28) / 10,
      isoCountry: countries[country] ?? 'ZZ',
      language: languages[country],
      // Coordinates are not on DemandEndpoint — they are the caller's, and the
      // caller is what computes distance. Kept alongside for the sweep below.
      ...({ latitude, longitude } as object),
    });
  }

  return airports;
}

describe('cost at world scale', () => {
  /**
   * A generous timeout, because this is a benchmark on a shared runner.
   *
   * The first version used vitest's default five seconds and measured 719,000
   * pairs across four sweeps. That took 4.2 s on one CI run and 5.6 s on the
   * next, so it began failing unrelated pull requests — a benchmark that flakes
   * is worse than no benchmark, because it trains people to re-run CI without
   * reading it.
   *
   * Fixed at both ends: a smaller sample, and a timeout that is not a budget.
   * The *measurement* is per pair and extrapolated, so a smaller sample costs a
   * little precision and nothing else — while the five-minute budget being
   * asserted has nothing to do with how long this test may take to run.
   */
  it('generates every viable demand pool well inside five minutes', { timeout: 60_000 }, () => {
    // 700 airports is ~245,000 pairs. Large enough that the per-pair figure is
    // stable, small enough that four sweeps take well under a second.
    const sample = 700;
    const airports = buildAirports(sample) as (DemandEndpoint & {
      latitude: number;
      longitude: number;
    })[];
    const samplePairs = (sample * (sample - 1)) / 2;

    /**
     * One full sweep, exactly as the generator will run it: enumerate the
     * unordered pairs, get a distance, size the pool, keep the viable ones.
     *
     * The distance is computed rather than looked up, which is the pessimistic
     * choice — M1-04's matrix exists and the real generator would read from it.
     * Measuring the slower path means the budget cannot be missed by an
     * optimisation that quietly disappears.
     */
    const sweep = (): number => {
      let viable = 0;
      for (let i = 0; i < airports.length; i += 1) {
        const origin = airports[i];
        if (!origin) continue;
        for (let j = i + 1; j < airports.length; j += 1) {
          const destination = airports[j];
          if (!destination) continue;
          const distanceNm = haversineNm(
            origin.latitude,
            origin.longitude,
            destination.latitude,
            destination.longitude,
          );
          if (isViablePair(demandPool(origin, destination, distanceNm))) viable += 1;
        }
      }
      return viable;
    };

    // Warm up. Timing the optimiser rather than the code would measure nothing.
    sweep();

    // The fastest of several runs, for the reason `position.test.ts` records:
    // every machine this runs on is shared, noise only ever adds time, and one
    // sample measures the neighbours.
    let elapsedMs = Infinity;
    let viable = 0;
    for (let run = 0; run < 3; run += 1) {
      const started = clock.now();
      viable = sweep();
      elapsedMs = Math.min(elapsedMs, clock.now() - started);
    }

    // The sweep has to be doing real work for the number to mean anything: some
    // pairs viable, some not. All-or-nothing would mean the filter never ran.
    expect(viable).toBeGreaterThan(samplePairs * 0.02);
    expect(viable).toBeLessThan(samplePairs * 0.98);

    const perPairUs = (elapsedMs * 1_000) / samplePairs;
    const worldMs = perPairUs * WORLD_PAIRS * 1e-3;
    const onTheBoxMs = worldMs * SERVER_SLOWDOWN;

    // Always on: catches an accidental O(n²) inside the pair loop — which would
    // make the whole thing O(n⁴) — in any mode.
    expect(onTheBoxMs).toBeLessThan(BUDGET_MS * 4);

    if (!coverageInstrumented()) {
      // The real assertion: the full world, on the slow box, inside the budget.
      expect(onTheBoxMs).toBeLessThan(BUDGET_MS);
    }
  });
});
