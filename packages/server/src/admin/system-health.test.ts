import { describe, expect, it } from 'vitest';

import { type AdminNodeEngine, type AdminNodeHealth } from '@tailfin/shared';

import {
  assessNode,
  nodeAlerts,
  NODE_OFFLINE_AFTER_MS,
  NODE_STALE_AFTER_MS,
  WORKER_BEHIND_AFTER_MS,
} from './system-health';

/**
 * The judgement, without a database.
 *
 * What matters on this page is not that rows come back — it is that the right
 * word appears next to a node. "Online" against a worker that has quietly
 * stopped is the single most expensive thing this page could say, because the
 * whole reason it exists is that a stopped engine looks fine from outside.
 */

const NOW = new Date('2026-08-21T12:00:00.000Z');

function engineFixture(overrides: Partial<AdminNodeEngine> = {}): AdminNodeEngine {
  return {
    running: true,
    ticks: 1000,
    errors: 0,
    lateTicks: 0,
    processed: 0,
    failed: 0,
    unsupported: 0,
    lastTickAt: NOW.toISOString(),
    queueDue: 0,
    oldestDueAt: null,
    unhandledEventTypes: [],
    ...overrides,
  };
}

function nodeFixture(overrides: Partial<AdminNodeHealth> = {}): AdminNodeHealth {
  return {
    node: 'tailfin-dev-web',
    role: 'web',
    environment: 'dev',
    state: 'online',
    detail: '',
    build: 218,
    commit: 'abc1234',
    startedAt: NOW.toISOString(),
    lastSeenAt: NOW.toISOString(),
    ageMs: 0,
    uptimeSeconds: 3600,
    load: {
      cpuPercent: 12,
      loadAverage1m: 0.24,
      cores: 2,
      processMemoryBytes: 120_000_000,
      memoryUsedPercent: 40,
      memoryTotalBytes: 4_000_000_000,
    },
    engine: null,
    ...overrides,
  };
}

describe('how fresh a heartbeat has to be', () => {
  it('calls a node online while it is still beating', () => {
    const { state } = assessNode({ role: 'web', ageMs: 5_000, engine: null, now: NOW });
    expect(state).toBe('online');
  });

  it('tolerates one missed beat rather than crying wolf on every deploy', () => {
    // A deploy restarts the process; one gap is ordinary and must not paint the
    // page amber every time somebody ships.
    const { state } = assessNode({
      role: 'web',
      ageMs: NODE_STALE_AFTER_MS - 1,
      engine: null,
      now: NOW,
    });
    expect(state).toBe('online');
  });

  it('calls it stale after three missed beats', () => {
    const { state, detail } = assessNode({
      role: 'web',
      ageMs: NODE_STALE_AFTER_MS + 1,
      engine: null,
      now: NOW,
    });
    expect(state).toBe('stale');
    expect(detail).toMatch(/last heartbeat/i);
  });

  it('calls it offline once it has clearly stopped', () => {
    const { state, detail } = assessNode({
      role: 'web',
      ageMs: NODE_OFFLINE_AFTER_MS + 1,
      engine: null,
      now: NOW,
    });
    expect(state).toBe('offline');
    expect(detail).toMatch(/stopped reporting/i);
  });
});

describe('a worker is judged on more than whether it is reporting', () => {
  it('refuses to call a stopped engine online, however fresh the heartbeat', () => {
    // The failure this whole page exists for: the process is alive, the
    // heartbeat is current, and nothing is being drained.
    const { state, detail } = assessNode({
      role: 'worker',
      ageMs: 1_000,
      engine: engineFixture({ running: false }),
      now: NOW,
    });

    expect(state).toBe('stale');
    expect(detail).toMatch(/engine is stopped/i);
  });

  it('distinguishes idle from stuck, which a zero cannot do on its own', () => {
    const idle = assessNode({
      role: 'worker',
      ageMs: 1_000,
      engine: engineFixture({ processed: 0, queueDue: 0 }),
      now: NOW,
    });

    // processed: 0 is correct today — nothing schedules events yet. The page has
    // to say "nothing to do" rather than leave a nought to be interpreted.
    expect(idle.state).toBe('online');
    expect(idle.detail).toMatch(/nothing to do/i);

    const stuck = assessNode({
      role: 'worker',
      ageMs: 1_000,
      engine: engineFixture({
        queueDue: 12,
        oldestDueAt: new Date(NOW.getTime() - WORKER_BEHIND_AFTER_MS - 5_000).toISOString(),
      }),
      now: NOW,
    });

    expect(stuck.state).toBe('stale');
    expect(stuck.detail).toMatch(/not keeping up/i);
  });

  it('calls a worker with a shallow backlog online, not behind', () => {
    // Work in the queue is not a fault. Work that has been waiting is.
    const { state, detail } = assessNode({
      role: 'worker',
      ageMs: 1_000,
      engine: engineFixture({
        queueDue: 4,
        oldestDueAt: new Date(NOW.getTime() - 2_000).toISOString(),
      }),
      now: NOW,
    });

    expect(state).toBe('online');
    expect(detail).toMatch(/draining/i);
  });

  it('does not trust a worker that sends no engine state', () => {
    const { state } = assessNode({ role: 'worker', ageMs: 1_000, engine: null, now: NOW });
    expect(state).toBe('stale');
  });
});

