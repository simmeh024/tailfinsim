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

import { readWorldAirports } from './airports';
import { readWorldClock } from './clock';
import { readWorldMap } from './map';

import type { DatabaseHandle } from '../db/client';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export function registerWorldRoutes(app: FastifyInstance, { db }: { db: DatabaseHandle }): void {
  /*
   * The world map's airports. Reference data shared by every world, so it needs a
   * session but not an airline — the globe renders before a player founds anything,
   * and the airports are the same regardless.
   */
  app.get('/api/world/airports', { onRequest: app.requireAuth }, async (_request, reply) => {
    const airports = await readWorldAirports(db.db);
    return reply.code(200).send({ airports });
  });

  /*
   * The player's own overlay — their hubs and routes, positioned. World-scoped, so
   * it takes the airline resolved from the session; a player with no airline gets a
   * 409 through the airline guard, which the map treats as "nothing to draw yet".
   */
  app.get(
    '/api/world/map',
    { onRequest: app.requireAirline },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const own = resolvedAirlineOf(request);
      const map = await readWorldMap(db.db, own.id, own.worldId);
      return reply.code(200).send(map);
    },
  );

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
