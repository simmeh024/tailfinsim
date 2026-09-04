/**
 * Holding and resolving airport slots (M7-05, §"Slots").
 *
 * The database half of the slot model. `@tailfin/sim` owns the one pure fact —
 * which band a departure minute falls in (`bandOf`) — and this owns everything
 * about *holding* a band: the per-band capacity, who holds what, claiming and
 * releasing, and the resolver that tells schedule authoring whether a leg's
 * origin band is held.
 *
 * ## What is and is not enforced
 *
 * A slot is required only at an IATA **Level 3** (coordinated) airport. Levels 1
 * and 2 and uncoordinated airports are free — `resolveLegSlots` returns `true`
 * for them, so nothing there is ever refused for want of a slot. A holding is a
 * per-band operating right, not a per-movement token (see the schema note and
 * ADR-0025), so one holding covers every departure the airline flies in that
 * band. Route *opening* is never slot-gated — a route is not a movement — so the
 * gate lives here at schedule authoring, where a real departure time exists.
 *
 * ## No worker
 *
 * Holdings are standing state. Nothing expires, drifts or bills on a tick, so —
 * unlike almost everything else in the network engine — the slot system works
 * identically on a world with no worker.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';

import type { AirportSlotBand, AirportSlotsResponse } from '@tailfin/shared';
import { bandOf, SLOT_BANDS_PER_DAY } from '@tailfin/sim';

import { airport, slotHolding } from '../db/schema';

import type { ResolvedPlayerAirline } from '../airline/context';
import type { Database } from '../db/client';

/** The IATA designation at which a held slot becomes mandatory. */
const COORDINATED_LEVEL = 3;

/**
 * How many airlines may hold a given band, by airport tier.
 *
 * A structural scarcity attribute of the airport, like its runway or its slot
 * level — deliberately **not** an economy-config coefficient, because it prices
 * nothing and a world would never want to retune it independently of the
 * catalogue. Only Level 3 airports are capped; the tier decides how hard. Kept a
 * documented constant for this first cut (ADR-0025); if it ever needs per-world
 * tuning it can move, but a balance payload is the wrong home for it today.
 */
const CAPACITY_BY_TIER: Record<string, number> = {
  flagship: 8,
  large: 5,
};
const DEFAULT_COORDINATED_CAPACITY = 4;

/** Whether an airport's slot level makes a held slot mandatory. */
export function isCoordinated(slotLevel: number | null): boolean {
  return slotLevel === COORDINATED_LEVEL;
}

/** The per-band capacity of a coordinated airport of the given tier. */
export function slotCapacityPerHour(tier: string | null): number {
  return (tier !== null ? CAPACITY_BY_TIER[tier] : undefined) ?? DEFAULT_COORDINATED_CAPACITY;
}

interface AirportRow {
  icao: string;
  name: string;
  slotLevel: number | null;
  tier: string | null;
}

/** Load an airport by ICAO, or null — the caller turns null into a 404. */
async function loadAirport(db: Database, icao: string): Promise<AirportRow | null> {
  const [row] = await db
    .select({
      icao: airport.icaoCode,
      name: airport.name,
      slotLevel: airport.slotLevel,
      tier: airport.tier,
    })
    .from(airport)
    .where(eq(airport.icaoCode, icao))
    .limit(1);
  if (row?.icao == null) return null;
  return { icao: row.icao, name: row.name, slotLevel: row.slotLevel, tier: row.tier };
}

/** Build the per-band picture of one coordinated airport for one airline. */
async function pictureOf(
  db: Database,
  own: ResolvedPlayerAirline,
  air: AirportRow,
): Promise<AirportSlotsResponse> {
  const coordinated = isCoordinated(air.slotLevel);
  if (!coordinated) {
    return {
      icao: air.icao,
      name: air.name,
      coordinated: false,
      slotLevel: air.slotLevel,
      bands: [],
    };
  }

  const capacity = slotCapacityPerHour(air.tier);

  // How full each band is, across every airline, and which bands this airline holds.
  const [heldRows, mineRows] = await Promise.all([
    db
      .select({ band: slotHolding.band, count: sql<number>`count(*)::int` })
      .from(slotHolding)
      .where(and(eq(slotHolding.worldId, own.worldId), eq(slotHolding.airportIcao, air.icao)))
      .groupBy(slotHolding.band),
    db
      .select({ band: slotHolding.band })
      .from(slotHolding)
      .where(
        and(
          eq(slotHolding.worldId, own.worldId),
          eq(slotHolding.airlineId, own.id),
          eq(slotHolding.airportIcao, air.icao),
        ),
      ),
  ]);

  const heldByBand = new Map<number, number>(heldRows.map((r) => [r.band, r.count]));
  const mine = new Set<number>(mineRows.map((r) => r.band));

  const bands: AirportSlotBand[] = [];
  for (let band = 0; band < SLOT_BANDS_PER_DAY; band += 1) {
    const held = heldByBand.get(band) ?? 0;
    bands.push({
      band,
      capacity,
      held,
      heldByYou: mine.has(band),
      available: Math.max(capacity - held, 0),
    });
  }

  return { icao: air.icao, name: air.name, coordinated: true, slotLevel: air.slotLevel, bands };
}

/** One airport's slot picture for this airline, or null if no such airport. */
export async function readAirportSlots(
  db: Database,
  own: ResolvedPlayerAirline,
  icao: string,
): Promise<AirportSlotsResponse | null> {
  const air = await loadAirport(db, icao);
  if (air === null) return null;
  return pictureOf(db, own, air);
}

