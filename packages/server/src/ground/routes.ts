import {
  apiErrorJsonSchema,
  groundContractsResponseJsonSchema,
  groundStationResponseJsonSchema,
  OpenSelfHandlingRequest,
  SignContractRequest,
  Uuid,
} from '@tailfin/shared';

import { resolvedAirlineOf } from '../airline/context';
import { parseRequestBody } from '../http/request-body';

import {
  closeSelfHandling,
  listAirlineContracts,
  openSelfHandling,
  readStation,
  signContract,
  terminateContract,
} from './contracts';

import type { DatabaseHandle } from '../db/client';
import type { FastifyInstance } from 'fastify';

/**
 * The ground handling API (M5-06, §9.3).
 *
 * Owner-scoped: the airline is resolved from the session, never accepted from the
 * client. `requireAirline` to view a station's vendors and your arrangements
 * there; `requireActiveAirline` to sign, terminate, staff or close one, because
 * every one of those either commits the airline to a term or moves its cash. The
 * authorization matrix records these rows and SEC-04's enumeration gate fails the
 * build if it does not.
 *
 * ## Why terminating can be refused
 *
 * Breaking a contract early costs a penalty and can bill a pro-rata volume
 * shortfall (§9.3), so it is a **spend**, and it behaves like every other
 * player-initiated spend in the game: refused with `422 insufficient_funds` when
 * the money is not there rather than taking the airline negative. An airline that
 * cannot afford the exit is locked into its handler, which is a consequence of
 * being broke rather than an inconsistency.
 */
export function registerGroundRoutes(app: FastifyInstance, { db }: { db: DatabaseHandle }): void {
  // A static segment, so Fastify routes it ahead of `/api/ground/:icao` — the
  // whole network's arrangements, for the expiry and shortfall alerts, rather
  // than one station's.
  app.get(
    '/api/ground/contracts',
    {
      onRequest: app.requireAirline,
      schema: { response: { 200: groundContractsResponseJsonSchema } },
    },
    async (request, reply) => {
      const own = resolvedAirlineOf(request);
      return reply.code(200).send(await listAirlineContracts(db.db, own));
    },
  );

  app.get<{ Params: { icao: string } }>(
    '/api/ground/:icao',
    {
      onRequest: app.requireAirline,
      schema: {
        response: { 200: groundStationResponseJsonSchema, 404: apiErrorJsonSchema },
      },
    },
    async (request, reply) => {
      const own = resolvedAirlineOf(request);
      const station = await readStation(db.db, own, request.params.icao.toUpperCase());
      if (station === null) {
        return reply.code(404).send({ code: 'not_found', message: 'No such station' });
      }
      return reply.code(200).send(station);
    },
  );

  app.post<{ Params: { icao: string }; Body: unknown }>(
    '/api/ground/:icao/contracts',
    {
      onRequest: app.requireActiveAirline,
      schema: {
        response: {
          200: groundStationResponseJsonSchema,
          400: apiErrorJsonSchema,
          404: apiErrorJsonSchema,
          422: apiErrorJsonSchema,
        },
      },
    },
    async (request, reply) => {
      const parsed = parseRequestBody(request, SignContractRequest);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ code: 'invalid_input', message: 'Expected a service line and a grade' });
      }
      const own = resolvedAirlineOf(request);
      const result = await signContract(db.db, own, request.params.icao.toUpperCase(), parsed.data);
      if (!result.ok) {
        if (result.code === 'unknown_station') {
          return reply.code(404).send({ code: 'not_found', message: 'No such station' });
        }
        const message =
          result.code === 'capacity_exhausted'
            ? 'That handler is full — every contract slot is taken'
            : result.code === 'insufficient_funds'
              ? 'The airline cannot afford to break the contract it already holds here'
              : 'That handler is not offered at this station';
        return reply.code(422).send({ code: result.code, message });
      }
      return reply.code(200).send(result.station);
    },
  );

  app.post<{ Params: { icao: string }; Body: unknown }>(
    '/api/ground/:icao/self-handling',
    {
      onRequest: app.requireActiveAirline,
      schema: {
        response: {
          200: groundStationResponseJsonSchema,
          400: apiErrorJsonSchema,
          404: apiErrorJsonSchema,
          422: apiErrorJsonSchema,
        },
      },
    },
    async (request, reply) => {
      const parsed = parseRequestBody(request, OpenSelfHandlingRequest);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ code: 'invalid_input', message: 'Expected a service line and a headcount' });
      }
      const own = resolvedAirlineOf(request);
      const result = await openSelfHandling(
        db.db,
        own,
        request.params.icao.toUpperCase(),
        parsed.data,
      );
      if (!result.ok) {
        if (result.code === 'unknown_station') {
          return reply.code(404).send({ code: 'not_found', message: 'No such station' });
        }
        const message =
          result.code === 'needs_hub'
            ? 'Handling a line yourself needs a hub at the station'
            : 'The airline cannot afford to break the contract it already holds here';
        return reply.code(422).send({ code: result.code, message });
      }
      return reply.code(200).send(result.station);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/ground/contracts/:id',
    {
      onRequest: app.requireActiveAirline,
      schema: {
        response: {
          200: groundStationResponseJsonSchema,
          404: apiErrorJsonSchema,
          422: apiErrorJsonSchema,
        },
      },
    },
    async (request, reply) => {
      const own = resolvedAirlineOf(request);
      // A malformed id receives the endpoint's *identical* 404 (ADR-0020): a
      // client must not be able to tell a bad uuid from someone else's contract.
      if (!Uuid.safeParse(request.params.id).success) {
        return reply.code(404).send({ code: 'not_found', message: 'No such contract' });
      }
      const result = await terminateContract(db.db, own, request.params.id);
      if (!result.ok) {
        if (result.code === 'not_found') {
          return reply.code(404).send({ code: 'not_found', message: 'No such contract' });
        }
        return reply.code(422).send({
          code: result.code,
          message: 'The airline cannot afford to break this contract early',
        });
      }
      const station = await readStation(db.db, own, result.icao);
      if (station === null) {
        return reply.code(404).send({ code: 'not_found', message: 'No such station' });
      }
      return reply.code(200).send(station);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/ground/self-handling/:id',
    {
      onRequest: app.requireActiveAirline,
      schema: {
        response: { 200: groundStationResponseJsonSchema, 404: apiErrorJsonSchema },
      },
    },
    async (request, reply) => {
      const own = resolvedAirlineOf(request);
      if (!Uuid.safeParse(request.params.id).success) {
        return reply.code(404).send({ code: 'not_found', message: 'No such operation' });
      }
      const icao = await closeSelfHandling(db.db, own, request.params.id);
      if (icao === null) {
        return reply.code(404).send({ code: 'not_found', message: 'No such operation' });
      }
      const station = await readStation(db.db, own, icao);
      if (station === null) {
        return reply.code(404).send({ code: 'not_found', message: 'No such station' });
      }
      return reply.code(200).send(station);
    },
  );
}
