import {
  cashRunwayResponseJsonSchema,
  financePnlResponseJsonSchema,
  Timestamp,
  Uuid,
} from '@tailfin/shared';

import { resolvedAirlineOf } from '../airline/context';
import { worldGameNow } from '../world/game-now';

import { readProfitAndLoss, type LedgerQuery } from './ledger';
import { readCashRunway } from './runway';

import type { DatabaseHandle } from '../db/client';
import type { FastifyInstance } from 'fastify';

const DAY_MS = 86_400_000;
const DEFAULT_PERIOD_DAYS = 30;
/** The longest period `days` may ask for: a year and a day, which every annual view fits. */
const MAX_PERIOD_DAYS = 366;

function queryDate(value: string | undefined, fallback: Date): Date | null {
  if (value === undefined) return fallback;
  if (!Timestamp.safeParse(value).success) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

/**
 * `?days=N` — a period ending at the world's now, in game days (SURFACE-03).
 *
 * Undefined when absent, null when present and not a whole number of days in
 * range. It exists so a page can ask for *"the last 30 game days"* without
 * knowing what the world's clock reads: the client cannot compute a game-time
 * `from` honestly — it would be converting a wall clock it should never be
 * reading — and the server already knows the answer.
 */
function queryDays(value: string | undefined): number | undefined | null {
  if (value === undefined) return undefined;
  if (!/^\d{1,3}$/.test(value)) return null;
  const days = Number(value);
  return days >= 1 && days <= MAX_PERIOD_DAYS ? days : null;
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
      days?: string;
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
      const own = resolvedAirlineOf(request);
      /*
       * The default period ends at the **world's** now (SURFACE-03).
       *
       * It used to end at `new Date()` — the wall clock — while every ledger line
       * is dated on the world's clock (TIME-02 made `occurred_at` game time for
       * every cause). On any world whose clock is not the reader's, which is
       * every world, the default P&L described a month nothing in it had
       * happened in, and a page reading it showed an airline that had done
       * nothing. Explicit `from`/`to` are unchanged.
       */
      const gameNow = await worldGameNow(db.db, own.worldId);
      const days = queryDays(request.query.days);
      const to = queryDate(request.query.to, gameNow);
      const from = queryDate(
        request.query.from,
        new Date((to ?? gameNow).getTime() - (days ?? DEFAULT_PERIOD_DAYS) * DAY_MS),
      );
      const routeId = optionalUuid(request.query.routeId);
      const aircraftId = optionalUuid(request.query.aircraftId);
      const hubId = optionalUuid(request.query.hubId);
      const cabinClass = request.query.cabinClass;

      if (
        days === null ||
        // `days` and `from` are two answers to one question; both is a contradiction.
        (days !== undefined && request.query.from !== undefined) ||
        !from ||
        !to ||
        to < from ||
        routeId === null ||
        aircraftId === null ||
        hubId === null
      ) {
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
          airlineId: own.id,
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
