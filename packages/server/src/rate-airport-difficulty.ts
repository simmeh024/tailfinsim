import { formatDifficultyResult, rateAirportDifficulty } from './data/difficulty/apply';
import { createDatabase } from './db/client';

/**
 * `node dist/rate-airport-difficulty.js` — rates airport difficulty (M9-02).
 *
 * §10.2's crew XP multiplier needs to know how hard a field is to fly into.
 * This is the script that decides: it reads the imported airports and their
 * runways, applies the rules in `data/difficulty/rating.ts`, folds in the
 * committed list of known-difficult fields, and writes the rating plus an audit
 * trail back.
 *
 * Reproducible. Running it twice gives the same answer; it is a pure function
 * of the airport and runway tables plus one committed CSV.
 *
 * Re-run it after any OurAirports import, and after editing the reference list
 * or a threshold. It needs the airports and their runways and nothing else — no
 * tiers, no catchment — so it can run at any point after `data:airports`.
 */

async function main(): Promise<void> {
  const db = createDatabase();
  try {
    const result = await rateAirportDifficulty(db.db);
    process.stdout.write(`\n${formatDifficultyResult(result)}\n`);

    /*
     * Non-zero exit on a reference entry that matched no airport. The rating is
     * still written — it is not wrong, it is *incomplete*, and a typo in an
     * ICAO code is the one failure nothing else can catch: the entry simply
     * never applies while the CSV goes on claiming it does.
     */
    if (result.unmatched.length > 0) {
      process.stderr.write(
        `\n${String(result.unmatched.length)} reference entries matched no airport — ` +
          'check the ICAO codes before use.\n',
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
    `\nDifficulty rating failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}
