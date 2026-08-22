import { createFlightArriveHandler } from '../flight/settle';
import { type HandlerRegistry, type WorldEventType } from '../sim/event-queue';

/**
 * What a Worker built from this tree can actually do (SCALE-06).
 *
 * This used to be an object literal in `worker.ts`, which was fine while the
 * only thing that needed to know was the engine that was already running. The
 * deployment gate needs the same answer from a process that must **not** run —
 * and the moment two places answer "what can this build handle", they can
 * disagree. A build whose gate says `FLIGHT_ARRIVE` while its engine registers
 * something else is worse than no gate at all, because it is a gate that lies.
 *
 * So there is one registry and one factory, and `--handled-event-types` reads
 * the keys of the same object `createSimulationEngine` is handed. Drift is not
 * unlikely here; it is impossible.
 *
 * ## One entry today
 *
 * `FLIGHT_DEPART` is scheduled by `schedule/store.ts` when flights are
 * materialised and `TURNAROUND_COMPLETE` by nothing yet, and neither has a
 * handler — departure is M2/M4 behaviour and inventing one here would be exactly
 * the accidental decision ADR-0019's boundary exists to prevent.
 *
 * Since SCALE-05 that gap is survivable at runtime: `drainDueEvents` marks an
 * event of an unhandled type `unsupported` rather than `failed`, nothing is
 * attempted and nothing is destroyed, and the first Worker that ships the
 * handler puts the rows back. SCALE-06 is the other end of the same problem —
 * survivable is not the same as intended, and a Worker that will park a queue
 * full of real work should be refused at deploy time rather than explained
 * afterwards.
 */
export function createHandlerRegistry(): HandlerRegistry {
  return {
    FLIGHT_ARRIVE: createFlightArriveHandler(),
  };
}

/**
 * The event types this build handles, sorted.
 *
 * Derived from the registry rather than listed beside it — see above. Sorted so
 * that the bundle's output is stable: the deploy prints this into a log an
 * operator compares across runs, and key insertion order is not a promise worth
 * relying on for that.
 *
 * Building the registry to read its keys does instantiate the handlers, which is
 * deliberate. `createFlightArriveHandler()` closes over its dependencies and
 * touches nothing — no database, no clock, no I/O — so the cost is a closure,
 * and the alternative is a second list to keep in step.
 */
export function handledEventTypes(): WorldEventType[] {
  return (Object.keys(createHandlerRegistry()) as WorldEventType[]).sort((a, b) =>
    a.localeCompare(b),
  );
}
