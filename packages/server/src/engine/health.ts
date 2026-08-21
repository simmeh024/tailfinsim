import Fastify, { type FastifyInstance } from 'fastify';

import { readBuildInfo } from '../build-info';
import { readDeployInfo } from '../deploy-info';
import { type EnvironmentLabel } from '../env';

import { type SimulationEngine } from './simulation';

/**
 * The worker's only HTTP surface (OPS-08).
 *
 * A worker with no port at all would be simpler, and would also be a process
 * nobody can ask anything. `systemctl is-active` reports that Node is running,
 * which is not the same question as whether the engine is ticking — the admin
 * console already refuses to make that mistake in the other direction, inferring
 * world liveness from the queue rather than from a loop it cannot see.
 *
 * So: one endpoint, and everything else deliberately absent.
 *
 * ## Why this is not `buildApp`
 *
 * `app.ts` carries authentication, sessions, the admin console, the client
 * bundle and every game route. Reusing it and "just not registering some
 * plugins" would make the worker's public surface a matter of which lines
 * somebody remembered to leave out. A separate, tiny instance makes "the worker
 * serves nothing" a property of the file rather than of a configuration, and
 * `health.test.ts` asserts the route table to keep it that way.
 *
 * ## Loopback
 *
 * Bound to 127.0.0.1 by `worker.ts`. Nothing outside the box has any business
 * reading it, there is no authentication on it, and the counters it reports
 * describe the shape of the simulation. Caddy is not configured to proxy it and
 * must not be.
 */

export interface WorkerHealthOptions {
  engine: SimulationEngine;
  environmentLabel: EnvironmentLabel;
  logLevel?: string;
  /** Injected so a test can prove the database probe is what decides the status. */
  pingDatabase: () => Promise<void>;
}

export function buildWorkerHealthApp(options: WorkerHealthOptions): FastifyInstance {
  const { engine, environmentLabel, logLevel = 'info', pingDatabase } = options;

  const app = Fastify({ logger: { level: logLevel } });

  const buildInfo = readBuildInfo();
  const deployInfo = readDeployInfo();
  const startedAt = Date.now();

  app.get(
    '/healthz',
    {
      // Health checks are noise in the log once a timer polls them, exactly as
      // in the web app.
      logLevel: 'warn',
    },
    async (_request, reply) => {
      let dbState: 'up' | 'down' = 'down';
      try {
        await pingDatabase();
        dbState = 'up';
      } catch (cause) {
        app.log.error({ err: cause }, 'health check: database unreachable');
      }

      const engineState = engine.snapshot();

      /**
       * Degraded when the database is down **or** the engine is not running.
       *
       * The second half is the one that matters here. A worker process that is
       * alive with a stopped loop is the failure this endpoint exists to catch —
       * it is what `systemctl` cannot tell you, and reporting 200 for it would
       * make this endpoint exactly as useless as the "ticks: 0, errors: 0"
       * reading that means nothing has run.
       */
      const healthy = dbState === 'up' && engineState.status === 'running';

      const body = {
        status: healthy ? ('ok' as const) : ('degraded' as const),
        role: 'worker' as const,
        db: dbState,
        uptime: Math.round((Date.now() - startedAt) / 1000),
        environment: environmentLabel,
        build: buildInfo.build,
        commit: buildInfo.commit,
        ref: deployInfo?.ref ?? null,
        engine: engineState,
      };

      return reply.code(healthy ? 200 : 503).send(body);
    },
  );

  /**
   * Queue depth, per world, from the database.
   *
   * Separate from `/healthz` on purpose: this one asks Postgres a question per
   * world, and a health endpoint that a deploy script polls every second must
   * not do that. A monitor reads `/healthz`; a human — or the admin console at
   * OPS-14 — reads this.
   */
  app.get('/queues', async (_request, reply) => {
    try {
      return await reply.send({ worlds: await engine.queues() });
    } catch (cause) {
      app.log.error({ err: cause }, 'queue depth: database unreachable');
      return reply.code(503).send({ error: 'database unreachable' });
    }
  });

  return app;
}
