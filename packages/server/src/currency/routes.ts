import { SetCurrencyRequest } from '@tailfin/shared';

import { parseRequestBody } from '../http/request-body';

import { listCurrencies, setPlayerCurrency } from './rates';

import type { DatabaseHandle } from '../db/client';
import type { FastifyInstance } from 'fastify';

/**
 * The display-currency API (M8-02, §24).
 *
 * `GET /api/currencies` lists the supported currencies and their live rates;
 * `PUT /api/me/currency` records the signed-in player's choice. Both are behind
 * `requireAuth` — a display preference belongs to an account, and the write is
 * scoped to the session player's own row, so there is no cross-owner surface to
 * classify. Neither touches money: rates are display ratios and the choice only
 * changes what the client renders.
 */
export function registerCurrencyRoutes(app: FastifyInstance, { db }: { db: DatabaseHandle }): void {
  app.get('/api/currencies', { onRequest: app.requireAuth }, async (_request, reply) => {
    return reply.code(200).send(await listCurrencies(db.db));
  });

  app.put('/api/me/currency', { onRequest: app.requireAuth }, async (request, reply) => {
    const parsed = parseRequestBody(request, SetCurrencyRequest);
    if (!parsed.success) {
      return reply.code(400).send({
        code: 'invalid_input',
        message: 'Expected a supported ISO-4217 currency code',
      });
    }
    // `requireAuth` guarantees a player; the write is scoped to their own id.
    const playerId = request.player!.id;
    const changed = await setPlayerCurrency(db.db, playerId, parsed.data.currency);
    if (!changed) {
      // The session resolved to a player row that no longer exists — treat it as
      // an unauthenticated request rather than inventing a 404 for "me".
      return reply.code(401).send({ code: 'unauthorized', message: 'Sign in required' });
    }
    return reply.code(200).send({ currency: parsed.data.currency });
  });
}
