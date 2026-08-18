import { adminAuditResponseJsonSchema, adminListResponseJsonSchema } from '@tailfin/shared';

import { type DatabaseHandle } from '../db/client';

import { parseAuditJson, readAudit } from './audit';
import { listAdmins } from './grants';

import type { FastifyInstance } from 'fastify';

/**
 * The admin API (M1A-01, §22).
 *
 * Read-only for now, and deliberately so. The mutating actions — creating a
 * world, changing its speed, resetting it — are M1A-02 to M1A-04, and each needs
 * its own confirmation semantics. What this milestone owns is the floor beneath
 * all of them: a way to tell an admin from a player, and a record that cannot be
 * edited.
 *
 * Every route here carries `requireAdmin`. That is the security boundary; the
 * link the interface shows is not.
 */

export interface AdminRoutesOptions {
  db: DatabaseHandle;
}

export function registerAdminRoutes(app: FastifyInstance, { db }: AdminRoutesOptions): void {
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
}
