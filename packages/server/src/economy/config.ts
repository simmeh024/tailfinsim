import { createHash } from 'node:crypto';

import {
  canonicalEconomyJson,
  ECONOMY_CONFIG_V1 as SHIPPED_ECONOMY_CONFIG,
  EconomyConfig,
  type EconomyConfig as EconomyConfigContract,
} from '@tailfin/shared';

/**
 * An economy version, once something can pin it (M3-11, §22.3).
 *
 * The payload itself is `@tailfin/shared`'s: one zod schema validates what goes
 * into `economy_config`, what comes out of it, and what an admin submits. This
 * file is the *server's* side of that — parsing, freezing and identifying a
 * version — and nothing here contains a balance number.
 */

/**
 * A parsed, frozen payload.
 *
 * `Readonly<T>` at the top level with a **deep runtime freeze** underneath,
 * rather than a recursive `DeepReadonly` type. The type would have to flatten
 * tuples like `bounds: [number, number]` into `readonly number[]` to be written
 * at all, and `packages/sim` reads those as fixed-length pairs — so the clever
 * type would break the very assignment it exists to protect. The freeze is what
 * actually stops a mutation, and it stops it at every depth.
 */
export type PinnedEconomyConfig = Readonly<EconomyConfigContract>;

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}

/**
 * Parse a payload from anywhere untrusted and freeze it.
 *
 * The database is untrusted for this purpose, and deliberately so. A row is
 * text, it can be written by a psql session, and a config that parsed on the way
 * in years ago is not proof that it parses against today's schema — a field
 * added since would be missing. Validating on the way *out* is what turns that
 * into a clear refusal at load rather than a `NaN` fare six hours later.
 */
export function defineEconomyConfig(input: unknown): PinnedEconomyConfig {
  return deepFreeze(EconomyConfig.parse(input));
}

/**
 * The shipped payload, frozen — the seed for a fresh database, not the source of
 * truth for a running one.
 *
 * Everything that reads this at runtime is either the seed itself or a test.
 * Live code loads the world's pinned version through `economy/loader.ts`; lint
 * enforces that, because a route quietly running the shipped numbers instead of
 * the world's is invariant 3 failing in the way that is hardest to notice.
 */
export const ECONOMY_CONFIG_V1: PinnedEconomyConfig = defineEconomyConfig(SHIPPED_ECONOMY_CONFIG);

/**
 * What identifies a payload, independently of how its JSON happened to be
 * written.
 *
 * Taken over the canonical form, so key order cannot change it. That is what
 * lets the seed compare a stored v1 against the shipped v1 and report a live
 * retune rather than crying wolf on every deploy.
 */
export function economyChecksum(config: EconomyConfigContract): string {
  return createHash('sha256').update(canonicalEconomyJson(config)).digest('hex');
}

/** Thrown when a world pins a version the database does not have. */
export class UnknownEconomyConfigError extends Error {
  constructor(readonly version: string) {
    super(
      `No economy config version "${version}". A world pins a version that is not in economy_config; ` +
        'nothing falls back to the shipped payload, because a world silently running different ' +
        'numbers from the ones it was tuned with is worse than a refusal.',
    );
    this.name = 'UnknownEconomyConfigError';
  }
}
