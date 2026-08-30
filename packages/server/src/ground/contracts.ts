import { and, eq, isNotNull, lte, sql } from 'drizzle-orm';

import {
  GROUND_SERVICE_LINES,
  type AirportTier,
  type GroundContractsResponse,
  type GroundServiceLine,
  type GroundServiceLineView,
  type GroundStationResponse,
  type HandlerGrade,
  type SignContractRequest,
} from '@tailfin/shared';
import {
  contractExpiring,
  contractTermEnd,
  gameTime,
  handlerProfile,
  stationVendors,
  type WorldClock,
} from '@tailfin/sim';

import { airport, groundContract, world } from '../db/schema';

import type { ResolvedPlayerAirline } from '../airline/context';
import type { Database } from '../db/client';

/**
 * Ground handling contracts (M5-06, §9.3).
 *
 * The vendors are derived; this owns the rows an airline signs against them, and
 * the two rules that make ground ops a shared world: **one active handler per
 * service line at a station**, and a vendor's **finite capacity** that competing
 * airlines exhaust. Owner-scoped throughout — the airline is resolved from the
 * session, never accepted from the client.
 */

interface StationContext {
  seed: string;
  tier: AirportTier;
  clock: WorldClock;
}

async function loadStationContext(
  db: Database,
  worldId: string,
  icao: string,
): Promise<StationContext | null> {
  const clock = await loadWorldClock(db, worldId);
  if (clock === null) return null;
  const [w] = await db
    .select({ seed: world.seed })
    .from(world)
    .where(eq(world.id, worldId))
    .limit(1);
  if (!w) return null;
  const [a] = await db
    .select({ tier: airport.tier })
    .from(airport)
    .where(eq(airport.icaoCode, icao))
    .limit(1);
  if (!a) return null;
  if (a.tier === null) return null;
  return { seed: w.seed, tier: a.tier, clock };
}

