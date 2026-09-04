# ADR-0019: The web/worker boundary, with Postgres as the queue

- **Status:** Accepted
- **Date:** 2026-08-21
- **Deployed:** 2026-08-22 — OPS-09 runs the dev Worker on its own node. Production still
  has no Worker; OPS-12 owns that rollout.
- **Deciders:** @simmeh024
- **Constrains:** every scheduled job, every new server entry point, and the node topology in OPS-09 – OPS-16

## Context

Tailfin had one process. `main.ts` built the Fastify app, listened, and shut down; everything
ran inside it. Nothing anywhere stated which responsibilities were _web_ work and which were
_engine_ work, so the first person to wire up the simulation would have decided that by
accident, in whichever file they happened to be editing.

There was a narrow window worth using. The simulation did not run in **any** process:
`createTickLoop` (`sim/tick.ts`) and `drainDueEvents` (`sim/event-queue.ts`) were both built
and both tested since M1-06, and nothing called either of them. So this is not an extraction
from a monolith. It is choosing where the engine lives **before** it has a home, which is the
cheapest this decision will ever be.

Three facts shaped it:

- `esbuild` already emitted multiple entry points from `build.mjs`, so a multi-entry-point build
  is an established pattern here rather than a new one.
- The `world_event` table is already a durable job queue and already multi-worker-safe: rows
  are claimed `FOR UPDATE SKIP LOCKED`, one transaction per event, with a unique
  `(world_id, idempotency_key)` per world.
- `packages/sim` is pure and reads no clock (CONTRIBUTING invariant 2), so it does not care
  which process calls it.

## Decision

### 1. Two entry points, not one binary with a switch

`src/worker.ts` sits alongside `src/main.ts`, built from the same `build.mjs` with the same
build stamp. There is no `WORKER_ENABLED` flag.

A flag would produce one binary that is _sometimes_ both, and "sometimes both" is precisely
the state this boundary exists to prevent: the first person needing a scheduled job would set
the flag on the web node, and nobody would find out until it ran twice. Two entry points make
"web without worker" and "worker without web" the default rather than a configuration.

### 2. Web owns requests; the worker owns the clock

**Web owns** HTTP, the client bundle, the API, authentication and sessions, the admin console,
and any work short enough to finish inside a request.

**The worker owns** the tick loop, draining `world_event`, economy processing, demand and route
calculation, scheduled jobs, and anything CPU-heavy or long-running.

**Neither owns both, and a scheduled job has exactly one owner: the worker.**

### 3. Postgres remains the queue. No broker is adopted.

`world_event` already provides what Redis or RabbitMQ would be brought in for. A unique
`(world_id, idempotency_key)` refuses duplicates at the database rather than in application
logic that has to be right every time. `SKIP LOCKED` lets several workers drain one queue
without blocking or double-handling. Claim and handle share one transaction, so a worker that
dies mid-job leaves the row pending rather than half-done.

A broker would arrive with a second piece of infrastructure to run, secure, back up and reason
about, and would cost the property that matters most here: **a job and the data it changes
commit or roll back together.** No external broker can offer that.

### 4. The database is also the channel between the processes

Web writes a row; the worker picks it up. No RPC, no shared memory, no HTTP call between nodes
that has to be retried, authenticated and monitored. Where web needs something to happen _now_,
it writes the row with a `fire_at` already due.

M4-04 adds a scheduled mutation that is a due column rather than a queued event. A new order
persists an indexed `delivery_at`, and the same Worker tick claims due `aircraft_order` rows
with `FOR UPDATE SKIP LOCKED`. This is an extension of the channel, not an exception to the
ownership rule: web records the commitment, the Worker alone starts the delayed work, and
Postgres still makes claim plus materialisation atomic.

> **Superseded in part by [ADR-0026](0026-in-world-spans-are-game-time.md) (TIME-01,
> 2026-09-04).** This paragraph originally justified `delivery_at` as _wall-clock_ — §7.2 called
> a factory lead time weeks of real time, whereas `world_event.fire_at` is game time and
> accelerates with world speed. That exception is gone: `delivery_at` is now a game instant and
> the sweep compares it against `gameTime(clock, now())`. What survives unchanged is the shape
> and the ownership — a due column on the row that already owns the promise, claimed only by the
> Worker, rather than a second copy of it in the queue.

### 5. The boundary is enforced, not merely documented

- `eslint.config.js` forbids importing `sim/tick` anywhere in the server package except
  `worker.ts`, `engine/**` and the loop itself.
- `engine/boundary.test.ts` walks the module graph from `app.ts` and `main.ts` and asserts the
  loop and the whole of `engine/` are unreachable, then walks from `worker.ts` and asserts they
  are — and that `app.ts` is not.
- `engine/health.test.ts` asserts the worker's entire route table, so "serves nothing" is a
  property of a test rather than of intention.

Note the line: the restriction is on the **loop**, not on the queue. `sim/event-queue.ts` stays
open to the web process, because writing a due row is exactly how web is meant to ask the
worker for something.

## Consequences

