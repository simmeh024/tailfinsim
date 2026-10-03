import {
  apiErrorJsonSchema,
  researchResponseJsonSchema,
  ResearchNodeId,
  SetDoctrineFundingInput,
  StartResearchInput,
  type ResearchRefusal,
} from '@tailfin/shared';

import { resolvedAirlineOf } from '../airline/context';
import { loadWorldEconomyConfig } from '../economy/loader';
import { parseRequestBody } from '../http/request-body';
import { worldGameNow } from '../world/game-now';

import { setDoctrineFunding } from './doctrine';
import { readResearch, startResearch } from './store';

import type { DatabaseHandle } from '../db/client';
import type { FastifyInstance, FastifyReply } from 'fastify';

/**
 * §10.3's research tree API (M9-05).
 *
 * `requireAirline` to look; `requireActiveAirline` to start, because a project
 * spends cash and points that cannot be refunded — the same split the academy
 * routes draw.
 *
 * ## No resource id, and the node is not one
 *
 * Neither route takes an id from the path, and no handler accepts an
 * `airlineId`: the airline comes from the session and every query is scoped by
 * it. The body's `nodeId` is a **selector over the fixed catalogue** — one of
 * §10.3's 24 nodes, validated by `StartResearchInput` — and names nothing a
 * player owns, so there is no cross-owner case to conceal. Another airline's
 * progress on the same node is simply not in the query.
 *
 * ## Funding doctrine (M9-06)
 *
 * `PUT /api/research/projects/:nodeId/funding` is the one route with a path
 * parameter, and the resource it names **is** owned: this airline's project on
 * that node. So it is concealed the ADR-0020 way — a malformed node id, a node
 * this airline never researched and another airline's progress on the same node
 * all receive the identical `404 project_absent`, because the query is scoped by
 * the session's airline and nothing else. It moves no research points and buys
 * none: stopping funding saves upkeep and lets the doctrine lapse, resuming
 * costs upkeep and lets it recover.
 *
 * ## What is deliberately absent
 *
 * There is **no** route that buys research points, grants them, or shortens a
 * project. §10.3: *"You cannot buy RP. You cannot rush it."* The strongest form
 * of that rule is that the route table has nowhere to express either — and
 * `no-purchase.test.ts` holds the table to it.
 */

const MESSAGES: Record<ResearchRefusal, string> = {
  academy_level: 'This tier needs a higher academy level',
  prerequisite: 'Research the tier below in this branch first',
  not_released: 'This tier is not available yet',
  already_complete: 'This doctrine is already researched',
  already_in_progress: 'This doctrine is already being researched',
  project_running: 'Another research project is running',
  insufficient_points: 'Not enough research points',
  insufficient_funds: 'The airline cannot afford this',
};

/**
 * Every refusal describes known state and is a `409` — there is no id here to
 * conceal. The body is the house shape, `{ code, message }`, with the closed
 * `ResearchRefusal` code in `code`, exactly as the academy and roster routes
 * send theirs.
 */
function sendRefusal(reply: FastifyReply, refusal: ResearchRefusal) {
  return reply.code(409).send({ code: refusal, message: MESSAGES[refusal] });
}

/** One body for every node this airline has no project on. ADR-0020. */
const PROJECT_ABSENT = { code: 'project_absent', message: 'No such research project' } as const;

export function registerResearchRoutes(app: FastifyInstance, { db }: { db: DatabaseHandle }): void {
  app.get(
    '/api/research',
    {
      onRequest: app.requireAirline,
      schema: { response: { 200: researchResponseJsonSchema } },
    },
    async (request, reply) => {
      const own = resolvedAirlineOf(request);
      return reply
        .code(200)
        .send(await readResearch(db.db, { worldId: own.worldId, airlineId: own.id }));
    },
  );

  app.post<{ Body: unknown }>(
    '/api/research/projects',
    {
      onRequest: app.requireActiveAirline,
      schema: {
        response: {
          200: researchResponseJsonSchema,
          400: apiErrorJsonSchema,
          409: apiErrorJsonSchema,
        },
      },
    },
    async (request, reply) => {
      const parsed = parseRequestBody(request, StartResearchInput);
      if (!parsed.success) {
        return reply.code(400).send({ code: 'invalid_input', message: 'Expected a research node' });
      }
      const own = resolvedAirlineOf(request);
      const scope = { worldId: own.worldId, airlineId: own.id };
      const result = await startResearch(db.db, scope, parsed.data.nodeId);
      if (!result.ok) return sendRefusal(reply, result.refusal);
      // The whole tree back: a start changes the points, the purse, the running
      // project and every other node's verdict at once.
      return reply.code(200).send(await readResearch(db.db, scope));
    },
  );

  app.put<{ Params: { nodeId: string }; Body: unknown }>(
    '/api/research/projects/:nodeId/funding',
    {
      onRequest: app.requireActiveAirline,
      schema: {
        response: {
          200: researchResponseJsonSchema,
          400: apiErrorJsonSchema,
          404: apiErrorJsonSchema,
          409: apiErrorJsonSchema,
        },
      },
    },
    async (request, reply) => {
      // The id first: a malformed one is the same 404 as an absent one, whatever
      // the body says.
      const node = ResearchNodeId.safeParse(request.params.nodeId);
      if (!node.success) return reply.code(404).send(PROJECT_ABSENT);
      const parsed = parseRequestBody(request, SetDoctrineFundingInput);
      if (!parsed.success) {
        return reply.code(400).send({ code: 'invalid_input', message: 'Expected { funded }' });
      }

      const own = resolvedAirlineOf(request);
      const scope = { worldId: own.worldId, airlineId: own.id };
      const economy = await loadWorldEconomyConfig(db.db, own.worldId);
      const result = await setDoctrineFunding(
        db.db,
        scope,
        node.data,
        parsed.data.funded,
        await worldGameNow(db.db, own.worldId),
        economy.research,
      );
      if (!result.ok) {
        return result.kind === 'absent'
          ? reply.code(404).send(PROJECT_ABSENT)
          : reply.code(409).send({
              code: 'not_complete',
              message: 'This doctrine is still being researched',
            });
      }
      return reply.code(200).send(await readResearch(db.db, scope));
    },
  );
}
