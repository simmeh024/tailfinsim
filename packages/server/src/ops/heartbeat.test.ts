import { describe, expect, it } from 'vitest';

import { captureLoad, nodeIdentity } from './heartbeat';

/**
 * What a node calls itself, and what it reports about its load.
 *
 * The identity is the part with a bug history: the first version keyed on the
 * hostname alone and the first deployment showed why that is not enough.
 */

describe('what identifies a node', () => {
  it('is the hostname and the role together', () => {
    expect(nodeIdentity('web', 'tailfin')).toBe('tailfin/web');
    expect(nodeIdentity('worker', 'tailfin-dev-worker')).toBe('tailfin-dev-worker/worker');
  });

  it('keeps two roles on one host apart', () => {
    // The collision this exists to prevent, and it is not hypothetical: the web
    // box already runs production and dev side by side, and OPS-09's original
    // plan put the worker on the dev box as a second service. Keyed on hostname
    // alone, two such processes share a primary key, overwrite each other's row,
    // and the console shows one node flapping between roles instead of two nodes.
    expect(nodeIdentity('web', 'tailfin')).not.toBe(nodeIdentity('worker', 'tailfin'));
  });
});

describe('what a node reports about its load', () => {
  const load = captureLoad();

  it('normalises CPU by core count, so two nodes are comparable', () => {
    // A load average of 2 means saturation on two cores and a quarter of it on
    // eight. Reporting the raw figure would invite exactly that misreading.
    expect(load.cores).toBeGreaterThanOrEqual(1);
    expect(load.cpuPercent).toBeCloseTo((load.loadAverage1m / load.cores) * 100, 0);
  });

  it('reports the process and the machine separately', () => {
    // Both are wanted: a worker pinning the box matters, and so does a worker
    // leaking while the box still looks fine.
    expect(load.processMemoryBytes).toBeGreaterThan(0);
    expect(load.memoryTotalBytes).toBeGreaterThan(load.processMemoryBytes);
  });

  it('keeps percentages inside a range the page can render', () => {
    expect(load.cpuPercent).toBeGreaterThanOrEqual(0);
    expect(load.memoryUsedPercent).toBeGreaterThanOrEqual(0);
    expect(load.memoryUsedPercent).toBeLessThanOrEqual(100);
  });
});
