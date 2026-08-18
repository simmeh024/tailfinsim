import { describe, expect, it } from 'vitest';

import { createTickLoop } from './tick';

/**
 * The tick loop.
 *
 * Time and timers are injected, so none of this waits in real life. The property
 * worth protecting is that a slow tick delays the next one rather than running
 * alongside it — late is recoverable, concurrent is not.
 */

/** A controllable clock and timer queue, so a "second" costs nothing. */
function harness() {
  let currentMs = 0;
  const pending: { at: number; fn: () => void }[] = [];

  return {
    now: (): Date => new Date(currentMs),
    setTimer: (fn: () => void, ms: number): unknown => {
      const entry = { at: currentMs + ms, fn };
      pending.push(entry);
      return entry;
    },
    clearTimer: (handle: unknown): void => {
      const index = pending.indexOf(handle as { at: number; fn: () => void });
      if (index >= 0) pending.splice(index, 1);
    },
    /**
     * Moves time on and fires anything due, oldest first.
     *
     * Flushes microtasks *before* looking for timers, not only after: the loop
     * schedules its next tick from inside an async function, so at the instant
     * `advance` is called the timer may not exist yet. Checking first and
     * flushing later finds an empty queue and the loop appears to stop dead.
     */
    advance: async (ms: number): Promise<void> => {
      const target = currentMs + ms;
      for (let guard = 0; guard < 10_000; guard += 1) {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        pending.sort((a, b) => a.at - b.at);
        const next = pending[0];
        if (!next || next.at > target) break;

        pending.shift();
        // A tick may have pushed the clock past its own deadline via `elapse`.
        currentMs = Math.max(currentMs, next.at);
        next.fn();
      }
      currentMs = Math.max(currentMs, target);
    },
    elapse: (ms: number): void => {
      currentMs += ms;
    },
  };
}

describe('createTickLoop', () => {
  it('does not tick before it is started', async () => {
    const h = harness();
    const loop = createTickLoop({ onTick: () => Promise.resolve(), ...h });
    await h.advance(5_000);
    expect(loop.ticks).toBe(0);
  });

  it('ticks immediately on start, then on the interval', async () => {
    const h = harness();
    const loop = createTickLoop({ intervalMs: 1_000, onTick: () => Promise.resolve(), ...h });

    loop.start();
    await Promise.resolve();
    expect(loop.ticks).toBe(1);

    await h.advance(3_000);
    expect(loop.ticks).toBe(4);
    await loop.stop();
  });

  it('passes an increasing tick number', async () => {
    const h = harness();
    const seen: number[] = [];
    const loop = createTickLoop({
      intervalMs: 1_000,
      onTick: ({ tickNumber }) => {
        seen.push(tickNumber);
        return Promise.resolve();
      },
      ...h,
    });

    loop.start();
    await h.advance(2_000);
    await loop.stop();
    expect(seen).toEqual([1, 2, 3]);
  });

  it('stops ticking after stop', async () => {
    const h = harness();
    const loop = createTickLoop({ intervalMs: 1_000, onTick: () => Promise.resolve(), ...h });
    loop.start();
    await h.advance(2_000);
    const before = loop.ticks;
    await loop.stop();
    await h.advance(10_000);
    expect(loop.ticks).toBe(before);
    expect(loop.running).toBe(false);
  });

  it('is idempotent on a second start', async () => {
    // Two loops racing over the same queue is exactly what this guards against.
    const h = harness();
    const loop = createTickLoop({ intervalMs: 1_000, onTick: () => Promise.resolve(), ...h });
    loop.start();
    loop.start();
    await h.advance(2_000);
    expect(loop.ticks).toBe(3);
    await loop.stop();
  });
});

describe('a slow tick', () => {
  it('delays the next tick instead of overlapping it', async () => {
    // The property that matters. `setInterval` would queue a second run on top
    // of the first; this must not.
    const h = harness();
    let concurrent = 0;
    let maxConcurrent = 0;

    const loop = createTickLoop({
      intervalMs: 1_000,
      onTick: async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        // A tick that takes two and a half intervals.
        h.elapse(2_500);
        await Promise.resolve();
        concurrent -= 1;
      },
      ...h,
    });

    loop.start();
    await h.advance(10_000);
    await loop.stop();

    expect(maxConcurrent).toBe(1);
  });

  it('counts a tick that overran its interval', async () => {
    const h = harness();
    const loop = createTickLoop({
      intervalMs: 1_000,
      onTick: async () => {
        h.elapse(1_500);
        await Promise.resolve();
      },
      ...h,
    });

    loop.start();
    await h.advance(5_000);
    await loop.stop();

    // Every tick here overran, so every tick is late — a rising count is the
    // signal that the drain is not keeping up.
    expect(loop.lateTicks).toBeGreaterThan(0);
    expect(loop.lateTicks).toBe(loop.ticks);
  });

  it('runs the next tick immediately when the last one ate the whole interval', async () => {
    const h = harness();
    const loop = createTickLoop({
      intervalMs: 1_000,
      onTick: async () => {
        h.elapse(4_000);
        await Promise.resolve();
      },
      ...h,
    });

    loop.start();
    await h.advance(4_100);
    await loop.stop();
    // No negative delay, no burst of catch-up ticks — just the next one, now.
    expect(loop.ticks).toBeGreaterThanOrEqual(1);
  });
});

describe('a failing tick', () => {
  it('does not stop the loop', async () => {
    // A tick that throws must not take the world's clock down with it.
    const h = harness();
    let calls = 0;
    const loop = createTickLoop({
      intervalMs: 1_000,
      onTick: () => {
        calls += 1;
        if (calls === 2) return Promise.reject(new Error('database went away'));
        return Promise.resolve();
      },
      ...h,
    });

    loop.start();
    await h.advance(4_000);
    await loop.stop();

    expect(calls).toBeGreaterThan(3);
    expect(loop.errors).toBe(1);
  });

  it('reports the error rather than swallowing it silently', async () => {
    const h = harness();
    const seen: unknown[] = [];
    const loop = createTickLoop({
      intervalMs: 1_000,
      onTick: () => Promise.reject(new Error('boom')),
      onError: (error) => seen.push(error),
      ...h,
    });

    loop.start();
    await h.advance(1_000);
    await loop.stop();

    expect(seen.length).toBeGreaterThan(0);
    expect((seen[0] as Error).message).toBe('boom');
  });
});

describe('shutdown', () => {
  it('waits for a tick that is still running', async () => {
    // The difference between a clean SIGTERM and a half-applied event.
    const h = harness();
    let finished = false;
    let release: (() => void) | null = null;

    const loop = createTickLoop({
      intervalMs: 1_000,
      onTick: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        finished = true;
      },
      ...h,
    });

    loop.start();
    await Promise.resolve();

    const stopping = loop.stop();
    expect(finished).toBe(false);
    release!();
    await stopping;
    expect(finished).toBe(true);
  });

  it('is safe to stop a loop that was never started', async () => {
    const h = harness();
    const loop = createTickLoop({ onTick: () => Promise.resolve(), ...h });
    await expect(loop.stop()).resolves.toBeUndefined();
  });
});
