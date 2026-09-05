import { and, eq } from 'drizzle-orm';

import {
  type AuthoredLeg,
  type CreateScheduleRequest,
  type EditScheduleRequest,
  type ScheduleAuthoringProblem,
  type ScheduleCostEstimate,
  type ScheduleLegCost,
  type ScheduleView,
  AircraftSpec as AircraftSpecSchema,
  type AircraftSpec,
} from '@tailfin/shared';
import {
  type AircraftCapability,
  computeBlockTime,
  DEFAULT_FLIGHT_PROFILE,
  computeTurnaround,
  DEFAULT_TURNAROUND_MINUTES,
  handlingProfile,
  gameTime,
  horizonFrom,
  MINUTES_PER_DAY,
  type RepeatPattern,
  routeVariableCostPerSeatMinor,
  type WorldClock,
} from '@tailfin/sim';

import { airframe, route, schedule, world } from '../db/schema';
import { loadWorldEconomyConfig } from '../economy/loader';
import { handlingArrangementFor } from '../ground/contracts';
import { absoluteFromLocal, loadAirportOffsets } from '../network/airport-time';
import { primeEconomicsScope, type RouteEconomicsScope } from '../network/economics';
import { openRoute } from '../network/open-route';
import { resolveLegSlots } from '../network/slots';

import { readSchedule } from './read';
import {
  createSchedule,
  deleteSchedule,
  replaceScheduleLegs,
  setScheduleActive,
  type LegInput,
} from './store';

import type { ResolvedPlayerAirline } from '../airline/context';
import type { Database } from '../db/client';
import type { RouteEconomics, RouteRow } from '../network/fares';

/**
 * Turning an authored rotation into flights (M2-03, §8.2).
 *
 * A rotation is a **sequence of stops**, so the player authors legs as airport
 * pairs and the server does the rest, all against the **actual airframe**:
 *
 *   - **Finds or opens each leg's route.** A pair the airline already flies is
 *     reused; one it does not is opened, reachability/range/runway/wingspan and
 *     operating authority all checked against this aeroplane's spec — so a leg the
 *     aircraft physically cannot fly is refused, naming why.
 *   - **Adds a nonstop return** when `autoReturn` is set — from the last stop back
 *     to the first, placed as soon as the aircraft has landed and turned.
 *   - **Places the legs and prices them.** Block time comes from the airframe's
 *     cruise speed; a cost estimate per leg is surfaced (never a gate — a player
 *     may fly a loss-making route on purpose).
 */

/** How the economics of one leg's route are resolved — the network provider. */
export type RouteEconomicsProvider = (
  row: RouteRow,
  /**
   * The lookups every leg of one request shares (BUG-08). Optional: a provider
   * handed none reads them for itself, which is what every caller did before a
   * rotation's legs were costed in a loop.
   */
  scope?: RouteEconomicsScope,
) => Promise<RouteEconomics>;

/** The airframe capability the reachability and range checks run against. */
export function airframeCapability(spec: AircraftSpec): AircraftCapability {
  return {
    rangeNm: spec.rangeNm,
    takeoffRunM: spec.runwayRequirementM,
    wingspanCode: spec.wingspanCode,
    // AircraftSpec carries no ETOPS approval yet; null flies within the default
    // 60-minute diversion rule, which is every route this reference network flies.
    etopsMinutes: null,
  };
}

interface ResolvedLeg {
  routeId: string;
  originIcao: string;
  destinationIcao: string;
  greatCircleNm: number;
  /** Minute-of-day the player asked for, or null for an auto-return (placed ASAP). */
  departureMinuteLocal: number | null;
  /** Whether this save opened the route rather than reusing one the airline held. */
  opened: boolean;
}

interface Refusal {
  problem: ScheduleAuthoringProblem;
  detail: string;
}
type LegResolution = { ok: true; leg: ResolvedLeg } | ({ ok: false } & Refusal);

/** The owned airframe's spec, or null when the aircraft is not this airline's. */
async function loadOwnedAirframeSpec(
  db: Database,
  own: ResolvedPlayerAirline,
  airframeId: string,
): Promise<AircraftSpec | null> {
  const [row] = await db
    .select({ effectiveSpec: airframe.effectiveSpec })
    .from(airframe)
    .where(
      and(
        eq(airframe.id, airframeId),
        eq(airframe.airlineId, own.id),
        eq(airframe.worldId, own.worldId),
      ),
    )
    .limit(1);
  if (!row) return null;
  const parsed = AircraftSpecSchema.safeParse(JSON.parse(row.effectiveSpec) as unknown);
  return parsed.success ? parsed.data : null;
}

