import {
  AllocateSkillPointInput,
  apiErrorJsonSchema,
  crewRosterResponseJsonSchema,
  Uuid,
  type CrewSkillRefusal,
} from '@tailfin/shared';

import { resolvedAirlineOf } from '../airline/context';
import { parseRequestBody } from '../http/request-body';

import {
  allocateSkillPoint,
  convertToTrainingCaptain,
  readRoster,
  revertTrainingCaptain,
  type RosterResult,
} from './roster';

import type { DatabaseHandle } from '../db/client';
import type { FastifyInstance, FastifyReply } from 'fastify';

/**
 * The roster board (M9-03, M9-04, §10.2, §10.5).
 *
 * One read and three writes. §10.5 asks for a roster board and a pilot card, and
 * both are views of the same list — a card is one member of it — so a second
 * endpoint per member would be a round trip for data the board already has.
 * Every write returns the whole board for the same reason.
 *
 * Owner-scoped by resolution: the airline comes from the session, the member id
 * in the path is scoped by it inside the query, and a foreign, absent or
 * malformed id all receive the same 404 (ADR-0020, SEC-07).
 *
 * `requireAirline` to look and `requireActiveAirline` to change anything,
 * because §10.2 calls a point *"mostly irreversible"* and a Training Captain's
 * course is a fee — a ceased airline must not be able to make a permanent
 * decision or spend money it is being wound up over.
 *
 * ## The Training Captain designation is a sub-resource (M9-04)
 *
 * `POST` makes a member a Training Captain and `DELETE` returns them to the
 * line. Both bodyless: the member is in the path and the designation has no
 * parameters, so a body could only carry something the server must ignore —
 * which is what SEC-06's body policy exists to keep out. A `PUT` with a boolean
 * was the alternative and was rejected because the two directions do not cost
 * the same: a request that says *"set it to false"* reads as free, and
 * returning a Training Captain to the line is the dearer of the two.
 */

function refusalBody(refusal: CrewSkillRefusal): { code: CrewSkillRefusal; message: string } {
  const message: Record<CrewSkillRefusal, string> = {
    member_absent: 'No such crew member',
    no_unspent_points: 'This crew member has no unspent points',
    branch_wrong_ladder: 'That branch belongs to the other crew ladder',
    branch_full: 'That branch is already at its maximum',
    not_flight_deck: 'Only pilots can become Training Captains',
    not_command_rank: 'Only a Captain can become a Training Captain',
    already_training_captain: 'This crew member is already a Training Captain',
    below_max_level: 'This pilot has not reached the top level yet',
    no_academy: 'There is no commissioned academy at this crew base',
    academy_level: 'The academy at this crew base cannot train Training Captains yet',
    not_training_captain: 'This crew member is not a Training Captain',
    insufficient_funds: 'The airline cannot pay for this',
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

  /*
   * The designation, both ways (M9-04). One registration per method over one
   * handler shape: the only difference is which store function runs, and two
   * hand-written copies would be two chances to forget the malformed-id 404.
   */
  const designationRoutes = [
    { method: 'POST', change: convertToTrainingCaptain },
    { method: 'DELETE', change: revertTrainingCaptain },
  ] as const;

  for (const { method, change } of designationRoutes) {
    app.route<{ Params: { id: string } }>({
      method,
      url: '/api/crew/roster/:id/training-captain',
      onRequest: app.requireActiveAirline,
      schema: {
        response: {
          200: crewRosterResponseJsonSchema,
          404: apiErrorJsonSchema,
          409: apiErrorJsonSchema,
        },
      },
      handler: async (request, reply) => {
        const own = resolvedAirlineOf(request);
        const scope = { worldId: own.worldId, airlineId: own.id };
        // A malformed id is this endpoint's own 404, not a 400 (ADR-0020).
        if (!Uuid.safeParse(request.params.id).success) {
          return sendRefusal(reply, 'member_absent');
        }
        const result: RosterResult<unknown> = await change(db.db, scope, request.params.id);
        if (!result.ok) return sendRefusal(reply, result.refusal);
        // The whole board back: the designation moves cash, the member's line
        // value, the airline's boosts and the base's XP multiplier at once.
        return reply.code(200).send(await readRoster(db.db, scope));
      },
    });
  }
}
