import {
  academiesResponseJsonSchema,
  apiErrorJsonSchema,
  BuildAcademyModuleInput,
  FoundAcademyInput,
  Uuid,
  type AcademyRefusal,
} from '@tailfin/shared';

import { resolvedAirlineOf } from '../airline/context';
import { parseRequestBody } from '../http/request-body';

import { buildAcademyModule, foundAcademy, readAcademies, upgradeAcademy } from './store';

import type { DatabaseHandle } from '../db/client';
import type { FastifyInstance, FastifyReply } from 'fastify';

/**
 * The training academy API (M9-01, §10.1).
 *
 * ## Ownership is resolved, never verified
 *
 * `requireAirline` to look; `requireActiveAirline` to build, because every build
 * is a capital commitment. No handler accepts an `airlineId`, and the academy id
 * in a path is scoped by the resolved airline inside the query rather than
 * checked after it — so another player's academy is not in the result set, and a
 * foreign, malformed or absent id all receive the same 404 (ADR-0020, SEC-07).
 *
 * ## What is deliberately absent
 *
 * There is **no** endpoint that shortens a build, and none that demolishes one.
 * The first is the third acceptance criterion — *build time cannot be shortened
 * with money* — and the strongest form of that rule is that the route table has
 * nowhere to express it. The second follows `hub_facility`'s precedent: §10.1
 * gives a capital cost, a duration and an upkeep and no way back, and a closure
 * path would be a mechanic nobody has designed.
 */

function refusalBody(refusal: AcademyRefusal): { code: AcademyRefusal; message: string } {
  const message: Record<AcademyRefusal, string> = {
    base_absent: 'No such crew base',
    base_closed: 'That crew base is closed',
    academy_exists: 'That base already has an academy',
    academy_absent: 'No such academy',
    already_building: 'This academy is already under construction',
    max_level: 'This academy is already a Centre of Excellence',
    module_exists: 'That module is already built here',
    module_level: 'The academy is not yet at the level this module needs',
    unknown_family: 'This world flies no such aircraft family',
    insufficient_funds: 'The airline cannot afford this',
  };
  return { code: refusal, message: message[refusal] };
}

/**
 * A missing or foreign id is concealed as 404; the rest describe known state and
 * stay conflicts — the academy exists in the caller's namespace and cannot do
 * this now.
 */
function sendRefusal(reply: FastifyReply, refusal: AcademyRefusal) {
  const status = refusal === 'base_absent' || refusal === 'academy_absent' ? 404 : 409;
  return reply.code(status).send(refusalBody(refusal));
}

export function registerAcademyRoutes(app: FastifyInstance, { db }: { db: DatabaseHandle }): void {
  app.get(
    '/api/academies',
    {
      onRequest: app.requireAirline,
      schema: { response: { 200: academiesResponseJsonSchema } },
    },
    async (request, reply) => {
      const own = resolvedAirlineOf(request);
      return reply
        .code(200)
        .send(await readAcademies(db.db, { worldId: own.worldId, airlineId: own.id }));
    },
  );

  app.post<{ Body: unknown }>(
    '/api/academies',
    {
      onRequest: app.requireActiveAirline,
      schema: {
        response: {
          200: academiesResponseJsonSchema,
          400: apiErrorJsonSchema,
          404: apiErrorJsonSchema,
          409: apiErrorJsonSchema,
        },
      },
    },
    async (request, reply) => {
      const parsed = parseRequestBody(request, FoundAcademyInput);
      if (!parsed.success) {
        return reply.code(400).send({ code: 'invalid_input', message: 'Expected a crew base' });
      }
      const own = resolvedAirlineOf(request);
      const scope = { worldId: own.worldId, airlineId: own.id };
      const result = await foundAcademy(db.db, scope, parsed.data.crewBaseId);
      if (!result.ok) return sendRefusal(reply, result.refusal);
      // The whole state back, for the reason the crew endpoints return it: this
      // changed cash, the site list and what may be built next at once.
      return reply.code(200).send(await readAcademies(db.db, scope));
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/academies/:id/levels',
    {
      onRequest: app.requireActiveAirline,
      schema: {
        response: {
          200: academiesResponseJsonSchema,
          404: apiErrorJsonSchema,
          409: apiErrorJsonSchema,
        },
      },
    },
    async (request, reply) => {
      const own = resolvedAirlineOf(request);
      const scope = { worldId: own.worldId, airlineId: own.id };
      /*
       * A malformed id is the endpoint's own 404, not a 400. ADR-0020: a private
       * path id that is malformed, missing or somebody else's receives the same
       * body, so the shape of an id can never tell a caller whether it exists.
       */
      if (!Uuid.safeParse(request.params.id).success) {
        return sendRefusal(reply, 'academy_absent');
      }
      const result = await upgradeAcademy(db.db, scope, request.params.id);
      if (!result.ok) return sendRefusal(reply, result.refusal);
      return reply.code(200).send(await readAcademies(db.db, scope));
    },
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/academies/:id/modules',
    {
      onRequest: app.requireActiveAirline,
      schema: {
        response: {
          200: academiesResponseJsonSchema,
          400: apiErrorJsonSchema,
          404: apiErrorJsonSchema,
          409: apiErrorJsonSchema,
        },
      },
    },
    async (request, reply) => {
      const parsed = parseRequestBody(request, BuildAcademyModuleInput);
      if (!parsed.success) {
        return reply.code(400).send({ code: 'invalid_input', message: 'Malformed module' });
      }
      const own = resolvedAirlineOf(request);
      const scope = { worldId: own.worldId, airlineId: own.id };
      if (!Uuid.safeParse(request.params.id).success) {
        return sendRefusal(reply, 'academy_absent');
      }
      const result = await buildAcademyModule(db.db, scope, request.params.id, parsed.data);
      if (!result.ok) return sendRefusal(reply, result.refusal);
      return reply.code(200).send(await readAcademies(db.db, scope));
    },
  );
}
