import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CAPACITY_METRICS, CAPACITY_DECISION_RULE } from '@tailfin/shared';

/**
 * The capacity model's prose follows its type (SCALE-01).
 *
 * The typed contract lives in `@tailfin/shared` and its own invariants are
 * tested there. This is the half that needs the filesystem: `docs/capacity.md`
 * is the readable form of the same list, and a metric key that exists in the
 * type but not in the document is exactly the drift the typed half exists to
 * prevent. It lives in the server package because `@tailfin/shared` is pure and
 * has no node types to read a file with.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const capacityDoc = readFileSync(resolve(repoRoot, 'docs', 'capacity.md'), 'utf8');
const adr = readFileSync(resolve(repoRoot, 'docs', 'adr', '0022-capacity-model.md'), 'utf8');

describe('the capacity model and its documentation agree', () => {
  it('names every typed metric key in docs/capacity.md', () => {
    const missing = CAPACITY_METRICS.map((metric) => metric.key).filter(
      (key) => !capacityDoc.includes(key),
    );
    expect(missing, 'metrics typed but not documented').toEqual([]);
  });

  it('states the decision rule verbatim, in the doc and the ADR', () => {
    // The one rule everything downstream inherits. A console prints it in the
    // model's own words; the doc and ADR must carry the same words the type does.
    const ruleStart = 'Infrastructure load alone never justifies a capacity change';
    expect(CAPACITY_DECISION_RULE).toContain(ruleStart);
    expect(capacityDoc).toContain(ruleStart);
    expect(adr).toContain(ruleStart);
  });

  it('records the assessNode game-time correctness note the model refers to', () => {
    // SCALE-01 is documentation; the note is where the wall-vs-game discrepancy is
    // written down for a separate behaviour decision. If the note is dropped, the
    // model's queue-lateness definition would point at nothing.
    expect(capacityDoc).toContain('WORKER_BEHIND_AFTER_MS');
    expect(capacityDoc.toLowerCase()).toContain('game-time');
    expect(capacityDoc).toContain('assessNode');
  });
});
