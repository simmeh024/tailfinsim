# The capacity model

Tailfin measures a great many numbers and, until this document, never said which of them
**decide** anything. This is the canonical model that does: for every capacity metric, what it
means, its unit, its window, who produces it, whether a scaling decision may rest on it, and
whether it describes the simulation falling behind or merely the machine being busy.

The typed half of this contract is [`packages/shared/src/capacity.ts`](../packages/shared/src/capacity.ts)
— `CAPACITY_METRICS` is the same list as data, and everything downstream (trends · SCALE-03,
alerts · SCALE-04, recommendations · SCALE-10, any automatic policy · SCALE-11) imports it
rather than restating it. [ADR-0022](adr/0022-capacity-model.md) records why the model is shaped
this way. When the type and this prose disagree, the type wins and the drift test in
`capacity.test.ts` fails until they agree again.

## The one rule

> **Infrastructure load alone never justifies a capacity change. Domain pressure does, and
> infrastructure load explains it.**

Tailfin's load is not request-shaped. It is a clock draining a durable queue, and the failure
that matters is not "the box is busy" but "the world is falling behind". Those come apart in both
directions:

- **CPU 95 %, queue empty, no late ticks.** The engine ticked against nothing, or a build ran
  beside it. No scaling action.
- **CPU 65 %, thousands of due events, the oldest 40 s behind.** The engine is running and
  losing. Capacity is justified.

On a 2-core box the number most likely to be on the screen is CPU, which is the one that answers
the capacity question worst — so it is classified `infrastructure-load` and `diagnostic`, and
`authoritativeMetrics()` can never return it.

## Two axes and two classes

Every metric is placed on **two** axes.

- **Axis — what it describes.** `domain-pressure` (the simulation is behind: the queue is old,
  growing, or the engine cannot hold cadence) or `infrastructure-load` (the machine is busy: CPU,
  memory, the pool, tick duration).
- **Class — whether a decision may rest on it.** `authoritative` (a capacity decision may be
  founded on it) or `diagnostic` (it explains a decision after the fact, and must never trigger
  one). Every infrastructure-load metric is diagnostic by the rule above; some domain-pressure
  metrics are diagnostic too, because a raw **count** is diagnostic where its **rate** is
  authoritative.

The authoritative set is deliberately **small** — three metrics — because a model where eleven
numbers can each trigger a scale-up is a model whose first false positive comes from whichever is
noisiest.

## Two latenesses, named apart

"The engine is late" is unactionable because it hides two different facts:

- **Tick lateness** — `late-tick-rate`. A tick overran its 1 s interval: the engine could not
  finish one tick before the next was due. Domain pressure, authoritative — it means the engine
  physically cannot keep cadence.
- **Queue lateness** — `oldest-due-event-age`. The oldest pending event whose fire time has
  passed is behind the world clock. Domain pressure, authoritative — it is the primary signal.

They are related but not the same: a fast engine draining a huge backlog has low tick lateness
and high queue lateness at once.

### Queue lateness is a game-time comparison

`fire_at` is a **game-time** instant ([ADR-0005](adr/0005-world-epoch-and-reset.md)), so queue
lateness is

```
queue lateness = gameTime(clock, now) − oldest fire_at
```

both terms in the world's own calendar — **not** `wall_now − fire_at`. `WORKER_BEHIND_AFTER_MS`
(60 s) in [`admin/system-health.ts`](../packages/server/src/admin/system-health.ts) is the single
authoritative threshold, and `assessNode()` is its single intended implementation. The world
health page's `BEHIND_AFTER_MS` was set equal to it on purpose; this model is the third thing that
must agree, not a fourth opinion. Do not compute lateness a second time anywhere else.