/** The world's clock parameters, or null for an unknown world. */
async function loadWorldClock(db: Database, worldId: string): Promise<WorldClock | null> {
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

interface ActiveRow {
  id: string;
  airlineId: string;
  serviceLine: string;
  grade: string;
  termEnd: Date | null;
}

async function activeAt(db: Database, worldId: string, icao: string): Promise<ActiveRow[]> {
  return db
    .select({
      id: groundContract.id,
      airlineId: groundContract.airlineId,
      serviceLine: groundContract.serviceLine,
      grade: groundContract.grade,
      termEnd: groundContract.termEnd,
    })
    .from(groundContract)
    .where(
      and(
        eq(groundContract.worldId, worldId),
        eq(groundContract.airportIcao, icao),
        eq(groundContract.status, 'active'),
      ),
    );
}

/** Build the station view from its offers and the world's active contracts there. */
function buildStation(
  icao: string,
  ctx: StationContext,
  active: readonly ActiveRow[],
  airlineId: string,
  gameNow: Date,
): GroundStationResponse {
  // Contracts taken per (service line, grade), across every airline in the world.
  const taken = new Map<string, number>();
  for (const row of active) {
    const key = `${row.serviceLine}:${row.grade}`;
    taken.set(key, (taken.get(key) ?? 0) + 1);
  }

  const lines: GroundServiceLineView[] = GROUND_SERVICE_LINES.map((serviceLine) => {
    const mine = active.find((r) => r.airlineId === airlineId && r.serviceLine === serviceLine);
    return {
      serviceLine,
      contracted:
        mine === undefined
          ? null
          : {
              id: mine.id,
              serviceLine,
              grade: mine.grade as HandlerGrade,
              termEnd: mine.termEnd === null ? null : mine.termEnd.toISOString(),
              expiring: contractExpiring(mine.termEnd, gameNow),
            },
      offers: stationVendors(ctx.seed, icao, serviceLine, ctx.tier).map((offer) => {
        const profile = handlerProfile(offer.grade);
        return {
          grade: offer.grade,
          capacity: offer.capacity,
          taken: taken.get(`${serviceLine}:${offer.grade}`) ?? 0,
          reliability: profile.reliability,
          speedFactor: profile.speedFactor,
          quality: profile.quality,
        };
      }),
    };
  });

  return { icao, lines };
}

/** A station's vendors and this airline's contracts there, or null for an unknown station. */
export async function readStation(
  db: Database,
  own: ResolvedPlayerAirline,
  icao: string,
  now: Date = new Date(),
): Promise<GroundStationResponse | null> {
  const ctx = await loadStationContext(db, own.worldId, icao);
  if (ctx === null) return null;
  const active = await activeAt(db, own.worldId, icao);
  return buildStation(icao, ctx, active, own.id, gameTime(ctx.clock, now));
}

export type SignOutcome =
  | { ok: true; station: GroundStationResponse }
  | { ok: false; code: 'unknown_station' | 'grade_not_offered' | 'capacity_exhausted' };

/**
 * Sign a handler for a service line, replacing any handler already on that line.
 *
 * A `pg_advisory_xact_lock` on the vendor slot serialises airlines racing for the
 * last opening, so the capacity limit is exact under competition rather than a
 * best-effort count — the property the "capacity can be exhausted" criterion asks
 * for. Switching grades terminates the incumbent first, so its slot is freed
 * before the new one is counted.
 */
export async function signContract(
  db: Database,
  own: ResolvedPlayerAirline,
  icao: string,
  request: SignContractRequest,
  now: Date = new Date(),
): Promise<SignOutcome> {
  const ctx = await loadStationContext(db, own.worldId, icao);
  if (ctx === null) return { ok: false, code: 'unknown_station' };

  const offer = stationVendors(ctx.seed, icao, request.serviceLine, ctx.tier).find(
    (o) => o.grade === request.grade,
  );
  if (offer === undefined) return { ok: false, code: 'grade_not_offered' };

  // The term runs from the world's clock, not the wall clock: a contract lasts a
  // business season in the world's calendar (§9.3).
  const gameNow = gameTime(ctx.clock, now);
  const termEnd = contractTermEnd(gameNow);

  return db
    .transaction(async (tx) => {
      // Serialise everyone contending for this exact vendor slot.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`${own.worldId}:${icao}:${request.serviceLine}:${request.grade}`}))`,
      );

      // Retire any handler already on this line for this airline; it may be a
      // different grade whose slot must be freed before we count the new one.
      await tx
        .update(groundContract)
        .set({ status: 'terminated' })
        .where(
          and(
            eq(groundContract.airlineId, own.id),
            eq(groundContract.airportIcao, icao),
            eq(groundContract.serviceLine, request.serviceLine),
            eq(groundContract.status, 'active'),
          ),
        );

      const [{ count } = { count: 0 }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(groundContract)
        .where(
          and(
            eq(groundContract.worldId, own.worldId),
            eq(groundContract.airportIcao, icao),
            eq(groundContract.serviceLine, request.serviceLine),
            eq(groundContract.grade, request.grade),
            eq(groundContract.status, 'active'),
          ),
        );
      if (count >= offer.capacity) {
        // Roll the termination back — the airline keeps the handler it had.
        throw new CapacityExhausted();
      }

      await tx.insert(groundContract).values({
        worldId: own.worldId,
        airlineId: own.id,
        airportIcao: icao,
        serviceLine: request.serviceLine,
        grade: request.grade,
        status: 'active',
        termEnd,
      });

      const active = await activeAt(tx, own.worldId, icao);
      return { ok: true as const, station: buildStation(icao, ctx, active, own.id, gameNow) };
    })
    .catch((error: unknown): SignOutcome => {
      if (error instanceof CapacityExhausted) {
        return { ok: false, code: 'capacity_exhausted' as const };
      }
      throw error;
    });
}

/** Thrown to roll the sign transaction back when the vendor has no slot left. */
class CapacityExhausted extends Error {
  constructor() {
    super('The handler has no capacity left');
  }
}

/** Terminate a contract this airline holds. Returns the station it was at, or null. */
export async function terminateContract(
  db: Database,
  own: ResolvedPlayerAirline,
  contractId: string,
): Promise<string | null> {
  const [row] = await db
    .update(groundContract)
    .set({ status: 'terminated' })
    .where(
      and(
        eq(groundContract.id, contractId),
        eq(groundContract.airlineId, own.id),
        eq(groundContract.status, 'active'),
      ),
    )
    .returning({ icao: groundContract.airportIcao });
  return row?.icao ?? null;
}

export interface ExpiryResult {
  /** Contracts whose term ran out and were lapsed back to walk-up handling. */
  expired: number;
}

/**
 * Lapse every contract in this world whose term has ended (M5-06, §9.3).
 *
 * The other half of *"Contracts run for a fixed term"*: signing sets `term_end`,
 * and this is what makes the end mean something. A lapsed contract flips to
 * `expired`, which frees its vendor slot (capacity counts only `active` rows) and
 * drops the airline back to walk-up handling — so the ramp handler it was paying
 * for stops smoothing its turns, exactly as if it had never signed.
 *
 * Runs on the **worker** against the world's game clock, like every crew and
 * maintenance sweep. **Production has no worker**, so there a term would never
 * lapse: a contract signed on opening day would run for ever and its vendor slot
 * would never come free for a competitor. `groundContractsExpired` is the counter
 * that tells that apart from a world where nothing has reached its term yet.
 *
 * World-scoped and idempotent: a second run finds nothing still `active` past its
 * term, so two workers racing lapse each contract once.
 */
export async function expireGroundContracts(
  db: Database,
  worldId: string,
  gameNow: Date,
): Promise<ExpiryResult> {
  const lapsed = await db
    .update(groundContract)
    .set({ status: 'expired' })
    .where(
      and(
        eq(groundContract.worldId, worldId),
        eq(groundContract.status, 'active'),
        isNotNull(groundContract.termEnd),
        lte(groundContract.termEnd, gameNow),
      ),
    )
    .returning({ id: groundContract.id });
  return { expired: lapsed.length };
}

/**
 * Every active contract this airline holds, across all stations, with the ones
 * about to lapse flagged.
 *
 * §9.3's alert *"before it lapses"* wants the whole network in one read rather
 * than a page-by-page sweep, so a client can badge the airline the moment any
 * term is inside its warning window.
 */
export async function listAirlineContracts(
  db: Database,
  own: ResolvedPlayerAirline,
  now: Date = new Date(),
): Promise<GroundContractsResponse> {
  const clock = await loadWorldClock(db, own.worldId);
  if (clock === null) return { contracts: [] };
  const gameNow = gameTime(clock, now);

  const rows = await db
    .select({
      id: groundContract.id,
      icao: groundContract.airportIcao,
      serviceLine: groundContract.serviceLine,
      grade: groundContract.grade,
      termEnd: groundContract.termEnd,
    })
    .from(groundContract)
    .where(and(eq(groundContract.airlineId, own.id), eq(groundContract.status, 'active')));

  return {
    contracts: rows.map((row) => ({
      id: row.id,
      icao: row.icao,
      serviceLine: row.serviceLine as GroundServiceLine,
      grade: row.grade as HandlerGrade,
      termEnd: row.termEnd === null ? null : row.termEnd.toISOString(),
      expiring: contractExpiring(row.termEnd, gameNow),
    })),
  };
}

/**
 * The grade an airline uses for a service line at a station, for the sim to read.
 *
 * Null when nothing is contracted — the caller decides what "walk-up" handling
 * means. A single indexed lookup, so a departure can ask it cheaply.
 */
export async function contractedGrade(
  db: Database,
  airlineId: string,
  icao: string,
  serviceLine: GroundServiceLine,
): Promise<HandlerGrade | null> {
  const [row] = await db
    .select({ grade: groundContract.grade })
    .from(groundContract)
    .where(
      and(
        eq(groundContract.airlineId, airlineId),
        eq(groundContract.airportIcao, icao),
        eq(groundContract.serviceLine, serviceLine),
        eq(groundContract.status, 'active'),
      ),
    )
    .limit(1);
  return row ? (row.grade as HandlerGrade) : null;
}
