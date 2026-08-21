import { eq } from 'drizzle-orm';

import { canonicalEconomyJson } from '@tailfin/shared';

import { readBuildInfo } from '../build-info';
import { type Database } from '../db/client';
import { economyConfig } from '../db/schema';

import { defineEconomyConfig, ECONOMY_CONFIG_V1, economyChecksum } from './config';

/**
 * Putting the shipped economy into a database that has never seen it (M3-11).
 *
 * `world-config.ts` makes the same argument for `FLAGSHIP_CONFIG` and it applies
 * here: a migration runs once, and this has to run again every time a database
 * is created from scratch — which during testing is constantly. So it is a
 * startup step, not migration SQL, and writing the payload into SQL would also
 * have frozen a second copy of every balance number into a file nobody would
 * think to update.
 *
 * ## It inserts, and it never updates
 *
 * `onConflictDoNothing`, deliberately. Once `v1` exists in a database it belongs
 * to that database, and an admin may have retuned it — §22.3's whole point. An
 * upsert here would mean **every deploy silently reverted the live economy**,
 * which is the precise failure "config changes take effect without a deploy" is
 * meant to rule out. A deploy must not be able to move a balance number.
 *
 * That leaves an honest question — has somebody changed v1 out from under the
 * shipped payload? — and the checksum answers it. The result says so and the
 * caller logs it; nothing is overwritten either way.
 *
 * (In practice a *retune* creates a new version rather than editing v1, because
 * `economy_config` rows are immutable. A v1 that no longer matches therefore
 * means the row was written by a different build, which is exactly the thing
 * worth being told about.)
 */

export interface EconomySeedResult {
  version: string;
  /** True when this run created the row. False means it was already there. */
  inserted: boolean;
  /**
   * Whether the stored payload is the one this build ships.
   *
   * False is not an error: it means the database's economy was tuned by a
   * different build, and the database wins. Worth logging, never worth fixing
   * automatically.
   */
  matchesShipped: boolean;
  shippedChecksum: string;
  storedChecksum: string;
}

export async function seedEconomyConfig(db: Database): Promise<EconomySeedResult> {
  const shippedChecksum = economyChecksum(ECONOMY_CONFIG_V1);
  const build = readBuildInfo();

  const inserted = await db
    .insert(economyConfig)
    .values({
      version: ECONOMY_CONFIG_V1.version,
      // Canonical form, so the bytes in the row are the bytes the checksum was
      // taken over — a reader can verify the row without re-normalising it.
      payload: canonicalEconomyJson(ECONOMY_CONFIG_V1),
      checksum: shippedChecksum,
      parentVersion: null,
      notes: 'The economy as shipped: App. A.3 starting coefficients and the §22.3 cost tables.',
      createdByPlayerId: null,
      // No person did this, and saying "system" would be less use than saying
      // which build it was — which is what somebody investigating a mismatch
      // actually needs to know.
      createdByLabel: `build ${String(build.build)} (${build.commit})`,
    })
    .onConflictDoNothing()
    .returning({ version: economyConfig.version });

  if (inserted.length > 0) {
    return {
      version: ECONOMY_CONFIG_V1.version,
      inserted: true,
      matchesShipped: true,
      shippedChecksum,
      storedChecksum: shippedChecksum,
    };
  }

  const existing = await db
    .select({ payload: economyConfig.payload })
    .from(economyConfig)
    .where(eq(economyConfig.version, ECONOMY_CONFIG_V1.version))
    .limit(1);

  /**
   * Compared as *configs*, not as bytes.
   *
   * The stored `checksum` column is a fact about the text as written, and a
   * payload written before a section existed will never match a build that has
   * one — it would warn on every boot, for ever, about a difference that is
   * only the passage of time. Re-checksumming the **parsed** payload compares
   * what the two builds would actually run, with defaults applied, which is the
   * question this check is asking.
   *
   * A real divergence — an admin having retuned v1 — still shows, because a
   * retuned number survives parsing and changes the checksum.
   */
  const storedPayload = existing[0]?.payload;
  const storedChecksum =
    storedPayload === undefined
      ? ''
      : economyChecksum(defineEconomyConfig(JSON.parse(storedPayload) as unknown));

  return {
    version: ECONOMY_CONFIG_V1.version,
    inserted: false,
    matchesShipped: storedChecksum === shippedChecksum,
    shippedChecksum,
    storedChecksum,
  };
}

/**
 * The shipped economy, guaranteed present — once per process.
 *
 * `main.ts` seeds explicitly at boot because it has a logger and something to
 * say. Everything *else* that needs a pinnable economy reaches this instead:
 * a world cannot be created without one, and the places that create worlds
 * include the test suite, `pnpm world:seed` and the admin CLI — none of which
 * boot the web server. Leaving the seed to startup alone meant a freshly
 * migrated database could not have a world put in it at all, which is how this
 * was found.
 *
 * Safe to call anywhere for the same reason the seed itself is: it inserts and
 * never updates, so it cannot overwrite a retune. Memoised per process, so the
 * cost after the first call is nothing.
 *
 * The memo is cleared on failure. Caching a rejected promise would turn one
 * unlucky moment — the database briefly unreachable — into a process that
 * believed for ever that it had already seeded.
 *
 * One honest caveat: called with a transaction that later rolls back, the memo
 * records a seed that did not commit. Nothing in the database is inconsistent —
 * the world being created rolled back too — and the next attempt fails
 * validation with a clear message rather than doing something quietly wrong.
 * The admin route seeds through the pool before it validates, so the ordinary
 * path does not rely on this.
 */
let pending: Promise<EconomySeedResult> | null = null;

export function ensureEconomyConfigSeeded(db: Database): Promise<EconomySeedResult> {
  pending ??= seedEconomyConfig(db).catch((error: unknown) => {
    pending = null;
    throw error;
  });
  return pending;
}

/** Forget that this process has seeded. For tests that want a cold start. */
export function resetEconomySeedMemo(): void {
  pending = null;
}
