import {
  apiErrorJsonSchema,
  groundContractsResponseJsonSchema,
  groundStationResponseJsonSchema,
  SignContractRequest,
  Uuid,
} from '@tailfin/shared';

import { resolvedAirlineOf } from '../airline/context';
import { parseRequestBody } from '../http/request-body';

import { listAirlineContracts, readStation, signContract, terminateContract } from './contracts';

import type { DatabaseHandle } from '../db/client';
import type { FastifyInstance } from 'fastify';

/**
 * The ground handling API (M5-06, §9.3).
 *
 * Owner-scoped: the airline is resolved from the session, never accepted from the
 * client. `requireAirline` to view a station's vendors and your contracts there;
 * `requireActiveAirline` to sign or terminate one, because a contract is a
 * commitment. The authorization matrix records these rows and SEC-04's
 * enumeration gate fails the build if it does not.
 */
export function registerGroundRoutes(app: FastifyInstance, { db }: { db: DatabaseHandle }): void {
  // A static segment, so Fastify routes it ahead of `/api/ground/:icao` — the
  // whole network's contracts, for the expiry alert, rather than one station's.
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
            : 'That handler is not offered at this station';
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
        response: { 200: groundStationResponseJsonSchema, 404: apiErrorJsonSchema },
      },
    },
    async (request, reply) => {
      const own = resolvedAirlineOf(request);
      if (!Uuid.safeParse(request.params.id).success) {
        return reply.code(404).send({ code: 'not_found', message: 'No such contract' });
      }
      const icao = await terminateContract(db.db, own, request.params.id);
      if (icao === null) {
        return reply.code(404).send({ code: 'not_found', message: 'No such contract' });
      }
      const station = await readStation(db.db, own, icao);
      if (station === null) {
        return reply.code(404).send({ code: 'not_found', message: 'No such station' });
      }
      return reply.code(200).send(station);
    },
  );
}
