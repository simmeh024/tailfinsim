import {
  apiErrorJsonSchema,
  creditStandingResponseJsonSchema,
  DrawLoanRequest,
} from '@tailfin/shared';

import { resolvedAirlineOf } from '../airline/context';
import { parseRequestBody } from '../http/request-body';

import { drawLoan, readCreditStanding } from './credit';

import type { DatabaseHandle } from '../db/client';
import type { FastifyInstance } from 'fastify';

/**
 * The lending API (M8-06, §13).
 *
 * Two routes, owner-scoped by query throughout: what this airline may borrow,
 * and drawing it.
 *
 * `requireActiveAirline` to draw, because a loan commits the airline to a term
 * and moves its cash — and a ceased airline should not be taking on debt.
 * Reading the standing is `requireAirline`, since knowing you cannot borrow is
 * as useful as knowing you can.
 *
 * ## Why a refusal is a 422 and not a 403
 *
 * Being over your borrowing capacity is not an authorization failure. The
 * request was understood, the identity was allowed to make it, and the answer is
 * a rule of §13: *"loans support, they never carry"*. ADR-0020 reserves 403 for a
 * permission the identity lacks, and using it here would tell a player their
 * account was the problem when their **profit** is.
 */
export function registerCreditRoutes(app: FastifyInstance, { db }: { db: DatabaseHandle }): void {
  app.get(
    '/api/credit',
    {
      onRequest: app.requireAirline,
      schema: { response: { 200: creditStandingResponseJsonSchema } },
    },
    async (request, reply) => {
      const own = resolvedAirlineOf(request);
      return reply.code(200).send(await readCreditStanding(db.db, own));
    },
  );

  app.post(
    '/api/credit/loans',
    {
      onRequest: app.requireActiveAirline,
      schema: {
        response: {
          201: creditStandingResponseJsonSchema,
          400: apiErrorJsonSchema,
          404: apiErrorJsonSchema,
          422: apiErrorJsonSchema,
        },
      },
    },
    async (request, reply) => {
      const parsed = parseRequestBody(request, DrawLoanRequest);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ code: 'invalid_input', message: 'Expected an instrument and a principal' });
      }
      const own = resolvedAirlineOf(request);
      const outcome = await drawLoan(db.db, own, parsed.data);
      if (outcome.ok) return reply.code(201).send(outcome.standing);

      // An airframe that is not yours is concealed, like every other private id
      // (ADR-0020). The rest are rules of §13 and say so plainly.
      const status = outcome.failure.code === 'unknown_airframe' ? 404 : 422;
      return reply
        .code(status)
        .send({ code: outcome.failure.code, message: outcome.failure.message });
    },
  );
}
