import { asc, ne } from 'drizzle-orm';

import { gameTime, type WorldClock } from '@tailfin/sim';

import { deliverDueAircraftOrders } from '../aircraft/acquisition';
import { sweepMaintenance } from '../aircraft/maintenance';
import { refreshUsedAircraftMarket } from '../aircraft/used-market';
import { returnRestedCrew, standDownIdleCrew } from '../crew/duty-store';
import { returnSickCrew, reviewCrewMorale } from '../crew/morale';
import { runCrewPayroll } from '../crew/payroll';
import { completeDueConversions } from '../crew/store';
import { type Database } from '../db/client';
import { world, type WorldRow } from '../db/schema';
import { reviewNpcCarriers } from '../npc/operate';
import {
  drainDueEvents,
  queueDepth,
  type HandlerRegistry,
  type WorldEventType,
} from '../sim/event-queue';
import { createTickLoop, type TickLoop } from '../sim/tick';

/**
 * The simulation engine — what the worker process is *for* (OPS-08, §21).
 *
 * `createTickLoop` and `drainDueEvents` have both existed, tested, since M1-06,
 * and until now nothing anywhere called either of them. This is the thing that
 * calls them, and it lives here rather than in `app.ts` because the web process
 * must never acquire a heartbeat by convenience — ADR-0019 records the boundary
 * and `eslint.config.js` is what enforces it.
 *
 * Kept separate from `worker.ts` for the same reason `app.ts` is separate from
 * `main.ts`: everything interesting should be testable without a process, a port
 * or a signal handler.
 *
 * ## One loop, every world
 *
 * A loop per world is the obvious shape and the wrong one. Worlds are created,
 * reset and archived while the process runs, so the set is not known at start,
 * and N loops means N timers to reconcile against a table that changes underneath
 * them. One loop that re-reads the world list each tick is simpler and correct by
 * construction: a world created a second ago is drained a second later, and an
 * archived one stops being drained without anything having to be cancelled.
 *
 * The cost is one indexed `select` per tick against a table with single-digit
 * rows. That is not a cost.
 */

/** A world the engine will drive, with the clock its events are due against. */
export interface EngineWorld {
  id: string;
  name: string;
  clock: WorldClock;
}

/**
 * What one tick did.
 *
 * Reported per tick as well as accumulated, because "processed 400 events since
 * Tuesday" and "processed 400 events in the last second" are different
 * situations, and only one of them is interesting.
 */
export interface TickReport {
  tickNumber: number;
  tickedAt: Date;
  durationMs: number;
  worlds: number;
  processed: number;
  failed: number;
  /** Events left for a Worker that knows their type (SCALE-05). */
  unsupported: number;
  /** New factory orders materialised against wall-clock delivery dates. */
  aircraftDelivered: number;
  /** Used-market berths filled on this tick (M4-05). Zero on almost every one. */
  usedListingsCreated: number;
  /** Used listings withdrawn because they had been on the market too long. */
  usedListingsWithdrawn: number;
  /** Checks finished on this tick, and airframes grounded for deferring one (M4-06). */
  checksCompleted: number;
  airframesGrounded: number;
  /**
   * Type-rating conversions finished this run (M5-01).
   *
   * A counter for the same reason the maintenance ones exist: without a
   * worker, crew put into conversion never come out, and a Crew page showing
   * everybody permanently in a classroom reads as a broken feature rather
   * than a missing process.
   */
  crewConversionsCompleted: number;
  /** M5-02. Crew sets sent off duty because nothing more was dispatched. */
  crewStoodDown: number;
  /** M5-02. Crew sets whose rest finished and whose heads went back. */
  crewRested: number;
  /** M5-02. Airlines billed for a month of crew. */
  crewPaid: number;
  /** M5-03. Crew bases whose morale was reviewed. */
  moraleReviews: number;
  /** M5-03. Heads who resigned. The expensive half of section 9.2's bill. */
  crewResignations: number;
  /** M5-03. Heads who went off sick. */
  crewSickened: number;
  crewErrors: number;
}

export interface EngineLog {
  tick?: (report: TickReport) => void;
  error?: (error: unknown) => void;
  warn?: (message: string) => void;
  /** Notable but unalarming. An NPC review that actually did something (M3-12). */
  info?: (message: string) => void;
}

export interface SimulationEngineOptions {
  db: Database;

