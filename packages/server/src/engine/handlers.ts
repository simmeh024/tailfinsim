import { createFlightDepartHandler } from '../flight/depart';
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
 * ## Two entries
 *
 * `FLIGHT_DEPART` arrived with M5-02, which is the milestone that finally needed
 * it: *"legality is a hard rule at departure"* requires a departure to be hard
 * at. It is a **dispatch gate** rather than a flight-operations model, and
 * `flight/depart.ts` says at length what it deliberately does not do. Adding it
 * was a decision rather than a drift — this comment previously said inventing a
 * departure would be *"the accidental decision ADR-0019's boundary exists to
 * prevent"*, and that remains true of an accidental one.
 *
 * `TURNAROUND_COMPLETE` is still scheduled by nothing and handled by nothing.
 *
 * Since SCALE-05 that gap is survivable at runtime: `drainDueEvents` marks an
 * event of an unhandled type `unsupported` rather than `failed`, nothing is
 * attempted and nothing is destroyed, and the first Worker that ships the
 * handler puts the rows back — which is exactly what the first Worker carrying
 * this build will do with every parked `FLIGHT_DEPART`. SCALE-06 is the other
 * end of the same problem: survivable is not the same as intended, and a Worker
 * that will park a queue full of real work should be refused at deploy time
 * rather than explained afterwards.
 */
export function createHandlerRegistry(): HandlerRegistry {
  return {
    FLIGHT_DEPART: createFlightDepartHandler(),
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
