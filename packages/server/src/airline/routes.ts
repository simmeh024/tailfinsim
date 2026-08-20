import {
  CreateAirlineInput,
  createAirlineResponseJsonSchema,
  type ApiError,
} from '@tailfin/shared';

import { type DatabaseHandle } from '../db/client';

import { foundAirline, type FoundAirlineDependencies, type FoundAirlineResult } from './found';

import type { FastifyInstance, FastifyReply } from 'fastify';

/** Player-facing founding API (AIR-01). The guided screen belongs to AIR-07. */

export interface AirlineRoutesOptions extends FoundAirlineDependencies {
  db: DatabaseHandle;
}

function fieldsFromValidation(input: unknown): ApiError | null {
  const parsed = CreateAirlineInput.safeParse(input);
  if (parsed.success) return null;

  const fields: Record<string, string[]> = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path.length === 0 ? 'form' : String(issue.path[0]);
    (fields[field] ??= []).push(issue.message);
  }
  return {
    code: 'invalid_airline',
    message: 'The airline identity or founder hub is not valid',
    fields,
  };
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
        fields: { name: [result.reason] },
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
  { db, moderateIdentity }: AirlineRoutesOptions,
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

      const validation = fieldsFromValidation(request.body);
      if (validation) return reply.code(400).send(validation);

      // Parse again only after the cheap error projection above. This cannot
      // fail, and keeps the service boundary typed to the shared wire contract.
      const input = CreateAirlineInput.parse(request.body);
      const result = await foundAirline(db.db, playerId, input, { moderateIdentity });
      if (!result.ok) return sendRefusal(reply, result);

      return reply.code(201).send({ airline: result.airline, hub: result.hub });
    },
  );
}
