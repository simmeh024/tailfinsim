import {
  apiErrorJsonSchema,
  CreateRouteGroupRequest,
  routeGroupsResponseJsonSchema,
  routeGroupSummaryJsonSchema,
  serviceCatalogueResponseJsonSchema,
  servicePackagesResponseJsonSchema,
  servicePackageSummaryJsonSchema,
  UpdateRouteGroupRequest,
  Uuid,
  WriteServicePackageRequest,
} from '@tailfin/shared';

import { resolvedAirlineOf } from '../airline/context';
import { parseRequestBody } from '../http/request-body';

import {
  createPackage,
  createRouteGroup,
  deletePackage,
  deleteRouteGroup,
  listPackages,
  listRouteGroups,
  readCatalogue,
  updatePackage,
  updateRouteGroup,
} from './store';

import type { ServiceWriteFailure } from './store';
import type { DatabaseHandle } from '../db/client';
import type { FastifyInstance, FastifyReply } from 'fastify';

/**
 * The service catalogue API (M8-03, App. D).
 *
 * Owner-scoped throughout: the airline comes from the session and never from the
 * client, and every store query carries it, so another player's package or group
 * is **not found** rather than found and refused — ADR-0020's vocabulary, and the
 * reason a cross-owner id and an absent id get the identical 404 body.
 *
 * `requireAirline` to read the catalogue and your own configuration;
 * `requireActiveAirline` to write. Writing does not move cash — App. D's spending
 * happens per passenger carried, when a flight settles — but it does change what
 * every future flight on a route group serves, and a ceased airline should not be
 * changing what it serves.
 *
 * ## Why the catalogue is an endpoint
 *
 * The tier *names* are in the client's own bundle, but the prices and bands come
 * from the world's pinned economy version, and two worlds can pin different ones.
 * A client that bundled the numbers would show one world's prices in another's
 * configurator. `GET /api/service/catalogue` answers with the ladders already
 * merged against the caller's world.
 */

/** Turn a store refusal into its HTTP answer. */
function sendFailure(reply: FastifyReply, failure: ServiceWriteFailure): FastifyReply {
  switch (failure.code) {
    case 'not_found':
      return reply
        .code(404)
        .send({ code: 'not_found', message: 'No such service package or route group.' });
    case 'duplicate_name':
      return reply
        .code(409)
        .send({ code: 'duplicate_name', message: 'You already have one with that name.' });
    case 'package_in_use':
      return reply.code(409).send({
        code: 'package_in_use',
        message: `Still flown by ${failure.groups.join(', ')}. Reassign those route groups first.`,
      });
    case 'unknown_routes':
      return reply.code(404).send({
        code: 'unknown_routes',
        message: 'One or more of those routes is not yours.',
      });
    case 'invalid_selection':
      // 422 rather than 400: the body parsed, and what is wrong with it is a rule
      // of the catalogue rather than a malformed request.
      return reply.code(422).send({
        code: 'invalid_selection',
        message: failure.problems.map((problem) => problem.message).join(' '),
      });
  }
}

