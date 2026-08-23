import { eq } from 'drizzle-orm';

import type { CrewBalance } from '@tailfin/shared';
import {
  checkComplement,
  coversRank,
  cumulativeVerdict,
  maxFlightDutyMinutes,
  requiredComplement,
  type Complement,
  type CrewPool,
} from '@tailfin/sim';

import { aircraftType, airframe, airport, crewPool } from '../db/schema';
import { loadWorldEconomyConfig } from '../economy/loader';

import {
  commitComplement,
  dutyHistoryFor,
  endDutyPeriod,
  openPeriodFor,
  readBaseLocations,
  recordSector,
  startDutyPeriod,
  type CommittedSlot,
  type OpenDutyPeriod,
} from './duty-store';

import type { Database } from '../db/client';

/**
 * The hard rule at departure (M5-02, §9.2).
 *
 * ## Why this is a different check from the one at schedule-save
 *
 * M5-02's fourth acceptance criterion asks for a **warning** when a schedule is
 * saved and a **hard rule** at departure, and they really are different
 * questions. At save time the whole rotation is visible and none of it has
 * happened, so the honest answer is *"this plan has 45 minutes of slack in
 * it"*. At departure only the past is certain, and the question is the narrow
 * one a dispatcher actually asks: **may this aeroplane push back, now, with the
 * crew that are standing in front of it?**
 *
 * The sector count is where that shows. The rotation check uses the planned
 * count for the whole day, because that is what the regulation rosters against.
 * Dispatch uses *sectors already flown, plus this one*, because at the moment of
 * departure that is the only number that is a fact. Early in a day dispatch is
 * therefore the more permissive of the two — and by the last sector of the day
 * they converge on the same answer, which is the sector where it matters.
 *
 * ## What it does when the crew have run out
 *
 * In order:
 *
 *   1. **A reserve set, if the airline is paying for one.** §9.2's *"deliberately
 *      a hard call"*: reserves cost money every day and earn it back here.
 *   2. **A delay**, if the rested crew are back inside
 *      `crewTimeoutMaxDelayMinutes`.
 *   3. **A cancellation.** A crew that needs eleven hours is not a delay.
 *
 * Every one of those is recorded with the cause `crew_timeout`, which is what
 * M2-08 asked for and what makes *"why did this cancel"* answerable.
 *
 * ## What it deliberately does not do
 *
 * It does not roll for disruption. A flight that clears this may still be
 * delayed by weather, and `crewTimeoutRisk` is what feeds that roll — but a
 * crew *timeout* is not a probability, it is arithmetic, and mixing the two
 * would make a legal flight occasionally illegal for no reason a player could
 * inspect.
 */

export type DispatchDecision =
  | {
      status: 'go';
      dutyPeriodId: string;
      /** Minutes of flight duty left when this leg lands. Feeds the timeout risk. */
      marginMinutes: number;
      /** Set when a standby crew were called out to make this departure. */
      usedReserve: boolean;
    }
  | {
      status: 'delay';
      untilAt: Date;
      cause: 'crew_timeout';
      reason: string;
    }
  | {
      status: 'cancel';
      cause: 'crew_timeout' | 'no_crew';
      reason: string;
    };

export interface DispatchRequest {
  worldId: string;
  airlineId: string;
  airframeId: string;
  flightId: string;
  originIcao: string;
  destinationIcao: string;
  /** Game time. When the aeroplane is trying to go. */
  departAt: Date;
  /** Game time. When it would land if it went now. */
  arriveAt: Date;
}

/**
 * May this flight depart?
 *
 * Writes when the answer is yes: the duty period is opened or extended and the
 * complement is committed, in whatever transaction the caller provides. Writes
 * nothing when the answer is no — the caller decides what a delay or a
 * cancellation looks like on the flight row, because that is flight state and
 * not crew state.
 */