**Deployment state.** At adoption this ADR started nothing: building the process and starting
it were deliberately separate so the first environment was chosen rather than inherited.
OPS-09 (#188) has since deployed `worker.js` on the dedicated dev Worker node. Production
still has no Worker; OPS-12 (#191) owns that separate rollout.

**A known gap, carried in the open.** The worker registers a handler for `FLIGHT_ARRIVE` only.
`FLIGHT_DEPART` is scheduled by `schedule/store.ts` when flights are materialised, and
`TURNAROUND_COMPLETE` by nothing yet; neither has a handler, because departure behaviour is M2
and M4 work and inventing it here would be exactly the accidental decision this ADR exists to
prevent.

That mattered operationally, because `drainDueEvents` marked an event of an unhandled type
`failed` rather than `done` — right, on the reasoning that an unhandled type is a deployment
problem and the row should still be there when the handler ships, and also a loaded gun. Start
a worker against a queue holding materialised departures and every one of those rows was marked
failed on the first tick.

**Closed by SCALE-05 (#454).** The reasoning was sound; the bug was that one state was being
asked to mean two things — _this event is broken_ and _this worker cannot do this yet_. There
is now a fourth `world_event_status`, `unsupported`:

- excluded from the claim predicate, so it cannot be reclaimed on every tick and starve the
  supported events behind it;
- not terminal, and nothing is attempted — `attempts` stays at zero and `processed_at` stays
  null, which is what makes returning it to `pending` a status change rather than a repair;
- counted apart from `failed` in `EngineSnapshot` and on the System Health page, so a rising
  `failed` means something is genuinely broken again;
- returned to the queue automatically by the first worker that boots with a handler for the
  type, and manually through an audited `POST /api/admin/events/requeue`.

The migration adding the enum value is written so the new value is never _used_ in the
transaction that adds it — the constraint it widens is expressed in terms of the two existing
terminal statuses — because `deploy.sh` batches the whole pending migration set into one
transaction and Postgres refuses the other shape.

So the gap is still real and still announced at boot and in `/healthz` as
`engine.unhandledEventTypes`. What changed is that meeting it now pauses work instead of
destroying it, and a worker may safely start against a database whose queue is not empty.

**Gated at deploy time by SCALE-06 (#455).** Safe is not the same as intended. A Worker rolled
back to a build without a handler still stops processing a type the world is generating, and
the operator's first sign is a growing pile of deferred work rather than a refused deploy.
`worker.js` therefore carries two probes — `--handled-event-types` and `--handler-preflight` —
which answer from the built bundle and return before `engine.start()` and before
`app.listen()`. `deploy.sh` runs the second for the Worker role only, after the migration
preflight and before the pre-migration backup, and fails closed on a gap.

The probes read the same registry the engine is handed, now `engine/handlers.ts` rather than a
literal in `worker.ts`. That is the load-bearing part: two lists would eventually disagree, and
a gate that approves builds it should refuse is worse than no gate. `/healthz` cannot serve
this purpose however carefully it is polled — the engine drains a tick before the first poll
lands, so the endpoint reports on a queue that has already met the build it was meant to
protect.

**Two processes are more to run than one.** The mitigation is that this change is code shape,
not machines: the split can land as two processes on one box and stay there indefinitely.
OPS-16's Checkpoint A makes stopping there a legitimate outcome.

**The worker has a port.** One, on loopback, serving `/healthz` and `/queues` and nothing else.
A worker with no port would be simpler and would also be a process nobody can ask anything:
`systemctl is-active` reports that Node is running, which is a different question from whether
the engine is ticking. `/healthz` answers 503 when the engine is stopped even though the
process is alive, which is the failure it exists to catch.

## Revisit when

The queue decision is a decision, not a rule. Adopt a broker if any of these is **measured**,
not anticipated:

- sub-second fan-out is required and Postgres polling cannot deliver it;
- cross-world pub/sub is needed, rather than per-world work queues;
- `SKIP LOCKED` contention is measurable at real queue depth on the real box.

Revisit the process split itself if the opposite happens: if the worker stays idle through
launch, one process would have been enough, and the seam costs nothing to leave in place.

## Alternatives considered

**A `WORKER_ENABLED` flag on `main.ts`.** Rejected in §1 — it makes "both" reachable by
configuration.

**A loop inside `main.ts` for now, extracted later.** Rejected. It is the option that is cheap
today and expensive at exactly the moment there are two web nodes, because the second one
starts a second loop and every job runs twice. The seam is worth having before it is needed.

**Redis or RabbitMQ.** Rejected in §3, with the revisit conditions above.

**An HTTP endpoint on the worker for web to call.** Rejected in §4: it needs authentication,
retries and monitoring, and it makes the worker reachable, which is the property most worth
denying it.

## References

- [OPS-08 #187](https://github.com/simmeh024/tailfinsim/issues/187) — the issue this answers
- [OPS-09 #188](https://github.com/simmeh024/tailfinsim/issues/188) · [OPS-16 #195](https://github.com/simmeh024/tailfinsim/issues/195) — where it gets run, and the four-node sequence
- [ADR-0003](0003-deployment-approach.md) — the single-box deployment this begins to outgrow
- [ADR-0005](0005-world-epoch-and-reset.md) — why `fire_at` is a game-time instant
- `packages/server/src/sim/event-queue.ts` · `packages/server/src/sim/tick.ts` — the queue and the loop
- `packages/server/src/engine/` — the engine, and the tests that hold the boundary