describe('the alerts', () => {
  it('says outright when no worker has ever reported', () => {
    const alerts = nodeAlerts([nodeFixture()]);
    expect(alerts.join(' ')).toMatch(/simulation is not running/i);
  });

  it('compares builds so a reader does not have to', () => {
    const alerts = nodeAlerts([
      nodeFixture({ node: 'web-01', build: 218 }),
      nodeFixture({ node: 'worker-01', role: 'worker', build: 214, engine: engineFixture() }),
    ]);

    // Independent deployment means these drift. Two numbers on a page invite a
    // comparison; an alert performs it.
    expect(alerts.join(' ')).toMatch(/different builds/i);
    expect(alerts.join(' ')).toContain('web-01 on 218');
    expect(alerts.join(' ')).toContain('worker-01 on 214');
  });

  it('ignores an offline node when comparing builds', () => {
    // A node that has stopped reporting is stale data, and its old build number
    // would raise a skew alert about a machine that is not running at all.
    const alerts = nodeAlerts([
      nodeFixture({ node: 'web-01', build: 218 }),
      nodeFixture({
        node: 'worker-01',
        role: 'worker',
        build: 100,
        state: 'offline',
        engine: engineFixture(),
      }),
    ]);

    expect(alerts.join(' ')).not.toMatch(/different builds/i);
    expect(alerts.join(' ')).toMatch(/stopped reporting/i);
  });

  it('surfaces an unhandled event type as a deployment gap that pauses work', () => {
    const alerts = nodeAlerts([
      nodeFixture({
        node: 'worker-01',
        role: 'worker',
        engine: engineFixture({ unhandledEventTypes: ['FLIGHT_DEPART'] }),
      }),
    ]);

    const text = alerts.join(' ');
    expect(text).toContain('FLIGHT_DEPART');
    // This assertion used to read `/marked failed/` and was correct until
    // SCALE-05. `drainDueEvents` now marks these `unsupported`: the work is
    // paused rather than destroyed, and the alert must not keep telling an
    // operator otherwise — an alert that overstates is one they learn to ignore.
    expect(text).toMatch(/paused as unsupported/i);
    expect(text).not.toMatch(/marked failed/i);
  });

  it('says how much work is waiting, per world and per type', () => {
    // "412 unsupported events" is not actionable; naming the world, the type
    // and the age is.
    const alerts = nodeAlerts(
      [nodeFixture({ node: 'worker-01', role: 'worker', engine: engineFixture() })],
      [
        {
          worldId: '11111111-2222-3333-4444-555555555555',
          worldName: 'Northern Sky',
          type: 'FLIGHT_DEPART',
          count: 412,
          oldestFireAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
        },
      ],
    );

    const text = alerts.join(' ');
    expect(text).toContain('412 FLIGHT_DEPART');
    expect(text).toContain('Northern Sky');
    expect(text).toMatch(/3 days ago/);
  });

  it('says nothing about unsupported work when there is none', () => {
    const alerts = nodeAlerts([
      nodeFixture({ node: 'worker-01', role: 'worker', engine: engineFixture() }),
    ]);
    expect(alerts.join(' ')).not.toMatch(/waiting for a handler/i);
  });

  it('is empty for a healthy, matched pair', () => {
    const alerts = nodeAlerts([
      nodeFixture({ node: 'web-01', build: 218 }),
      nodeFixture({ node: 'worker-01', role: 'worker', build: 218, engine: engineFixture() }),
    ]);

    expect(alerts).toEqual([]);
  });
});
