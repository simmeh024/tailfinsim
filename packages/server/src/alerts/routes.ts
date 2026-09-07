import {
  alertsResponseJsonSchema,
  digestResponseJsonSchema,
  MarkDigestReadRequest,
  markDigestReadResponseJsonSchema,
} from '@tailfin/shared';

import { resolvedAirlineOf } from '../airline/context';
import { parseRequestBody } from '../http/request-body';

import { markDigestRead, readDigest } from './digest';
import { readOpenAlerts } from './store';

import type { DatabaseHandle } from '../db/client';
import type { FastifyInstance } from 'fastify';

export function registerAlertRoutes(app: FastifyInstance, { db }: { db: DatabaseHandle }): void {
  /**
   * §14.5's alerts for the player's own airline (M8-13).
   *
   * No query string at all, like `GET /api/finance/runway` beside it. The rules,
   * the thresholds and the ordering are the server's, so there is nothing here a
   * client could ask differently — and the badge in the shell must not be able
   * to disagree with the page it links to.
   */
  app.get(
    '/api/alerts',
    {
      onRequest: app.requireAirline,
      schema: { response: { 200: alertsResponseJsonSchema } },
    },
    async (request, reply) =>
      reply.code(200).send(await readOpenAlerts(db.db, resolvedAirlineOf(request))),
  );

  /**
   * §3.2's offline arrival digest.
   *
   * A safe `GET`: it reads the watermark and does not move it, so a refresh
   * shows the same feed and ADR-0025's *no state-changing GET* rule holds.
   */
  app.get(
    '/api/digest',
    {
      onRequest: app.requireAirline,
      schema: { response: { 200: digestResponseJsonSchema } },
    },
    async (request, reply) =>
      reply.code(200).send(await readDigest(db.db, resolvedAirlineOf(request))),
  );

  /**
   * Acknowledge a digest.
   *
   * The body carries the `window.toAt` the client was shown, so the
   * acknowledgement can never reach past an event the player never saw. The
   * server clamps it to its own game time and only ever moves the watermark
   * forward — see `markDigestRead`.
   */
  app.post<{ Body: unknown }>(
    '/api/digest/read',
    {
      onRequest: app.requireAirline,
      schema: { response: { 200: markDigestReadResponseJsonSchema } },
    },
    async (request, reply) => {
      const parsed = parseRequestBody(request, MarkDigestReadRequest);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ code: 'invalid_digest_read', message: 'Invalid digest acknowledgement' });
      }

      const throughAt = new Date(parsed.data.throughAt);
      if (!Number.isFinite(throughAt.getTime())) {
        return reply
          .code(400)
          .send({ code: 'invalid_digest_read', message: 'Invalid digest acknowledgement' });
      }

      return reply
        .code(200)
        .send(await markDigestRead(db.db, resolvedAirlineOf(request), throughAt));
    },
  );
}
