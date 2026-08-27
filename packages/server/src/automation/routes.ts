import {
  apiErrorJsonSchema,
  AutomationSystem,
  automationStateResponseJsonSchema,
  SetAutomationRequest,
} from '@tailfin/shared';

import { resolvedAirlineOf } from '../airline/context';
import { parseRequestBody } from '../http/request-body';

import { listSettings, writeSetting } from './store';
import { listOpenTasks } from './tasks';

import type { DatabaseHandle } from '../db/client';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * The automation ladder API (M5-05, ADR-0023).
 *
 * Owner-scoped: the airline is resolved from the session, never accepted from the
 * client. `requireAirline` to read your settings and your operations queue;
 * `requireActiveAirline` to change a mode or a policy, because delegating a
 * system while restricted is a commitment like any other. The authorization
 * matrix records both rows and `authorization-inventory.test.ts` fails the build
 * if it does not.
 */
async function state(db: DatabaseHandle, request: FastifyRequest) {
  const own = resolvedAirlineOf(request);
  const [settings, tasks] = await Promise.all([
    listSettings(db.db, own),
    listOpenTasks(db.db, own),
  ]);
  return { settings, tasks };
}

export function registerAutomationRoutes(
  app: FastifyInstance,
  { db }: { db: DatabaseHandle },
): void {
  app.get(
    '/api/automation',
    {
      onRequest: app.requireAirline,
      schema: { response: { 200: automationStateResponseJsonSchema } },
    },
    async (request, reply) => {
      return reply.code(200).send(await state(db, request));
    },
  );

  app.put<{ Params: { system: string }; Body: unknown }>(
    '/api/automation/:system',
    {
      onRequest: app.requireActiveAirline,
      schema: {
        response: {
          200: automationStateResponseJsonSchema,
          400: apiErrorJsonSchema,
        },
      },
    },
    async (request, reply) => {
      const system = AutomationSystem.safeParse(request.params.system);
      if (!system.success) {
        return reply
          .code(400)
          .send({ code: 'invalid_input', message: 'No such automation system' });
      }
      const parsed = parseRequestBody(request, SetAutomationRequest);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ code: 'invalid_input', message: 'Expected a mode and a policy' });
      }
      const own = resolvedAirlineOf(request);
      await writeSetting(db.db, own, system.data, parsed.data);
      return reply.code(200).send(await state(db, request));
    },
  );
}
