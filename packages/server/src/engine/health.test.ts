import { describe, expect, it } from 'vitest';

import { type Database } from '../db/client';

import { buildWorkerHealthApp } from './health';
import { createSimulationEngine, type SimulationEngine } from './simulation';

/**
 * The worker's health endpoint.
 *
 * Two things are being proved. The first is the judgement: a worker process that
 * is alive with a stopped engine must not answer 200, because that is the exact
 * failure `systemctl is-active` cannot see and the whole reason this endpoint
 * exists. The second is the absence: the worker serves nothing else, and the
 * route table is asserted so that stays true by test rather than by intention.
 */

const db = {} as Database;

function engineWith(options: { running: boolean } = { running: false }): SimulationEngine {
  const engine = createSimulationEngine({
    db,
    handlers: {},
    listWorlds: () => Promise.resolve([]),
    drain: () => Promise.resolve({ processed: 0, failed: 0, unsupported: 0, upTo: new Date() }),
    // Never fires: the loop schedules its next run through this and the test
    // never calls it back, so exactly one tick happens.
    setTimer: () => 1,
    clearTimer: () => undefined,
  });
  if (options.running) engine.start();
  return engine;
}

function build(options: {
  engine: SimulationEngine;
  dbUp?: boolean;
}): ReturnType<typeof buildWorkerHealthApp> {
  return buildWorkerHealthApp({
    engine: options.engine,
    environmentLabel: 'dev',
    logLevel: 'silent',
    pingDatabase: () =>
      options.dbUp === false
        ? Promise.reject(new Error('connection refused'))
        : Promise.resolve(undefined),
  });
}

describe('the worker health endpoint', () => {
  it('is ok when the engine is running and the database answers', async () => {
    const engine = engineWith({ running: true });
    const app = build({ engine });

    const response = await app.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ status: string; role: string; db: string }>();
    expect(body.status).toBe('ok');
    // The role is in the payload so a monitor pointed at the wrong port finds
    // out from the answer rather than from the port number.
    expect(body.role).toBe('worker');
    expect(body.db).toBe('up');

    await engine.stop();
    await app.close();
  });

  it('is degraded — and 503 — when the process is up but the engine is not', async () => {
    const app = build({ engine: engineWith({ running: false }) });

    const response = await app.inject({ method: 'GET', url: '/healthz' });

    // The failure this endpoint exists for. `systemctl` would call this process
    // active; nothing is ticking.
    expect(response.statusCode).toBe(503);
    const body = response.json<{ status: string; engine: { status: string } }>();
    expect(body.status).toBe('degraded');
    expect(body.engine.status).toBe('stopped');
  });

  it('still answers, with the engine state, when the database is unreachable', async () => {
    const engine = engineWith({ running: true });
    const app = build({ engine, dbUp: false });

    const response = await app.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(503);
    const body = response.json<{ db: string; engine: { status: string; ticks: number } }>();
    // "The engine is up and Postgres is not" is a state somebody needs telling
    // about, so the counters have to survive the database being gone.
    expect(body.db).toBe('down');
    expect(body.engine.status).toBe('running');

    await engine.stop();
    await app.close();
  });

  it('carries the event types it cannot handle, rather than leaving them to be discovered', async () => {
    const app = build({ engine: engineWith() });

    const response = await app.inject({ method: 'GET', url: '/healthz' });
    const body = response.json<{ engine: { unhandledEventTypes: string[] } }>();

    expect(body.engine.unhandledEventTypes).toContain('FLIGHT_DEPART');
  });

  it('reports the build, so a node cannot claim a version it is not running', async () => {
    const app = build({ engine: engineWith() });

    const body = await app
      .inject({ method: 'GET', url: '/healthz' })
      .then((response) => response.json<{ build: number; commit: string; environment: string }>());

    expect(typeof body.build).toBe('number');
    expect(body.commit).not.toBe('');
    expect(body.environment).toBe('dev');
  });
});

describe('what the worker does not serve', () => {
  it('has exactly two routes, and neither is a game surface', async () => {
    const app = build({ engine: engineWith() });
    await app.ready();

    const routes = app
      .printRoutes({ commonPrefix: false })
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.includes('('));

    // The acceptance criterion — "the worker exposes no public HTTP surface" —
    // turned into something that fails when somebody adds a route here because
    // it was convenient. If a third route is genuinely wanted, this list is the
    // place the decision gets made.
    expect(routes).toHaveLength(2);
    expect(app.printRoutes({ commonPrefix: false })).toContain('healthz');
    expect(app.printRoutes({ commonPrefix: false })).toContain('queues');

    await app.close();
  });

  it('serves no client, no session and no admin console', async () => {
    const app = build({ engine: engineWith() });

    for (const url of ['/', '/api/me', '/api/version', '/admin', '/api/admin/worlds']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, `${url} must not be served by the worker`).toBe(404);
    }

    await app.close();
  });
});
