/**
 * `@tailfin/shared` — the single source of truth for types shared across the
 * simulation, the server and the client.
 *
 * Zod schemas land here in M0-07. Until then this package exists so the
 * workspace graph and project references are wired and verified.
 *
 * Design doc: §21 Technical Shape.
 */

/** Schema version of the shared contract. Bumped when a breaking change lands. */
export const SHARED_SCHEMA_VERSION = 1 as const;

/** The flagship world's epoch — 20 October 2024 (design doc §3.1b). */
export const FLAGSHIP_EPOCH_ISO = '2024-10-20T00:00:00.000Z' as const;

/** World time runs at twice wall-clock (design doc §3.1). */
export const FLAGSHIP_SPEED_MULTIPLIER = 2 as const;
