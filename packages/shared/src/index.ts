/**
 * `@tailfin/shared` — the single source of truth for every type that crosses a
 * boundary (M0-07).
 *
 * Every wire type is a zod schema here, with its TypeScript type inferred from
 * it via `z.infer`. Nothing anywhere else in the codebase hand-writes an
 * interface for the same thing.
 *
 * ## Wire types are not database row types
 *
 * `packages/server/src/db/schema.ts` also exports types — `AirlineRow` and
 * friends, inferred from the Drizzle table definitions. Those are *not*
 * duplicates of the schemas here, and the distinction is load-bearing:
 *
 *   | | database row | wire type |
 *   | --- | --- | --- |
 *   | money | `bigint` | `number` (integer minor units) |
 *   | reputation | `string` (from `numeric(3,2)`) | `number` 0–1 |
 *   | timestamps | `Date` | ISO 8601 string |
 *
 * Neither is hand-written, both are inferred, and converting between them is the
 * server's job at the boundary. Collapsing them into one type would mean either
 * leaking `numeric`-as-string into the client or pretending JSON has a date
 * type.
 *
 * ## What is provisional
 *
 * `world` and `airline` mirror tables that exist (M0-06). `airport`,
 * `aircraft`, `network` and `flight` are written from the design doc **ahead of
 * their tables** — M1-01, M4-01, M2-01, M2-03 and M1-07 respectively. They are
 * the contract those milestones must satisfy, so reconciliation is a comparison
 * against the doc rather than a negotiation. Each file says so at the top.
 */

export * from './primitives';
export * from './world';
export * from './airline';
export * from './economy-config';
export * from './airport';
export * from './aircraft';
export * from './network';
export * from './flight';
export * from './api';
export * from './auth';
export * from './admin';
export * from './version';
export * from './json-schema';

/** Schema version of the shared contract. Bumped when a breaking change lands. */
export const SHARED_SCHEMA_VERSION = 1 as const;

/** The flagship world's epoch — 20 October 2024 (design doc §3.1b). */
export const FLAGSHIP_EPOCH_ISO = '2024-10-20T00:00:00.000Z' as const;

/** World time runs at twice wall-clock (design doc §3.1). */
export const FLAGSHIP_SPEED_MULTIPLIER = 2 as const;
export * from './world-config';