export function registerServiceRoutes(app: FastifyInstance, { db }: { db: DatabaseHandle }): void {
  app.get(
    '/api/service/catalogue',
    {
      onRequest: app.requireAirline,
      schema: { response: { 200: serviceCatalogueResponseJsonSchema } },
    },
    async (request, reply) => {
      const own = resolvedAirlineOf(request);
      return reply.code(200).send(await readCatalogue(db.db, own));
    },
  );

  app.get(
    '/api/service/packages',
    {
      onRequest: app.requireAirline,
      schema: { response: { 200: servicePackagesResponseJsonSchema } },
    },
    async (request, reply) => {
      const own = resolvedAirlineOf(request);
      return reply.code(200).send({ packages: await listPackages(db.db, own) });
    },
  );

  app.post(
    '/api/service/packages',
    {
      onRequest: app.requireActiveAirline,
      schema: {
        response: {
          201: servicePackageSummaryJsonSchema,
          400: apiErrorJsonSchema,
          409: apiErrorJsonSchema,
          422: apiErrorJsonSchema,
        },
      },
    },
    async (request, reply) => {
      const parsed = parseRequestBody(request, WriteServicePackageRequest);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ code: 'invalid_input', message: 'Expected a name and a per-cabin selection' });
      }
      const own = resolvedAirlineOf(request);
      const outcome = await createPackage(db.db, own, parsed.data);
      return outcome.ok ? reply.code(201).send(outcome.value) : sendFailure(reply, outcome.failure);
    },
  );

  app.put<{ Params: { id: string } }>(
    '/api/service/packages/:id',
    {
      onRequest: app.requireActiveAirline,
      schema: {
        response: {
          200: servicePackageSummaryJsonSchema,
          400: apiErrorJsonSchema,
          404: apiErrorJsonSchema,
          409: apiErrorJsonSchema,
          422: apiErrorJsonSchema,
        },
      },
    },
    async (request, reply) => {
      // A malformed id gets the endpoint's own 404, not a 400 — SEC-07's rule:
      // a private path id says nothing about whether it could have existed.
      if (!Uuid.safeParse(request.params.id).success) {
        return reply
          .code(404)
          .send({ code: 'not_found', message: 'No such service package or route group.' });
      }
      const parsed = parseRequestBody(request, WriteServicePackageRequest);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ code: 'invalid_input', message: 'Expected a name and a per-cabin selection' });
      }
      const own = resolvedAirlineOf(request);
      const outcome = await updatePackage(db.db, own, request.params.id, parsed.data);
      return outcome.ok ? reply.code(200).send(outcome.value) : sendFailure(reply, outcome.failure);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/service/packages/:id',
    {
      onRequest: app.requireActiveAirline,
      schema: {
        response: {
          400: apiErrorJsonSchema,
          404: apiErrorJsonSchema,
          409: apiErrorJsonSchema,
        },
      },
    },
    async (request, reply) => {
      if (!Uuid.safeParse(request.params.id).success) {
        return reply
          .code(404)
          .send({ code: 'not_found', message: 'No such service package or route group.' });
      }
      const own = resolvedAirlineOf(request);
      const outcome = await deletePackage(db.db, own, request.params.id);
      return outcome.ok ? reply.code(204).send() : sendFailure(reply, outcome.failure);
    },
  );

  app.get(
    '/api/service/route-groups',
    {
      onRequest: app.requireAirline,
      schema: { response: { 200: routeGroupsResponseJsonSchema } },
    },
    async (request, reply) => {
      const own = resolvedAirlineOf(request);
      return reply.code(200).send(await listRouteGroups(db.db, own));
    },
  );

  app.post(
    '/api/service/route-groups',
    {
      onRequest: app.requireActiveAirline,
      schema: {
        response: {
          201: routeGroupSummaryJsonSchema,
          400: apiErrorJsonSchema,
          404: apiErrorJsonSchema,
          409: apiErrorJsonSchema,
        },
      },
    },
    async (request, reply) => {
      const parsed = parseRequestBody(request, CreateRouteGroupRequest);
      if (!parsed.success) {
        return reply.code(400).send({ code: 'invalid_input', message: 'Expected a group name' });
      }
      const own = resolvedAirlineOf(request);
      const outcome = await createRouteGroup(db.db, own, parsed.data);
      return outcome.ok ? reply.code(201).send(outcome.value) : sendFailure(reply, outcome.failure);
    },
  );

  app.put<{ Params: { id: string } }>(
    '/api/service/route-groups/:id',
    {
      onRequest: app.requireActiveAirline,
      schema: {
        response: {
          200: routeGroupsResponseJsonSchema,
          400: apiErrorJsonSchema,
          404: apiErrorJsonSchema,
          409: apiErrorJsonSchema,
        },
      },
    },
    async (request, reply) => {
      if (!Uuid.safeParse(request.params.id).success) {
        return reply
          .code(404)
          .send({ code: 'not_found', message: 'No such service package or route group.' });
      }
      const parsed = parseRequestBody(request, UpdateRouteGroupRequest);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ code: 'invalid_input', message: 'Expected a name, routes or a package' });
      }
      const own = resolvedAirlineOf(request);
      const outcome = await updateRouteGroup(db.db, own, request.params.id, parsed.data);
      if (!outcome.ok) return sendFailure(reply, outcome.failure);
      // The whole configuration back, because assigning a package to one group
      // can have moved routes out of another and a client that patched its own
      // copy would be recomputing the server's answer.
      return reply.code(200).send(await listRouteGroups(db.db, own));
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/service/route-groups/:id',
    {
      onRequest: app.requireActiveAirline,
      schema: { response: { 404: apiErrorJsonSchema } },
    },
    async (request, reply) => {
      if (!Uuid.safeParse(request.params.id).success) {
        return reply
          .code(404)
          .send({ code: 'not_found', message: 'No such service package or route group.' });
      }
      const own = resolvedAirlineOf(request);
      const outcome = await deleteRouteGroup(db.db, own, request.params.id);
      return outcome.ok ? reply.code(204).send() : sendFailure(reply, outcome.failure);
    },
  );
}