> **Correctness note, for a human to confirm (SCALE-01 is documentation; a fix is out of scope).**
> The worker heartbeat sends `oldestDueAt` as the raw game-time `min(fire_at)`
> ([`worker.ts`](../packages/server/src/worker.ts) `refreshQueueSummary`), and `assessNode()`
> currently evaluates `now.getTime() − Date.parse(oldestDueAt)` — a wall instant minus a game
> instant. For the flagship (epoch 2024-10-20, 2×) those are ~2 years apart, so any non-empty
> flagship queue would read as "behind" regardless of true lateness. It has not bitten because
> dev's flagship queue is empty (no players yet, so nothing schedules). The **model** defines
> lateness correctly above; whether `assessNode()` should convert `now` through `gameTime` before
> subtracting is a behaviour question for a follow-up, raised rather than guessed at, per the
> issue's own instruction.

## Rates, not totals

Anything authoritative is a **rate over a stated window**. `processed` since process start is
diagnostic: it resets on deploy and only grows. `event-drain-rate` — `processed` per minute — is a
signal. The rates here are derived from the counters that already exist rather than adding new
ones.

## State the windows

The worker heartbeat cadence is 15 s and the tick is 1 s, so a one-minute window holds four
samples of a heartbeat-sourced number and sixty of a tick-sourced one. A metric whose window is
shorter than its sampling interval is a lie, so each metric's `window` says which it is: an
_instantaneous_ level refreshed every 15 s, or a _rate_ and how many samples back it. A
"five-minute drain rate" built from 15 s heartbeats is twenty samples — say so, or it reads as
continuous.

## The metrics

Authoritative metrics are in **bold**. "Avail." is whether the number can be obtained today:
_measured_ (emitted now), _derivable_ (from counters that exist), or _gap_ (not obtainable yet).

### Domain pressure

| Metric                   | Key                    | Unit       | Class         | Avail.    | Judged against           |
| ------------------------ | ---------------------- | ---------- | ------------- | --------- | ------------------------ |
| **Oldest due-event age** | `oldest-due-event-age` | game-ms    | authoritative | measured  | `WORKER_BEHIND_AFTER_MS` |
| **Queue growth rate**    | `queue-growth-rate`    | events/min | authoritative | gap       | —                        |
| **Late-tick rate**       | `late-tick-rate`       | ratio      | authoritative | derivable | —                        |
| Due-event count          | `due-event-count`      | count      | diagnostic    | measured  | —                        |
| Event drain rate         | `event-drain-rate`     | events/min | diagnostic    | derivable | —                        |
| Event arrival rate       | `event-arrival-rate`   | events/min | diagnostic    | gap       | —                        |
| Failed-event rate        | `failed-event-rate`    | events/min | diagnostic    | derivable | —                        |

- **`oldest-due-event-age`** — queue lateness, defined above. The primary authoritative signal.
- **`queue-growth-rate`** — arrival minus drain, per minute. Authoritative because it answers
  _"are we falling further behind?"_, which age (_"are we behind now?"_) cannot. A **gap**: the
  due-count series is not retained until SCALE-02.
- **`late-tick-rate`** — `lateTicks / ticks` over a window. Authoritative: a tick that will not
  fit its interval is capacity, not diagnosis.
- **`due-event-count`** — a level, not a verdict. A large count that is draining is fine; a small
  one that is growing is not. A single drain handles at most `batchSize` (200) events per world,
  so a count above that means at least one drain hit the cap — which the count alone does not
  reveal, and nothing records.
- **`event-drain-rate`** and **`event-arrival-rate`** — the two halves of `queue-growth-rate`.
  Diagnostic on their own; only together do they say whether the engine is winning. Arrival is a
  gap: nothing counts scheduled events.
- **`failed-event-rate`** — a handler threw. Worth waking someone for, but more capacity does not
  fix a throwing handler, so it explains an incident and never justifies a scale-up. Distinct from
  `unsupported` (a build with no handler for a type — a deployment gap, not a failure).

### Infrastructure load

