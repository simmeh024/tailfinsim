import { describe, expect, it } from 'vitest';

import { MetricId } from '@tailfin/shared';

import { collectRegisteredRoutes } from '../test-fixtures/route-inventory';

import { BREAKDOWN_DIMENSIONS, METRICS, rowDrillDown } from './registry';

/**
 * §14.1's rule, enforced rather than intended — M8-09's first acceptance
 * criterion.
 *
 * > Every exposed metric has a working drill-down; a metric without one fails a
 * > test.
 *
 * "Working" is doing a lot of work in that sentence, and the interesting failure
 * is not a metric with no drill-down at all — the type system already refuses
 * that, because `MetricDefinition.drillDown` has no `?`. It is a metric whose
 * drill-down names an endpoint that **used to exist**. Routes get renamed and a
 * link rots in silence, so this asks the router what it actually serves.
 *
 * **No database.** Route registration never touches the pool, so this runs on
 * every pull request rather than only where `DATABASE_URL` is set — the same
 * reasoning `authorization-inventory.test.ts` gives, and for the same reason: a
 * dead drill-down is exactly the mistake that arrives from someone who never ran
 * the database suites.
 */
describe('every metric drills down somewhere real', () => {
  it('exposes a metric for every id, and no id twice', () => {
    // Guards the guard. Every assertion below iterates `METRICS`, and an empty
    // registry would satisfy all of them.
    const ids = METRICS.map((metric) => metric.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...MetricId.options].sort());
  });

  it('names an endpoint the router actually serves (AC1)', async () => {
    const served = new Set(
      (await collectRegisteredRoutes())
        .filter((route) => route.method === 'GET')
        .map((route) => route.url),
    );
    expect(served.size).toBeGreaterThanOrEqual(20);

    const dead = METRICS.filter((metric) => !served.has(metric.drillDown.endpoint)).map(
      (metric) => `${metric.id} -> ${metric.drillDown.endpoint}`,
    );

    expect(
      dead,
      'These metrics declare a drill-down the server does not serve. A figure ' +
        'that cannot be interrogated is the dead-end number §14.1 forbids:\n  ' +
        dead.join('\n  '),
    ).toEqual([]);
  });

  it('carries the next rung too, so the chain does not stop at one step', async () => {
    const served = new Set(
      (await collectRegisteredRoutes())
        .filter((route) => route.method === 'GET')
        .map((route) => route.url),
    );

    for (const dimension of BREAKDOWN_DIMENSIONS) {
      const next = rowDrillDown(dimension);
      expect(next, `no next rung for a ${dimension} breakdown row`).not.toBeNull();
      expect(served.has(next?.endpoint ?? '')).toBe(true);
    }
  });

  it('completes §14.1’s load-factor chain end to end (AC3)', async () => {
    const served = new Set(
      (await collectRegisteredRoutes())
        .filter((route) => route.method === 'GET')
        .map((route) => route.url),
    );

    /*
     * The sentence the criterion comes from, walked one link at a time:
     *
     * > Load factor → by route → by flight → by segment → the Appendix A
     * > waterfall showing which competitor took the passengers and why.
     */
    const loadFactor = METRICS.find((metric) => metric.id === 'load_factor');
    expect(loadFactor?.drillDown.by).toBe('route');
    expect(served.has(loadFactor?.drillDown.endpoint ?? '')).toBe(true);

    const toFlight = rowDrillDown('route');
    expect(toFlight?.by).toBe('flight');
    expect(served.has(toFlight?.endpoint ?? '')).toBe(true);

    // The last rung is the waterfall itself, which is per segment already — App.
    // A's `bySegment` is the segment view, so the chain ends there rather than
    // needing a rung of its own.
    expect(served.has('/api/routes/:routeId/waterfall')).toBe(true);
  });

  it('gives every metric the four things a client cannot infer', () => {
    for (const metric of METRICS) {
      // A number without a unit is unformattable and a number without a polarity
      // is uncolourable, and a client that guessed either would eventually be
      // confidently wrong — a rising CASK is bad, a rising load factor is good.
      expect(metric.label.length, metric.id).toBeGreaterThan(0);
      expect(metric.description.length, metric.id).toBeGreaterThan(10);
      expect(metric.unit, metric.id).toBeTruthy();
      expect(metric.polarity, metric.id).toBeTruthy();
    }
  });

  it('bounds the ratios, and deliberately does not bound breakeven load', () => {
    const bounded = METRICS.filter((metric) => metric.clampTo !== null).map((metric) => metric.id);
    expect(bounded).toContain('load_factor');
    expect(bounded).toContain('on_time');
    expect(bounded).toContain('spill_rate');
    /*
     * Above 1 a route cannot break even at *any* load factor — every extra
     * passenger loses money — and §14.4's ranked chart has to tell "reprice it"
     * from "kill it". A clamped 1.00 would read as "nearly there".
     */
    expect(bounded).not.toContain('breakeven_load_factor');
  });
});