  /**
   * The handler for each kind of scheduled event.
   *
   * Passed in rather than looked up here, so the process that owns the engine
   * decides what it is able to do and a test can drive it with nothing at all.
   * `worker.ts` assembles the real registry and says out loud which types it
   * cannot handle.
   */
  handlers: HandlerRegistry;

  /** Real milliseconds between ticks. The coarse tick of §21 is 1000. */
  intervalMs?: number;

  log?: EngineLog;

  /** Injected in tests, so nothing waits in real time and no database is needed. */
  now?: () => Date;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  listWorlds?: (db: Database) => Promise<EngineWorld[]>;
  drain?: typeof drainDueEvents;
  /**
   * The NPC review (M3-12). Injectable so the engine's own tests do not need a
   * world full of carriers to assert the loop.
   */
  reviewNpcs?: typeof reviewNpcCarriers;
  /** Real-time aircraft delivery sweep (M4-04), injected in engine tests. */
  deliverAircraft?: typeof deliverDueAircraftOrders;
  /** Used-market generation and withdrawal (M4-05), injected in engine tests. */
  refreshUsedMarket?: typeof refreshUsedAircraftMarket;
  /** Check completion and maintenance grounding (M4-06), injected in engine tests. */
  sweepChecks?: typeof sweepMaintenance;
  /** Injected like the sweeps above, so the tick can be tested without Postgres. */
  completeConversions?: typeof completeDueConversions;
  /** M5-02. Ends the day for a crew set nothing dispatched. */
  standDownCrew?: typeof standDownIdleCrew;
  /** M5-02. Returns rested heads to their pools. */
  returnCrew?: typeof returnRestedCrew;
  /** M5-02. Bills the month's salaries and base overheads. */
  payCrew?: typeof runCrewPayroll;
  /** M5-03. Moves morale toward its target and collects the bill. */
  reviewMorale?: typeof reviewCrewMorale;
  /** M5-03. Returns crew whose sick leave has run out. */
  returnSick?: typeof returnSickCrew;
  depth?: typeof queueDepth;
}

/**
 * Everything a monitor can learn without touching the database.
 *
 * Deliberately a plain snapshot of in-memory counters. The worker's `/healthz`
 * has to be able to answer while Postgres is unreachable, because "the engine is
 * up and the database is not" is exactly the state somebody needs telling about,
 * and a health endpoint that needs a query to describe itself cannot say it.
 */
export interface EngineSnapshot {
  status: 'stopped' | 'running';
  startedAt: string | null;
  /** Ticks attempted, including any that threw. */
  ticks: number;
  /** Ticks that threw. A rising count is the signal that something is wrong. */
  errors: number;
  /** Ticks that overran the interval. */
  lateTicks: number;
  lastTickAt: string | null;
  lastTickDurationMs: number | null;
  /** Worlds driven on the last tick. */
  worlds: number;
  /** Events handled, and events whose handler threw, since this process started. */
  processed: number;
  failed: number;
  /**
   * Events this build could not handle, since it started (SCALE-05).
   *
   * Counted apart from `failed` deliberately. They used to share a number, which
   * made the more important one useless: `failed` should mean *something is
   * broken*, and its commonest cause was a build that simply did not have a
   * handler yet. A rising `failed` is now worth waking somebody for; a rising
   * `unsupported` is worth shipping a handler for.
   */
  unsupported: number;
  /**
   * Event types with no handler registered in this process.
   *
   * Not empty today, and saying so is still the point — but it is no longer a
   * loaded gun. Since SCALE-05 an event of an unhandled type is marked
   * `unsupported`: excluded from the claim so it cannot starve the queue, not
   * terminal, nothing attempted, and returned to `pending` by the first Worker
   * that knows the type. Starting an engine against a queue full of a type it
   * cannot handle now pauses that work instead of destroying it.
   */
  unhandledEventTypes: WorldEventType[];
  /** NPC decisions recorded since start, and reviews that threw (M3-12). */
  npcDecisions: number;
  npcErrors: number;
  aircraftDeliveries: number;
  aircraftDeliveryErrors: number;
  /** Used-market listings created and withdrawn since start, and sweeps that threw (M4-05). */
  usedListingsCreated: number;
  usedListingsWithdrawn: number;
  usedMarketErrors: number;
  /** Checks finished and airframes grounded since start, and sweeps that threw (M4-06). */
  checksCompleted: number;
  airframesGrounded: number;
  /**
   * Type-rating conversions finished this run (M5-01).
   *
   * A counter for the same reason the maintenance ones exist: without a
   * worker, crew put into conversion never come out, and a Crew page showing
   * everybody permanently in a classroom reads as a broken feature rather
   * than a missing process.
   */
  crewConversionsCompleted: number;
  /** M5-02. Crew sets sent off duty because nothing more was dispatched. */
  crewStoodDown: number;
  /** M5-02. Crew sets whose rest finished and whose heads went back. */
  crewRested: number;
  /** M5-02. Airlines billed for a month of crew. */
  crewPaid: number;
  /** M5-03. Crew bases whose morale was reviewed. */
  moraleReviews: number;
  /** M5-03. Heads who resigned. The expensive half of section 9.2's bill. */
  crewResignations: number;
  /** M5-03. Heads who went off sick. */
  crewSickened: number;
  crewErrors: number;
  maintenanceErrors: number;
}

