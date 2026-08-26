import { z } from 'zod';

/**
 * The capacity model (SCALE-01).
 *
 * Tailfin measures a lot of numbers and, until this file, never said which of
 * them decide anything. This is the contract that says so: for every capacity
 * metric, what it means, its unit, its window, who produces it, whether a
 * scaling decision may rest on it, and whether it describes the *simulation
 * falling behind* or merely *the machine being busy*.
 *
 * The prose companion is `docs/capacity.md`; ADR-0022 records why the model is
 * shaped this way. This file is the half that does not drift: everything
 * downstream — trends (SCALE-03), alerts (SCALE-04), recommendations (SCALE-10)
 * — imports these definitions rather than restating them, so they cannot come to
 * disagree in production about whether there is any pressure.
 *
 * ## The one rule the whole milestone inherits
 *
 * **Infrastructure load alone never justifies a capacity change. Domain pressure
 * does, and infrastructure load explains it.** Tailfin's load is not
 * request-shaped; it is a clock draining a durable queue, and the failure that
 * matters is not "the box is busy" but "the world is falling behind". On a
 * 2-core box the number most likely to be on the screen is CPU, which is the one
 * that answers the capacity question worst — so CPU is classified
 * `infrastructure-load` and `diagnostic`, and {@link authoritativeMetrics} can
 * never return it.
 */

/**
 * What a metric describes.
 *
 * - `domain-pressure`: the simulation is behind — the queue is old, growing, or
 *   the engine cannot hold its cadence. This is what justifies capacity.
 * - `infrastructure-load`: the machine is busy — CPU, memory, the pool, how long
 *   a tick took. This *explains* a decision; it never triggers one.
 */
export const CapacityAxis = z.enum(['domain-pressure', 'infrastructure-load']);
export type CapacityAxis = z.infer<typeof CapacityAxis>;

/**
 * Whether a scaling decision may rest on a metric.
 *
 * - `authoritative`: a capacity decision may be founded on this number.
 * - `diagnostic`: it explains a decision after the fact; it must never be the
 *   thing that triggers one. Every `infrastructure-load` metric is `diagnostic`
 *   by the rule above, and some `domain-pressure` metrics are diagnostic too — a
 *   raw count is diagnostic where its *rate* is authoritative.
 */
export const CapacityClass = z.enum(['authoritative', 'diagnostic']);
export type CapacityClass = z.infer<typeof CapacityClass>;

/**
 * The unit a metric is expressed in.
 *
 * `game-ms` is called out separately from `ms` on purpose: queue lateness is a
 * comparison in **game time** (ADR-0005), and treating it as wall-clock
 * milliseconds is the specific mistake this model exists to prevent.
 */
export const CapacityUnit = z.enum([
  'game-ms',
  'ms',
  'count',
  'events-per-minute',
  'ticks-per-second',
  'ratio',
  'percent',
  'bytes',
]);
export type CapacityUnit = z.infer<typeof CapacityUnit>;

/** Whether the number can be obtained today, and if not, why not. */
export const CapacityAvailability = z.enum(['measured', 'derivable', 'gap']);
export type CapacityAvailability = z.infer<typeof CapacityAvailability>;

/**
 * The stable identifiers for the metrics in the model.
 *
 * A closed set on purpose: a consumer switching over these keys should fail to
 * compile when the model gains or loses one, rather than silently ignoring it.
 */
export const CapacityMetricKey = z.enum([
  // Domain pressure
  'oldest-due-event-age',
  'queue-growth-rate',
  'late-tick-rate',
  'due-event-count',
  'event-drain-rate',
  'event-arrival-rate',
  'failed-event-rate',
  // Infrastructure load
  'tick-duration',
  'tick-cadence',
  'in-flight-events',
  'cpu-percent',
  'memory-used-percent',
  'process-rss',
  'pool-utilisation',
  'pool-wait',
]);
export type CapacityMetricKey = z.infer<typeof CapacityMetricKey>;

/**
 * One metric, fully classified.
 *
 * Everything a downstream feature needs to render, trend or alert on the metric
 * without inventing a second definition of any of it. `authoritative` metrics
 * carry a `threshold` where one is already defined in code — never a fresh
 * number, always a reference to the single existing one.
 */
