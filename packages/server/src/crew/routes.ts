import {
  apiErrorJsonSchema,
  crewResponseJsonSchema,
  HireCrewInput,
  OpenCrewBaseInput,
  StartCrewConversionInput,
  type CrewRefusal,
} from '@tailfin/shared';

import { resolvedAirlineOf } from '../airline/context';

import { hireCrew, openCrewBase, readCrewState, startCrewConversion } from './store';

import type { DatabaseHandle } from '../db/client';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * The crew endpoints (M5-01, §9.2).
 *
 * ## Ownership is resolved, never verified
 *
 * `requireActiveAirline` derives the airline from the session, the same boundary
 * the network and fleet APIs use. No handler accepts an `airlineId`, and the
 * mutations additionally never accept a `crewBaseId` without scoping the query by
 * the resolved airline — a base belonging to somebody else is not in the result
 * set, so operating on one is not a state a request can express.
 *
 * ## Refusals are data, not errors
 *
 * Every expected refusal is a `409` carrying a code from the closed `CrewRefusal`
 * set. "Not enough heads" and "hiring capacity" are answers the interface has to
 * place next to a specific control, and a prose message cannot be placed.
 */

/** The one place a refusal becomes an HTTP body. */
function refusalBody(refusal: CrewRefusal): { code: CrewRefusal; message: string } {
  const message: Record<CrewRefusal, string> = {
    base_exists: 'This airline already has a crew base at that airport',
    base_absent: 'No such crew base',
    base_closed: 'That crew base is closed',
    insufficient_funds: 'The airline cannot afford this',
    hiring_capacity: 'That is more than the base can hire in one week',
    not_enough_heads: 'The pool does not have that many crew available',
    same_family: 'Crew are already rated on that family',
  };
  return { code: refusal, message: message[refusal] };
}

export function registerCrewRoutes(app: FastifyInstance, { db }: { db: DatabaseHandle }): void {
  app.get(
    '/api/crew',
    {
      onRequest: app.requireAirline,
      schema: { response: { 200: crewResponseJsonSchema } },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const own = resolvedAirlineOf(request);
      return reply.code(200).send(await readCrewState(db.db, own.worldId, own.id));
    },
  );

  app.post<{ Body: unknown }>(
    '/api/crew/bases',
    {
      onRequest: app.requireActiveAirline,
      schema: {
        response: { 200: crewResponseJsonSchema, 400: apiErrorJsonSchema, 409: apiErrorJsonSchema },
      },
    },
    async (request, reply) => {
      const parsed = OpenCrewBaseInput.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ code: 'invalid_input', message: 'Expected an ICAO code' });
      }
      const own = resolvedAirlineOf(request);
      const result = await openCrewBase(db.db, {
        worldId: own.worldId,
        airlineId: own.id,
        airportIcao: parsed.data.airportIcao,
      });
      if (!result.ok) return reply.code(409).send(refusalBody(result.refusal));
      // The whole state back, not the id: every one of these changes cash,
      // availability and fragmentation at once, and a client that had to refetch
      // would show a stale purse for a frame.
      return reply.code(200).send(await readCrewState(db.db, own.worldId, own.id));
    },
  );

  app.post<{ Body: unknown }>(
    '/api/crew/hires',
    {
      onRequest: app.requireActiveAirline,
      schema: {
        response: { 200: crewResponseJsonSchema, 400: apiErrorJsonSchema, 409: apiErrorJsonSchema },
      },
    },
    async (request, reply) => {
      const parsed = HireCrewInput.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ code: 'invalid_input', message: 'Malformed hire' });
      }
      const own = resolvedAirlineOf(request);
      const result = await hireCrew(db.db, {
        worldId: own.worldId,
        airlineId: own.id,
        ...parsed.data,
      });
      if (!result.ok) return reply.code(409).send(refusalBody(result.refusal));
      return reply.code(200).send(await readCrewState(db.db, own.worldId, own.id));
    },
  );

  app.post<{ Body: unknown }>(
    '/api/crew/conversions',
    {
      onRequest: app.requireActiveAirline,
      schema: {
        response: { 200: crewResponseJsonSchema, 400: apiErrorJsonSchema, 409: apiErrorJsonSchema },
      },
    },
    async (request, reply) => {
      const parsed = StartCrewConversionInput.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ code: 'invalid_input', message: 'Malformed conversion' });
      }
      const own = resolvedAirlineOf(request);
      const result = await startCrewConversion(db.db, {
        worldId: own.worldId,
        airlineId: own.id,
        ...parsed.data,
      });
      if (!result.ok) return reply.code(409).send(refusalBody(result.refusal));
      return reply.code(200).send(await readCrewState(db.db, own.worldId, own.id));
    },
  );
}