| Metric               | Key                   | Unit    | Class      | Avail.   | Judged against                |
| -------------------- | --------------------- | ------- | ---------- | -------- | ----------------------------- |
| Tick duration        | `tick-duration`       | ms      | diagnostic | measured | —                             |
| Tick cadence         | `tick-cadence`        | ticks/s | diagnostic | measured | —                             |
| In-flight events     | `in-flight-events`    | count   | diagnostic | gap      | —                             |
| CPU                  | `cpu-percent`         | percent | diagnostic | measured | —                             |
| Machine memory used  | `memory-used-percent` | percent | diagnostic | measured | —                             |
| Process memory (RSS) | `process-rss`         | bytes   | diagnostic | measured | —                             |
| DB pool utilisation  | `pool-utilisation`    | ratio   | diagnostic | gap      | `DATABASE_POOL_MAX`           |
| DB pool wait         | `pool-wait`           | count   | diagnostic | gap      | `DATABASE_CONNECT_TIMEOUT_MS` |

- **`tick-duration`** — the last tick only; a p50/p95 distribution would be the useful form and is
  a gap.
- **`tick-cadence`** — configured (1 s), not sampled. It frames `late-tick-rate` rather than
  moving.
- **`in-flight-events`** — always 0 or 1 today, because `drainDueEvents` handles one event per
  transaction, sequentially. Nothing to sample; it becomes meaningful only when SCALE-09 allows
  per-worker concurrency above one. Recorded now so that change has somewhere to land.
- **`cpu-percent`** — one-minute load average normalised by core count. No healthy range triggers
  anything, by the rule. On Windows `loadavg` is 0, so a local run reads 0 %.
- **`memory-used-percent`** / **`process-rss`** — the machine's total and this process's resident
  set. A steady RSS climb with a healthy queue is a leak — a bug to fix, not capacity to add.
- **`pool-utilisation`** / **`pool-wait`** — `pg.Pool` exposes `totalCount`, `idleCount` and
  `waitingCount`, but nothing reads them; a **gap**. A non-zero waiting count is the first sign the
  pool, not the engine, is the bottleneck. SEC-HARD-30 wants the same figures for abuse-bounding,
  so collect once, read twice.

## Gaps, and what would close them

| Gap                                       | Why it is not measured                                                                                          | What would obtain it                                                                           |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `queue-growth-rate`, `event-arrival-rate` | Only running totals and instantaneous levels exist; no series is retained, and nothing counts scheduled events. | SCALE-02 samples and stores due counts over time; a counter in `scheduleEvent()` for arrivals. |
| `in-flight-events`                        | The drain is sequential — one event per transaction — so the value is structurally 0 or 1.                      | SCALE-09, per-worker concurrency above one.                                                    |
| `pool-utilisation`, `pool-wait`           | `pg.Pool` publishes the numbers; the heartbeat does not sample them.                                            | Read `totalCount`/`idleCount`/`waitingCount` in `captureLoad()` (SCALE-02 / SEC-HARD-30).      |
| tick-duration distribution                | Only `lastTickDurationMs` is kept.                                                                              | Retain a small histogram or reservoir of recent tick durations.                                |

## Healthy ranges, on the production box

The box is a **2-core Xeon E5-2620 v4** — about five times slower than a development machine, so a
range measured on a laptop means little here. Where a range below says "not yet measured", that is
the honest state: the dev worker's flagship queue is usually empty (no players, so nothing
schedules), so the pressure metrics have not been exercised against a real backlog on the box. The
authoritative thresholds that **are** fixed are the ones in code — `WORKER_BEHIND_AFTER_MS` (60 s)
for queue lateness above all. Filling in the rest is a measurement task for when a world under real
load runs on the box; this document owns the vocabulary that measurement will be stated in.

## What this is not

Collecting or storing anything is SCALE-02; displaying anything is SCALE-03; acting on anything is
SCALE-04, SCALE-10 and SCALE-11. This is a contract over numbers Tailfin already produces, plus the
few it must start producing — not a metrics platform.
