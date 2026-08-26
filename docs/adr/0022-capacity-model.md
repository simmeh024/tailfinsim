# ADR-0022: The capacity model

- **Status:** Accepted
- **Date:** 2026-08-26
- **Deciders:** @simmeh024
- **Constrains:** every SCALE issue — trends (SCALE-03), alerts (SCALE-04), recommendations (SCALE-10), and any automatic policy (SCALE-11)

## Context

Tailfin measures ticks, errors, late ticks, processed and failed events; queue due-counts and
oldest-due instants per world; normalised CPU, load average, process RSS and machine memory. It
has never stated which of those numbers means _"this needs more capacity"_, which are merely
diagnostic, or what units and windows they are in.

Without that, the first scaling decision will be made from whichever number happened to be on
the screen — and on the production box, a 2-core Xeon E5-2620 v4, the number most likely to be
on the screen is CPU, which answers the question worst. Tailfin's load is not request-shaped: it
is a clock draining a durable queue, and the failure that matters is not "the box is busy" but
"the world is falling behind". Those come apart in both directions — a pinned CPU against an
empty queue is nothing to act on, and a half-idle CPU against a growing backlog is everything.

Everything later in the SCALE milestone reads from this. Trends, alerts, recommendations and any
automatic policy must all mean the same thing by "pressure", or they will disagree in production
about whether there is any. `assessNode()` already encodes a version of the judgement — a worker
whose oldest due event is more than `WORKER_BEHIND_AFTER_MS` behind is _stale_ even while its
process is healthy — but that instinct lives as one threshold in one file. This makes it a model.

## Decision

### 1. Two axes, and one rule over them

Every capacity metric is placed on two axes: **what it describes** —
`domain-pressure` (the simulation is behind) or `infrastructure-load` (the machine is busy) — and
**whether a decision may rest on it** — `authoritative` or `diagnostic`.

The rule the whole milestone inherits:

> **Infrastructure load alone never justifies a capacity change. Domain pressure does, and
> infrastructure load explains it.**

Consequently every `infrastructure-load` metric is `diagnostic`, and CPU in particular can never
be authoritative. This is enforced, not merely asserted: `authoritativeMetrics()` filters on the
class, and `capacity.test.ts` fails if any infrastructure-load metric is marked authoritative.

### 2. The authoritative set is small — three metrics

`oldest-due-event-age` (queue lateness), `queue-growth-rate`, and `late-tick-rate`. A model where
eleven numbers can each trigger a scale-up is a model whose first false positive comes from
whichever is noisiest. The bound is encoded (`authoritativeMetrics().length <= 3`); raising it is
a change to this ADR, not a nudge because a new metric felt important. Everything else — CPU,
memory, pool, tick duration, raw counts and single-sided rates — is diagnostic and explains a
decision the authoritative three justify.

### 3. Rates, not totals, for anything authoritative

A running counter since process start resets on deploy and only grows, so it is diagnostic. Its
rate over a stated window is a signal. The authoritative rates are derived from the counters that
already exist rather than by adding new ones.

### 4. Two latenesses, defined apart, queue lateness in game time

_Tick lateness_ (`late-tick-rate` — a tick overran its interval) and _queue lateness_
(`oldest-due-event-age` — the oldest due event is behind the world clock) are different facts and
both matter; conflating them makes "the engine is late" unactionable. Queue lateness is a
**game-time** comparison — `gameTime(clock, now) − oldest fire_at`, both in the world's calendar,
because `fire_at` is game time (ADR-0005). `WORKER_BEHIND_AFTER_MS` is the single authoritative
threshold and `assessNode()` its single intended implementation; the model references them and
does not restate the number. (A correctness note about `assessNode()`'s current wall-vs-game
arithmetic is recorded in `docs/capacity.md` for a separate behaviour decision — this ADR fixes
the _definition_, not the code.)

### 5. The contract is typed, and the prose follows it

The model lives as data in `packages/shared/src/capacity.ts` (`CAPACITY_METRICS`), with
`docs/capacity.md` as its readable form. A contract that lived only in prose would drift the first
time a field was renamed; the typed half is what keeps it true, and a drift test asserts every
typed key appears in the document.

### 6. Gaps are named, not hidden

Metrics that cannot be obtained today are in the model marked `gap`, with what would close them:
`queue-growth-rate` and `event-arrival-rate` (no retained series; SCALE-02), `in-flight-events`
(the drain is sequential, so the value is structurally 0 or 1 until SCALE-09), and
`pool-utilisation`/`pool-wait` (`pg.Pool` publishes the numbers; nothing samples them). Recording
a gap is how the moment it closes has somewhere defined to land.

## Consequences

- SCALE-02 through SCALE-11 have one vocabulary and one classification to build on, and cannot
  each invent "pressure".
- No console can honestly present CPU as a reason to scale; the model forbids it and the type
  enforces it.
- The `assessNode()` game-time discrepancy is now written down where a maintainer will see it,
  rather than latent behind an empty dev queue.
- Healthy ranges on the production box remain mostly unmeasured, because no world under real load
  has run on it yet. This ADR owns the vocabulary; V&V (V-19, V-21) owns the budgets stated in it.

## Alternatives considered

- **CPU-and-memory thresholds, like an ordinary web service.** Rejected: it is the exact failure
  mode this milestone exists to prevent, and it inverts on a durable-queue workload.
- **A large authoritative set covering every pressure metric.** Rejected: noise. The smallest set
  that answers "are we behind, are we falling further behind, can the engine hold cadence" is
  three.
- **Prose only, no type.** Rejected: it drifts. The type is the half that stays true.
