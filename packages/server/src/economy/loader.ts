import { eq, inArray } from 'drizzle-orm';

import { type Database } from '../db/client';
import { economyConfig, world } from '../db/schema';

import { defineEconomyConfig, type PinnedEconomyConfig, UnknownEconomyConfigError } from './config';

/**
 * Reading the economy a world is actually running (M3-11, §22.3).
 *
 * This is what makes *"config changes take effect without a deploy"* true. A
 * world pins a version; this resolves it to a payload; every economic
 * calculation takes that payload as a parameter. Nothing in the running server
 * reads a balance number from code.
 *
 * ## The cache needs no invalidation, because a version cannot change
 *
 * `economy_config` rows are immutable — migration 0023 installs triggers that
 * refuse UPDATE, DELETE and TRUNCATE — so a payload cached under `v2` is `v2`
 * for ever. That buys three things at once:
 *
 *   - **No cross-process invalidation.** The web node and the worker node cache
 *     independently and can never disagree, because there is nothing to
 *     disagree about. Postgres remains the only channel between them (ADR-0019)
 *     and this needs no channel at all.
 *   - **A retune is visible immediately anyway.** Changing what a world runs
 *     means re-*pinning* it, and the pin is read fresh from `world` on every
 *     resolution — never cached. So the next settlement after an admin repins
 *     uses the new version, in every process, with no restart. That is the
 *     "invalidation on version change" M3-11 asks for: it falls out of caching
 *     the immutable half and not the mutable half.
 *   - **The cache is bounded by the number of versions**, which is the number
 *     of retunes anyone has ever made. It does not need eviction.
 *
 * The one cost is a `world` read per resolution. That is deliberate and cheap:
 * a primary-key lookup against a table with a handful of rows, in exchange for
 * a repin never being stale anywhere.
 *
 * ## Why it is a module-level cache rather than an injected object
 *
 * A resolution often happens inside a transaction, which is a different
 * `Database` handle every time — a per-handle cache would therefore never hit
 * where it matters most. The cache is keyed by version alone, which is safe
 * because a process talks to one database. `clearEconomyConfigCache` exists for
 * tests that want a cold start.
 */

const cache = new Map<string, PinnedEconomyConfig>();
let hits = 0;
let misses = 0;

export interface EconomyCacheStats {
  /** Versions currently held. Bounded by how many versions have ever existed. */
  size: number;
  hits: number;
  misses: number;
}

export function economyCacheStats(): EconomyCacheStats {
  return { size: cache.size, hits, misses };
}

/**
 * Drop cached payloads.
 *
 * Not needed in normal operation — see the note above. It exists for tests, and
 * for the one real case: a version that was somehow written twice by two
 * processes racing the seed, where dropping and re-reading is a cheap way to be
 * certain of what the database holds.
 */
export function clearEconomyConfigCache(version?: string): void {
  if (version === undefined) {
    cache.clear();
    hits = 0;
    misses = 0;
    return;
  }
  cache.delete(version);
}

async function fetchInto(db: Database, versions: readonly string[]): Promise<void> {
  if (versions.length === 0) return;

  const rows = await db
    .select({ version: economyConfig.version, payload: economyConfig.payload })
    .from(economyConfig)
    .where(inArray(economyConfig.version, [...versions]));

  for (const row of rows) {
    // Parsed on the way out, not merely on the way in. A row is text and could
    // have been written by a psql session; and a payload that validated against
    // last year's schema is not proof that it validates against this one. A
    // clear refusal here beats a NaN fare six hours later.
    cache.set(row.version, defineEconomyConfig(JSON.parse(row.payload) as unknown));
  }
}

/** The payload for one version, or `UnknownEconomyConfigError` — never a fallback. */
export async function loadEconomyConfig(
  db: Database,
  version: string,
): Promise<PinnedEconomyConfig> {
  const cached = cache.get(version);
  if (cached) {
    hits += 1;
    return cached;
  }

  misses += 1;
  await fetchInto(db, [version]);

  const loaded = cache.get(version);
  if (!loaded) throw new UnknownEconomyConfigError(version);
  return loaded;
}

/**
 * Several versions in one round trip.
 *
 * For the places that hold a list of worlds — the founding options, the admin
 * world list — where resolving one at a time would be a query per row.
 */
export async function loadEconomyConfigs(
  db: Database,
  versions: Iterable<string>,
): Promise<Map<string, PinnedEconomyConfig>> {
  const wanted = [...new Set(versions)];
  const missing = wanted.filter((version) => {
    const hit = cache.has(version);
    if (hit) hits += 1;
    else misses += 1;
    return !hit;
  });

  await fetchInto(db, missing);

  const resolved = new Map<string, PinnedEconomyConfig>();
  for (const version of wanted) {
    const config = cache.get(version);
    if (!config) throw new UnknownEconomyConfigError(version);
    resolved.set(version, config);
  }
  return resolved;
}

/**
 * The economy one world is running, resolved through its current pin.
 *
 * The pin is read here rather than passed in, so a caller cannot hold a stale
 * one across a repin.
 */
export async function loadWorldEconomyConfig(
  db: Database,
  worldId: string,
): Promise<PinnedEconomyConfig> {
  const rows = await db
    .select({ version: world.economyConfigVersion })
    .from(world)
    .where(eq(world.id, worldId))
    .limit(1);

  const row = rows[0];
  if (!row) throw new Error(`No world ${worldId}`);
  return loadEconomyConfig(db, row.version);
}

/**
 * Whether a version could be pinned, without loading it.
 *
 * Used by the validation paths, which want to refuse "that version does not
 * exist" as a field error rather than by throwing.
 */
export async function economyConfigVersionExists(db: Database, version: string): Promise<boolean> {
  if (cache.has(version)) return true;

  const rows = await db
    .select({ version: economyConfig.version })
    .from(economyConfig)
    .where(eq(economyConfig.version, version))
    .limit(1);

  return rows.length > 0;
}
