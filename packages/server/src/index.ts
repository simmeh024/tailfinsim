/**
 * `@tailfin/server` — the authoritative game server.
 *
 * Owns the world clock, the tick loop, persistence and the API. The client is
 * a viewer and a command issuer, never an authority (design doc §21).
 *
 * The Fastify app, `/healthz` and structured logging land in M0-08.
 */

import { SHARED_SCHEMA_VERSION } from '@tailfin/shared';
import { inGameDate } from '@tailfin/sim';

/** Placeholder until M0-08 stands up the Fastify app. */
export function describeBoot(): string {
  return `tailfin-server schema=${SHARED_SCHEMA_VERSION} epoch=${inGameDate(0).toISOString()}`;
}
