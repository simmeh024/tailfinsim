/**
 * The tick loop (M1-06, §21).
 *
 * ~1 Hz. Two jobs: drain any due events, and give the position broadcaster a
 * heartbeat. Positions themselves are computed from a flight's departure time
 * and great-circle path rather than stored per tick (§21), so the tick does not
 * touch them — it only marks the moment.
 *
 * ## Why this is not just `setInterval`
 *
 * A drain that takes longer than the interval must not start again on top of
 * itself. `setInterval` will happily queue a second run while the first is still
 * awaiting the database, and the two will fight over the same rows — the queue
 * survives that (`SKIP LOCKED`), but the pile-up does not fix itself and memory
 * goes with it. So each tick is scheduled *after* the last one finishes.
 *
 * The consequence, stated plainly: the loop is "at most 1 Hz", not "exactly".
 * Under load it slows down rather than overlapping, which is the right way for a
 * simulation to degrade — late is recoverable, concurrent is not.
 */

export interface TickLoopOptions {
  /** Target interval in real milliseconds. §21's coarse tick is 1000. */
  intervalMs?: number;
  /** Runs once per tick. */
  onTick: (context: { tickedAt: Date; tickNumber: number }) => Promise<void>;
  /** A tick that throws must not stop the loop; it is reported here. */
  onError?: (error: unknown) => void;
  /** Injected so tests do not wait in real time. */
  now?: () => Date;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface TickLoop {
  start: () => void;
  stop: () => Promise<void>;
  readonly running: boolean;
  readonly ticks: number;
  /** Ticks that threw. A rising count is the signal something is wrong. */
  readonly errors: number;
  /** Ticks that ran late because the previous one overran. */
  readonly lateTicks: number;
}

export function createTickLoop(options: TickLoopOptions): TickLoop {
  const {
    intervalMs = 1_000,
    onTick,
    onError,
    now = () => new Date(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (handle) => {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  } = options;

  let running = false;
  let handle: unknown = null;
  let inFlight: Promise<void> | null = null;
  let ticks = 0;
  let errors = 0;
  let lateTicks = 0;

  const runOnce = async (): Promise<void> => {
    const startedAt = now();
    ticks += 1;
    try {
      await onTick({ tickedAt: startedAt, tickNumber: ticks });
    } catch (error) {
      // Swallowed on purpose. A tick that throws must not take the world's clock
      // down with it; the count and the callback are how it becomes visible.
      errors += 1;
      onError?.(error);
    }

    const elapsed = now().getTime() - startedAt.getTime();
    if (elapsed > intervalMs) lateTicks += 1;

    if (!running) return;
    // Scheduled from the end of the last tick, never from a fixed interval —
    // see the note above about overlapping runs.
    const delay = Math.max(0, intervalMs - elapsed);
    handle = setTimer(() => {
      inFlight = runOnce();
    }, delay);
  };

  return {
    start(): void {
      if (running) return;
      running = true;
      inFlight = runOnce();
    },

    async stop(): Promise<void> {
      running = false;
      if (handle !== null) {
        clearTimer(handle);
        handle = null;
      }
      // Awaited so a caller shutting down knows no tick is still mid-transaction
      // — the difference between a clean SIGTERM and a half-applied event.
      if (inFlight) await inFlight;
      inFlight = null;
    },

    get running(): boolean {
      return running;
    },
    get ticks(): number {
      return ticks;
    },
    get errors(): number {
      return errors;
    },
    get lateTicks(): number {
      return lateTicks;
    },
  };
}
