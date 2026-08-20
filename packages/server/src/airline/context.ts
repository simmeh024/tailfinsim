/**
 * The authenticated player's airline context (AIR-05).
 *
 * Player-facing handlers never accept an airline id and compare ownership.
 * This boundary resolves an airline from the session and the active world;
 * handlers can then query only inside that airline, so reaching a competitor's
 * rows is not a state they can express.
 */

import { and, asc, eq } from 'drizzle-orm';

import { Uuid } from '@tailfin/shared';

import { type DatabaseHandle, type Database } from '../db/client';
import { airline } from '../db/schema';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export const ACTIVE_WORLD_HEADER = 'x-tailfin-world-id' as const;

export interface ResolvedPlayerAirline {
  id: string;
  worldId: string;
}

export type ActiveWorldHeaderResult = { ok: true; worldId: string | undefined } | { ok: false };

/** Parse the one optional contextual header without accepting duplicate values. */
export function parseActiveWorldHeader(
  value: string | string[] | undefined,
): ActiveWorldHeaderResult {
  if (value === undefined) return { ok: true, worldId: undefined };
  if (Array.isArray(value) || !Uuid.safeParse(value).success) return { ok: false };
  return { ok: true, worldId: value };
}

export type ResolvePlayerAirlineResult =
  | { kind: 'resolved'; airline: ResolvedPlayerAirline }
  | { kind: 'airline-required' }
  | { kind: 'active-world-required' };

/**
 * Select within an explicit world, or infer only an unambiguous single airline.
 *
 * There is deliberately no "newest airline" fallback. Creation recency is not
 * player intent, and guessing would silently operate on a different world as
 * soon as the player founded a second airline.
 */
export async function resolvePlayerAirline(
  db: Database,
  playerId: string,
  activeWorldId: string | undefined,
): Promise<ResolvePlayerAirlineResult> {
  const rows = await db
    .select({ id: airline.id, worldId: airline.worldId })
    .from(airline)
    .where(
      activeWorldId === undefined
        ? eq(airline.playerId, playerId)
        : and(eq(airline.playerId, playerId), eq(airline.worldId, activeWorldId)),
    )
    // Stable for diagnostics; only the number of rows matters when no world was supplied.
    .orderBy(asc(airline.id))
    .limit(activeWorldId === undefined ? 2 : 1);

  const own = rows[0];
  if (!own) return { kind: 'airline-required' };
  if (activeWorldId === undefined && rows.length > 1) {
    return { kind: 'active-world-required' };
  }
  return { kind: 'resolved', airline: own };
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Populated only after `requireAirline` has resolved session ownership. */
    airline: ResolvedPlayerAirline | null;
  }

  interface FastifyInstance {
    /**
     * Requires a session and resolves its airline for the active world.
     * Responds itself when the player context is incomplete.
     */
    requireAirline: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export interface PlayerAirlineContextOptions {
  db: DatabaseHandle;
}

export function registerPlayerAirlineContext(
  app: FastifyInstance,
  { db }: PlayerAirlineContextOptions,
): void {
  app.decorateRequest('airline', null);

  app.decorate('requireAirline', async (request: FastifyRequest, reply: FastifyReply) => {
    await app.requireAuth(request, reply);
    if (reply.sent || request.player === undefined) return;

    const selected = parseActiveWorldHeader(request.headers[ACTIVE_WORLD_HEADER]);
    if (!selected.ok) {
      await reply.code(400).send({
        code: 'invalid_active_world',
        message: `${ACTIVE_WORLD_HEADER} must contain one world UUID`,
      });
      return;
    }

    const result = await resolvePlayerAirline(db.db, request.player.id, selected.worldId);
    if (result.kind === 'airline-required') {
      await reply.code(409).send({
        code: 'airline_required',
        message: 'Found an airline in the active world before using this feature',
      });
      return;
    }
    if (result.kind === 'active-world-required') {
      await reply.code(409).send({
        code: 'active_world_required',
        message: `Choose an active world with ${ACTIVE_WORLD_HEADER} before using this feature`,
      });
      return;
    }

    request.airline = result.airline;
  });
}

/** A programming assertion for handlers already guarded by `requireAirline`. */
export function resolvedAirlineOf(request: FastifyRequest): ResolvedPlayerAirline {
  if (request.airline === null) {
    throw new Error('requireAirline did not populate request.airline');
  }
  return request.airline;
}
