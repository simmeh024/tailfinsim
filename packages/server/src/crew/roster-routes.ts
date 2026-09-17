import {
  AllocateSkillPointInput,
  apiErrorJsonSchema,
  crewRosterResponseJsonSchema,
  Uuid,
  type CrewSkillRefusal,
} from '@tailfin/shared';

import { resolvedAirlineOf } from '../airline/context';
import { parseRequestBody } from '../http/request-body';

import { allocateSkillPoint, readRoster } from './roster';

import type { DatabaseHandle } from '../db/client';
import type { FastifyInstance, FastifyReply } from 'fastify';

/**
 * The roster board (M9-03, §10.2, §10.5).
 *
 * Two routes and no more. §10.5 asks for a roster board and a pilot card, and
 * both are views of the same list — a card is one member of it — so a second
 * endpoint per member would be a round trip for data the board already has.
 *
 * Owner-scoped by resolution: the airline comes from the session, the member id
 * in the path is scoped by it inside the query, and a foreign, absent or
 * malformed id all receive the same 404 (ADR-0020, SEC-07).
 *
 * `requireAirline` to look and `requireActiveAirline` to spend, because §10.2
 * calls a point *"mostly irreversible"* — a ceased airline must not be able to
 * make a permanent decision.
 */

function refusalBody(refusal: CrewSkillRefusal): { code: CrewSkillRefusal; message: string } {
  const message: Record<CrewSkillRefusal, string> = {
    member_absent: 'No such crew member',
    no_unspent_points: 'This crew member has no unspent points',
    branch_wrong_ladder: 'That branch belongs to the other crew ladder',
    branch_full: 'That branch is already at its maximum',
  };
  return { code: refusal, message: message[refusal] };
}

function sendRefusal(reply: FastifyReply, refusal: CrewSkillRefusal) {
  return reply.code(refusal === 'member_absent' ? 404 : 409).send(refusalBody(refusal));
}

export function registerRosterRoutes(app: FastifyInstance, { db }: { db: DatabaseHandle }): void {
  app.get(
    '/api/crew/roster',
    {
      onRequest: app.requireAirline,
      schema: { response: { 200: crewRosterResponseJsonSchema } },
    },
    async (request, reply) => {
      const own = resolvedAirlineOf(request);
      return reply
        .code(200)
        .send(await readRoster(db.db, { worldId: own.worldId, airlineId: own.id }));
    },
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/crew/roster/:id/skills',
    {
      onRequest: app.requireActiveAirline,
      schema: {
        response: {
          200: crewRosterResponseJsonSchema,
          400: apiErrorJsonSchema,
          404: apiErrorJsonSchema,
          409: apiErrorJsonSchema,
        },
      },
    },
    async (request, reply) => {
      const parsed = parseRequestBody(request, AllocateSkillPointInput);
      if (!parsed.success) {
        return reply.code(400).send({ code: 'invalid_input', message: 'Expected a branch' });
      }
      const own = resolvedAirlineOf(request);
      const scope = { worldId: own.worldId, airlineId: own.id };
      // A malformed id is this endpoint's own 404, not a 400 (ADR-0020).
      if (!Uuid.safeParse(request.params.id).success) {
        return sendRefusal(reply, 'member_absent');
      }
      const result = await allocateSkillPoint(db.db, scope, request.params.id, parsed.data.branch);
      if (!result.ok) return sendRefusal(reply, result.refusal);
      // The whole board back: a spend changes the member, the branch totals and
      // the airline's stacked boosts at once.
      return reply.code(200).send(await readRoster(db.db, scope));
    },
  );
}
