import {
  adminAuditResponseJsonSchema,
  adminCreateWorldResponseJsonSchema,
  adminListResponseJsonSchema,
  adminOverviewResponseJsonSchema,
  adminWorldListResponseJsonSchema,
  apiErrorJsonSchema,
} from '@tailfin/shared';

import { type DatabaseHandle } from '../db/client';

import { parseAuditJson, readAudit } from './audit';
import { type Actor, listAdmins } from './grants';
import { buildOverview } from './overview';
import {
  constraintFailure,
  createWorldAsAdmin,
  listWorlds,
  summariseWorld,
  validateWorldConfig,
} from './worlds';

import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * The admin API (M1A-01 and M1A-02, §22).
 *
 * Everything readable, plus one thing that writes: creating a world. Changing a
 * running world's speed and resetting it are M1A-03 and M1A-04, and each needs
 * confirmation semantics of its own — creation is the mild one, because a world
 * in `staging` affects nobody until it is opened.
 *
 * Every route here carries `requireAdmin`. That is the security boundary; the
 * link the interface shows is not. Every mutating route writes its audit row in
 * the same transaction as its change.
 */

export interface AdminRoutesOptions {
  db: DatabaseHandle;
}

/**
 * Who is doing this, for the audit row.
 *
 * `requireAdmin` has already established there is a player, so the fallbacks
 * exist to keep the types honest rather than because they can happen. The label
 * is captured at the time of the action, so the entry stays readable even after
 * the account is renamed or anonymised (§22.10).
 */
function actorOf(request: FastifyRequest): Actor {
  return {
    playerId: request.player?.id ?? null,
    label: request.player?.displayName ?? 'unknown admin',
    requestId: request.id,
  };
}

export function registerAdminRoutes(app: FastifyInstance, { db }: AdminRoutesOptions): void {
  app.get(
    '/api/admin/overview',
    {
      onRequest: app.requireAdmin,
      schema: { response: { 200: adminOverviewResponseJsonSchema } },
    },
    async (_request, reply) => reply.code(200).send(await buildOverview(db.db)),
  );

  app.get(
    '/api/admin/audit',
    {
      onRequest: app.requireAdmin,
      schema: { response: { 200: adminAuditResponseJsonSchema } },
    },
    async (_request, reply) => {
      const rows = await readAudit(db.db, 100);
      return reply.code(200).send({
        entries: rows.map((row) => ({
          id: row.id,
          at: row.at.toISOString(),
          actorPlayerId: row.actorPlayerId,
          actorLabel: row.actorLabel,
          action: row.action,
          subjectType: row.subjectType,
          subjectId: row.subjectId,
          before: parseAuditJson(row.before),
          after: parseAuditJson(row.after),
          requestId: row.requestId,
        })),
      });
    },
  );

  app.get(
    '/api/admin/admins',
    {
      onRequest: app.requireAdmin,
      schema: { response: { 200: adminListResponseJsonSchema } },
    },
    async (_request, reply) => {
      const admins = await listAdmins(db.db);
      return reply.code(200).send({
        admins: admins.map((entry) => ({
          playerId: entry.playerId,
          displayName: entry.displayName,
          grantedAt: entry.grantedAt.toISOString(),
          grantedByPlayerId: entry.grantedByPlayerId,
          grantedByLabel: entry.grantedByLabel,
        })),
      });
    },
  );

  // ------------------------------------------------------------------ worlds

  app.get(
    '/api/admin/worlds',
    {
      onRequest: app.requireAdmin,
      schema: { response: { 200: adminWorldListResponseJsonSchema } },
    },
    async (_request, reply) => reply.code(200).send({ worlds: await listWorlds(db.db) }),
  );

  app.post(
    '/api/admin/worlds',
    {
      onRequest: app.requireAdmin,
      schema: {
        response: {
          201: adminCreateWorldResponseJsonSchema,
          400: apiErrorJsonSchema,
          409: apiErrorJsonSchema,
        },
      },
    },
    async (request, reply) => {
      const now = new Date();
      const validated = validateWorldConfig(request.body, now);
      if (!validated.ok) {
        return reply.code(400).send({
          code: 'invalid_world',
          message: 'This world cannot be created as described.',
          fields: validated.fields,
        });
      }

      try {
        const result = await createWorldAsAdmin(db.db, validated.config, actorOf(request), now);

        if (!result.created) {
          // 409, not 400: nothing about the request is malformed, the world is
          // simply already there. A form can say so against the name field.
          return reply.code(409).send({
            code: 'world_exists',
            message: `A world called "${validated.config.name}" already exists.`,
            fields: {
              name: [
                'A world with this name already exists. Pick another, or reset the one there.',
              ],
            },
          });
        }

        return reply.code(201).send({ world: summariseWorld(result.world, now) });
      } catch (error) {
        // The schema's checks are the backstop under the validation above, and
        // they can still fire — two admins submitting the same name at once, or
        // a rule the database knows that this code has forgotten. Translated
        // rather than leaked: a constraint name is not a sentence.
        const refusal = constraintFailure(error);
        if (!refusal) throw error;
        request.log.warn({ err: error }, 'world creation refused by a database constraint');
        return reply.code(400).send({
          code: 'invalid_world',
          message: 'This world cannot be created as described.',
          fields: refusal.fields,
        });
      }
    },
  );
}
