import {
  AirlineCodeAvailabilityInput,
  CreateAirlineInput,
  ForceRenameAirlineInput,
  Uuid,
  apiErrorJsonSchema,
  airlineFoundingAirportListResponseJsonSchema,
  airlineFoundingOptionsResponseJsonSchema,
  airlineCodeAvailabilityResponseJsonSchema,
  createAirlineResponseJsonSchema,
  forceRenameAirlineResponseJsonSchema,
  type ApiError,
} from '@tailfin/shared';

import { type DatabaseHandle } from '../db/client';

import { checkAirlineCodeAvailability } from './codes';
import { foundAirline, type FoundAirlineDependencies, type FoundAirlineResult } from './found';
import { listAirlineFoundingOptions, searchAirlineFoundingAirports } from './founding-options';
import { forceRenameAirline } from './rename';

import type { FastifyInstance, FastifyReply } from 'fastify';

/** Founding, AIR-07's player read model, and AIR-02's audited moderation remedy. */

export interface AirlineRoutesOptions extends FoundAirlineDependencies {
  db: DatabaseHandle;
}

function fieldsFromIssues(
  code: string,
  message: string,
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): ApiError {
  const fields: Record<string, string[]> = {};
  for (const issue of issues) {
    const field = issue.path.length === 0 ? 'form' : String(issue.path[0]);
    (fields[field] ??= []).push(issue.message);
  }
  return { code, message, fields };
}

async function sendRefusal(reply: FastifyReply, result: Exclude<FoundAirlineResult, { ok: true }>) {
  switch (result.kind) {
    case 'world-not-found':
      return reply
        .code(404)
        .send({ code: 'world_not_found', message: `World ${result.worldId} does not exist` });
    case 'world-not-open':
      return reply.code(409).send({
        code: 'world_not_open',
        message: `This world is ${result.status}; an airline can only be founded in an open world`,
      });
    case 'world-full':
      return reply.code(409).send({
        code: 'world_full',
        message: `This world has reached its player cap of ${String(result.playerCap)}`,
      });
    case 'unknown-hub':
      return reply.code(422).send({
        code: 'unknown_hub',
        message: `${result.ident} is not an airport in this dataset`,
        fields: { hubIdent: [`No airport has the identifier ${result.ident}.`] },
      });
    case 'identity-refused':
      return reply.code(422).send({
        code: 'identity_refused',
        message: result.reason,
        fields: { [result.field]: [result.reason] },
      });
    case 'code-taken': {
      const field = result.codeKind === 'iata' ? 'iataCode' : 'icaoCode';
      return reply.code(409).send({
        code: `${result.codeKind}_code_taken`,
        message: `${result.code} is already assigned to an airline in this world`,
        fields: { [field]: [`${result.code} is already taken in this world.`] },
        codeKind: result.codeKind,
        submittedCode: result.code,
        alternatives: result.alternatives,
        advisory: result.advisory,
      });
    }
    case 'code-reserved': {
      const field = result.codeKind === 'iata' ? 'iataCode' : 'icaoCode';
      return reply.code(409).send({
        code: `${result.codeKind}_code_reserved`,
        message: `${result.code} is reserved by this world's airline-code policy`,
        fields: { [field]: [`${result.code} is reserved and cannot be allocated.`] },
        codeKind: result.codeKind,
        submittedCode: result.code,
        alternatives: result.alternatives,
        advisory: result.advisory,
      });
    }
    case 'already-founded':
      return reply.code(409).send({
        code: 'airline_already_founded',
        message: 'You already own an airline in this world',
      });
  }
}