export async function dispatchCrew(
  db: Database,
  request: DispatchRequest,
): Promise<DispatchDecision> {
  const context = await loadContext(db, request);
  if (context === null) {
    // No airframe, no type, or no crew base: not a crew *timeout*, and saying
    // so matters. A world with no crew model at all must not report every
    // departure as a fatigue problem.
    return {
      status: 'cancel',
      cause: 'no_crew',
      reason: 'The airline has no crew base able to staff this aircraft.',
    };
  }

  const { crew, family, seats, blockMinutes } = context;
  const existing = await openPeriodFor(db, request.airframeId);

  if (existing !== null && existing.locationIcao === request.originIcao) {
    const verdict = await extendVerdict(db, existing, context, request);
    if (verdict.ok) {
      await recordSector(db, existing.id, {
        blockMinutes,
        arrivedAtIcao: request.destinationIcao,
        arrivesAt: request.arriveAt,
      });
      return {
        status: 'go',
        dutyPeriodId: existing.id,
        marginMinutes: verdict.marginMinutes,
        usedReserve: existing.fromReserve,
      };
    }

    /*
     * The crew in front of the aeroplane cannot legally take it. Send them off
     * duty now — they are done for the day whatever happens next — and see
     * whether anyone else can.
     */
    const atBase = existing.locationIcao === context.baseIcao;
    const { restUntil } = await endDutyPeriod(db, existing.id, request.departAt, atBase, crew.duty);

    const reserve = await tryOpenPeriod(db, request, context, { fromReserve: true });
    if (reserve !== null) {
      return {
        status: 'go',
        dutyPeriodId: reserve.id,
        marginMinutes: reserve.marginMinutes,
        usedReserve: true,
      };
    }

    const waitMinutes = (restUntil.getTime() - request.departAt.getTime()) / 60_000;
    if (waitMinutes <= crew.duty.crewTimeoutMaxDelayMinutes) {
      return {
        status: 'delay',
        untilAt: restUntil,
        cause: 'crew_timeout',
        reason: `${verdict.reason} No reserve crew were available, so the flight waits for legal rest.`,
      };
    }
    return {
      status: 'cancel',
      cause: 'crew_timeout',
      reason: `${verdict.reason} The rest they are owed runs past the point where waiting is a delay.`,
    };
  }

  /*
   * Either no set is on duty, or the set that is on duty is somewhere else —
   * the aeroplane was ferried without them, say. Both need a fresh crew at the
   * origin, and a set stranded elsewhere is not this flight's problem to solve.
   */
  const fresh = await tryOpenPeriod(db, request, context, { fromReserve: false });
  if (fresh !== null) {
    return {
      status: 'go',
      dutyPeriodId: fresh.id,
      marginMinutes: fresh.marginMinutes,
      usedReserve: false,
    };
  }

  const reserve = await tryOpenPeriod(db, request, context, { fromReserve: true });
  if (reserve !== null) {
    return {
      status: 'go',
      dutyPeriodId: reserve.id,
      marginMinutes: reserve.marginMinutes,
      usedReserve: true,
    };
  }

  return {
    status: 'cancel',
    cause: 'no_crew',
    reason:
      `No rested crew rated on the ${family} are available at ${request.originIcao} ` +
      `to staff a ${String(seats)}-seat cabin.`,
  };
}

/* ---------------------------------------------------------------------- */

interface DispatchContext {
  crew: CrewBalance;
  family: string;
  seats: number;
  blockMinutes: number;
  crewBaseId: string;
  baseIcao: string;
  /** Standard-time offset at the reporting airport, in minutes. */
  offsetMinutes: number;
  pools: CrewPool[];
}

/**
 * Everything the decision needs, in one pass.
 *
 * Returns `null` rather than throwing when a piece is missing, because every
 * missing piece has the same meaning to the caller — this airline cannot crew
 * this aeroplane — and a thrown error inside a worker tick would fail the whole
 * event rather than the one flight.
 */
async function loadContext(
  db: Database,
  request: DispatchRequest,
): Promise<DispatchContext | null> {
  const frames = await db
    .select({
      typeDesignation: airframe.typeDesignation,
      effectiveSpec: airframe.effectiveSpec,
    })
    .from(airframe)
    .where(eq(airframe.id, request.airframeId))
    .limit(1);
  const frame = frames[0];
  if (!frame) return null;

  const types = await db
    .select({ family: aircraftType.family })
    .from(aircraftType)
    .where(eq(aircraftType.designation, frame.typeDesignation))
    .limit(1);
  const family = types[0]?.family;
  if (family === undefined) return null;

  const bases = await readBaseLocations(db, request.airlineId);
  if (bases.length === 0) return null;

  /*
   * Prefer a base at the airport the flight leaves from; fall back to the
   * first. The fallback is where a positioning cost will eventually attach —
   * crew based elsewhere have to get there — and it is deliberately still
   * permissive, because refusing outright would make a single-base airline
   * unable to fly the second half of any rotation.
   */
  const base = bases.find((entry) => entry.airportIcao === request.originIcao) ?? bases[0];
  if (!base) return null;

  const spec = JSON.parse(frame.effectiveSpec) as { seatsTwoClass?: number };
  const seats = spec.seatsTwoClass ?? 0;
  const blockMinutes = Math.max(
    1,
    Math.round((request.arriveAt.getTime() - request.departAt.getTime()) / 60_000),
  );

  const [economy, pools, origins] = await Promise.all([
    loadWorldEconomyConfig(db, request.worldId),
    poolsAtBase(db, base.id),
    db
      .select({ utcOffsetMinutes: airport.utcOffsetMinutes })
      .from(airport)
      .where(eq(airport.icaoCode, request.originIcao))
      .limit(1),
  ]);

  return {
    crew: economy.crew,
    family,
    seats,
    blockMinutes,
    crewBaseId: base.id,
    baseIcao: base.airportIcao,
    offsetMinutes: origins[0]?.utcOffsetMinutes ?? base.utcOffsetMinutes ?? 0,
    pools,
  };
}

