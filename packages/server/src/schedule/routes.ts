import { and, eq } from 'drizzle-orm';

import { CreateScheduleRequest } from '@tailfin/shared';

import { resolvedAirlineOf } from '../airline/context';
import { airframe } from '../db/schema';
import { parseRequestBody } from '../http/request-body';

import { placeLegs, resolveAuthoredLegs } from './authoring';
import { listSchedules, readSchedule } from './read';
import { createSchedule } from './store';

import type { DatabaseHandle } from '../db/client';
import type { FastifyInstance } from 'fastify';

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
export function registerScheduleRoutes(app: FastifyInstance, { db }: { db: DatabaseHandle }): void {
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
          message: 'Expected an airframe, at least one leg naming a route, and a repeat pattern',
        });
      }
      const own = resolvedAirlineOf(request);
      const { airframeId, legs, repeat } = parsed.data;

      // The aeroplane has to be the airline's. Resolved, not verified: a foreign
      // or absent airframe simply is not in the result set, and answers 404.
      const [owned] = await db.db
        .select({ id: airframe.id })
        .from(airframe)
        .where(
          and(
            eq(airframe.id, airframeId),
            eq(airframe.airlineId, own.id),
            eq(airframe.worldId, own.worldId),
          ),
        )
        .limit(1);
      if (!owned) {
        return reply.code(404).send({ code: 'not_found', message: 'No such aircraft' });
      }

      // And every leg has to name a route the airline holds.
      const resolved = await resolveAuthoredLegs(db.db, own, legs);
      if (resolved === null) {
        return reply.code(404).send({ code: 'not_found', message: 'No such route' });
      }

      const result = await createSchedule(db.db, {
        worldId: own.worldId,
        airlineId: own.id,
        airframeId,
        legs: placeLegs(resolved),
        // The wire's weekday is an unbranded 1–7; the sim's is a literal union.
        // The strict request schema has already bounded the values, so this only
        // narrows the type — the same cast `loadSchedule` makes on the way out.
        repeat:
          repeat.kind === 'weekdays'
            ? { kind: 'weekdays', days: repeat.days.map((d) => d as 1 | 2 | 3 | 4 | 5 | 6 | 7) }
            : { kind: 'daily' },
      });
      if (!result.ok) {
        // 422: the rotation cannot run, and the body names exactly why (M2-03).
        return reply.code(422).send({ problem: result.problem, detail: result.detail });
      }

      const view = await readSchedule(db.db, own, result.scheduleId);
      if (view === null) {
        // The row was just written inside the same request; its absence is a bug,
        // not a 404 for the player.
        throw new Error(`Schedule ${result.scheduleId} vanished immediately after creation`);
      }
      return reply.code(201).send({ schedule: view, warning: result.warning?.detail ?? null });
    },
  );
}
