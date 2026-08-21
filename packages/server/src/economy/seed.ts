import { eq } from 'drizzle-orm';

import { canonicalEconomyJson } from '@tailfin/shared';

import { readBuildInfo } from '../build-info';
import { type Database } from '../db/client';
import { economyConfig } from '../db/schema';

import { ECONOMY_CONFIG_V1, economyChecksum } from './config';

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
    .select({ checksum: economyConfig.checksum })
    .from(economyConfig)
    .where(eq(economyConfig.version, ECONOMY_CONFIG_V1.version))
    .limit(1);

  const storedChecksum = existing[0]?.checksum ?? '';
  return {
    version: ECONOMY_CONFIG_V1.version,
    inserted: false,
    matchesShipped: storedChecksum === shippedChecksum,
    shippedChecksum,
    storedChecksum,
  };
}
