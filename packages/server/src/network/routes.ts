/**
 * The route and fare endpoints (M3-09).
 *
 * The first **player-facing** API in Tailfin — everything before this was
 * `/api/version`, auth, or the admin console. So it is also where the ownership
 * pattern for player data gets set, and it is worth being deliberate about.
 *
 * ## Ownership is resolved, never verified
 *
 * Every handler derives the airline from the authenticated session and then
 * queries the route **within** that airline. It never accepts an `airlineId`
 * and checks it matches.
 *
 * The difference matters: the second form is one forgotten comparison away from
 * letting somebody price a competitor's route, and the forgotten comparison is
 * invisible in review because the code looks like it checks something. The
 * first form cannot express the bug — a route belonging to another airline
 * simply is not in the result set.
 *
 * A route that does not exist and one belonging to somebody else return the
 * same 404, so the endpoint is not an oracle for which route ids are real.
 */

import { and, eq } from 'drizzle-orm';

import { FareTable } from '@tailfin/shared';

import { airline, route } from '../db/schema';

import { parseFares, previewFares, type RouteEconomics, type RouteRow, setFares } from './fares';
import { openRoute } from './open-route';

import type { Database, DatabaseHandle } from '../db/client';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface NetworkRoutesOptions {
  db: DatabaseHandle;
  /**
   * Everything M4, M6, M7 and §15 will one day supply for a route.
   *
   * Injected rather than looked up because none of those systems exist. Making
   * it a parameter keeps the fiction visible: when the fleet lands, this
   * becomes a query and the handlers do not change.
   */
  economicsFor: (row: RouteRow) => Promise<RouteEconomics> | RouteEconomics;
}

/**
 * Find a route inside the caller's own airline, or nothing.
 *
 * One query, joined through the airline the session owns. See the module note
 * on why this is a resolution rather than a check.
 */
async function ownedRoute(
  db: Database,
  playerId: string,
  routeId: string,
): Promise<RouteRow | null> {
  const rows = await db
    .select({
      id: route.id,
      worldId: route.worldId,
      airlineId: route.airlineId,
      originIcao: route.originIcao,
      destinationIcao: route.destinationIcao,
      greatCircleNm: route.greatCircleNm,
      fares: route.fares,
    })
    .from(route)
    .innerJoin(airline, eq(airline.id, route.airlineId))
    .where(and(eq(route.id, routeId), eq(airline.playerId, playerId)))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return { ...row, fares: parseFares(row.fares) };
}

/** The 404 a stranger's route gets, identical to the one a missing route gets. */
async function notFound(reply: FastifyReply): Promise<void> {
  await reply.code(404).send({ code: 'not_found', message: 'No such route' });
}

export function registerNetworkRoutes(
  app: FastifyInstance,
  { db, economicsFor }: NetworkRoutesOptions,
): void {
  /** The player's own routes, with their fares. */
  app.get(
    '/api/routes',
    { onRequest: app.requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const playerId = request.player?.id;
      if (playerId === undefined) return notFound(reply);

      const rows = await db.db
        .select({
          id: route.id,
          originIcao: route.originIcao,
          destinationIcao: route.destinationIcao,
          greatCircleNm: route.greatCircleNm,
          fares: route.fares,
          active: route.active,
        })
        .from(route)
        .innerJoin(airline, eq(airline.id, route.airlineId))
        .where(eq(airline.playerId, playerId));

      return reply.code(200).send({
        routes: rows.map((row) => ({ ...row, fares: parseFares(row.fares) })),
      });
    },
  );

  /**
   * Open a route.
   *
   * A refusal names **which** of B.4's seven checks failed. The design doc is
   * explicit that the UI shows that and *"never a generic unavailable"*, and a
   * route refused for range needs a different aeroplane while one refused for a
   * curfew needs a different time — collapsing them throws away the only part
   * of the answer a player can act on.
   *
   * 422 for a rule refusal, 409 for a pair already open: the first is "this
   * cannot be done", the second is "this is already done", and a client that
   * cannot tell them apart will offer the wrong remedy.
   */
  app.post<{ Body: unknown }>(
    '/api/routes',
    { onRequest: app.requireAuth },
    async (request, reply) => {
      const playerId = request.player?.id;
      if (playerId === undefined) return notFound(reply);

      const body = request.body as { originIcao?: unknown; destinationIcao?: unknown } | null;
      if (typeof body?.originIcao !== 'string' || typeof body.destinationIcao !== 'string') {
        return reply
          .code(400)
          .send({ code: 'invalid_route', message: 'An origin and a destination are required' });
      }

      const result = await openRoute(db.db, playerId, {
        originIcao: body.originIcao,
        destinationIcao: body.destinationIcao,
      });

      if (result.ok) return reply.code(201).send(result);
      if (result.kind === 'duplicate') {
        return reply
          .code(409)
          .send({ code: 'duplicate_route', message: 'You already fly that pair' });
      }
      return reply.code(422).send(result);
    },
  );

  /**
   * Set the fares on a route.
   *
   * Refuses below A.10's floor, and says what the floor was — M3-09's first
   * acceptance criterion. A 422 rather than a 400: the request was well-formed
   * and was refused by a **rule**, which is a different thing from malformed
   * input and deserves a different code.
   */
  app.put<{ Params: { routeId: string }; Body: unknown }>(
    '/api/routes/:routeId/fares',
    { onRequest: app.requireAuth },
    async (request, reply) => {
      const playerId = request.player?.id;
      if (playerId === undefined) return notFound(reply);

      const parsed = FareTable.safeParse((request.body as { fares?: unknown })?.fares);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ code: 'invalid_fares', message: 'Fares must be whole minor units per cabin' });
      }

      const row = await ownedRoute(db.db, playerId, request.params.routeId);
      if (!row) return notFound(reply);

      const result = await setFares(db.db, row, parsed.data, await economicsFor(row));
      return reply.code(result.ok ? 200 : 422).send(result);
    },
  );

  /**
   * What would happen if you saved these fares.
   *
   * A `POST` despite changing nothing, because the proposed fare table is the
   * input and a body is the honest place for it — putting a fare table in a
   * query string would be a worse contract for the sake of a verb.
   */
  app.post<{ Params: { routeId: string }; Body: unknown }>(
    '/api/routes/:routeId/fares/preview',
    { onRequest: app.requireAuth },
    async (request, reply) => {
      const playerId = request.player?.id;
      if (playerId === undefined) return notFound(reply);

      const parsed = FareTable.safeParse((request.body as { fares?: unknown })?.fares);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ code: 'invalid_fares', message: 'Fares must be whole minor units per cabin' });
      }

      const row = await ownedRoute(db.db, playerId, request.params.routeId);
      if (!row) return notFound(reply);

      return reply.code(200).send(previewFares(row, parsed.data, await economicsFor(row)));
    },
  );
}