export type SlotMutation =
  | { ok: true; slots: AirportSlotsResponse }
  | { ok: false; problem: 'unknown_airport' | 'not_coordinated' | 'invalid_band' | 'band_full' };

/** Whether a band value is a whole hour of the day. */
function validBand(band: number): boolean {
  return Number.isInteger(band) && band >= 0 && band < SLOT_BANDS_PER_DAY;
}

/**
 * Claim a slot in one band, or say why not.
 *
 * Idempotent: an airline that already holds the band succeeds without a second
 * row (the unique constraint guarantees it). Capacity is checked and the row
 * inserted inside one transaction so two racing claims cannot both pass a stale
 * count — the count is re-read against the same snapshot the insert writes into.
 */
export async function claimSlot(
  db: Database,
  own: ResolvedPlayerAirline,
  icao: string,
  band: number,
): Promise<SlotMutation> {
  const air = await loadAirport(db, icao);
  if (air === null) return { ok: false, problem: 'unknown_airport' };
  if (!isCoordinated(air.slotLevel)) return { ok: false, problem: 'not_coordinated' };
  if (!validBand(band)) return { ok: false, problem: 'invalid_band' };

  const capacity = slotCapacityPerHour(air.tier);

  const full = await db.transaction(async (tx) => {
    const already = await tx
      .select({ id: slotHolding.id })
      .from(slotHolding)
      .where(
        and(
          eq(slotHolding.worldId, own.worldId),
          eq(slotHolding.airlineId, own.id),
          eq(slotHolding.airportIcao, air.icao),
          eq(slotHolding.band, band),
        ),
      )
      .limit(1);
    if (already[0]) return false; // already held — idempotent success

    const counted = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(slotHolding)
      .where(
        and(
          eq(slotHolding.worldId, own.worldId),
          eq(slotHolding.airportIcao, air.icao),
          eq(slotHolding.band, band),
        ),
      );
    if ((counted[0]?.count ?? 0) >= capacity) return true; // full

    await tx
      .insert(slotHolding)
      .values({ worldId: own.worldId, airlineId: own.id, airportIcao: air.icao, band })
      .onConflictDoNothing();
    return false;
  });

  if (full) return { ok: false, problem: 'band_full' };
  return { ok: true, slots: await pictureOf(db, own, air) };
}

/**
 * Release a band. Idempotent — releasing one you do not hold changes nothing and
 * still returns the current picture, so a double-tap is not an error.
 */
export async function releaseSlot(
  db: Database,
  own: ResolvedPlayerAirline,
  icao: string,
  band: number,
): Promise<SlotMutation> {
  const air = await loadAirport(db, icao);
  if (air === null) return { ok: false, problem: 'unknown_airport' };
  if (!validBand(band)) return { ok: false, problem: 'invalid_band' };

  await db
    .delete(slotHolding)
    .where(
      and(
        eq(slotHolding.worldId, own.worldId),
        eq(slotHolding.airlineId, own.id),
        eq(slotHolding.airportIcao, air.icao),
        eq(slotHolding.band, band),
      ),
    );

  return { ok: true, slots: await pictureOf(db, own, air) };
}

/** One leg's slot-relevant facts: where it departs from and when. */
export interface LegOrigin {
  originIcao: string;
  departureMinute: number;
}

/**
 * Whether each leg holds the slot its departure needs, in leg order.
 *
 * The value schedule authoring feeds `validateRotation` as `context.slots`. A leg
 * from an uncoordinated airport is always `true` (nothing is required there); a
 * leg from a coordinated one is `true` only if the airline holds that origin's
 * band. Batched: one read of the origins' slot levels and one of the airline's
 * holdings, however many legs there are.
 */
export async function resolveLegSlots(
  db: Database,
  own: ResolvedPlayerAirline,
  legs: readonly LegOrigin[],
): Promise<boolean[]> {
  if (legs.length === 0) return [];

  const origins = [...new Set(legs.map((l) => l.originIcao))];

  const [levelRows, holdingRows] = await Promise.all([
    db
      .select({
        icao: airport.icaoCode,
        slotLevel: airport.slotLevel,
        offset: airport.utcOffsetMinutes,
      })
      .from(airport)
      .where(inArray(airport.icaoCode, origins)),
    db
      .select({ icao: slotHolding.airportIcao, band: slotHolding.band })
      .from(slotHolding)
      .where(and(eq(slotHolding.worldId, own.worldId), eq(slotHolding.airlineId, own.id))),
  ]);

  const coordinated = new Set(
    levelRows.filter((r) => r.icao !== null && isCoordinated(r.slotLevel)).map((r) => r.icao),
  );
  // A slot is claimed for a **local** band, but a leg's departure is stored
  // absolute — so the leg's band is read at the origin's local time (M3-04a).
  const offsetOf = new Map(levelRows.map((r) => [r.icao, r.offset ?? 0]));
  const held = new Set(holdingRows.map((r) => `${r.icao}|${String(r.band)}`));

  return legs.map((leg) => {
    if (!coordinated.has(leg.originIcao)) return true;
    const band = bandOf(leg.departureMinute + (offsetOf.get(leg.originIcao) ?? 0));
    return held.has(`${leg.originIcao}|${String(band)}`);
  });
}
