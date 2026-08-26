import { describe, expect, it } from 'vitest';

import {
  authoritativeMetrics,
  CAPACITY_METRICS,
  CapacityMetric,
  CapacityMetricKey,
  capacityMetric,
  metricsByAxis,
} from './capacity';

/**
 * The capacity contract holds together (SCALE-01).
 *
 * The point of typing the model rather than only writing it down is that the
 * invariants can be enforced instead of hoped for. These are those invariants —
 * the ones that, if they ever stopped being true, would mean the model had
 * quietly become a different model than the one `docs/capacity.md` and ADR-0022
 * describe.
 */

describe('the capacity model', () => {
  it('is a valid, complete set of metric definitions', () => {
    for (const metric of CAPACITY_METRICS) {
      expect(() => CapacityMetric.parse(metric)).not.toThrow();
    }
    // Every key in the closed enum has exactly one definition, and vice versa.
    const keys = CAPACITY_METRICS.map((metric) => metric.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(keys)).toEqual(new Set(CapacityMetricKey.options));
  });

  it('keeps the authoritative set small and defensible', () => {
    // "A model with too many authoritative metrics is a model with none." Three
    // is the defended set — oldest-due-event-age, queue-growth-rate,
    // late-tick-rate. Raising this bound is a decision to make in ADR-0022, not a
    // number to nudge because a new metric felt important.
    expect(authoritativeMetrics().length).toBeLessThanOrEqual(3);
    expect(authoritativeMetrics().length).toBeGreaterThan(0);
  });

  it('never lets an infrastructure-load metric be authoritative', () => {
    // The rule the whole milestone inherits: no scaling decision may rest on the
    // machine being busy. Encoded, not just documented.
    const offenders = CAPACITY_METRICS.filter(
      (metric) =>
        metric.axis === 'infrastructure-load' && metric.classification === 'authoritative',
    ).map((metric) => metric.key);
    expect(offenders).toEqual([]);
  });

  it('classifies CPU as infrastructure load, and diagnostic', () => {
    // The specific number most likely to be on the screen on a 2-core box, and
    // the one that answers the capacity question worst.
    const cpu = capacityMetric('cpu-percent');
    expect(cpu.axis).toBe('infrastructure-load');
    expect(cpu.classification).toBe('diagnostic');
  });

  it('makes oldest-due-event-age the authoritative queue-lateness signal, in game time', () => {
    const age = capacityMetric('oldest-due-event-age');
    expect(age.axis).toBe('domain-pressure');
    expect(age.classification).toBe('authoritative');
    // Game time, not wall time — the ADR-0005 trap this model exists to name.
    expect(age.unit).toBe('game-ms');
    // Judged against the one existing threshold, referenced not restated.
    expect(age.threshold).toContain('WORKER_BEHIND_AFTER_MS');
  });

  it('references existing thresholds by name rather than carrying a number', () => {
    // A threshold cell is a pointer at the single source of truth in code, so the
    // model cannot come to disagree with it. Prove there is no bare number in one.
    for (const metric of CAPACITY_METRICS) {
      if (metric.threshold !== null) {
        expect(metric.threshold, metric.key).toMatch(/[A-Z_]{3,}/);
      }
    }
  });

  it('splits every metric across the two axes with nothing left over', () => {
    const domain = metricsByAxis('domain-pressure').length;
    const infra = metricsByAxis('infrastructure-load').length;
    expect(domain + infra).toBe(CAPACITY_METRICS.length);
    expect(domain).toBeGreaterThan(0);
    expect(infra).toBeGreaterThan(0);
  });

  it('states a producer, a window and a healthy range for every metric', () => {
    for (const metric of CAPACITY_METRICS) {
      expect(metric.producer.length, metric.key).toBeGreaterThan(0);
      expect(metric.window.length, metric.key).toBeGreaterThan(0);
      expect(metric.healthy.length, metric.key).toBeGreaterThan(0);
    }
  });

  it('covers every metric the issue named as the minimum', () => {
    // The minimum coverage SCALE-01 lists, mapped to keys. A missing one is a
    // hole in the model, not a stylistic choice.
    const required: CapacityMetricKey[] = [
      'tick-duration',
      'tick-cadence',
      'late-tick-rate',
      'event-drain-rate',
      'due-event-count',
      'oldest-due-event-age',
      'in-flight-events',
      'failed-event-rate',
      'pool-utilisation',
      'pool-wait',
      'cpu-percent',
      'memory-used-percent',
    ];
    const present = new Set(CAPACITY_METRICS.map((metric) => metric.key));
    expect(required.filter((key) => !present.has(key))).toEqual([]);
  });
});

// The prose/type drift check lives in the server package, not here: `@tailfin/shared`
// is a pure boundary package with no node types, so it cannot read `docs/capacity.md`.
// See `packages/server/src/capacity-model.test.ts`.