/** The route for a pair the airline already holds, or null. */
async function existingRoute(
  db: Database,
  own: ResolvedPlayerAirline,
  originIcao: string,
  destinationIcao: string,
): Promise<{ id: string; greatCircleNm: number } | null> {
  const [row] = await db
    .select({ id: route.id, greatCircleNm: route.greatCircleNm })
    .from(route)
    .where(
      and(
        eq(route.airlineId, own.id),
        eq(route.worldId, own.worldId),
        eq(route.originIcao, originIcao),
        eq(route.destinationIcao, destinationIcao),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Turn an `openRoute` refusal into a schedule refusal, naming the leg. */
function refuseOpen(
  outcome: Extract<Awaited<ReturnType<typeof openRoute>>, { ok: false }>,
  originIcao: string,
  destinationIcao: string,
): Refusal {
  const leg = `${originIcao}→${destinationIcao}`;
  switch (outcome.kind) {
    case 'unknown-airport':
      return { problem: 'unknown_airport', detail: `No airport ${outcome.icao}.` };
    case 'same-airport':
      return { problem: 'unreachable', detail: `A leg cannot start and end at ${originIcao}.` };
    case 'unreachable':
      return {
        problem: 'unreachable',
        detail: `${leg} cannot be flown: ${outcome.reachability.detail}`,
      };
    case 'authority':
      return {
        problem: 'authority_required',
        detail: `${leg} needs the Safety & Compliance office (${outcome.reason}).`,
      };
    case 'airline-not-active':
      return { problem: 'unreachable', detail: `Your airline is ${outcome.status}.` };
    case 'duplicate':
      // The route was created concurrently; the caller re-reads it. Not reachable
      // on the ordinary path, but mapped so the type is exhaustive.
      return { problem: 'unreachable', detail: `${leg} could not be resolved; try again.` };
  }
}

/** Find or open the route for one leg, range-checked against the airframe. */
async function resolveOrOpenLeg(
  db: Database,
  own: ResolvedPlayerAirline,
  capability: AircraftCapability,
  originIcao: string,
  destinationIcao: string,
  departureMinuteLocal: number | null,
): Promise<LegResolution> {
  const held = await existingRoute(db, own, originIcao, destinationIcao);
  if (held) {
    // An existing route may have been opened for a longer-range aeroplane, so
    // range-check it against the one actually being scheduled.
    if (held.greatCircleNm >= capability.rangeNm) {
      return {
        ok: false,
        problem: 'unreachable',
        detail: `${originIcao}→${destinationIcao} is out of range: ${Math.round(held.greatCircleNm)} nm, the aircraft does ${String(capability.rangeNm)} nm.`,
      };
    }
    return {
      ok: true,
      leg: {
        routeId: held.id,
        originIcao,
        destinationIcao,
        greatCircleNm: held.greatCircleNm,
        departureMinuteLocal,
        opened: false,
      },
    };
  }

  const opened = await openRoute(db, own, { originIcao, destinationIcao }, capability);
  if (!opened.ok) {
    if (opened.kind === 'duplicate') {
      // Lost a race to open it — it exists now, so read it back.
      const now = await existingRoute(db, own, originIcao, destinationIcao);
      if (now) {
        return {
          ok: true,
          leg: {
            routeId: now.id,
            originIcao,
            destinationIcao,
            greatCircleNm: now.greatCircleNm,
            departureMinuteLocal,
            opened: false,
          },
        };
      }
    }
    return { ok: false, ...refuseOpen(opened, originIcao, destinationIcao) };
  }
  return {
    ok: true,
    leg: {
      routeId: opened.routeId,
      originIcao,
      destinationIcao,
      greatCircleNm: opened.greatCircleNm,
      departureMinuteLocal,
      opened: true,
    },
  };
}

export type PreparedLegs = { ok: true; legs: ResolvedLeg[] } | ({ ok: false } & Refusal);

/**
 * Resolve every authored leg to a route, opening what is missing, and append the
 * nonstop return when asked.
 */
export async function prepareLegs(
  db: Database,
  own: ResolvedPlayerAirline,
  capability: AircraftCapability,
  authored: readonly AuthoredLeg[],
  autoReturn: boolean,
): Promise<PreparedLegs> {
  const legs: ResolvedLeg[] = [];
  for (const leg of authored) {
    const resolution = await resolveOrOpenLeg(
      db,
      own,
      capability,
      leg.originIcao.toUpperCase(),
      leg.destinationIcao.toUpperCase(),
      leg.departureMinuteLocal,
    );
    if (!resolution.ok) return resolution;
    legs.push(resolution.leg);
  }

  if (autoReturn && legs.length > 0) {
    const first = legs[0]!;
    const last = legs[legs.length - 1]!;
    // Only when the aircraft is not already back where it started — otherwise a
    // return leg would start and end at the same airport.
    if (last.destinationIcao !== first.originIcao) {
      const resolution = await resolveOrOpenLeg(
        db,
        own,
        capability,
        last.destinationIcao,
        first.originIcao,
        null,
      );
      if (!resolution.ok) return resolution;
      legs.push(resolution.leg);
    }
  }

  return { ok: true, legs };
}

/**
 * Place resolved legs into a rotation: absolute minutes from the cycle anchor,
 * with each leg's computed block and turnaround.
 *
 * A chosen departure time is **local** to the airport the leg leaves from, so it
 * is converted to the absolute (UTC-anchor) minute the rest of the pipeline runs
 * on via that airport's UTC offset (M3-04a). Leg 0 departs at its own converted
 * minute-of-day; each later leg with a chosen time departs at the first
 * occurrence of that minute at or after the previous leg has landed and turned,
 * so a rotation that spills past midnight rolls to the next day. A leg with no
 * chosen time (the auto-return) departs as soon as it can — an absolute quantity
 * already, and its local time is a consequence.
 *
 * The one edge this first cut does not fully model: for a **weekly** rotation at
 * a large offset, a local departure can cross UTC midnight and so land on the
 * adjacent UTC cycle day. The time is correct; the calendar day can be off by
 * one at the extremes. Daily rotations — the common case — are exact.
 */
export function placeLegs(
  legs: readonly ResolvedLeg[],
  cruiseSpeedKt: number,
  offsets: ReadonlyMap<string, number> = new Map(),
  turnaroundFor: (icao: string) => number = () => DEFAULT_TURNAROUND_MINUTES,
): LegInput[] {
  const placed: LegInput[] = [];
  let earliest = 0;
  for (const [index, leg] of legs.entries()) {
    // Whole minutes: `schedule_leg.block_minutes` is an integer column, and a leg
    // is a plan rather than a settlement — the precise block time is recomputed at
    // arrival. `computeBlockTime` returns a fractional figure, so round it here.
    const blockMinutes = Math.round(
      computeBlockTime(leg.greatCircleNm, cruiseSpeedKt, DEFAULT_FLIGHT_PROFILE).blockMinutes,
    );
    /*
     * The turn happens where the aeroplane lands, so it is the **destination's**
     * handler that decides how long it takes (M5-06, §9.3). Resolved by the
     * caller, because this function is pure and the arrangement is a database
     * fact; unresolved, it falls back to the type's unimproved baseline, which is
     * what every leg used before a handler could reach it.
     */
    const turnaroundMinutes = turnaroundFor(leg.destinationIcao);

    let departureMinute: number;
    if (leg.departureMinuteLocal === null) {
      departureMinute = earliest;
    } else {
      departureMinute = absoluteFromLocal(
        leg.departureMinuteLocal,
        offsets.get(leg.originIcao) ?? 0,
      );
      if (index > 0) {
        while (departureMinute < earliest) departureMinute += MINUTES_PER_DAY;
      }
    }

    placed.push({
      originIcao: leg.originIcao,
      destinationIcao: leg.destinationIcao,
      departureMinute,
      blockMinutes,
      turnaroundMinutes,
    });
    earliest = departureMinute + blockMinutes + turnaroundMinutes;
  }
  return placed;
}

/**
 * How long a turn takes at each station a rotation lands at (M5-06, §9.3).
 *
 * §9.3's *"cheap ramp handlers = slower turns"*, wired. Until this existed the
 * grade changed a turn's **cost** and its **reliability** and not its duration:
 * `speedFactor` was modelled, published on every vendor offer and read by
 * nothing, because `placeLegs` used the type's flat baseline for every leg.
 *
 * ## What is live here, and what is not
 *
 * The handler is the only input that varies. Everything else `computeTurnaround`
 * takes stays the stand-in it already was, and deliberately:
 *
 *   - **the stand is `contact`**, because there is no gate allocation to ask
 *     (App. B.6's remote-stand penalty has nothing to trigger it yet);
 *   - **congestion is 1**, because §3.3's airport busyness is not modelled;
 *   - **no boosts**, because §10.4's ladder has nothing wired to a schedule;
 *   - **the seat term is zero** — `seats` is passed equal to `referenceSeats`.
 *     `DEFAULT_TURNAROUND_MINUTES` is quoted at no published reference cabin, so
 *     comparing an airframe's real seat count against it would be inventing a
 *     balance number rather than wiring one. When the catalogue carries §7.1's
 *     per-type turnaround baseline, that is where this changes.
 *
 * ## It is fixed when the schedule is written
 *
 * `schedule_leg.turnaround_minutes` is a stored plan, so signing a better
 * handler does not shorten the turns of a rotation authored before it — the
 * player re-saves, and the editor shows the new figure. That matches what the
 * column already is: the plan crew legality is checked against and the plan the
 * player is looking at, rather than a live reading. Resolving it at
 * materialisation instead would make a saved rotation's timings move underneath
 * the player without them touching it, which is a bigger change than this defect
 * warrants and is worth its own decision.
 *
 * Exported because it is the seam where this reads the database, and the pure
 * half (`placeLegs`) cannot cover it — see `turnaround-db.test.ts`.
 */
export async function turnaroundResolver(
  db: Database,
  own: ResolvedPlayerAirline,
  legs: readonly ResolvedLeg[],
): Promise<(icao: string) => number> {
  const stations = [...new Set(legs.map((leg) => leg.destinationIcao))];
  if (stations.length === 0) return () => DEFAULT_TURNAROUND_MINUTES;

  const economy = await loadWorldEconomyConfig(db, own.worldId);
  const minutes = new Map<string, number>();

  for (const icao of stations) {
    const arrangement = await handlingArrangementFor(db, own.id, icao, 'ramp_baggage', economy);
    const turn = computeTurnaround(
      {
        baseTurnaroundMinutes: DEFAULT_TURNAROUND_MINUTES,
        // Equal, so the seat term contributes nothing — see the note above.
        seats: 1,
        referenceSeats: 1,
      },
      {
        stand: 'contact',
        vendor: { speedFactor: handlingProfile(arrangement).speedFactor },
        cabinOptionMinutes: 0,
        serviceMinutes: 0,
        congestionFactor: 1,
        boosts: [],
      },
    );
    // Whole minutes: `schedule_leg.turnaround_minutes` is an integer column, and
    // a leg is a plan rather than a settlement.
    minutes.set(icao, Math.round(turn.minutes));
  }

  return (icao) => minutes.get(icao) ?? DEFAULT_TURNAROUND_MINUTES;
}

/** The variable cost and distance of each leg, surfaced for the player (§14). */
export async function estimateCost(
  own: ResolvedPlayerAirline,
  legs: readonly ResolvedLeg[],
  economicsFor: RouteEconomicsProvider,
  /**
   * The lookups every leg of this rotation shares, read once (BUG-08).
   *
   * Passed in rather than primed here because this function has no `db` — it
   * takes its economics as a parameter, which is the seam that lets the pure
   * tests drive it. Omitting it is correct and costs what it used to: each leg
   * reads the world and the airline again for itself.
   */
  scope?: RouteEconomicsScope,
): Promise<ScheduleCostEstimate> {
  const legCosts: ScheduleLegCost[] = [];
  let totalDistanceNm = 0;
  let totalVariableCostMinor = 0;
  let routesOpened = 0;

  for (const leg of legs) {
    const economics = await economicsFor(
      {
        id: leg.routeId,
        worldId: own.worldId,
        airlineId: own.id,
        originIcao: leg.originIcao,
        destinationIcao: leg.destinationIcao,
        greatCircleNm: leg.greatCircleNm,
        fares: {},
      },
      scope,
    );
    const variableCostMinor = Math.round(
      routeVariableCostPerSeatMinor(
        {
          distanceNm: leg.greatCircleNm,
          aircraft: economics.aircraft,
          market: economics.market,
          originStation: economics.originStation,
          originFees: economics.originFees,
          destinationFees: economics.destinationFees,
        },
        economics.settlement,
      ).sectorCostMinor,
    );

    legCosts.push({
      originIcao: leg.originIcao,
      destinationIcao: leg.destinationIcao,
      distanceNm: leg.greatCircleNm,
      opened: leg.opened,
      variableCostMinor,
    });
    totalDistanceNm += leg.greatCircleNm;
    totalVariableCostMinor += variableCostMinor;
    if (leg.opened) routesOpened += 1;
  }

  return { legs: legCosts, totalDistanceNm, totalVariableCostMinor, routesOpened };
}

/** The wire's unbranded 1–7 weekday narrowed to the sim's literal union. */
function toSimRepeat(repeat: CreateScheduleRequest['repeat']): RepeatPattern {
  return repeat.kind === 'weekdays'
    ? { kind: 'weekdays', days: repeat.days.map((d) => d as 1 | 2 | 3 | 4 | 5 | 6 | 7) }
    : { kind: 'daily' };
}

/** The outcome of authoring a schedule, in the vocabulary the route handler maps to HTTP. */
export type AuthorScheduleResult =
  | {
      status: 'created';
      schedule: ScheduleView;
      warning: string | null;
      cost: ScheduleCostEstimate;
    }
  /** The airframe is not this airline's — a 404, not an oracle. */
  | { status: 'unknown_airframe' }
  /** The rotation cannot run (a leg is unreachable/needs authority, or it does not close…). */
  | { status: 'refused'; problem: ScheduleAuthoringProblem; detail: string };

/**
 * Author a schedule for an airline, end to end.
 *
 * The whole database side of `POST /api/schedules`: resolve the airframe and its
 * capability, find or open every leg's route against it, place the rotation,
 * validate and write it, and price it. Kept out of the route handler so the
 * handler stays a thin mapping to status codes.
 */
export async function authorSchedule(
  db: Database,
  own: ResolvedPlayerAirline,
  request: CreateScheduleRequest,
  economicsFor: RouteEconomicsProvider,
): Promise<AuthorScheduleResult> {
  const spec = await loadOwnedAirframeSpec(db, own, request.airframeId);
  if (spec === null) return { status: 'unknown_airframe' };
  const capability = airframeCapability(spec);

  const prepared = await prepareLegs(db, own, capability, request.legs, request.autoReturn);
  if (!prepared.ok)
    return { status: 'refused', problem: prepared.problem, detail: prepared.detail };

  const offsets = await loadAirportOffsets(
    db,
    prepared.legs.map((leg) => leg.originIcao),
  );
  const placed = placeLegs(
    prepared.legs,
    spec.cruiseSpeedKt,
    offsets,
    await turnaroundResolver(db, own, prepared.legs),
  );
  const result = await createSchedule(
    db,
    {
      worldId: own.worldId,
      airlineId: own.id,
      airframeId: request.airframeId,
      legs: placed,
      repeat: toSimRepeat(request.repeat),
    },
    // Slots resolved from real holdings — the M7-05 wiring the store has waited for.
    // `crewLegal` stays undefined so the database still decides crew.
    { slots: await resolveLegSlots(db, own, placed) },
  );
  if (!result.ok) {
    return { status: 'refused', problem: result.problem, detail: result.detail };
  }

  const view = await readSchedule(db, own, result.scheduleId);
  if (view === null) {
    // Written inside this same call; its absence is a bug, not a player-facing 404.
    throw new Error(`Schedule ${result.scheduleId} vanished immediately after creation`);
  }
  return {
    status: 'created',
    schedule: view,
    warning: result.warning?.detail ?? null,
    cost: await estimateCost(
      own,
      prepared.legs,
      economicsFor,
      await primeEconomicsScope(db, {
        worldId: own.worldId,
        airlineId: own.id,
        originIcaos: prepared.legs.map((leg) => leg.originIcao),
      }),
    ),
  };
}

/** The world's clock parameters, or null for an unknown world. */
async function worldClockOf(db: Database, worldId: string): Promise<WorldClock | null> {
  const [row] = await db
    .select({
      epoch: world.epoch,
      launchDate: world.launchDate,
      speedMultiplier: world.speedMultiplier,
    })
    .from(world)
    .where(eq(world.id, worldId))
    .limit(1);
  if (!row) return null;
  return {
    epoch: row.epoch,
    launchDate: row.launchDate,
    speedMultiplier: Number(row.speedMultiplier),
  };
}

/** The outcome of editing a schedule's legs, mapped to HTTP by the route handler. */
export type EditScheduleResult =
  | { status: 'updated'; schedule: ScheduleView; cost: ScheduleCostEstimate }
  /** No such schedule for this airline — a 404, not an oracle. */
  | { status: 'not_found' }
  /** The new rotation cannot run, and here is exactly why. */
  | { status: 'refused'; problem: ScheduleAuthoringProblem; detail: string };

/**
 * Replace a schedule's legs and repeat, owner-scoped (M2-03 lifecycle).
 *
 * Keeps the schedule's airframe — a schedule is one airframe's rotation — and
 * checks the new legs against it exactly as authoring does. `replaceScheduleLegs`
 * reconciles the flights already on the horizon: only future, unflown ones move.
 */
export async function editSchedule(
  db: Database,
  own: ResolvedPlayerAirline,
  scheduleId: string,
  request: EditScheduleRequest,
  economicsFor: RouteEconomicsProvider,
  now: Date = new Date(),
): Promise<EditScheduleResult> {
  const [owned] = await db
    .select({ airframeId: schedule.airframeId })
    .from(schedule)
    .where(and(eq(schedule.id, scheduleId), eq(schedule.airlineId, own.id)))
    .limit(1);
  if (!owned) return { status: 'not_found' };

  const spec = await loadOwnedAirframeSpec(db, own, owned.airframeId);
  // A schedule whose airframe has since been sold cannot be range-checked; refuse
  // rather than guess with a reference aeroplane.
  if (spec === null) return { status: 'not_found' };
  const capability = airframeCapability(spec);

  const prepared = await prepareLegs(db, own, capability, request.legs, request.autoReturn);
  if (!prepared.ok)
    return { status: 'refused', problem: prepared.problem, detail: prepared.detail };

  const clock = await worldClockOf(db, own.worldId);
  if (clock === null) return { status: 'not_found' };
  const gameNow = gameTime(clock, now);

  const offsets = await loadAirportOffsets(
    db,
    prepared.legs.map((leg) => leg.originIcao),
  );
  const placed = placeLegs(
    prepared.legs,
    spec.cruiseSpeedKt,
    offsets,
    await turnaroundResolver(db, own, prepared.legs),
  );
  const outcome = await replaceScheduleLegs(
    db,
    scheduleId,
    placed,
    toSimRepeat(request.repeat),
    gameNow,
    horizonFrom(gameNow),
    // Same slot resolution as create — an edit is authored under the same rule.
    { slots: await resolveLegSlots(db, own, placed) },
  );
  if (!outcome.ok) return { status: 'refused', problem: outcome.problem, detail: outcome.detail };

  const view = await readSchedule(db, own, scheduleId);
  if (view === null) throw new Error(`Schedule ${scheduleId} vanished immediately after an edit`);
  return {
    status: 'updated',
    schedule: view,
    cost: await estimateCost(
      own,
      prepared.legs,
      economicsFor,
      await primeEconomicsScope(db, {
        worldId: own.worldId,
        airlineId: own.id,
        originIcaos: prepared.legs.map((leg) => leg.originIcao),
      }),
    ),
  };
}

/**
 * Pause or resume a schedule, owner-scoped. Returns the updated view, or null
 * when it is not this airline's.
 */
export async function pauseSchedule(
  db: Database,
  own: ResolvedPlayerAirline,
  scheduleId: string,
  active: boolean,
): Promise<ScheduleView | null> {
  const changed = await setScheduleActive(db, scheduleId, own.id, active);
  if (!changed) return null;
  return readSchedule(db, own, scheduleId);
}

/**
 * Delete a schedule and cancel its future flights, owner-scoped. Returns false
 * when it is not this airline's.
 */
export async function removeSchedule(
  db: Database,
  own: ResolvedPlayerAirline,
  scheduleId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const clock = await worldClockOf(db, own.worldId);
  if (clock === null) return false;
  return deleteSchedule(db, scheduleId, own.id, gameTime(clock, now));
}
