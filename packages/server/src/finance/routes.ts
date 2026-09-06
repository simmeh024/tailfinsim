import {
  cashRunwayResponseJsonSchema,
  financePnlResponseJsonSchema,
  Timestamp,
  Uuid,
} from '@tailfin/shared';

import { resolvedAirlineOf } from '../airline/context';

import { readProfitAndLoss, type LedgerQuery } from './ledger';
import { readCashRunway } from './runway';

import type { DatabaseHandle } from '../db/client';
import type { FastifyInstance } from 'fastify';

const DEFAULT_PERIOD_MS = 30 * 86_400_000;

function queryDate(value: string | undefined, fallback: Date): Date | null {
  if (value === undefined) return fallback;
  if (!Timestamp.safeParse(value).success) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function optionalUuid(value: string | undefined): string | undefined | null {
  if (value === undefined) return undefined;
  return Uuid.safeParse(value).success ? value : null;
}

export function registerFinanceRoutes(app: FastifyInstance, { db }: { db: DatabaseHandle }): void {
  /**
   * §13.6's cash runway (M8-08).
   *
   * No query string at all, deliberately. The trailing window, the horizon and
   * the "below 30 days" threshold are all the server's, so there is nothing here
   * for a client to disagree about — and the status strip that reads this on
   * every page is the last place that should be able to ask a different question
   * from the dashboard beside it.
   */
  app.get(
    '/api/finance/runway',
    {
      onRequest: app.requireAirline,
      schema: { response: { 200: cashRunwayResponseJsonSchema } },
    },
    async (request, reply) =>
      reply.code(200).send(await readCashRunway(db.db, resolvedAirlineOf(request))),
  );

  app.get<{
    Querystring: {
      from?: string;
      to?: string;
      routeId?: string;
      aircraftId?: string;
      hubId?: string;
      cabinClass?: LedgerQuery['cabinClass'];
    };
  }>(
    '/api/finance/pnl',
    {
      onRequest: app.requireAirline,
      schema: { response: { 200: financePnlResponseJsonSchema } },
    },
    async (request, reply) => {
      const to = queryDate(request.query.to, new Date());
      const from = queryDate(
        request.query.from,
        new Date((to ?? new Date()).getTime() - DEFAULT_PERIOD_MS),
      );
      const routeId = optionalUuid(request.query.routeId);
      const aircraftId = optionalUuid(request.query.aircraftId);
      const hubId = optionalUuid(request.query.hubId);
      const cabinClass = request.query.cabinClass;

      if (!from || !to || to < from || routeId === null || aircraftId === null || hubId === null) {
        return reply
          .code(400)
          .send({ code: 'invalid_period', message: 'Invalid finance period or dimension' });
      }
      if (cabinClass && !['economy', 'premium_economy', 'business', 'first'].includes(cabinClass)) {
        return reply
          .code(400)
          .send({ code: 'invalid_cabin_class', message: 'Unknown cabin class' });
      }

      return reply.code(200).send(
        await readProfitAndLoss(db.db, {
          airlineId: resolvedAirlineOf(request).id,
          from,
          to,
          routeId,
          aircraftId,
          hubId,
          cabinClass,
        }),
      );
    },
  );
}
