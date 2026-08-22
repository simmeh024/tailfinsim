import {
  AircraftAcquisitionInput,
  aircraftAcquisitionResponseJsonSchema,
  aircraftOrderListResponseJsonSchema,
  apiErrorJsonSchema,
  fleetCatalogueResponseJsonSchema,
  type ApiError,
} from '@tailfin/shared';

import { resolvedAirlineOf } from '../airline/context';
import { type DatabaseHandle } from '../db/client';

import {
  acquireAircraft,
  listAircraftOrders,
  type AircraftAcquisitionRefusal,
} from './acquisition';
import { fleetCatalogue } from './era';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * The fleet catalogue, as this world sees it (M4-02, §7.2b).
 *
 * ## Ownership is resolved, never verified
 *
 * `requireAirline` derives the airline — and therefore the world — from the
 * authenticated session, the same boundary M3-09's route API uses. The handler
 * never accepts a `worldId`, so it cannot be asked what a *different* world can
 * fly. That matters more than it looks: era gating is world-specific, and a
 * catalogue endpoint that took an id would let a player read the contents of a
 * world whose clock they are not in.
 */
export function registerAircraftRoutes(app: FastifyInstance, { db }: { db: DatabaseHandle }): void {
  app.get(
    '/api/fleet/catalogue',
    {
      onRequest: app.requireAirline,
      schema: { response: { 200: fleetCatalogueResponseJsonSchema } },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const own = resolvedAirlineOf(request);
      return reply.code(200).send(await fleetCatalogue(db.db, own.worldId));
    },
  );

  /**
   * The single commercial mutation for lease, used and new aircraft (M4-04).
   *
   * `requireActiveAirline` is intentional: every path creates a new financial
   * commitment, so a restricted airline may read its orders but may not place
   * another one (ADR-0018).
   */
  app.post<{ Body: unknown }>(
    '/api/fleet/acquisitions',
    {
      onRequest: app.requireActiveAirline,
      schema: {
        response: {
          201: aircraftAcquisitionResponseJsonSchema,
          400: apiErrorJsonSchema,
          404: apiErrorJsonSchema,
          409: apiErrorJsonSchema,
          422: apiErrorJsonSchema,
        },
      },
    },
    async (request, reply) => {
      const parsed = AircraftAcquisitionInput.safeParse(request.body);
      if (!parsed.success) {
        const fields: Record<string, string[]> = {};
        for (const issue of parsed.error.issues) {
          const field = issue.path.length === 0 ? 'form' : String(issue.path[0]);
          (fields[field] ??= []).push(issue.message);
        }
        return reply.code(400).send({
          code: 'invalid_aircraft_acquisition',
          message: 'The aircraft acquisition request is not valid',
          fields,
        });
      }

      const result = await acquireAircraft(db.db, resolvedAirlineOf(request), parsed.data);
      if (!result.ok) return sendAcquisitionRefusal(reply, result);
      return reply.code(201).send({
        order: result.order,
        airframe: result.airframe,
        replayed: result.replayed,
      });
    },
  );

  /** Restricted airlines can still inspect commitments they already made. */
  app.get(
    '/api/fleet/orders',
    {
      onRequest: app.requireAirline,
      schema: { response: { 200: aircraftOrderListResponseJsonSchema } },
    },
    async (request, reply) =>
      reply.code(200).send({ orders: await listAircraftOrders(db.db, resolvedAirlineOf(request)) }),
  );
}

function sendAcquisitionRefusal(reply: FastifyReply, result: AircraftAcquisitionRefusal) {
  let status: 404 | 409 | 422;
  let error: ApiError;

  switch (result.kind) {
    case 'request-id-conflict':
      status = 409;
      error = {
        code: 'aircraft_request_id_conflict',
        message: 'That aircraft request id already belongs to another acquisition',
      };
      break;
    case 'airline-not-active':
      status = 409;
      error = {
        code: `airline_${result.status}`,
        message: `This airline is ${result.status} and cannot acquire aircraft`,
      };
      break;
    case 'type-not-found':
      status = 404;
      error = {
        code: 'aircraft_type_not_found',
        message: `${result.designation} does not exist in this world's catalogue`,
      };
      break;
    case 'airport-not-found':
      status = 404;
      error = {
        code: 'delivery_airport_not_found',
        message: `${result.icao} is not a known delivery airport`,
      };
      break;
    case 'listing-not-available':
      status = 409;
      error = {
        code: 'used_aircraft_not_available',
        message: 'That used aircraft is no longer available',
      };
      break;
    case 'insufficient-funds':
      status = 409;
      error = {
        code: 'insufficient_funds',
        message: `This acquisition needs ${String(result.requiredMinor)} minor units; ${String(result.availableMinor)} are available`,
      };
      break;
    case 'type-not-orderable':
      status = 422;
      error = {
        code: 'aircraft_type_not_orderable',
        message: `${result.designation} is ${result.availability} and cannot be acquired this way`,
      };
      break;
    case 'lease-not-offered':
      status = 422;
      error = {
        code: 'aircraft_lease_not_offered',
        message: `${result.designation} has no lease offer in this catalogue`,
      };
      break;
    case 'invalid-build':
      status = 422;
      error = {
        code: 'invalid_aircraft_build',
        message: 'The requested factory options do not make a valid build',
        fields: {
          optionIds: result.refusals.map((refusal) => refusal.detail),
        },
      };
      break;
  }

  return reply.code(status).send(error);
}