export function registerAirlineRoutes(
  app: FastifyInstance,
  { db, identityModerator, codePolicy }: AirlineRoutesOptions,
): void {
  /** Server-owned world terms used both by the landing redirect and the founding desk. */
  app.get(
    '/api/airlines/founding-options',
    {
      onRequest: app.requireAuth,
      schema: { response: { 200: airlineFoundingOptionsResponseJsonSchema } },
    },
    async (request, reply) => {
      const playerId = request.player?.id;
      if (playerId === undefined) return;
      return reply.code(200).send(await listAirlineFoundingOptions(db.db, playerId));
    },
  );

  /** Searchable founder-hub list; the empty query is the three recommendations. */
  app.get<{ Querystring: { q?: string } }>(
    '/api/airlines/founding-airports',
    {
      onRequest: app.requireAuth,
      schema: { response: { 200: airlineFoundingAirportListResponseJsonSchema } },
    },
    async (request, reply) =>
      reply.code(200).send(await searchAirlineFoundingAirports(db.db, request.query.q)),
  );

  /**
   * Founding-form convenience only. The response says explicitly that no code
   * is reserved; the unique constraints in the founding transaction decide.
   */
  app.post<{ Body: unknown }>(
    '/api/airlines/code-availability',
    {
      onRequest: app.requireAuth,
      schema: {
        response: {
          200: airlineCodeAvailabilityResponseJsonSchema,
          400: apiErrorJsonSchema,
          404: apiErrorJsonSchema,
        },
      },
    },
    async (request, reply) => {
      const parsed = AirlineCodeAvailabilityInput.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send(
            fieldsFromIssues(
              'invalid_code_availability_check',
              'The world, airline name or proposed codes are not valid',
              parsed.error.issues,
            ),
          );
      }

      const result = await checkAirlineCodeAvailability(db.db, parsed.data, codePolicy);
      if (!result.ok) {
        return reply
          .code(404)
          .send({ code: 'world_not_found', message: `World ${result.worldId} does not exist` });
      }
      return reply.code(200).send(result.availability);
    },
  );

  app.post<{ Body: unknown }>(
    '/api/airlines',
    {
      onRequest: app.requireAuth,
      schema: { response: { 201: createAirlineResponseJsonSchema } },
    },
    async (request, reply) => {
      const playerId = request.player?.id;
      if (playerId === undefined) return;

      const parsed = CreateAirlineInput.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send(
            fieldsFromIssues(
              'invalid_airline',
              'The airline identity or founder hub is not valid',
              parsed.error.issues,
            ),
          );
      }

      const result = await foundAirline(db.db, playerId, parsed.data, {
        identityModerator,
        codePolicy,
      });
      if (!result.ok) return sendRefusal(reply, result);

      return reply.code(201).send({ airline: result.airline, hub: result.hub });
    },
  );

  /**
   * Audited moderation remedy. AIR-08 owns ordinary player rebrands and their
   * cost; this path exists so unacceptable public text can be corrected now.
   */
  app.patch<{ Params: { airlineId: string }; Body: unknown }>(
    '/api/admin/airlines/:airlineId/identity',
    {
      onRequest: app.requireAdmin,
      schema: {
        response: {
          200: forceRenameAirlineResponseJsonSchema,
          400: apiErrorJsonSchema,
          404: apiErrorJsonSchema,
          422: apiErrorJsonSchema,
        },
      },
    },
    async (request, reply) => {
      if (!Uuid.safeParse(request.params.airlineId).success) {
        return reply
          .code(404)
          .send({ code: 'airline_not_found', message: 'No airline with that id.' });
      }

      const parsed = ForceRenameAirlineInput.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send(
            fieldsFromIssues(
              'invalid_airline_identity',
              'The replacement identity or audit reason is not valid',
              parsed.error.issues,
            ),
          );
      }

      const result = await forceRenameAirline(
        db.db,
        request.params.airlineId,
        parsed.data,
        {
          playerId: request.player?.id ?? null,
          label: request.player?.displayName ?? 'unknown admin',
          requestId: request.id,
        },
        { identityModerator },
      );
      if (!result.ok) {
        if (result.kind === 'airline-not-found') {
          return reply
            .code(404)
            .send({ code: 'airline_not_found', message: 'No airline with that id.' });
        }
        return reply.code(422).send({
          code: 'identity_refused',
          message: result.reason,
          fields: { [result.field]: [result.reason] },
        });
      }

      return reply.code(200).send({ airline: result.airline, changed: result.changed });
    },
  );
}
