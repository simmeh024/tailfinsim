import {
  CreateAirlineInput,
  ForceRenameAirlineInput,
  Uuid,
  apiErrorJsonSchema,
  createAirlineResponseJsonSchema,
  forceRenameAirlineResponseJsonSchema,
  type ApiError,
} from '@tailfin/shared';

import { type DatabaseHandle } from '../db/client';

import { foundAirline, type FoundAirlineDependencies, type FoundAirlineResult } from './found';
import { forceRenameAirline } from './rename';

import type { FastifyInstance, FastifyReply } from 'fastify';

/** Founding (AIR-01) and AIR-02's audited moderation remedy. Player UI comes later. */

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
  { db, identityModerator }: AirlineRoutesOptions,
): void {
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

      const result = await foundAirline(db.db, playerId, parsed.data, { identityModerator });
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
