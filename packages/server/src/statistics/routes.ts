import {
  MetricDimension,
  MetricId,
  metricBreakdownResponseJsonSchema,
  statisticsResponseJsonSchema,
} from '@tailfin/shared';

import { resolvedAirlineOf } from '../airline/context';

import { readMetricBreakdown, readStatistics } from './metrics';

import type { DatabaseHandle } from '../db/client';
import type { FastifyInstance } from 'fastify';

/**
 * §14's metrics API (M8-09).
 *
 * Two routes, and the second one is the reason the first is worth having: a
 * figure without somewhere to go is the *"dead-end number"* §14.1 forbids.
 *
 * ## The metric id is a selector, not an owned resource
 *
 * SEC-07 asks every identifier to be classified rather than assumed. `:metricId`
 * is a **client-supplied selector over a fixed server-side enum** — it names
 * nothing the player owns and there is no cross-owner question to conceal. An
 * unknown one is a 404 because the metric does not exist, not because somebody
 * else's does. The data behind it is scoped to the resolved owner like every
 * other private read (ADR-0020).
 */
export function registerStatisticsRoutes(
  app: FastifyInstance,
  { db }: { db: DatabaseHandle },
): void {
  app.get(
    '/api/statistics',
    {
      onRequest: app.requireAirline,
      schema: { response: { 200: statisticsResponseJsonSchema } },
    },
    async (request, reply) =>
      reply.code(200).send(await readStatistics(db.db, resolvedAirlineOf(request))),
  );

  app.get<{ Params: { metricId: string }; Querystring: { by?: string } }>(
    '/api/statistics/:metricId/breakdown',
    {
      onRequest: app.requireAirline,
      schema: { response: { 200: metricBreakdownResponseJsonSchema } },
    },
    async (request, reply) => {
      const metric = MetricId.safeParse(request.params.metricId);
      // `route` is the only dimension this build can actually produce, and
      // defaulting to it keeps the metric's own `drillDown` link usable without
      // a query string. A dimension it cannot serve is refused rather than
      // answered empty — an empty breakdown reads as "this figure has no
      // causes", which is a different and untrue statement.
      const by = MetricDimension.safeParse(request.query.by ?? 'route');
      if (!metric.success || !by.success) {
        return reply
          .code(404)
          .send({ code: 'metric_not_found', message: 'No such metric or breakdown' });
      }

      const breakdown = await readMetricBreakdown(
        db.db,
        resolvedAirlineOf(request),
        metric.data,
        by.data,
      );
      if (breakdown === null) {
        return reply
          .code(404)
          .send({ code: 'metric_not_found', message: 'No such metric or breakdown' });
      }
      return reply.code(200).send(breakdown);
    },
  );
}