async function poolsAtBase(db: Database, crewBaseId: string): Promise<CrewPool[]> {
  const rows = await db
    .select({
      family: crewPool.family,
      rank: crewPool.rank,
      headcount: crewPool.headcount,
      unavailable: crewPool.unavailable,
      onDuty: crewPool.onDuty,
      reserve: crewPool.reserve,
    })
    .from(crewPool)
    .where(eq(crewPool.crewBaseId, crewBaseId));

  /*
   * `unavailable` is what `checkComplement` subtracts, and at dispatch time
   * "cannot be rostered" means in a classroom *or* already working. Folding
   * `onDuty` in here rather than teaching the pure model about duty keeps
   * `packages/sim` ignorant of a concept it has no rows for.
   */
  return rows.map((row) => ({
    family: row.family,
    rank: row.rank,
    headcount: row.headcount,
    unavailable: row.unavailable + row.onDuty,
  }));
}

/** Reserve heads that are not already committed, by rank. */
async function reservePoolsAtBase(db: Database, crewBaseId: string): Promise<CrewPool[]> {
  const rows = await db
    .select({
      family: crewPool.family,
      rank: crewPool.rank,
      headcount: crewPool.headcount,
      unavailable: crewPool.unavailable,
      onDuty: crewPool.onDuty,
      reserve: crewPool.reserve,
    })
    .from(crewPool)
    .where(eq(crewPool.crewBaseId, crewBaseId));

  return rows.map((row) => {
    const free = Math.max(0, row.headcount - row.unavailable - row.onDuty);
    const usable = Math.min(row.reserve, free);
    // Expressed as a pool of exactly the usable reserve heads, so the same
    // `checkComplement` answers both questions without a second code path.
    return { family: row.family, rank: row.rank, headcount: usable, unavailable: 0 };
  });
}

interface ExtendVerdict {
  ok: boolean;
  marginMinutes: number;
  reason: string;
}

/** Whether the set already on duty may take one more sector. */
async function extendVerdict(
  db: Database,
  period: OpenDutyPeriod,
  context: DispatchContext,
  request: DispatchRequest,
): Promise<ExtendVerdict> {
  const { crew, blockMinutes } = context;
  const reportLocal =
    period.reportAt.getUTCHours() * 60 + period.reportAt.getUTCMinutes() + context.offsetMinutes;

  const sectors = period.sectors + 1;
  const ceiling = maxFlightDutyMinutes(reportLocal, sectors, crew.duty);
  const elapsed = (request.arriveAt.getTime() - period.reportAt.getTime()) / 60_000;
  const margin = ceiling - elapsed;

  if (margin < 0) {
    return {
      ok: false,
      marginMinutes: margin,
      reason:
        `The crew would reach ${formatMinutes(elapsed)} of flight duty across ` +
        `${String(sectors)} sectors, past their ${formatMinutes(ceiling)} limit.`,
    };
  }

  // The rolling ceilings, which bite over a fortnight rather than over a day.
  const history = await dutyHistoryFor(db, period.crewBaseId, period.family, request.departAt);
  const cumulative = cumulativeVerdict(
    history,
    {
      at: request.departAt,
      dutyMinutes: elapsed + crew.duty.offDutyAfterArrivalMinutes,
      blockMinutes: period.blockMinutes + blockMinutes,
    },
    crew.duty,
  );
  if (cumulative.status === 'illegal') {
    return { ok: false, marginMinutes: -cumulative.overMinutes, reason: cumulative.reason };
  }

  return { ok: true, marginMinutes: margin, reason: '' };
}