export interface QueueDepthByWorld {
  worldId: string;
  name: string;
  due: number;
  oldestDueAt: Date | null;
}

export interface SimulationEngine {
  start: () => void;
  stop: () => Promise<void>;
  /** One tick, run inline. The engine need not have been started; used by tests. */
  runOnce: () => Promise<TickReport>;
  snapshot: () => EngineSnapshot;
  /** Queue depth per world. Hits the database, so it is not part of the snapshot. */
  queues: () => Promise<QueueDepthByWorld[]>;
}

/**
 * Every type the queue can carry.
 *
 * Listed rather than derived so that a missing handler is a known list rather
 * than a surprise — and so that adding a type to `WorldEventType` without
 * deciding who handles it fails to compile here.
 */
const ALL_EVENT_TYPES: readonly WorldEventType[] = [
  'FLIGHT_DEPART',
  'FLIGHT_ARRIVE',
  'TURNAROUND_COMPLETE',
];

function clockOf(row: WorldRow): WorldClock {
  return {
    epoch: row.epoch,
    launchDate: row.launchDate,
    // `numeric` arrives as a string; the clock wants a number.
    speedMultiplier: Number(row.speedMultiplier),
  };
}

/**
 * Every world whose clock is still running.
 *
 * All four statuses except `archived`. `staging` and `locked` both look like
 * candidates for exclusion and neither is: a staging world's clock is derived
 * from its epoch and launch date exactly like an open one's, and locking
 * deliberately stops *play* without stopping the clock — an aircraft in the air
 * when a world locks is still in the air when it reopens, which is only true if
 * its arrival still fires. Archived is the status that means "a record of what
 * happened", and draining one would keep changing the record.
 */
export async function listTickableWorlds(db: Database): Promise<EngineWorld[]> {
  const rows = await db
    .select()
    .from(world)
    .where(ne(world.status, 'archived'))
    .orderBy(asc(world.createdAt));

  return rows.map((row) => ({ id: row.id, name: row.name, clock: clockOf(row) }));
}