export const CapacityMetric = z.object({
  key: CapacityMetricKey,
  /** Human label for a console. */
  label: z.string().min(1),
  /** One sentence: what the number is. */
  definition: z.string().min(1),
  unit: CapacityUnit,
  /**
   * The window the number is expressed over, in words.
   *
   * A metric whose window is shorter than its sampling interval is a lie, so the
   * window says which is which: "instantaneous, refreshed every 15 s" is a level;
   * "per minute over ≥ 4 heartbeat samples" is a rate and says how many samples
   * back it.
   */
  window: z.string().min(1),
  /** Where the number is produced — the function or file that emits it. */
  producer: z.string().min(1),
  axis: CapacityAxis,
  classification: CapacityClass,
  availability: CapacityAvailability,
  /**
   * The name of the single existing threshold this metric is judged against, or
   * null. A *reference*, never a value — the number lives in code (e.g.
   * `WORKER_BEHIND_AFTER_MS`), and duplicating it here is how two places come to
   * disagree about "behind".
   */
  threshold: z.string().min(1).nullable(),
  /**
   * What healthy looks like on the production box, and where that was measured.
   * Prose because the box is specific (a 2-core Xeon E5-2620 v4) and the honest
   * answer is often "not yet measured on the box".
   */
  healthy: z.string().min(1),
  /** Anything load-bearing that the fields above cannot carry. */
  notes: z.string().min(1).optional(),
});
export type CapacityMetric = z.infer<typeof CapacityMetric>;

/**
 * The canonical capacity model, as data.
 *
 * `docs/capacity.md` is the readable form of exactly this list; the test in
 * `capacity.test.ts` asserts the invariants that keep the two halves honest — a
 * small authoritative set, no authoritative infrastructure metric, and a
 * threshold reference on every authoritative metric that has one.
 */
