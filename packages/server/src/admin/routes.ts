import {
  adminAuditResponseJsonSchema,
  adminCreateEconomyConfigResponseJsonSchema,
  adminCreateWorldResponseJsonSchema,
  adminEconomyConfigDetailResponseJsonSchema,
  adminEconomyConfigListResponseJsonSchema,
  adminNpcResponseJsonSchema,
  adminPinEconomyConfigResponseJsonSchema,
  adminListResponseJsonSchema,
  adminOverviewResponseJsonSchema,
  adminPlayerDetailResponseJsonSchema,
  adminPlayerListResponseJsonSchema,
  adminResetWorldResponseJsonSchema,
  ECONOMY_CONFIG_V1_VERSION,
  adminSpeedChangeResponseJsonSchema,
  adminWorldStatusResponseJsonSchema,
  adminSystemHealthResponseJsonSchema,
  adminWorldHealthResponseJsonSchema,
  adminWorldListResponseJsonSchema,
  apiErrorJsonSchema,
  revokeSessionsResponseJsonSchema,
  Uuid,
} from '@tailfin/shared';

import { revokePlayerSessions } from '../auth/revocation';
import { type DatabaseHandle } from '../db/client';
import { economyChecksum, ECONOMY_CONFIG_V1 } from '../economy/config';
import { economyConfigVersionExists } from '../economy/loader';
import { ensureEconomyConfigSeeded } from '../economy/seed';
import {
  createEconomyConfigVersion,
  type CreateEconomyRefusalCode,
  listEconomyConfigVersions,
  type PinEconomyRefusalCode,
  pinWorldEconomyConfig,
  readEconomyConfigVersion,
  validateCreateRequest,
  validatePinRequest,
} from '../economy/versions';

import { parseAuditJson, readAudit } from './audit';
import { type Actor, listAdmins } from './grants';
import { BEHIND_AFTER_MS, buildWorldHealth } from './health';
import {
  changeWorldStatus,
  type LifecycleRefusalCode,
  resetWorldAsAdmin,
  validateResetRequest,
  validateStatusRequest,
} from './lifecycle';
import { buildNpcReport } from './npc';
import { buildOverview } from './overview';
import { listPlayers, readPlayer } from './players';
import { changeWorldSpeed, type SpeedRefusalCode, validateSpeedRequest } from './speed';
import { buildSystemHealth, NODE_OFFLINE_AFTER_MS, NODE_STALE_AFTER_MS } from './system-health';
import {
  constraintFailure,
  countWorldContents,
  createWorldAsAdmin,
  listWorlds,
  summariseWorld,
  validateWorldConfig,
} from './worlds';

import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * The admin API (M1A-01 to M1A-03, §22).
 *
 * Everything readable, plus two things that write: creating a world, and
 * changing the speed of one. Resetting is M1A-04 and needs confirmation
 * semantics of its own. The three are in ascending order of consequence —
 * creating a world in `staging` affects nobody until it is opened, changing a
 * speed alters how fast a live world runs, and a reset destroys it.
 *
 * Every route here carries `requireAdmin`. That is the security boundary; the
 * link the interface shows is not. Every mutating route writes its audit row in
 * the same transaction as its change.
 */

export interface AdminRoutesOptions {
  db: DatabaseHandle;
}

/**
 * Who is doing this, for the audit row.
 *
 * `requireAdmin` has already established there is a player, so the fallbacks
 * exist to keep the types honest rather than because they can happen. The label
 * is captured at the time of the action, so the entry stays readable even after
 * the account is renamed or anonymised (§22.10).
 */
function actorOf(request: FastifyRequest): Actor {
  return {
    playerId: request.player?.id ?? null,
    label: request.player?.displayName ?? 'unknown admin',
    requestId: request.id,
  };
}

