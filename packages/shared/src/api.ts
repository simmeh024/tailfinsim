import { z } from 'zod';

/**
 * API response shapes.
 *
 * The point of M0-07 is that these are validated at the boundary, not merely
 * described. Today there is exactly one boundary — the placeholder server's
 * `/healthz` — and it validates through `HealthResponse` before replying, so the
 * pattern is established rather than promised. M0-08 replaces that server with
 * Fastify and wires these into its schema validation for every route.
 */

export const HealthStatus = z.enum(['ok', 'degraded']);
export type HealthStatus = z.infer<typeof HealthStatus>;

/**
 * `db` is deliberately a tri-state rather than a boolean. `not_checked` is
 * honest about the placeholder server not yet querying the database, and it
 * cannot be mistaken for a passing check the way `false` could be mistaken for
 * a failing one. M0-08 replaces it with a real `select 1`.
 */
export const DatabaseHealth = z.enum(['up', 'down', 'not_checked']);
export type DatabaseHealth = z.infer<typeof DatabaseHealth>;

export const HealthResponse = z.object({
  status: HealthStatus,
  db: DatabaseHealth,
  /** Whole seconds since the process started. */
  uptime: z.number().int().nonnegative(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

/**
 * The single error shape every endpoint uses.
 *
 * `code` is machine-readable and stable; `message` is for humans and may change.
 * Clients branch on `code` — that split is what lets the wording improve without
 * breaking anything.
 */
export const ApiError = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  /** Field-level detail for validation failures, keyed by path. */
  fields: z.record(z.string(), z.array(z.string())).optional(),
});
export type ApiError = z.infer<typeof ApiError>;
