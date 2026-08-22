import { fleetCatalogueResponseJsonSchema } from '@tailfin/shared';

import { resolvedAirlineOf } from '../airline/context';
import { type DatabaseHandle } from '../db/client';

import { fleetCatalogue } from './era';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * The fleet catalogue, as this world sees it (M4-02, §7.2b).
 *
 * ## Ownership is resolved, never verified
 *
 * `requireAirline` derives the airline — and therefore the world — from the
 * authenticated session, the same boundary M3-09's route API uses. The handler
 * never accepts a `worldId`, so it cannot be asked what a *different* world can
 * fly. That matters more than it looks: era gating is world-specific, and a
 * catalogue endpoint that took an id would let a player read the contents of a
 * world whose clock they are not in.
 */
export function registerAircraftRoutes(app: FastifyInstance, { db }: { db: DatabaseHandle }): void {
  app.get(
    '/api/fleet/catalogue',
    {
      onRequest: app.requireAirline,
      schema: { response: { 200: fleetCatalogueResponseJsonSchema } },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const own = resolvedAirlineOf(request);
      return reply.code(200).send(await fleetCatalogue(db.db, own.worldId));
    },
  );
}
