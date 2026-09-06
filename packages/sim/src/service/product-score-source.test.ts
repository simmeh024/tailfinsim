import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * M8-04's second acceptance criterion, as a guard rather than a convention:
 *
 * > `ProductScore` feeds the demand model and **nothing else computes it
 * > separately**.
 *
 * The reason it needs a guard is that it had already failed once before anyone
 * wrote it down. Two modules produced a product score out of thin air —
 * `REFERENCE_SELF.productScore` and `PLAYER_ASSUMPTION.productScore`, both a
 * flat `0.6` — and each was a perfectly reasonable local decision at the time it
 * was made. A third would have been reasonable too. Nothing stopped it, so
 * nothing did.
 *
 * So this scans `packages/sim` and `packages/server` for a **literal assigned to
 * a product-score field**, and allows only the places entitled to one:
 *
 * - `sim/service/product-score.ts` — the assembly itself.
 * - `server/src/service/product-score.ts` — the one resolver that feeds it real
 *   state.
 * - `economy-config.ts`'s NPC archetypes. An NPC has no cabin, no crew base and
 *   no ground contract, so its product is a **declared property of a synthetic
 *   competitor** rather than something assembled from parts it does not have.
 *   That is balance, it lives in the pinned payload, and it is visible to the
 *   admin console like every other balance number.
 * - `network/economics.ts`'s `REFERENCE_SELF` — now only the fixture the pure
 *   fare-floor and waterfall tests price against, where no database exists.
 *
 * A new entry in that list is a decision worth arguing about in review, which is
 * the entire point of the list existing.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/** Where a product-score literal is legitimate, and why — see the note above. */
const ENTITLED: readonly string[] = [
  'packages/sim/src/service/product-score.ts',
  'packages/server/src/service/product-score.ts',
  'packages/shared/src/economy-config.ts',
  'packages/server/src/network/economics.ts',
];

/** `productScore: 0.6`, `productScore = 0.42` — a number conjured, not derived. */
const CONJURED = /\bproductScore\s*[:=]\s*(?!0\s*[;,)\]}])[0-9]*\.?[0-9]+/;

function walk(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    if (entry === 'node_modules' || entry === 'dist') return [];
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

describe('one ProductScore, assembled in one place', () => {
  const files = [
    ...walk(join(repoRoot, 'packages', 'sim', 'src')),
    ...walk(join(repoRoot, 'packages', 'server', 'src')),
    ...walk(join(repoRoot, 'packages', 'shared', 'src')),
  ].map((file) => relative(repoRoot, file).replaceAll('\\', '/'));

  it('scans a non-trivial number of files, so a passing result means something', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('finds the assembly and its resolver where they are meant to be', () => {
    // Guards against the entitlement list outliving the files it names.
    for (const entitled of ENTITLED) {
      expect(files).toContain(entitled);
    }
  });

  it.each(files.filter((file) => !ENTITLED.includes(file)))(
    '%s does not conjure a product score',
    (file) => {
      const source = readFileSync(join(repoRoot, file), 'utf8');
      const match = CONJURED.exec(source);
      expect(
        match?.[0] ?? null,
        `${file} assigns a product score literal. ProductScore is assembled by ` +
          'sim/service/product-score.ts from a service package and App. D.1 execution; ' +
          'a second source is what M8-04 exists to remove. If this really is a ' +
          'declared property of something with no cabin and no crew, add it to ' +
          'ENTITLED with the reason.',
      ).toBeNull();
    },
  );
});
