/**
 * The airport-slot endpoints (M7-05, §"Slots").
 *
 * Slots are addressed **in the context of an airport** — `/api/airports/:icao/…`
 * — because that is what they belong to: a band at a place. `:icao` is a public
 * identifier (like `/api/ground/:icao`), not an owned resource; ownership lives
 * in the holdings, which every handler resolves within the session's airline and
 * never trusts from the path. A band is a public selector, 0–23.
 *
 * Viewing a coordinated airport's slot picture needs only `requireAirline`;
 * claiming or releasing one needs `requireActiveAirline`, because holding a slot
 * is an operating act and a ceased airline's record is read-only.
 */

import { resolvedAirlineOf } from '../airline/context';

import { claimSlot, readAirportSlots, releaseSlot } from './slots';

import type { DatabaseHandle } from '../db/client';
import type { FastifyInstance } from 'fastify';

export interface SlotRoutesOptions {
  db: DatabaseHandle;
}

export function registerSlotRoutes(app: FastifyInstance, { db }: SlotRoutesOptions): void {
  /** One coordinated airport's bands: capacity, how full, and which you hold. */
  app.get<{ Params: { icao: string } }>(
    '/api/airports/:icao/slots',
    { onRequest: app.requireAirline },
    async (request, reply) => {
      const own = resolvedAirlineOf(request);
      const slots = await readAirportSlots(db.db, own, request.params.icao.toUpperCase());
      if (slots === null) {
        return reply.code(404).send({ code: 'not_found', message: 'No such airport' });
      }
      return reply.code(200).send(slots);
    },
  );

  /**
   * Claim a band. 409 when it is full, 422 at an uncoordinated airport (nothing
   * to claim there), 400 for a band that is not an hour of the day, 404 for an
   * airport that does not exist.
   */
  app.post<{ Params: { icao: string; band: string } }>(
    '/api/airports/:icao/slots/:band',
    { onRequest: app.requireActiveAirline },
    async (request, reply) => {
      const own = resolvedAirlineOf(request);
      const band = Number(request.params.band);
      const result = await claimSlot(db.db, own, request.params.icao.toUpperCase(), band);
      if (result.ok) return reply.code(200).send(result.slots);
      switch (result.problem) {
        case 'unknown_airport':
          return reply.code(404).send({ code: 'not_found', message: 'No such airport' });
        case 'not_coordinated':
          return reply
            .code(422)
            .send({ code: 'not_coordinated', message: 'This airport is not slot-coordinated' });
        case 'invalid_band':
          return reply
            .code(400)
            .send({ code: 'invalid_band', message: 'A band is an hour of the day, 0–23' });
        case 'band_full':
          return reply
            .code(409)
            .send({ code: 'band_full', message: 'Every slot in this band is taken' });
      }
    },
  );

  /** Release a band. Idempotent — releasing one you do not hold is a no-op, not an error. */
  app.delete<{ Params: { icao: string; band: string } }>(
    '/api/airports/:icao/slots/:band',
    { onRequest: app.requireActiveAirline },
    async (request, reply) => {
      const own = resolvedAirlineOf(request);
      const band = Number(request.params.band);
      const result = await releaseSlot(db.db, own, request.params.icao.toUpperCase(), band);
      if (result.ok) return reply.code(200).send(result.slots);
      switch (result.problem) {
        case 'unknown_airport':
          return reply.code(404).send({ code: 'not_found', message: 'No such airport' });
        case 'invalid_band':
          return reply
            .code(400)
            .send({ code: 'invalid_band', message: 'A band is an hour of the day, 0–23' });
        default:
          return reply.code(404).send({ code: 'not_found', message: 'No such airport' });
      }
    },
  );
}