export function registerAdminRoutes(app: FastifyInstance, { db }: AdminRoutesOptions): void {
  app.get(
    '/api/admin/overview',
    {
      onRequest: app.requireAdmin,
      schema: { response: { 200: adminOverviewResponseJsonSchema } },
    },
    async (_request, reply) => reply.code(200).send(await buildOverview(db.db)),
  );

  app.get<{ Querystring: { includeViews?: string } }>(
    '/api/admin/audit',
    {
      onRequest: app.requireAdmin,
      schema: { response: { 200: adminAuditResponseJsonSchema } },
    },
    async (request, reply) => {
      // Views are left out unless asked for. Opening a player's account is
      // recorded (M1A-08), but those rows would outnumber every change and bury
      // the entries the log is read for.
      const includeViews = request.query.includeViews === 'true';
      const rows = await readAudit(db.db, { limit: 100, includeViews });
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

  // ----------------------------------------------------------------- players

  app.get<{ Querystring: { q?: string; limit?: string; offset?: string } }>(
    '/api/admin/players',
    {
      onRequest: app.requireAdmin,
      schema: { response: { 200: adminPlayerListResponseJsonSchema } },
    },
    async (request, reply) => {
      // Not audited. A search returning a page of names is not a view of a
      // person's record — the detail route below is, and that one is recorded.
      const page = await listPlayers(db.db, {
        query: request.query.q,
        limit: request.query.limit === undefined ? undefined : Number(request.query.limit),
        offset: request.query.offset === undefined ? undefined : Number(request.query.offset),
      });
      return reply.code(200).send(page);
    },
  );

  app.get<{ Params: { playerId: string } }>(
    '/api/admin/players/:playerId',
    {
      onRequest: app.requireAdmin,
      schema: {
        response: { 200: adminPlayerDetailResponseJsonSchema, 404: apiErrorJsonSchema },
      },
    },
    async (request, reply) => {
      if (!Uuid.safeParse(request.params.playerId).success) {
        return reply
          .code(404)
          .send({ code: 'player_not_found', message: 'No player with that id.' });
      }

      // A GET that writes, deliberately: this discloses somebody's identities,
      // email address and sessions, and §22.1 asks for a record of every admin
      // action. The row is written in the same transaction as the read, so the
      // disclosure and the record cannot come apart.
      const detail = await readPlayer(db.db, request.params.playerId, actorOf(request));
      if (!detail) {
        return reply
          .code(404)
          .send({ code: 'player_not_found', message: 'No player with that id.' });
      }

      return reply.code(200).send({ player: detail });
    },
  );

  app.post<{ Params: { playerId: string } }>(
    '/api/admin/players/:playerId/sessions/revoke',
    {
      onRequest: app.requireAdmin,
      schema: {
        response: { 200: revokeSessionsResponseJsonSchema, 404: apiErrorJsonSchema },
      },
    },
    async (request, reply) => {
      if (!Uuid.safeParse(request.params.playerId).success) {
        return reply
          .code(404)
          .send({ code: 'player_not_found', message: 'No player with that id.' });
      }

      const revokedSessions = await revokePlayerSessions(
        db.db,
        request.params.playerId,
        actorOf(request),
      );
      if (revokedSessions === null) {
        return reply
          .code(404)
          .send({ code: 'player_not_found', message: 'No player with that id.' });
      }
      return reply.code(200).send({ signedOut: true, revokedSessions });
    },
  );

  // ------------------------------------------------------------------ worlds

  /**
   * Declared before `/worlds/:worldId/...` so there is no chance of `health`
   * being read as a world id. Fastify's router would not confuse them, but the
   * ordering costs nothing and removes the question.
   */
  app.get(
    '/api/admin/worlds/health',
    {
      onRequest: app.requireAdmin,
      schema: { response: { 200: adminWorldHealthResponseJsonSchema } },
    },
    async (_request, reply) => {
      const report = await buildWorldHealth(db.db);
      return reply.code(200).send({
        worlds: report.worlds,
        datasets: report.datasets,
        serverTime: report.serverTime.toISOString(),
        behindAfterMs: BEHIND_AFTER_MS,
      });
    },
  );

  /**
   * The machines, rather than the worlds (OPS-15).
   *
   * Read from `node_heartbeat`, never by reaching for another host: the console
   * cannot open a connection to the worker and must not be able to. See
   * `ops/heartbeat.ts` for why the direction of trust runs this way.
   */
  app.get(
    '/api/admin/system-health',
    {
      onRequest: app.requireAdmin,
      schema: { response: { 200: adminSystemHealthResponseJsonSchema } },
    },
    async (_request, reply) => {
      const report = await buildSystemHealth(db.db);
      return reply.code(200).send({
        nodes: report.nodes,
        serverTime: report.serverTime.toISOString(),
        staleAfterMs: NODE_STALE_AFTER_MS,
        offlineAfterMs: NODE_OFFLINE_AFTER_MS,
        alerts: report.alerts,
      });
    },
  );

  app.get(
    '/api/admin/worlds',
    {
      onRequest: app.requireAdmin,
      schema: { response: { 200: adminWorldListResponseJsonSchema } },
    },
    async (_request, reply) => reply.code(200).send({ worlds: await listWorlds(db.db) }),
  );

  app.post(
    '/api/admin/worlds',
    {
      onRequest: app.requireAdmin,
      schema: {
        response: {
          201: adminCreateWorldResponseJsonSchema,
          400: apiErrorJsonSchema,
          409: apiErrorJsonSchema,
        },
      },
    },
    async (request, reply) => {
      const now = new Date();
      const validated = await validateWorldConfig(request.body, now, async (version) => {
        // Validation runs before `createWorld`, so the shipped version has to be
        // there by now or a freshly migrated database refuses its first world
        // with a field error. Memoised and insert-only; see `economy/seed.ts`.
        await ensureEconomyConfigSeeded(db.db);
        return economyConfigVersionExists(db.db, version);
      });
      if (!validated.ok) {
        return reply.code(400).send({
          code: 'invalid_world',
          message: 'This world cannot be created as described.',
          fields: validated.fields,
        });
      }

      try {
        const result = await createWorldAsAdmin(db.db, validated.config, actorOf(request), now);

        if (!result.created) {
          // 409, not 400: nothing about the request is malformed, the world is
          // simply already there. A form can say so against the name field.
          return reply.code(409).send({
            code: 'world_exists',
            message: `A world called "${validated.config.name}" already exists.`,
            fields: {
              name: [
                'A world with this name already exists. Pick another, or reset the one there.',
              ],
            },
          });
        }

        return reply.code(201).send({ world: summariseWorld(result.world, now) });
      } catch (error) {
        // The schema's checks are the backstop under the validation above, and
        // they can still fire — two admins submitting the same name at once, or
        // a rule the database knows that this code has forgotten. Translated
        // rather than leaked: a constraint name is not a sentence.
        const refusal = constraintFailure(error);
        if (!refusal) throw error;
        request.log.warn({ err: error }, 'world creation refused by a database constraint');
        return reply.code(400).send({
          code: 'invalid_world',
          message: 'This world cannot be created as described.',
          fields: refusal.fields,
        });
      }
    },
  );

  /**
   * The status each refusal deserves.
   *
   * A malformed speed is the request's fault (400). A world that is archived, or
   * that somebody else has already changed, is a conflict with the world's state
   * rather than a bad request (409) — the same message sent a minute earlier
   * would have worked. "Already at that speed" sits with the 400s because the
   * value submitted is the thing that has to change.
   */
  const SPEED_REFUSAL_STATUS: Record<SpeedRefusalCode, number> = {
    invalid_speed: 400,
    speed_unchanged: 400,
    world_not_found: 404,
    world_archived: 409,
    speed_stale: 409,
  };

  app.post<{ Params: { worldId: string } }>(
    '/api/admin/worlds/:worldId/speed',
    {
      onRequest: app.requireAdmin,
      schema: {
        response: {
          200: adminSpeedChangeResponseJsonSchema,
          400: apiErrorJsonSchema,
          404: apiErrorJsonSchema,
          409: apiErrorJsonSchema,
        },
      },
    },
    async (request, reply) => {
      // Checked here rather than left to Postgres: a non-uuid id makes the
      // driver raise a type error, which would surface as a 500 for what is
      // plainly a request for a world that does not exist.
      if (!Uuid.safeParse(request.params.worldId).success) {
        return reply.code(404).send({ code: 'world_not_found', message: 'No world with that id.' });
      }

      const validated = validateSpeedRequest(request.body);
      if (!validated.ok) {
        return reply.code(SPEED_REFUSAL_STATUS[validated.code]).send({
          code: validated.code,
          message: validated.message,
          fields: validated.fields,
        });
      }

      const outcome = await changeWorldSpeed(
        db.db,
        request.params.worldId,
        validated.request,
        actorOf(request),
      );

      if (!outcome.ok) {
        return reply.code(SPEED_REFUSAL_STATUS[outcome.code]).send({
          code: outcome.code,
          message: outcome.message,
          fields: outcome.fields,
        });
      }

      request.log.info(
        {
          worldId: outcome.world.id,
          from: outcome.before.speedMultiplier,
          to: outcome.after.speedMultiplier,
          pendingEvents: outcome.pendingEvents,
          driftMs: outcome.driftMs,
        },
        'world speed changed',
      );

      return reply.code(200).send({
        // The queue count is already known from inside the transaction, so it is
        // passed rather than queried again — and it is the count as of the
        // change, which is what the response is describing. A speed change
        // cannot touch airlines, so that one is read fresh.
        world: summariseWorld(outcome.world, new Date(), {
          pendingEvents: outcome.pendingEvents,
          airlines: (await countWorldContents(db.db)).get(outcome.world.id)?.airlines ?? 0,
        }),
        before: outcome.before,
        after: outcome.after,
        pendingEvents: outcome.pendingEvents,
        driftMs: outcome.driftMs,
      });
    },
  );

  // ------------------------------------------------------- lifecycle (M1A-04)

  /**
   * The status each lifecycle refusal deserves.
   *
   * The split is the same as the speed route's: a malformed or wrong *value* is
   * the request's fault, and a world that has moved on, or that cannot go where
   * it is being sent, is a conflict with the world's state. A mistyped
   * confirmation name is 400 — the thing to change is what was typed.
   */
  const LIFECYCLE_REFUSAL_STATUS: Record<LifecycleRefusalCode, number> = {
    invalid_request: 400,
    name_mismatch: 400,
    world_not_found: 404,
    status_stale: 409,
    illegal_transition: 409,
    status_unchanged: 409,
    world_archived: 409,
  };

  /** A world id that is not a uuid is a world that does not exist, not a 500. */
  function missingWorld(worldId: string): boolean {
    return !Uuid.safeParse(worldId).success;
  }

  app.post<{ Params: { worldId: string } }>(
    '/api/admin/worlds/:worldId/status',
    {
      onRequest: app.requireAdmin,
      schema: {
        response: {
          200: adminWorldStatusResponseJsonSchema,
          400: apiErrorJsonSchema,
          404: apiErrorJsonSchema,
          409: apiErrorJsonSchema,
        },
      },
    },
    async (request, reply) => {
      if (missingWorld(request.params.worldId)) {
        return reply.code(404).send({ code: 'world_not_found', message: 'No world with that id.' });
      }

      const validated = validateStatusRequest(request.body);
      if (!validated.ok) {
        return reply.code(LIFECYCLE_REFUSAL_STATUS[validated.code]).send({
          code: validated.code,
          message: validated.message,
          fields: validated.fields,
        });
      }

      const outcome = await changeWorldStatus(
        db.db,
        request.params.worldId,
        validated.request,
        actorOf(request),
      );

      if (!outcome.ok) {
        return reply.code(LIFECYCLE_REFUSAL_STATUS[outcome.code]).send({
          code: outcome.code,
          message: outcome.message,
          fields: outcome.fields,
        });
      }

      request.log.info(
        { worldId: outcome.world.id, from: outcome.before, to: outcome.after },
        'world status changed',
      );

      const contents = (await countWorldContents(db.db)).get(outcome.world.id);
      return reply.code(200).send({
        world: summariseWorld(outcome.world, new Date(), contents),
        before: outcome.before,
        after: outcome.after,
      });
    },
  );

  app.post<{ Params: { worldId: string } }>(
    '/api/admin/worlds/:worldId/reset',
    {
      onRequest: app.requireAdmin,
      schema: {
        response: {
          200: adminResetWorldResponseJsonSchema,
          400: apiErrorJsonSchema,
          404: apiErrorJsonSchema,
          409: apiErrorJsonSchema,
        },
      },
    },
    async (request, reply) => {
      if (missingWorld(request.params.worldId)) {
        return reply.code(404).send({ code: 'world_not_found', message: 'No world with that id.' });
      }

      const validated = validateResetRequest(request.body);
      if (!validated.ok) {
        return reply.code(LIFECYCLE_REFUSAL_STATUS[validated.code]).send({
          code: validated.code,
          message: validated.message,
          fields: validated.fields,
        });
      }

      const outcome = await resetWorldAsAdmin(
        db.db,
        request.params.worldId,
        validated.request,
        actorOf(request),
      );

      if (!outcome.ok) {
        return reply.code(LIFECYCLE_REFUSAL_STATUS[outcome.code]).send({
          code: outcome.code,
          message: outcome.message,
          fields: outcome.fields,
        });
      }

      // `warn`, not `info`. This is the most destructive thing the console can
      // do, and the server log should carry it at a level somebody greps for.
      request.log.warn(
        {
          worldId: outcome.world.id,
          airlinesDestroyed: outcome.destroyed.airlines,
          eventsDestroyed: outcome.destroyed.events,
          reason: outcome.reason,
        },
        'world reset',
      );

      return reply.code(200).send({
        // Counted as zero rather than queried: the reset just deleted both, in
        // the transaction that has already committed.
        world: summariseWorld(outcome.world, new Date()),
        destroyed: outcome.destroyed,
        inGameDate: outcome.inGameDate.toISOString(),
        reason: outcome.reason,
      });
    },
  );

  // ------------------------------------------------- economy config (M3-11)

  /**
   * The status each economy refusal deserves.
   *
   * Same split as the speed and lifecycle routes. A malformed payload or a name
   * that is already taken is the request's fault; a world that has moved on
   * since the admin was shown it is a conflict with the world's state.
   *
   * Two tables rather than one, each total over the codes its own route can
   * actually produce. A single shared table would keep type-checking after a
   * code moved to the other route, which is exactly when a status goes wrong.
   */
  const ECONOMY_CREATE_STATUS: Record<CreateEconomyRefusalCode, 400 | 409> = {
    invalid_request: 400,
    invalid_payload: 400,
    // Not 400: nothing about the request is malformed, the version is simply
    // already taken — and it can never be overwritten, so this is a conflict.
    version_exists: 409,
    unknown_parent: 400,
  };

  const ECONOMY_PIN_STATUS: Record<PinEconomyRefusalCode, 400 | 404 | 409> = {
    invalid_request: 400,
    unknown_version: 400,
    world_not_found: 404,
    world_archived: 409,
    version_stale: 409,
    version_unchanged: 409,
  };

  app.get(
    '/api/admin/economy-config',
    {
      onRequest: app.requireAdmin,
      schema: { response: { 200: adminEconomyConfigListResponseJsonSchema } },
    },
    async (_request, reply) => {
      const versions = await listEconomyConfigVersions(db.db);
      const shipped = versions.find((v) => v.version === ECONOMY_CONFIG_V1_VERSION);

      return reply.code(200).send({
        versions,
        shippedVersion: ECONOMY_CONFIG_V1_VERSION,
        // Compared by checksum rather than by re-reading the payload: the row is
        // stored in canonical form, so this is an exact answer to "is the
        // database's economy still the one this build ships?". A `false` is not
        // an error — the database wins — but it is worth saying out loud.
        shippedMatchesStored: shipped?.checksum === economyChecksum(ECONOMY_CONFIG_V1),
      });
    },
  );

  app.get<{ Params: { version: string } }>(
    '/api/admin/economy-config/:version',
    {
      onRequest: app.requireAdmin,
      schema: {
        response: {
          200: adminEconomyConfigDetailResponseJsonSchema,
          404: apiErrorJsonSchema,
        },
      },
    },
    async (request, reply) => {
      const detail = await readEconomyConfigVersion(db.db, request.params.version);
      if (!detail) {
        return reply.code(404).send({
          code: 'economy_config_not_found',
          message: 'No economy config version by that name.',
        });
      }
      return reply.code(200).send(detail);
    },
  );

  /**
   * Create a version. Changes nothing on its own.
   *
   * A world has to be pinned to it, which is the route below and a separately
   * audited act. That separation is §22.3's promotion path: a retune can be
   * written, diffed and reviewed while every world carries on running what it
   * was already running.
   */
  app.post(
    '/api/admin/economy-config',
    {
      onRequest: app.requireAdmin,
      schema: {
        response: {
          201: adminCreateEconomyConfigResponseJsonSchema,
          400: apiErrorJsonSchema,
          409: apiErrorJsonSchema,
        },
      },
    },
    async (request, reply) => {
      const validated = validateCreateRequest(request.body);
      if (!validated.ok) {
        return reply.code(ECONOMY_CREATE_STATUS[validated.code]).send({
          code: validated.code,
          message: validated.message,
          fields: validated.fields,
        });
      }

      const outcome = await createEconomyConfigVersion(db.db, validated, actorOf(request));
      if (!outcome.ok) {
        return reply.code(ECONOMY_CREATE_STATUS[outcome.code]).send({
          code: outcome.code,
          message: outcome.message,
          fields: outcome.fields,
        });
      }

      request.log.info(
        {
          version: outcome.summary.version,
          parentVersion: outcome.summary.parentVersion,
          changes: outcome.diff.length,
        },
        'economy config version created',
      );

      return reply.code(201).send({ summary: outcome.summary, diff: outcome.diff });
    },
  );

  app.post<{ Params: { worldId: string } }>(
    '/api/admin/worlds/:worldId/economy-config',
    {
      onRequest: app.requireAdmin,
      schema: {
        response: {
          200: adminPinEconomyConfigResponseJsonSchema,
          400: apiErrorJsonSchema,
          404: apiErrorJsonSchema,
          409: apiErrorJsonSchema,
        },
      },
    },
    async (request, reply) => {
      if (missingWorld(request.params.worldId)) {
        return reply.code(404).send({ code: 'world_not_found', message: 'No world with that id.' });
      }

      const validated = validatePinRequest(request.body);
      if (!validated.ok) {
        return reply.code(ECONOMY_PIN_STATUS[validated.code]).send({
          code: validated.code,
          message: validated.message,
          fields: validated.fields,
        });
      }

      const outcome = await pinWorldEconomyConfig(
        db.db,
        request.params.worldId,
        validated.request,
        actorOf(request),
      );

      if (!outcome.ok) {
        return reply.code(ECONOMY_PIN_STATUS[outcome.code]).send({
          code: outcome.code,
          message: outcome.message,
          fields: outcome.fields,
        });
      }

      // `warn`, not `info`: this changes what every future flight in a live
      // world is priced with, and the server log should carry it at a level
      // somebody greps for.
      request.log.warn(
        {
          worldId: outcome.worldId,
          from: outcome.before,
          to: outcome.after,
          changes: outcome.diff.length,
          pendingEvents: outcome.pendingEvents,
        },
        'world economy config pinned',
      );

      return reply.code(200).send({
        worldId: outcome.worldId,
        worldName: outcome.worldName,
        before: outcome.before,
        after: outcome.after,
        diff: outcome.diff,
        pendingEvents: outcome.pendingEvents,
      });
    },
  );

  /**
   * NPC carriers and their decisions (M3-12).
   *
   * Scoped to one world because NPCs are: a carrier belongs to a world and
   * competes in that world's markets, and a cross-world listing would be a list
   * of things that never meet.
   */
  app.get<{ Params: { worldId: string } }>(
    '/api/admin/worlds/:worldId/npc',
    {
      onRequest: app.requireAdmin,
      schema: {
        response: { 200: adminNpcResponseJsonSchema, 404: apiErrorJsonSchema },
      },
    },
    async (request, reply) => {
      if (missingWorld(request.params.worldId)) {
        return reply.code(404).send({ code: 'world_not_found', message: 'No world with that id.' });
      }
      return reply.code(200).send(await buildNpcReport(db.db, request.params.worldId));
    },
  );
}
