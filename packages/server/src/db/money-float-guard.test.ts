import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * No money is a float (M8-02, issue #74 acceptance criterion).
 *
 * Money is stored as **integer minor units** (`bigint`), never a binary float —
 * floating-point currency arithmetic loses money in ways that are painful and
 * silent. The convention is the column-name suffix `_minor`, so this guard reads
 * `schema.ts` and proves every `_minor` column is declared `bigint(...)` and none
 * is a `doublePrecision`, `real` or `numeric`. `doublePrecision` is allowed
 * elsewhere (latitude, distances, hours) — this forbids it only for money.
 *
 * A lint rule was the issue's other option; a test is cheaper here and reads the
 * same source the migration is generated from.
 */
const schemaPath = fileURLToPath(new URL('./schema.ts', import.meta.url));
const schema = readFileSync(schemaPath, 'utf8');

/** Every `<type>('<name>_minor'` declaration in the schema, as [type, name]. */
function minorColumns(): { type: string; name: string }[] {
  const matches = schema.matchAll(/(\w+)\('([a-z_]*_minor)'/g);
  return [...matches].map((m) => ({ type: m[1]!, name: m[2]! }));
}

describe('money is never a floating-point column', () => {
  it('finds the money columns to check', () => {
    // A vacuous guard is worse than none: assert it is actually looking at money.
    expect(minorColumns().length).toBeGreaterThanOrEqual(10);
  });

  it('declares every _minor column as bigint', () => {
    const offenders = minorColumns().filter((c) => c.type !== 'bigint');
    expect(
      offenders,
      `These money columns are not bigint (integer minor units):\n  ${offenders
        .map((c) => `${c.name} → ${c.type}`)
        .join('\n  ')}`,
    ).toEqual([]);
  });

  it('never declares a money column with a floating-point or numeric type', () => {
    for (const bad of ['doublePrecision', 'real', 'numeric']) {
      const hit = new RegExp(`${bad}\\('[a-z_]*_minor'`).test(schema);
      expect(hit, `a _minor column is declared ${bad}`).toBe(false);
    }
  });
});
