import { describe, expect, it, vi } from 'vitest';

import { type Database } from '../db/client';

import { type RefreshFxResult } from './currency-refresh';
import { createSimulationEngine } from './simulation';

import type { FxRateSource } from '../currency/fx-source';

/**
 * The FX sweep says which of its states it is in.
 *
 * **No database.** `refreshFx` and `fxSource` are both injectable, so what is
 * proved here is the loop's own bookkeeping. The refresh's behaviour against
 * real Postgres — the daily gate, the rate maths, the `max()` normalisation —
 * is `currency-refresh.test.ts`'s and is not re-asserted.
 *
 * ## The bug these pin
 *
 * The daily gate returning `fresh` incremented nothing, so
 * `fxRefreshes: 0, fxRefreshErrors: 0` meant either *"the rates are up to
 * date"* or *"this sweep never ran"*. That is the `ticks: 0, errors: 0`
 * ambiguity every counter in the heartbeat exists to remove, reproduced inside
 * one of them — and it cost a real diagnostic session: the only way to tell the
 * two apart was to read `worker.ts` and confirm a source was wired.
 *
 * It mattered in this sweep more than most, because its failure mode is
 * silently serving stale money rather than visibly stopping.
 */

const db = {} as Database;

/** A source that must never be reached: the loop injects `refreshFx` instead. */
const UNUSED_SOURCE: FxRateSource = () => {
  throw new Error('the stubbed refreshFx should have been called instead');
};

const AT = new Date('2026-08-20T03:00:00.000Z');

function engineWith(refreshFx: () => Promise<RefreshFxResult>) {
  return createSimulationEngine({
    db,
    handlers: {},
    listWorlds: () => Promise.resolve([]),
    drain: () => Promise.resolve({ processed: 0, failed: 0, unsupported: 0, upTo: new Date(0) }),
    fxSource: UNUSED_SOURCE,
    refreshFx,
  });
}

describe('the FX sweep distinguishes its states', () => {
  it('counts a skip, so an up-to-date sweep is visibly alive', async () => {
    const refreshFx = vi.fn(() =>
      Promise.resolve<RefreshFxResult>({ refreshed: false, reason: 'fresh', newestAt: AT }),
    );
    const engine = engineWith(refreshFx);

    await engine.runOnce();
    const snapshot = engine.snapshot();

    expect(refreshFx).toHaveBeenCalledTimes(1);
    // The regression: this was 0 and indistinguishable from a sweep that never ran.
    expect(snapshot.fxRefreshesSkipped).toBe(1);
    expect(snapshot.fxRefreshes).toBe(0);
    expect(snapshot.fxRefreshErrors).toBe(0);
  });

  it('reports the durable rate age, which survives what the counters cannot', async () => {
    const engine = engineWith(() =>
      Promise.resolve<RefreshFxResult>({ refreshed: false, reason: 'fresh', newestAt: AT }),
    );

    await engine.runOnce();

    // The question the counters cannot answer after a restart.
    expect(engine.snapshot().fxRatesRefreshedAt).toEqual(AT);
  });

  it('counts a refresh, and not a skip', async () => {
    const engine = engineWith(() =>
      Promise.resolve<RefreshFxResult>({ refreshed: true, updated: 4, newestAt: AT }),
    );

    await engine.runOnce();
    const snapshot = engine.snapshot();

    expect(snapshot.fxRefreshes).toBe(1);
    expect(snapshot.fxRefreshesSkipped).toBe(0);
    expect(snapshot.fxRatesRefreshedAt).toEqual(AT);
  });

  it('counts a failure as neither a refresh nor a skip', async () => {
    const engine = engineWith(() => Promise.reject(new Error('source down')));

    await engine.runOnce();
    const snapshot = engine.snapshot();

    expect(snapshot.fxRefreshErrors).toBe(1);
    expect(snapshot.fxRefreshes).toBe(0);
    expect(snapshot.fxRefreshesSkipped).toBe(0);
    // A throw tells us nothing new about the rates, so the last known age stands
    // rather than being cleared — clearing it would report fresh rates as absent.
    expect(snapshot.fxRatesRefreshedAt).toBeNull();
  });

  it('leaves every FX figure at its resting value when no source is configured', async () => {
    // The other half of the old ambiguity, and the reason a skip counter alone
    // is not enough: with no source the sweep does not run, so the counters look
    // exactly as they did for "up to date". `fxRatesRefreshedAt` staying null is
    // what separates them — and on a node with no worker, null is the truth.
    const refreshFx = vi.fn(() =>
      Promise.resolve<RefreshFxResult>({ refreshed: false, reason: 'fresh', newestAt: AT }),
    );
    const engine = createSimulationEngine({
      db,
      handlers: {},
      listWorlds: () => Promise.resolve([]),
      drain: () => Promise.resolve({ processed: 0, failed: 0, unsupported: 0, upTo: new Date(0) }),
      refreshFx,
    });

    await engine.runOnce();
    const snapshot = engine.snapshot();

    expect(refreshFx).not.toHaveBeenCalled();
    expect(snapshot.fxRefreshes).toBe(0);
    expect(snapshot.fxRefreshErrors).toBe(0);
    expect(snapshot.fxRefreshesSkipped).toBe(0);
    expect(snapshot.fxRatesRefreshedAt).toBeNull();
  });

  it('attempts at most once an hour, however often it ticks', async () => {
    // The attempt throttle is what makes the skip counter a useful signal rather
    // than a tick counter in disguise: it should climb hourly, not per second.
    const refreshFx = vi.fn(() =>
      Promise.resolve<RefreshFxResult>({ refreshed: false, reason: 'fresh', newestAt: AT }),
    );
    const engine = engineWith(refreshFx);

    await engine.runOnce();
    await engine.runOnce();
    await engine.runOnce();

    expect(refreshFx).toHaveBeenCalledTimes(1);
    expect(engine.snapshot().fxRefreshesSkipped).toBe(1);
  });
});
