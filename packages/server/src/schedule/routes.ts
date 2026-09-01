import {
  CreateScheduleRequest,
  EditScheduleRequest,
  SetScheduleActiveRequest,
  Uuid,
} from '@tailfin/shared';

import { resolvedAirlineOf } from '../airline/context';
import { parseRequestBody } from '../http/request-body';

import {
  authorSchedule,
  editSchedule,
  pauseSchedule,
  removeSchedule,
  type RouteEconomicsProvider,
} from './authoring';
import { listSchedules } from './read';

import type { DatabaseHandle } from '../db/client';
import type { FastifyInstance } from 'fastify';

/** A leg refusal that names an airport that does not exist is a 404; the rest are 422. */
function refusalStatus(problem: string): 404 | 422 {
  return problem === 'unknown_airport' ? 404 : 422;
}

/**
 * The schedule API (M2-03, §8.2).
 *
 * The seam that was missing: `schedule/store.ts` has known how to validate and
 * write a rotation since M2-03, and `@tailfin/sim` how to materialise one, but
 * nothing let a *player* author one — the network page's schedule surface has
 * been mock until now. This wires the two together.
 *
 * Owner-scoped like the route endpoints: the airline is resolved from the
 * session, the airframe and every route are resolved *within* it, and anything
 * that is not the caller's is a 404 rather than an oracle. `requireActiveAirline`
 * to author one, because a schedule commits an aeroplane; `requireAirline` to
 * read them back.
 */
export function registerScheduleRoutes(
  app: FastifyInstance,
  { db, economicsFor }: { db: DatabaseHandle; economicsFor: RouteEconomicsProvider },
): void {
  app.get('/api/schedules', { onRequest: app.requireAirline }, async (request, reply) => {
    const own = resolvedAirlineOf(request);
    return reply.code(200).send({ schedules: await listSchedules(db.db, own) });
  });

  app.post<{ Body: unknown }>(
    '/api/schedules',
    { onRequest: app.requireActiveAirline },
    async (request, reply) => {
      const parsed = parseRequestBody(request, CreateScheduleRequest);
      if (!parsed.success) {
        return reply.code(400).send({
          code: 'invalid_input',
          message: 'Expected an airframe, at least one leg of airport pairs, and a repeat pattern',
        });
      }
      const own = resolvedAirlineOf(request);
      const result = await authorSchedule(db.db, own, parsed.data, economicsFor);

      switch (result.status) {
        case 'unknown_airframe':
          return reply.code(404).send({ code: 'not_found', message: 'No such aircraft' });
        case 'refused':
          // The rotation cannot run: an airport that does not exist is a 404, a leg
          // the aircraft cannot fly (or that does not close) is a 422 — the body
          // names exactly why (M2-03, App. B.4).
          return reply
            .code(refusalStatus(result.problem))
            .send({ problem: result.problem, detail: result.detail });
        case 'created':
          return reply
            .code(201)
            .send({ schedule: result.schedule, warning: result.warning, cost: result.cost });
      }
    },
  );

  /**
   * Replace a rotation's legs and repeat. Only future, unflown flights move; the
   * airframe is not editable here (a schedule is one airframe's rotation).
   */
  app.put<{ Params: { id: string }; Body: unknown }>(
    '/api/schedules/:id',
    { onRequest: app.requireActiveAirline },
    async (request, reply) => {
      if (!Uuid.safeParse(request.params.id).success) {
        return reply.code(404).send({ code: 'not_found', message: 'No such schedule' });
      }
      const parsed = parseRequestBody(request, EditScheduleRequest);
      if (!parsed.success) {
        return reply.code(400).send({
          code: 'invalid_input',
          message: 'Expected at least one leg of airport pairs, and a repeat pattern',
        });
      }
      const own = resolvedAirlineOf(request);
      const result = await editSchedule(db.db, own, request.params.id, parsed.data, economicsFor);

      switch (result.status) {
        case 'not_found':
          return reply.code(404).send({ code: 'not_found', message: 'No such schedule' });
        case 'refused':
          return reply
            .code(refusalStatus(result.problem))
            .send({ problem: result.problem, detail: result.detail });
        case 'updated':
          return reply
            .code(200)
            .send({ schedule: result.schedule, warning: null, cost: result.cost });
      }
    },
  );

  /** Pause a rotation, or resume it — it stops (or resumes) being materialised. */
  app.put<{ Params: { id: string }; Body: unknown }>(
    '/api/schedules/:id/active',
    { onRequest: app.requireActiveAirline },
    async (request, reply) => {
      if (!Uuid.safeParse(request.params.id).success) {
        return reply.code(404).send({ code: 'not_found', message: 'No such schedule' });
      }
      const parsed = parseRequestBody(request, SetScheduleActiveRequest);
      if (!parsed.success) {
        return reply.code(400).send({ code: 'invalid_input', message: 'Expected an active flag' });
      }
      const own = resolvedAirlineOf(request);
      const view = await pauseSchedule(db.db, own, request.params.id, parsed.data.active);
      if (view === null) {
        return reply.code(404).send({ code: 'not_found', message: 'No such schedule' });
      }
      return reply.code(200).send({ schedule: view, warning: null });
    },
  );

  /** Delete a rotation and cancel its future, unflown flights. */
  app.delete<{ Params: { id: string } }>(
    '/api/schedules/:id',
    { onRequest: app.requireActiveAirline },
    async (request, reply) => {
      if (!Uuid.safeParse(request.params.id).success) {
        return reply.code(404).send({ code: 'not_found', message: 'No such schedule' });
      }
      const own = resolvedAirlineOf(request);
      const removed = await removeSchedule(db.db, own, request.params.id);
      if (!removed) {
        return reply.code(404).send({ code: 'not_found', message: 'No such schedule' });
      }
      return reply.code(200).send({ ok: true });
    },
  );
}
