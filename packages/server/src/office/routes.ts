import {
  apiErrorJsonSchema,
  HireOfficeRequest,
  OfficeRole,
  officeStateResponseJsonSchema,
} from '@tailfin/shared';

import { resolvedAirlineOf } from '../airline/context';
import { parseRequestBody } from '../http/request-body';

import { dismissOffice, hireOffice, readOfficeState } from './hires';

import type { DatabaseHandle } from '../db/client';
import type { FastifyInstance } from 'fastify';

/**
 * The office API (M5-04, §9.1).
 *
 * Owner-scoped throughout: the airline is resolved from the session (AIR-05),
 * never accepted from the client, so every read and write reaches only the
 * caller's own office. The authorization matrix records these three rows and
 * `authorization-inventory.test.ts` (SEC-04) fails the build if it does not.
 *
 * `requireAirline` to read, `requireActiveAirline` to hire or dismiss: looking at
 * your office is fine while restricted, but committing a new salaried head is a
 * new commitment, and §9 treats those alike whether the money moves now or on
 * the next payday.
 */
export function registerOfficeRoutes(app: FastifyInstance, { db }: { db: DatabaseHandle }): void {
  app.get(
    '/api/office',
    {
      onRequest: app.requireAirline,
      schema: { response: { 200: officeStateResponseJsonSchema } },
    },
    async (request, reply) => {
      const own = resolvedAirlineOf(request);
      return reply.code(200).send(await readOfficeState(db.db, own));
    },
  );

  app.post<{ Body: unknown }>(
    '/api/office/hires',
    {
      onRequest: app.requireActiveAirline,
      schema: {
        response: {
          200: officeStateResponseJsonSchema,
          400: apiErrorJsonSchema,
        },
      },
    },
    async (request, reply) => {
      const parsed = parseRequestBody(request, HireOfficeRequest);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ code: 'invalid_input', message: 'Expected a role and a candidate' });
      }
      const own = resolvedAirlineOf(request);
      const result = await hireOffice(db.db, own, parsed.data);
      if (!result.ok) {
        return reply.code(400).send({ code: result.code, message: 'No such office role' });
      }
      // The whole office back, not the one hire: hiring the gate seat flips
      // `hasExtendedAuthority`, and a client that had to refetch would show the
      // gate stale for a frame.
      return reply.code(200).send(await readOfficeState(db.db, own));
    },
  );

  app.delete<{ Params: { role: string } }>(
    '/api/office/hires/:role',
    {
      onRequest: app.requireActiveAirline,
      schema: {
        response: {
          200: officeStateResponseJsonSchema,
          400: apiErrorJsonSchema,
        },
      },
    },
    async (request, reply) => {
      const role = OfficeRole.safeParse(request.params.role);
      if (!role.success) {
        return reply.code(400).send({ code: 'invalid_input', message: 'No such office role' });
      }
      const own = resolvedAirlineOf(request);
      await dismissOffice(db.db, own, role.data);
      return reply.code(200).send(await readOfficeState(db.db, own));
    },
  );
}
