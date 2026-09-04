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
 * `world` and `airline` mirror tables that exist (M0-06). `airport` is now a
 * deliberately mixed contract: import, tier, slots and catchment exist, while
 * capacity, fees, curfew and constraints remain ahead of storage. `aircraft`,
 * `network` and `flight` similarly began from the design doc ahead of their
 * tables. Each file states which part is implemented so clients can use a
 * purpose-built projection instead of assuming the complete record exists.
 */

export * from './primitives';
export * from './world';
export * from './airline';
export * from './airline-logo';
export * from './economy-config';
export * from './npc';
export * from './airport';
export * from './aircraft';
export * from './aircraft-acquisition';
export * from './aircraft-options';
export * from './aircraft-catalogue';
export * from './aircraft-asset';
export * from './aircraft-runtime';
export * from './used-market';
export * from './maintenance';
export * from './crew';
export * from './fleet';
export * from './livery';
export * from './livery-resources';
export * from './network';
export * from './slots';
export * from './automation';
export * from './ground';
export * from './fuel';
export * from './office';
export * from './executive';
export * from './flight';
export * from './api';
export * from './auth';
export * from './admin';
export * from './capacity';
export * from './version';
export * from './finance';
export * from './currency';
export * from './json-schema';

/** Schema version of the shared contract. Bumped when a breaking change lands. */
export const SHARED_SCHEMA_VERSION = 1 as const;

/** The flagship world's epoch — 20 October 2024 (design doc §3.1b). */
export const FLAGSHIP_EPOCH_ISO = '2024-10-20T00:00:00.000Z' as const;

/** World time runs at twice wall-clock (design doc §3.1). */
export const FLAGSHIP_SPEED_MULTIPLIER = 2 as const;
export * from './world-config';
