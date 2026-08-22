import {
  AircraftAcquisitionInput,
  aircraftAcquisitionResponseJsonSchema,
  aircraftOrderListResponseJsonSchema,
  apiErrorJsonSchema,
  fleetCatalogueResponseJsonSchema,
  usedMarketResponseJsonSchema,
  BookCheckInput,
  bookCheckResponseJsonSchema,
  maintenanceResponseJsonSchema,
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
import { bookCheck, fleetMaintenance } from './maintenance';
import { listUsedMarket } from './used-market';

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

  /**
   * What the world is offering second-hand (M4-05, App. C.5).
   *
   * `requireAirline`, not `requireActiveAirline`: browsing commits nothing, and a
   * restricted airline that can already read its own orders should be able to see
   * what it would be buying if it were not restricted. The purchase itself still
   * goes through `/api/fleet/acquisitions`, which does require an active airline
   * (ADR-0018).
   *
   * The world comes from the session, like everywhere else, so this cannot be
   * asked what a *different* world is selling — the same reason the catalogue
   * route takes no id. A used market is world-specific twice over: era gating
   * decides which types could appear at all, and the world seed decides which
   * ones did.
   */
  app.get(
    '/api/fleet/used-market',
    {
      onRequest: app.requireAirline,
      schema: { response: { 200: usedMarketResponseJsonSchema } },
    },
    async (request, reply) => {
      const own = resolvedAirlineOf(request);
      return reply.code(200).send(await listUsedMarket(db.db, own.worldId));
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

  /**
   * The fleet's maintenance position (M4-06, §7.3).
   *
   * `requireAirline`: a restricted airline still has aeroplanes, still accrues
   * hours on the ones already flying, and still needs to see what is due. Being
   * unable to *book* a check is a different thing from being unable to look, and
   * conflating them would leave a restricted operator blind to a grounding they
   * are heading for.
   */
  app.get(
    '/api/fleet/maintenance',
    {
      onRequest: app.requireAirline,
      schema: { response: { 200: maintenanceResponseJsonSchema } },
    },
    async (request, reply) => {
      const own = resolvedAirlineOf(request);
      return reply.code(200).send(await fleetMaintenance(db.db, own));
    },
  );

  /**
   * Book a check.
   *
   * `requireActiveAirline`, because it spends money and takes an aeroplane out of
   * service — a commitment, like an acquisition (ADR-0018).
   *
   * The tier is the only thing the client chooses. Cost, downtime and the
   * completion instant are all derived server-side from the world's economy and
   * the type's maintenance profile, so a client cannot ask for a cheap D-check or
   * a one-day one.
   */
  app.post<{ Body: unknown }>(
    '/api/fleet/maintenance/checks',
    {
      onRequest: app.requireActiveAirline,
      schema: {
        response: {
          201: bookCheckResponseJsonSchema,
          400: apiErrorJsonSchema,
          404: apiErrorJsonSchema,
          409: apiErrorJsonSchema,
          422: apiErrorJsonSchema,
        },
      },
    },
    async (request, reply) => {
      const parsed = BookCheckInput.safeParse(request.body);
      if (!parsed.success) {
        const fields: Record<string, string[]> = {};
        for (const issue of parsed.error.issues) {
          const field = issue.path.length === 0 ? 'form' : String(issue.path[0]);
          (fields[field] ??= []).push(issue.message);
        }
        return reply.code(400).send({
          code: 'invalid_maintenance_check',
          message: 'The maintenance check request is not valid',
          fields,
        });
      }

      const own = resolvedAirlineOf(request);
      const result = await bookCheck(db.db, own, parsed.data.airframeId, parsed.data.tier);
      if (!result.ok) return sendCheckRefusal(reply, result);

      return reply.code(201).send({
        airframeId: parsed.data.airframeId,
        tier: result.tier,
        costMinor: result.costMinor,
        completesAt: result.completesAt.toISOString(),
      });
    },
  );
}

function sendCheckRefusal(reply: FastifyReply, result: { kind: string } & Record<string, unknown>) {
  switch (result.kind) {
    // `not-owned` answers 404, not 403. An airframe belonging to somebody else
    // must be indistinguishable from one that does not exist, or the endpoint
    // becomes a way to ask whether a given id is a real aeroplane (ADR-0010).
    case 'airframe-not-found':
    case 'not-owned':
      return reply.code(404).send({
        code: 'airframe_not_found',
        message: 'No such aircraft in your fleet',
      });
    case 'already-in-check':
      return reply.code(409).send({
        code: 'airframe_already_in_check',
        message: 'That aircraft is already in a check',
      });
    case 'insufficient-funds':
      return reply.code(422).send({
        code: 'insufficient_funds',
        message: 'The airline cannot afford that check',
      });
    default:
      return reply.code(422).send({
        code: 'maintenance_check_refused',
        message: 'That maintenance check cannot be booked',
      });
  }
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
