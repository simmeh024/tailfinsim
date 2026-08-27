import {
  apiErrorJsonSchema,
  executiveFloorStateJsonSchema,
  HireOfficeRequest,
  OfficeSeatId,
  officeStateResponseJsonSchema,
} from '@tailfin/shared';

import { resolvedAirlineOf } from '../airline/context';
import { parseRequestBody } from '../http/request-body';

import { readExecutiveFloor, unlockExecutiveFloor, unlockExecutiveOffice } from './executive';
import { purchaseExpansion } from './expansion';
import { dismissOffice, hireOffice, readOfficeState } from './hires';

import type { DatabaseHandle } from '../db/client';
import type { FastifyInstance } from 'fastify';

/**
 * The office API (M5-04, §9.1).
 *
 * Owner-scoped throughout: the airline is resolved from the session (AIR-05),
 * never accepted from the client, so every read and write reaches only the
 * caller's own office. The authorization matrix records these rows and
 * `authorization-inventory.test.ts` (SEC-04) fails the build if it does not.
 *
 * `requireAirline` to read, `requireActiveAirline` to hire, dismiss or expand:
 * looking at your office is fine while restricted, but committing a salaried head
 * — or spending millions on more offices — is a new commitment, and §9 treats
 * those alike whether the money moves now or on the next payday.
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
          422: apiErrorJsonSchema,
        },
      },
    },
    async (request, reply) => {
      const parsed = parseRequestBody(request, HireOfficeRequest);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ code: 'invalid_input', message: 'Expected a seat and a candidate' });
      }
      const own = resolvedAirlineOf(request);
      const result = await hireOffice(db.db, own, parsed.data);
      if (!result.ok) {
        if (result.code === 'unknown_candidate') {
          return reply
            .code(400)
            .send({ code: 'invalid_input', message: 'No such candidate in the market' });
        }
        // 422: the request parsed, but the office rules refuse it.
        const message =
          result.code === 'seat_locked'
            ? 'Expand your headquarters before staffing this office'
            : result.code === 'already_seated'
              ? 'This person already holds another office'
              : result.code === 'specialist_unavailable'
                ? 'That social media specialist is not on offer in your market'
                : 'This seat only takes its own role';
        return reply.code(422).send({ code: result.code, message });
      }
      // The whole office back, not the one hire: hiring the gate seat flips
      // `hasExtendedAuthority`, and a client that had to refetch would show the
      // gate stale for a frame.
      return reply.code(200).send(await readOfficeState(db.db, own));
    },
  );

  app.delete<{ Params: { seat: string } }>(
    '/api/office/hires/:seat',
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
      const seat = OfficeSeatId.safeParse(request.params.seat);
      if (!seat.success) {
        return reply.code(400).send({ code: 'invalid_input', message: 'No such office seat' });
      }
      const own = resolvedAirlineOf(request);
      await dismissOffice(db.db, own, seat.data);
      return reply.code(200).send(await readOfficeState(db.db, own));
    },
  );

  app.post(
    '/api/office/expansion',
    {
      onRequest: app.requireActiveAirline,
      schema: {
        response: {
          200: officeStateResponseJsonSchema,
          422: apiErrorJsonSchema,
        },
      },
    },
    async (request, reply) => {
      const own = resolvedAirlineOf(request);
      const result = await purchaseExpansion(db.db, own);
      if (!result.ok) {
        const message =
          result.code === 'maxed'
            ? 'Your headquarters is already at its maximum size'
            : 'Not enough cash to expand your headquarters';
        return reply.code(422).send({ code: result.code, message });
      }
      return reply.code(200).send(await readOfficeState(db.db, own));
    },
  );

  app.get(
    '/api/office/executive',
    {
      onRequest: app.requireAirline,
      schema: { response: { 200: executiveFloorStateJsonSchema } },
    },
    async (request, reply) => {
      const own = resolvedAirlineOf(request);
      return reply.code(200).send(await readExecutiveFloor(db.db, own));
    },
  );

  app.post(
    '/api/office/executive/unlock',
    {
      onRequest: app.requireActiveAirline,
      schema: {
        response: { 200: executiveFloorStateJsonSchema, 422: apiErrorJsonSchema },
      },
    },
    async (request, reply) => {
      const own = resolvedAirlineOf(request);
      const result = await unlockExecutiveFloor(db.db, own);
      if (!result.ok) {
        const message =
          result.code === 'already_unlocked'
            ? 'Your executive floor is already open'
            : result.code === 'revenue_too_low'
              ? 'Your airline is not earning enough yet to open the executive floor'
              : 'Not enough cash to open the executive floor';
        return reply.code(422).send({ code: result.code, message });
      }
      return reply.code(200).send(result.state);
    },
  );

  app.post(
    '/api/office/executive/offices',
    {
      onRequest: app.requireActiveAirline,
      schema: {
        response: { 200: executiveFloorStateJsonSchema, 422: apiErrorJsonSchema },
      },
    },
    async (request, reply) => {
      const own = resolvedAirlineOf(request);
      const result = await unlockExecutiveOffice(db.db, own);
      if (!result.ok) {
        const message =
          result.code === 'floor_locked'
            ? 'Open the executive floor before its offices'
            : result.code === 'maxed'
              ? 'Every executive office is already open'
              : 'Not enough cash to open the next executive office';
        return reply.code(422).send({ code: result.code, message });
      }
      return reply.code(200).send(result.state);
    },
  );
}
