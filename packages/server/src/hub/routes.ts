import {
  apiErrorJsonSchema,
  hubCandidateListResponseJsonSchema,
  hubsResponseJsonSchema,
  OpenHubFacilityRequest,
  PurchaseHubRequest,
  Uuid,
} from '@tailfin/shared';

import { resolvedAirlineOf } from '../airline/context';
import { parseRequestBody } from '../http/request-body';

import { listHubs, openHubFacility, purchaseHub, searchHubCandidates } from './hubs';

import type { HubProblem } from './hubs';
import type { DatabaseHandle } from '../db/client';
import type { FastifyInstance, FastifyReply } from 'fastify';

/**
 * The hub API (M7-04, App. B.5).
 *
 * Owner-scoped: the airline is resolved from the session, never accepted from the
 * client. `requireAirline` to read hubs and price candidates; `requireActiveAirline`
 * to buy, because a hub is a commitment and a restricted airline may not make new
 * ones. The authorization matrix records these rows and SEC-04's enumeration gate
 * fails the build if it does not.
 */

/** ADR-0020's vocabulary, applied to each domain refusal exactly once. */
function sendProblem(reply: FastifyReply, problem: HubProblem): FastifyReply {
  switch (problem) {
    case 'unknown_airport':
      return reply.code(404).send({ code: 'not_found', message: 'No such airport' });
    // A hub id that is malformed, absent or another player's gets the identical
    // body: the private-resource rule, so the three are indistinguishable.
    case 'unknown_hub':
      return reply.code(404).send({ code: 'not_found', message: 'No such hub' });
    case 'already_a_hub':
      return reply
        .code(409)
        .send({ code: 'already_a_hub', message: 'This airline already has a hub at that airport' });
    case 'facility_already_open':
      return reply.code(409).send({
        code: 'facility_already_open',
        message: 'That facility is already open at this hub',
      });
    case 'cost_changed':
      return reply.code(409).send({
        code: 'hub_cost_changed',
        message:
          'The price has changed since it was quoted — the cost of a hub depends on how many ' +
          'you already own. Re-read the quote and confirm the new figure.',
      });
    case 'airport_not_playable':
      return reply.code(422).send({
        code: 'airport_not_playable',
        message: 'That airport has no scheduled service and cannot be a hub',
      });
    case 'requires_maintenance_line':
      return reply.code(422).send({
        code: 'requires_maintenance_line',
        message: 'Heavy check capability needs a maintenance line at this hub first',
      });
    case 'insufficient_funds':
      return reply
        .code(422)
        .send({ code: 'insufficient_funds', message: 'Not enough cash for that purchase' });
  }
}

export function registerHubRoutes(app: FastifyInstance, { db }: { db: DatabaseHandle }): void {
  app.get(
    '/api/hubs',
    {
      onRequest: app.requireAirline,
      schema: { response: { 200: hubsResponseJsonSchema } },
    },
    async (request, reply) => {
      const own = resolvedAirlineOf(request);
      return reply.code(200).send(await listHubs(db.db, own));
    },
  );

  // A static segment, so Fastify routes it ahead of nothing in particular today —
  // but `/api/hubs/:hubId/facilities` exists below, and a future `/api/hubs/:id`
  // would otherwise swallow this. Registered first deliberately.
  app.get<{ Querystring: { query?: string } }>(
    '/api/hubs/candidates',
    {
      onRequest: app.requireAirline,
      schema: { response: { 200: hubCandidateListResponseJsonSchema } },
    },
    async (request, reply) => {
      const own = resolvedAirlineOf(request);
      const raw = request.query.query;
      return reply
        .code(200)
        .send(await searchHubCandidates(db.db, own, typeof raw === 'string' ? raw : undefined));
    },
  );

  app.post<{ Body: unknown }>(
    '/api/hubs',
    {
      onRequest: app.requireActiveAirline,
      schema: {
        response: {
          200: hubsResponseJsonSchema,
          400: apiErrorJsonSchema,
          404: apiErrorJsonSchema,
          409: apiErrorJsonSchema,
          422: apiErrorJsonSchema,
        },
      },
    },
    async (request, reply) => {
      const parsed = parseRequestBody(request, PurchaseHubRequest);
      if (!parsed.success) {
        return reply.code(400).send({
          code: 'invalid_input',
          message: 'Expected an airport identifier and the cost that was quoted',
        });
      }
      const own = resolvedAirlineOf(request);
      const result = await purchaseHub(db.db, own, parsed.data);
      if (!result.ok) return sendProblem(reply, result.problem);
      return reply.code(200).send(result.hubs);
    },
  );

  app.post<{ Params: { hubId: string }; Body: unknown }>(
    '/api/hubs/:hubId/facilities',
    {
      onRequest: app.requireActiveAirline,
      schema: {
        response: {
          200: hubsResponseJsonSchema,
          400: apiErrorJsonSchema,
          404: apiErrorJsonSchema,
          409: apiErrorJsonSchema,
          422: apiErrorJsonSchema,
        },
      },
    },
    async (request, reply) => {
      const parsed = parseRequestBody(request, OpenHubFacilityRequest);
      if (!parsed.success) {
        return reply.code(400).send({
          code: 'invalid_input',
          message: 'Expected a facility kind and the cost that was quoted',
        });
      }
      // A malformed id never reaches the query, and answers exactly as an absent
      // or another player's id does (ADR-0020).
      if (!Uuid.safeParse(request.params.hubId).success) {
        return sendProblem(reply, 'unknown_hub');
      }
      const own = resolvedAirlineOf(request);
      const result = await openHubFacility(db.db, own, request.params.hubId, parsed.data);
      if (!result.ok) return sendProblem(reply, result.problem);
      return reply.code(200).send(result.hubs);
    },
  );
}
