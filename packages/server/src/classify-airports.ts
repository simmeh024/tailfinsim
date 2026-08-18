import { classifyAirports, formatClassifyResult } from './data/classify/apply';
import { createDatabase } from './db/client';

/**
 * `node dist/classify-airports.js` — assigns tiers and slot levels (M1-02).
 *
 * M1-02 requires the classification to be "reproducible from a single script".
 * This is that script: it reads the imported airports, applies the rules in
 * `data/classify/tier.ts`, and writes tier, slot level and an audit trail back.
 * Running it twice produces the same answer; it is a pure function of the
 * airport table plus the two committed reference lists.
 *
 * Re-run it after any OurAirports import, and after editing either reference
 * list or a threshold.
 */

async function main(): Promise<void> {
  const db = createDatabase();
  try {
    const result = await classifyAirports(db.db);
    process.stdout.write(`\n${formatClassifyResult(result)}\n`);

    const failed = result.distribution.filter((d) => !d.passed);
    const missingFlagships = result.namedFlagships.filter((f) => f.tier !== 'flagship');

    // Non-zero exit on a distribution that has drifted out of B.3's bounds. The
    // classification is still written — it is not wrong, it is *surprising*, and
    // the operator needs to look at it rather than have it silently accepted.
    if (failed.length > 0 || missingFlagships.length > 0) {
      process.stderr.write(
        '\nClassification is outside App. B.3 expectations — review before use.\n',
      );
      process.exit(3);
    }
  } finally {
    await db.close();
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    `\nClassification failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}