export const CAPACITY_METRICS: readonly CapacityMetric[] = [
  // ---------------------------------------------------------------- domain pressure
  {
    key: 'oldest-due-event-age',
    label: 'Oldest due-event age',
    definition:
      'How far the oldest pending event whose fire time has passed is behind the world clock — the queue lateness.',
    unit: 'game-ms',
    window: 'Instantaneous per world; the worker refreshes it every 15 s alongside the heartbeat.',
    producer: 'queueDepth() → worker heartbeat → AdminNodeEngine.oldestDueAt',
    axis: 'domain-pressure',
    classification: 'authoritative',
    availability: 'measured',
    threshold: 'WORKER_BEHIND_AFTER_MS (admin/system-health.ts)',
    healthy:
      'Under WORKER_BEHIND_AFTER_MS (60 s of game time). Dev’s flagship queue is usually empty, so the typical value is null; not yet exercised against a backlog on the box.',
    notes:
      'A game-time comparison: fire_at is game time (ADR-0005), so lateness is gameTime(clock, now) − oldest fire_at, not wall_now − fire_at. assessNode() is the single intended implementation; see the correctness note in docs/capacity.md before reading age off the raw heartbeat.',
  },
  {
    key: 'queue-growth-rate',
    label: 'Queue growth rate',
    definition:
      'Net change in the due-event count per minute — arrival rate minus drain rate — across every world a node drives.',
    unit: 'events-per-minute',
    window: 'Per minute, over ≥ 4 samples of the 15 s heartbeat.',
    producer: 'Derived from successive queueDepth() due counts; nothing stores the series yet.',
    axis: 'domain-pressure',
    classification: 'authoritative',
    availability: 'gap',
    threshold: null,
    healthy:
      'Around zero or negative in steady state (draining keeps up). Sustained positive growth is the clearest justification for capacity. No range measured — the series is not collected until SCALE-02.',
    notes:
      'Authoritative because it answers "are we falling further behind?", which oldest-due-event-age (are we behind now?) cannot. Needs SCALE-02 to sample and retain due counts.',
  },
  {
    key: 'late-tick-rate',
    label: 'Late-tick rate',
    definition:
      'The fraction of ticks that overran their interval — the engine could not finish a tick before the next was due.',
    unit: 'ratio',
    window: 'Per stated window, derived from the lateTicks and ticks counters.',
    producer: 'EngineSnapshot.lateTicks / EngineSnapshot.ticks (sim/tick.ts)',
    axis: 'domain-pressure',
    classification: 'authoritative',
    availability: 'derivable',
    threshold: null,
    healthy:
      'Near zero. A tick that cannot fit its 1 s interval means the engine physically cannot hold cadence, which is capacity, not diagnosis. Baseline on the 2-core box not yet recorded.',
    notes:
      'Tick lateness (a tick overran) is a different thing from queue lateness (the oldest event is behind). Named apart on purpose: conflating them makes "the engine is late" unactionable.',
  },
  {
    key: 'due-event-count',
    label: 'Due-event count',
    definition: 'How many pending events are currently due, per world and summed across a node.',
    unit: 'count',
    window: 'Instantaneous; refreshed every 15 s.',
    producer: 'queueDepth() → AdminNodeEngine.queueDue',
    axis: 'domain-pressure',
    classification: 'diagnostic',
    availability: 'measured',
    threshold: null,
    healthy:
      'A level, not a verdict: a large count that is draining is fine and a small one that is growing is not. It explains queue-growth-rate; it does not trigger.',
    notes:
      'A single drain handles at most batchSize (200) events per world; a count above that across a heartbeat means at least one drain hit the cap, which the count alone does not reveal.',
  },
  {
    key: 'event-drain-rate',
    label: 'Event drain rate',
    definition: 'Events processed per minute — how fast the engine is clearing the queue.',
    unit: 'events-per-minute',
    window: 'Per minute, from the delta of the processed counter over a stated window.',
    producer: 'Derived from EngineSnapshot.processed; the counter is a running total since start.',
    axis: 'domain-pressure',
    classification: 'diagnostic',
    availability: 'derivable',
    threshold: null,
    healthy:
      'Whatever keeps pace with arrivals. Diagnostic on its own — it is one half of queue-growth-rate, and only the two together say whether the engine is winning.',
    notes:
      'processed since process start is diagnostic and resets on deploy; only its rate over a window is a signal.',
  },
  {
    key: 'event-arrival-rate',
    label: 'Event arrival rate',
    definition: 'Events scheduled into the queue per minute — the inflow drain must keep up with.',
    unit: 'events-per-minute',
    window: 'Per minute over a stated window.',
    producer:
      'No counter for scheduled events exists; would come from scheduleEvent() (event-queue.ts).',
    axis: 'domain-pressure',
    classification: 'diagnostic',
    availability: 'gap',
    threshold: null,
    healthy:
      'The other half of queue-growth-rate. No range: nothing counts scheduled events today.',
    notes: 'Arrival − drain = growth; growth is the authoritative composite these two explain.',
  },
  {
    key: 'failed-event-rate',
    label: 'Failed-event rate',
    definition: 'Events whose handler threw, per minute — something is broken, not overloaded.',
    unit: 'events-per-minute',
    window: 'Per minute, from the delta of the failed counter.',
    producer: 'EngineSnapshot.failed (sim/tick.ts)',
    axis: 'domain-pressure',
    classification: 'diagnostic',
    availability: 'derivable',
    threshold: null,
    healthy:
      'Zero. A rising rate is worth waking someone for, but more capacity does not fix a throwing handler — so it explains an incident, it never justifies a scale-up.',
    notes:
      'Distinct from unsupported (a build with no handler for a type), which is a deployment gap, not a failure — see EngineSnapshot for why they no longer share a number.',
  },
  // ------------------------------------------------------------- infrastructure load
  {
    key: 'tick-duration',
    label: 'Tick duration',
    definition: 'How long the last tick took to run every due world.',
    unit: 'ms',
    window: 'Last tick only; there is no distribution.',
    producer: 'EngineSnapshot.lastTickDurationMs (engine/simulation.ts)',
    axis: 'infrastructure-load',
    classification: 'diagnostic',
    availability: 'measured',
    threshold: null,
    healthy:
      'Comfortably under the 1 s interval on the box. A distribution (p50/p95) would be the useful form and is a gap — only the last sample exists.',
  },
  {
    key: 'tick-cadence',
    label: 'Tick cadence',
    definition: 'How often the engine attempts a tick.',
    unit: 'ticks-per-second',
    window: 'Configured, not sampled: the §21 coarse tick is 1 s.',
    producer: 'SimulationEngineOptions.intervalMs (engine/simulation.ts)',
    axis: 'infrastructure-load',
    classification: 'diagnostic',
    availability: 'measured',
    threshold: null,
    healthy: 'One tick per second. Fixed; it frames late-tick-rate rather than moving.',
  },
  {
    key: 'in-flight-events',
    label: 'In-flight events',
    definition: 'Events being handled at this instant, per worker.',
    unit: 'count',
    window: 'Instantaneous.',
    producer: 'drainDueEvents() — one event per transaction, sequentially.',
    axis: 'infrastructure-load',
    classification: 'diagnostic',
    availability: 'gap',
    threshold: null,
    healthy:
      'Always 0 or 1 today, so there is nothing to sample. It becomes meaningful only when SCALE-09 allows per-worker concurrency above one; recorded now so that change has somewhere to land.',
  },
  {
    key: 'cpu-percent',
    label: 'CPU',
    definition: 'One-minute load average as a percentage of the cores the node has.',
    unit: 'percent',
    window: '1-minute load average, normalised by core count.',
    producer: 'captureLoad() → AdminNodeLoad.cpuPercent (ops/heartbeat.ts)',
    axis: 'infrastructure-load',
    classification: 'diagnostic',
    availability: 'measured',
    threshold: null,
    healthy:
      'No healthy range triggers anything: by the model’s rule, no scaling decision may rest on CPU alone. High CPU with an empty, current queue is a no-op; the queue is what decides. On Windows loadavg is 0, so a local run reads 0 %.',
  },
  {
    key: 'memory-used-percent',
    label: 'Machine memory used',
    definition: 'Fraction of the machine’s memory in use.',
    unit: 'percent',
    window: 'Instantaneous, every 15 s.',
    producer: 'captureLoad() → AdminNodeLoad.memoryUsedPercent (ops/heartbeat.ts)',
    axis: 'infrastructure-load',
    classification: 'diagnostic',
    availability: 'measured',
    threshold: null,
    healthy:
      'Headroom below the box’s total. Diagnostic: it explains a slowdown, it does not justify capacity on its own.',
  },
  {
    key: 'process-rss',
    label: 'Process memory (RSS)',
    definition: 'Resident set of the node process, as distinct from the machine total.',
    unit: 'bytes',
    window: 'Instantaneous, every 15 s.',
    producer: 'captureLoad() → AdminNodeLoad.processMemoryBytes (ops/heartbeat.ts)',
    axis: 'infrastructure-load',
    classification: 'diagnostic',
    availability: 'measured',
    threshold: null,
    healthy:
      'Flat over time. A steady climb with a healthy queue is a leak, which is a bug to fix, not capacity to add.',
  },
  {
    key: 'pool-utilisation',
    label: 'DB pool utilisation',
    definition: 'Fraction of the database connection pool in use.',
    unit: 'ratio',
    window: 'Instantaneous.',
    producer: 'pg.Pool totalCount/idleCount against DATABASE_POOL_MAX (10); not read today.',
    axis: 'infrastructure-load',
    classification: 'diagnostic',
    availability: 'gap',
    threshold: 'DATABASE_POOL_MAX (env.ts)',
    healthy:
      'Well under the pool max. The numbers exist on pg.Pool but nothing samples them; SEC-HARD-30 wants the same figures for abuse-bounding, so collect once, read twice.',
  },
  {
    key: 'pool-wait',
    label: 'DB pool wait',
    definition: 'Requests queued for a connection, and how long they wait.',
    unit: 'count',
    window: 'Instantaneous.',
    producer: 'pg.Pool waitingCount; not read today.',
    axis: 'infrastructure-load',
    classification: 'diagnostic',
    availability: 'gap',
    threshold: 'DATABASE_CONNECT_TIMEOUT_MS (env.ts)',
    healthy:
      'Zero waiters. A non-zero waiting count is the first sign the pool is the bottleneck rather than the engine — but it explains slowness, it is the domain-pressure metrics that justify a change.',
  },
] as const;

/** Every metric a scaling decision may rest on. Never an infrastructure-load metric. */
export function authoritativeMetrics(): readonly CapacityMetric[] {
  return CAPACITY_METRICS.filter((metric) => metric.classification === 'authoritative');
}

/** The metrics on one axis of the model. */
export function metricsByAxis(axis: CapacityAxis): readonly CapacityMetric[] {
  return CAPACITY_METRICS.filter((metric) => metric.axis === axis);
}

/** Look one up by key, for a consumer that has a key and wants its full definition. */
export function capacityMetric(key: CapacityMetricKey): CapacityMetric {
  const found = CAPACITY_METRICS.find((metric) => metric.key === key);
  if (found === undefined) throw new Error(`No capacity metric named ${key}`);
  return found;
}

/**
 * The rule the model turns on, as a string a console can print verbatim.
 *
 * Exported so a UI states it in the model’s own words rather than paraphrasing
 * it into something weaker.
 */
export const CAPACITY_DECISION_RULE =
  'Infrastructure load alone never justifies a capacity change. Domain pressure does, and infrastructure load explains it.';