export function createSimulationEngine(options: SimulationEngineOptions): SimulationEngine {
  const {
    db,
    handlers,
    intervalMs = 1_000,
    log,
    now = () => new Date(),
    setTimer,
    clearTimer,
    listWorlds = listTickableWorlds,
    drain = drainDueEvents,
    depth = queueDepth,
    reviewNpcs = reviewNpcCarriers,
    deliverAircraft = deliverDueAircraftOrders,
    refreshUsedMarket = refreshUsedAircraftMarket,
    sweepChecks = sweepMaintenance,
    completeConversions = completeDueConversions,
    standDownCrew = standDownIdleCrew,
    returnCrew = returnRestedCrew,
    payCrew = runCrewPayroll,
    reviewMorale = reviewCrewMorale,
    returnSick = returnSickCrew,
  } = options;

  const unhandledEventTypes = ALL_EVENT_TYPES.filter((type) => handlers[type] === undefined);

  let startedAt: Date | null = null;
  let lastTickAt: Date | null = null;
  let lastTickDurationMs: number | null = null;
  let lastWorldCount = 0;
  let processed = 0;
  let failed = 0;
  let unsupported = 0;
  let npcDecisions = 0;
  let npcErrors = 0;
  let aircraftDeliveries = 0;
  let aircraftDeliveryErrors = 0;
  let usedListingsCreated = 0;
  let usedListingsWithdrawn = 0;
  let usedMarketErrors = 0;
  let checksCompleted = 0;
  let airframesGrounded = 0;
  let crewConversionsCompleted = 0;
  let crewStoodDown = 0;
  let crewRested = 0;
  let crewPaid = 0;
  let moraleReviews = 0;
  let crewResignations = 0;
  let crewSickened = 0;
  let crewErrors = 0;
  let maintenanceErrors = 0;

  async function tick(context: { tickedAt: Date; tickNumber: number }): Promise<TickReport> {
    const worlds = await listWorlds(db);
    let tickProcessed = 0;
    let tickFailed = 0;
    let tickUnsupported = 0;
    let tickAircraftDelivered = 0;
    let tickListingsCreated = 0;
    let tickListingsWithdrawn = 0;
    let tickChecksCompleted = 0;
    let tickCrewConversions = 0;
    let tickCrewStoodDown = 0;
    let tickCrewRested = 0;
    let tickCrewPaid = 0;
    let tickMoraleReviews = 0;
    let tickResignations = 0;
    let tickSickened = 0;
    let tickCrewErrors = 0;
    let tickAirframesGrounded = 0;

    for (const entry of worlds) {
      // Aircraft factory lead time is explicitly **real time** (§7.2), not a
      // world-event fire_at. The Worker still owns it: one sweep per tickable
      // world, exactly where other scheduled mutations live (ADR-0019).
      try {
        const delivery = await deliverAircraft(db, entry.id, now());
        tickAircraftDelivered += delivery.delivered;
        if (delivery.delivered > 0) {
          log?.info?.(
            `[${entry.name}] aircraft delivery: ${String(delivery.delivered)} order(s) arrived`,
          );
        }
      } catch (error) {
        aircraftDeliveryErrors += 1;
        log?.warn?.(`[${entry.name}] aircraft delivery sweep failed: ${String(error)}`);
      }

      // The used market (M4-05), against this world's *game* clock rather than
      // the wall clock the delivery sweep above uses. A generation is a game
      // week, so a world at 4× renews its market twice as often in real time as
      // one at 2× — which is the same asymmetry §7.2 draws between era gating
      // and factory lead time, kept deliberately.
      //
      // Called every tick and does nothing on almost all of them: one config
      // lookup, one date comparison and one indexed count in the common case.
      // Cheap enough not to need a schedule, and a schedule is a second thing
      // that can be wrong.
      //
      // Isolated like the NPC review, and for the same reason: a market that
      // could not renew this tick renews the next one, but a flight that never
      // settles is money that never moves.
      try {
        const market = await refreshUsedMarket(db, entry.id, now());
        tickListingsCreated += market.created;
        tickListingsWithdrawn += market.withdrawn;
        if (market.created > 0 || market.withdrawn > 0) {
          log?.info?.(
            `[${entry.name}] used market: ${String(market.created)} listed, ` +
              `${String(market.withdrawn)} withdrawn (generation ${String(market.generation)})`,
          );
        }
      } catch (error) {
        usedMarketErrors += 1;
        log?.warn?.(`[${entry.name}] used market refresh failed: ${String(error)}`);
      }

      // Maintenance (M4-06), also on this world's game clock: a check's downtime
      // is a span in the world's calendar, so a world at 4× returns its aeroplanes
      // to service twice as fast in real time. Factory lead time is the one thing
      // in the fleet that stays in real weeks (§7.2).
      //
      // Isolated like the two above. A sweep that could not run this tick runs the
      // next one; the aeroplane stays in its check a second longer, which is a
      // cosmetic delay rather than lost money.
      try {
        const swept = await sweepChecks(db, entry.id, now());
        tickChecksCompleted += swept.completed;
        tickAirframesGrounded += swept.grounded;
        if (swept.completed > 0 || swept.grounded > 0) {
          log?.info?.(
            `[${entry.name}] maintenance: ${String(swept.completed)} check(s) finished, ` +
              `${String(swept.grounded)} airframe(s) grounded`,
          );
        }
      } catch (error) {
        maintenanceErrors += 1;
        log?.warn?.(`[${entry.name}] maintenance sweep failed: ${String(error)}`);
      }

      /*
       * Crew conversions (M5-01, section 9.2), on this world's game clock for
       * the same reason: a fortnight of training is a span in the world's
       * calendar, so a world at 4x returns its crew to the roster twice as fast
       * in real time as one at 2x. Section 7.2's real weeks on factory
       * deliveries remain the exception.
       *
       * Isolated like the sweeps above. Crew who could not be released this tick
       * are released the next one; they stay in the classroom a second longer,
       * which is cosmetic rather than lost money.
       */
      try {
        const converted = await completeConversions(db, entry.id, gameTime(entry.clock, now()));
        tickCrewConversions += converted.completed;
        if (converted.completed > 0) {
          log?.info?.(
            `[${entry.name}] crew: ${String(converted.completed)} conversion(s) finished`,
          );
        }
      } catch (error) {
        tickCrewErrors += 1;
        log?.warn?.(`[${entry.name}] crew conversion sweep failed: ${String(error)}`);
      }

      /*
       * Duty and rest (M5-02, section 9.2). Two sweeps, in this order and not
       * the other: a set is sent off duty first, and the rest it earns is
       * measured from that moment, so returning crew before standing them down
       * would give the ones who finished this tick a free night.
       *
       * Also game time. A duty period is something that happens inside the
       * world, like a conversion and unlike a factory delivery.
       */
      try {
        const worldNow = gameTime(entry.clock, now());
        const down = await standDownCrew(db, entry.id, worldNow);
        const back = await returnCrew(db, entry.id, worldNow);
        tickCrewStoodDown += down.stoodDown;
        tickCrewRested += back.returned;
        if (down.stoodDown > 0 || back.returned > 0) {
          log?.info?.(
            `[${entry.name}] crew: ${String(down.stoodDown)} set(s) off duty, ` +
              `${String(back.returned)} rested`,
          );
        }

        /*
         * Payday (M5-02). Attempted every tick and billed once: the reference
         * carries the world's own calendar month and AIR-06 refuses a second
         * movement with the same cause and reference, so this is a no-op for all
         * but the first tick of a month -- and self-heals if the worker was down
         * across the boundary.
         */
        const paid = await payCrew(db, entry.id, worldNow);
        tickCrewPaid += paid.airlinesBilled;
        if (paid.airlinesBilled > 0) {
          log?.info?.(
            `[${entry.name}] crew payroll: ${String(paid.airlinesBilled)} airline(s), ` +
              `${String(Math.round(paid.totalMinor / 100))}`,
          );
        }

        /*
         * Morale (M5-03). The review is what makes section 9.2's bill *arrive*:
         * a base drifts toward the target its pay band, rosters, hotels and rest
         * imply, and pays for it in sickness and resignations. Weekly in game
         * time, and it skips a base reviewed inside the week -- running it every
         * tick would apply a week of attrition sixty times a minute.
         */
        const sickBack = await returnSick(db, entry.id, worldNow);
        const morale = await reviewMorale(db, entry.id, worldNow);
        tickMoraleReviews += morale.basesReviewed;
        tickResignations += morale.resignations;
        tickSickened += morale.sickened;
        if (morale.resignations > 0 || morale.sickened > 0 || sickBack.returned > 0) {
          log?.info?.(
            `[${entry.name}] crew morale: ${String(morale.resignations)} resigned, ` +
              `${String(morale.sickened)} off sick, ${String(sickBack.returned)} pool(s) recovered`,
          );
        }
      } catch (error) {
        tickCrewErrors += 1;
        log?.warn?.(`[${entry.name}] crew duty sweep failed: ${String(error)}`);
      }

      // Each world is drained against its own clock: `fire_at` is a game-time
      // instant, so what is due depends on where that world's clock has got to,
      // and two worlds at different speeds disagree about the same moment.
      const result = await drain(db, entry.id, entry.clock, now(), handlers, {
        log: (line) => {
          log?.warn?.(`[${entry.name}] ${line}`);
        },
      });
      tickProcessed += result.processed;
      tickFailed += result.failed;
      tickUnsupported += result.unsupported;

      // The NPC review, on the same tick and against the same clock (M3-12).
      // It decides for itself whether the world is due — the engine ticks every
      // second and a carrier reviews weekly in game time — so calling it every
      // tick costs one config lookup and a date comparison in the common case.
      //
      // A failure here must not stop the queue draining. An NPC that could not
      // review this tick reviews the next one; a flight that never settles is
      // money that never moves.
      try {
        const review = await reviewNpcs(db, entry.id, gameTime(entry.clock, now()));
        if (review.reviewed && review.logged > 0) {
          npcDecisions += review.logged;
          log?.info?.(
            `[${entry.name}] npc review: ${String(review.entered)} entered, ` +
              `${String(review.exited)} exited, ${String(review.faresChanged)} fares moved`,
          );
        }
      } catch (error) {
        npcErrors += 1;
        log?.warn?.(`[${entry.name}] npc review failed: ${String(error)}`);
      }
    }

    const durationMs = now().getTime() - context.tickedAt.getTime();

    processed += tickProcessed;
    failed += tickFailed;
    unsupported += tickUnsupported;
    aircraftDeliveries += tickAircraftDelivered;
    usedListingsCreated += tickListingsCreated;
    usedListingsWithdrawn += tickListingsWithdrawn;
    checksCompleted += tickChecksCompleted;
    airframesGrounded += tickAirframesGrounded;
    crewConversionsCompleted += tickCrewConversions;
    crewStoodDown += tickCrewStoodDown;
    crewRested += tickCrewRested;
    crewPaid += tickCrewPaid;
    moraleReviews += tickMoraleReviews;
    crewResignations += tickResignations;
    crewSickened += tickSickened;
    crewErrors += tickCrewErrors;
    lastTickAt = context.tickedAt;
    lastTickDurationMs = durationMs;
    lastWorldCount = worlds.length;

    return {
      tickNumber: context.tickNumber,
      tickedAt: context.tickedAt,
      durationMs,
      worlds: worlds.length,
      processed: tickProcessed,
      failed: tickFailed,
      unsupported: tickUnsupported,
      aircraftDelivered: tickAircraftDelivered,
      usedListingsCreated: tickListingsCreated,
      usedListingsWithdrawn: tickListingsWithdrawn,
      checksCompleted: tickChecksCompleted,
      airframesGrounded: tickAirframesGrounded,
      crewConversionsCompleted: tickCrewConversions,
      crewStoodDown: tickCrewStoodDown,
      crewRested: tickCrewRested,
      crewPaid: tickCrewPaid,
      moraleReviews: tickMoraleReviews,
      crewResignations: tickResignations,
      crewSickened: tickSickened,
      crewErrors: tickCrewErrors,
    };
  }

  const loop: TickLoop = createTickLoop({
    intervalMs,
    now,
    setTimer,
    clearTimer,
    onTick: async (context) => {
      const report = await tick(context);
      log?.tick?.(report);
    },
    onError: (error) => {
      log?.error?.(error);
    },
  });

  return {
    start(): void {
      if (loop.running) return;
      startedAt = now();
      loop.start();
    },

    async stop(): Promise<void> {
      // Awaited: `TickLoop.stop` returns once no tick is still mid-transaction,
      // which is the difference between a clean SIGTERM and a half-applied event.
      await loop.stop();
      startedAt = null;
    },

    runOnce(): Promise<TickReport> {
      return tick({ tickedAt: now(), tickNumber: loop.ticks + 1 });
    },

    snapshot(): EngineSnapshot {
      return {
        status: loop.running ? 'running' : 'stopped',
        startedAt: startedAt?.toISOString() ?? null,
        ticks: loop.ticks,
        errors: loop.errors,
        lateTicks: loop.lateTicks,
        lastTickAt: lastTickAt?.toISOString() ?? null,
        lastTickDurationMs,
        worlds: lastWorldCount,
        processed,
        failed,
        unsupported,
        unhandledEventTypes,
        npcDecisions,
        npcErrors,
        aircraftDeliveries,
        aircraftDeliveryErrors,
        usedListingsCreated,
        usedListingsWithdrawn,
        usedMarketErrors,
        checksCompleted,
        airframesGrounded,
        crewConversionsCompleted,
        crewStoodDown,
        crewRested,
        crewPaid,
        moraleReviews,
        crewResignations,
        crewSickened,
        crewErrors,
        maintenanceErrors,
      };
    },

    async queues(): Promise<QueueDepthByWorld[]> {
      const worlds = await listWorlds(db);
      const depths: QueueDepthByWorld[] = [];
      for (const entry of worlds) {
        const measured = await depth(db, entry.id, entry.clock, now());
        depths.push({ worldId: entry.id, name: entry.name, ...measured });
      }
      return depths;
    },
  };
}
