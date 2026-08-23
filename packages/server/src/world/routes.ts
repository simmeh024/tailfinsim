/**
 * The player-facing world endpoint (§22.2).
 *
 * ## Ownership is resolved, never verified
 *
 * `requireAirline` derives the airline — and therefore the world — from the
 * authenticated session, the same boundary the network and fleet APIs use. The
 * handler never accepts a `worldId`, so it cannot be asked what time it is in a
 * world the player is not in. A world's clock is not especially sensitive, but
 * an endpoint that took an id would still be an oracle for which world ids exist,
 * and ADR-0020 asks for the shape that cannot express the question.
 */

import { worldClockJsonSchema } from '@tailfin/shared';

import { resolvedAirlineOf } from '../airline/context';

import { readWorldClock } from './clock';

import type { DatabaseHandle } from '../db/client';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export function registerWorldRoutes(app: FastifyInstance, { db }: { db: DatabaseHandle }): void {
  app.get(
    '/api/world/clock',
    {
      onRequest: app.requireAirline,
      schema: { response: { 200: worldClockJsonSchema } },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const own = resolvedAirlineOf(request);
      const result = await readWorldClock(db.db, own.worldId, new Date());

      /*
       * A resolved airline whose world has vanished is not reachable through any
       * ordinary path — the foreign key forbids it — so this is a 500-shaped
       * situation rather than a 404 the client should learn to handle. Throwing
       * keeps it in the logs instead of teaching the clock UI a state that only
       * a corrupt database can produce.
       */
      if (result.kind === 'not-found') {
        throw new Error(`Airline ${own.id} resolved to world ${own.worldId}, which is absent`);
      }
      return reply.code(200).send(result.clock);
    },
  );
}
