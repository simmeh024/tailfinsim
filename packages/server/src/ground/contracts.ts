import { and, eq, sql } from 'drizzle-orm';

import {
  GROUND_SERVICE_LINES,
  type AirportTier,
  type GroundServiceLine,
  type GroundServiceLineView,
  type GroundStationResponse,
  type HandlerGrade,
  type SignContractRequest,
} from '@tailfin/shared';
import { handlerProfile, stationVendors } from '@tailfin/sim';

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
}

async function loadStationContext(
  db: Database,
  worldId: string,
  icao: string,
): Promise<StationContext | null> {
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
  return { seed: w.seed, tier: a.tier };
}

interface ActiveRow {
  id: string;
  airlineId: string;
  serviceLine: string;
  grade: string;
}

async function activeAt(db: Database, worldId: string, icao: string): Promise<ActiveRow[]> {
  return db
    .select({
      id: groundContract.id,
      airlineId: groundContract.airlineId,
      serviceLine: groundContract.serviceLine,
      grade: groundContract.grade,
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
        mine === undefined ? null : { id: mine.id, serviceLine, grade: mine.grade as HandlerGrade },
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
): Promise<GroundStationResponse | null> {
  const ctx = await loadStationContext(db, own.worldId, icao);
  if (ctx === null) return null;
  const active = await activeAt(db, own.worldId, icao);
  return buildStation(icao, ctx, active, own.id);
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
): Promise<SignOutcome> {
  const ctx = await loadStationContext(db, own.worldId, icao);
  if (ctx === null) return { ok: false, code: 'unknown_station' };

  const offer = stationVendors(ctx.seed, icao, request.serviceLine, ctx.tier).find(
    (o) => o.grade === request.grade,
  );
  if (offer === undefined) return { ok: false, code: 'grade_not_offered' };

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
      });

      const active = await activeAt(tx, own.worldId, icao);
      return { ok: true as const, station: buildStation(icao, ctx, active, own.id) };
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
