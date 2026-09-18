/**
 * The airport-stand endpoints (M7-06, App. B.6).
 *
 * Addressed **in the context of an airport** — `/api/airports/:icao/gates/…` —
 * for the reason the slot routes are: a stand is a place at a place. `:icao` and
 * `:position` are both **public identifiers**, not owned resources: every airline
 * in the world sees the same apron, and App. B.7 makes seeing who holds what the
 * point. Ownership lives in the holdings, which every handler scopes to the
 * session's airline and never trusts from the path (SEC-07, ADR-0020).
 *
 * Viewing needs only `requireAirline`; leasing and releasing need
 * `requireActiveAirline`, because signing a lease is an operating act and a
 * ceased airline's record is read-only.
 */

import { LeaseStandRequest } from '@tailfin/shared';

import { resolvedAirlineOf } from '../airline/context';
import { parseRequestBody } from '../http/request-body';

import { leaseStand, readAirportGates, releaseStand } from './gates';

import type { DatabaseHandle } from '../db/client';
import type { FastifyInstance } from 'fastify';

export interface GateRoutesOptions {
  db: DatabaseHandle;
}

export function registerGateRoutes(app: FastifyInstance, { db }: GateRoutesOptions): void {
  /** One airport's stands: who holds what, what you hold, and what you need. */
  app.get<{ Params: { icao: string } }>(
    '/api/airports/:icao/gates',
    { onRequest: app.requireAirline },
    async (request, reply) => {
      const own = resolvedAirlineOf(request);
      const gates = await readAirportGates(db.db, own, request.params.icao.toUpperCase());
      if (gates === null) {
        return reply.code(404).send({ code: 'not_found', message: 'No such airport' });
      }
      return reply.code(200).send(gates);
    },
  );

  /**
   * Lease a stand. 404 for an airport or a stand that does not exist, 409 when a
   * rival's lease is in the way, 422 for a common-use stand (there is nothing to
   * lease) and 409 again when the quoted fee has moved.
   *
   * A stand the airport does not have is a **404 with the endpoint's identical
   * body**, not a 400: `position` is a public selector into a computed inventory,
   * and ADR-0020's vocabulary gives a missing identifier the same answer whatever
   * shape it arrived in.
   */
  app.post<{ Params: { icao: string }; Body: unknown }>(
    '/api/airports/:icao/gates',
    { onRequest: app.requireActiveAirline },
    async (request, reply) => {
      // SEC-06: the parsed result is the only thing this handler reads. The
      // policy test greps for a raw read, so even naming one in a comment fails
      // the build — which is the guard working rather than a false positive.
      const parsed = parseRequestBody(request, LeaseStandRequest);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ code: 'invalid_request', message: 'A lease names a stand and a contract' });
      }

      const own = resolvedAirlineOf(request);
      const result = await leaseStand(db.db, own, request.params.icao.toUpperCase(), {
        position: parsed.data.position.toUpperCase(),
        contract: parsed.data.contract,
        expectedAnnualFeeMinor: parsed.data.expectedAnnualFeeMinor,
      });
      if (result.ok) return reply.code(200).send(result.gates);

      switch (result.problem) {
        case 'unknown_airport':
        case 'unknown_stand':
          return reply.code(404).send({ code: 'not_found', message: 'No such stand' });
        case 'exclusively_held':
          return reply.code(409).send({
            code: 'exclusively_held',
            message: 'Another airline holds this stand exclusively',
          });
        case 'contested':
          return reply.code(409).send({
            code: 'contested',
            message: 'An exclusive lease needs a stand nobody else is on',
          });
        case 'not_leasable':
          return reply.code(422).send({
            code: 'not_leasable',
            message: 'A common-use stand is paid per turn, not leased',
          });
        case 'fee_changed':
          return reply
            .code(409)
            .send({ code: 'fee_changed', message: 'This lease now costs something else' });
      }
    },
  );

  /** Give a stand back. Idempotent — releasing one you do not hold is a no-op. */
  app.delete<{ Params: { icao: string; position: string } }>(
    '/api/airports/:icao/gates/:position',
    { onRequest: app.requireActiveAirline },
    async (request, reply) => {
      const own = resolvedAirlineOf(request);
      const result = await releaseStand(
        db.db,
        own,
        request.params.icao.toUpperCase(),
        request.params.position.toUpperCase(),
      );
      if (result.ok) return reply.code(200).send(result.gates);
      return reply.code(404).send({ code: 'not_found', message: 'No such stand' });
    },
  );
}