/**
 * Open a fresh duty period at the origin, if the pools can staff one.
 *
 * `null` means they cannot — no legal complement, or the day would already be
 * too long before it started. Nothing is written in that case.
 */
async function tryOpenPeriod(
  db: Database,
  request: DispatchRequest,
  context: DispatchContext,
  options: { fromReserve: boolean },
): Promise<{ id: string; marginMinutes: number } | null> {
  const { crew, family, seats, blockMinutes } = context;

  const pools = options.fromReserve
    ? await reservePoolsAtBase(db, context.crewBaseId)
    : context.pools;

  const check = checkComplement({ seats, blockMinutes }, pools, family, crew.regulation);
  if (!check.ok) return null;

  const reportAt = new Date(
    request.departAt.getTime() - crew.duty.reportBeforeDepartureMinutes * 60_000,
  );
  const reportLocal =
    reportAt.getUTCHours() * 60 + reportAt.getUTCMinutes() + context.offsetMinutes;
  const ceiling = maxFlightDutyMinutes(reportLocal, 1, crew.duty);
  const elapsed = (request.arriveAt.getTime() - reportAt.getTime()) / 60_000;
  const margin = ceiling - elapsed;
  // A single sector longer than a whole legal day. Rare, and it has to be
  // refused here rather than accepted and refused on the next departure.
  if (margin < 0) return null;

  const slots = resolveSlots(check.complement, pools);
  const committed = await commitComplement(db, {
    crewBaseId: context.crewBaseId,
    family,
    slots,
    fromReserve: options.fromReserve,
  });
  if (!committed) return null;

  const id = await startDutyPeriod(db, {
    worldId: request.worldId,
    airlineId: request.airlineId,
    airframeId: request.airframeId,
    crewBaseId: context.crewBaseId,
    family,
    complement: slots,
    fromReserve: options.fromReserve,
    reportAt,
    locationIcao: request.originIcao,
  });
  await recordSector(db, id, {
    blockMinutes,
    arrivedAtIcao: request.destinationIcao,
    arrivesAt: request.arriveAt,
  });

  return { id, marginMinutes: margin };
}

/**
 * Turn a complement into the ranks that will actually be charged for it.
 *
 * The same juniormost-first walk `checkComplement` uses to decide the answer is
 * *yes*. Repeating it here rather than having `checkComplement` return it keeps
 * the pure model's shape — it answers a question, it does not allocate — but the
 * two orders must agree, or an airline could dispatch a flight its pools cannot
 * staff. That agreement is what `dispatch.test.ts` pins.
 */
function resolveSlots(complement: Complement, pools: readonly CrewPool[]): CommittedSlot[] {
  const remaining = pools.map((pool) => ({
    rank: pool.rank,
    heads: Math.max(0, pool.headcount - pool.unavailable),
  }));
  const taken = new Map<string, number>();

  for (const slot of [...complement.flightDeck, ...complement.cabin]) {
    const eligible = remaining
      .filter((pool) => coversRank(pool.rank, slot.rank))
      .sort((a, b) => seniority(a.rank) - seniority(b.rank));

    let outstanding = slot.count;
    for (const pool of eligible) {
      if (outstanding === 0) break;
      const take = Math.min(pool.heads, outstanding);
      if (take === 0) continue;
      pool.heads -= take;
      outstanding -= take;
      taken.set(pool.rank, (taken.get(pool.rank) ?? 0) + take);
    }
  }

  return [...taken].map(([rank, count]) => ({ rank, count }));
}

const DECK = ['cadet', 'first_officer', 'senior_first_officer', 'captain', 'training_captain'];
const CABIN = ['cabin_crew', 'senior_cabin_crew', 'purser', 'cabin_service_manager'];

function seniority(rank: string): number {
  const inDeck = DECK.indexOf(rank);
  return inDeck >= 0 ? inDeck : CABIN.indexOf(rank);
}

function formatMinutes(minutes: number): string {
  const whole = Math.round(Math.abs(minutes));
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  if (hours === 0) return `${String(rest)}m`;
  return `${String(hours)}h${rest === 0 ? '' : String(rest).padStart(2, '0')}`;
}

/**
 * The complement one flight needs, for callers that want the number without the
 * decision — the Crew page's cover table, mostly.
 */
export function complementFor(seats: number, blockMinutes: number, crew: CrewBalance): Complement {
  return requiredComplement({ seats, blockMinutes }, crew.regulation);
}
