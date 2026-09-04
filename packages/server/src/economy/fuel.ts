import { inArray, eq } from 'drizzle-orm';

import {
  gameTime,
  stationFuelPricing,
  worldFuelMarket,
  type FuelMarket,
  type FuelStation,
  type FuelStationConfig,
  type WorldClock,
} from '@tailfin/sim';

import { airport, world } from '../db/schema';

import type { PinnedEconomyConfig } from './config';
import type { Database } from '../db/client';

/**
 * Where a station's fuel price comes from, on this side of the boundary
 * (M5-07, §9.3, §11).
 *
 * `@tailfin/sim` owns the model — which region an airport is in, what a tier
 * does to an into-plane fee, how the world curve moves. This owns the two facts
 * the model needs and only the database has: **what the airport actually is**
 * (its continent, country and tier) and **what the world's calendar reads**.
 *
 * ## Why the world seed is in here
 *
 * The per-station spread is drawn from the world seed, so the same airport is
 * dear in one world and cheap in another — and stays that way for the life of
 * the world. That makes a station's price a fact a player can learn, not noise
 * on a quote, but it does mean every caller needs the seed. Hence
 * {@link loadWorldFuelContext}: one query for the seed and the epoch, which are
 * the only two world columns fuel pricing reads.
 *
 * ## Not a cache
 *
 * Nothing here memoises across requests. A station's price is cheap to derive —
 * a hash and two multiplications — and an economy re-pin has to reach the next
 * read, which is the same reason `settleArrivedFlight` resolves the pin every
 * time rather than holding one.
 */

/**
 * The world columns fuel pricing reads, and nothing else.
 *
 * The clock comes with the seed because most callers need both: the curve is
 * evaluated at a **game** instant, and a caller answering a live question — a
 * fare-floor preview, say — has a wall clock and needs the world's own reading
 * of it. A caller that already holds a game instant (a settlement does) ignores
 * the clock fields.
 */
export interface WorldFuelContext {
  seed: string;
  /** The world's in-game start. Day zero of the curve (ADR-0005). */
  epoch: Date;
  launchDate: Date;
  speedMultiplier: number;
}

/** The clock parameters, in the shape `gameTime` takes. */
export function fuelClockOf(ctx: WorldFuelContext): WorldClock {
  return { epoch: ctx.epoch, launchDate: ctx.launchDate, speedMultiplier: ctx.speedMultiplier };
}

/** The airport columns the region and tier model reads, and nothing else. */
export interface AirportFuelRow {
  icao: string;
  continent: string | null;
  isoCountry: string | null;
  tier: 'flagship' | 'large' | 'medium' | 'small' | 'regional' | null;
}

export async function loadWorldFuelContext(
  db: Database,
  worldId: string,
): Promise<WorldFuelContext | null> {
  const [row] = await db
    .select({
      seed: world.seed,
      epoch: world.epoch,
      launchDate: world.launchDate,
      speedMultiplier: world.speedMultiplier,
    })
    .from(world)
    .where(eq(world.id, worldId))
    .limit(1);
  if (!row) return null;
  // `numeric` comes back from the driver as a string — the trap CLAUDE.md
  // records — so the multiplier is parsed at the boundary rather than trusted.
  return { ...row, speedMultiplier: Number(row.speedMultiplier) };
}

/** The station rate tables, sliced out of a world's pinned economy. */
export function fuelStationConfigOf(economy: PinnedEconomyConfig): FuelStationConfig {
  return {
    regions: economy.fuel.regions,
    defaultStation: economy.fuel.defaultStation,
    tierFeeFactor: economy.fuel.tierFeeFactor,
    stationSpread: economy.fuel.stationSpread,
  };
}

/**
 * The airports named, in one query.
 *
 * One `in` rather than a query per code: a settlement prices one station and a
 * fare-floor sweep prices forty, and the second must not become forty round
 * trips. Codes absent from `airport` are simply missing from the map — the
 * caller decides whether that is an error (it is, for a flight that flew) or a
 * shrug (it is, for a demand pool naming a field the import dropped).
 */
export async function loadAirportFuelRows(
  db: Database,
  icaos: readonly string[],
): Promise<Map<string, AirportFuelRow>> {
  const wanted = [...new Set(icaos)];
  if (wanted.length === 0) return new Map();

  const rows = await db
    .select({
      icao: airport.icaoCode,
      continent: airport.continent,
      isoCountry: airport.isoCountry,
      tier: airport.tier,
    })
    .from(airport)
    .where(inArray(airport.icaoCode, wanted));

  const found = new Map<string, AirportFuelRow>();
  for (const row of rows) {
    // `icao_code` is nullable — the universal identifier is `ident` (M1-01) — so
    // a row reached by an ICAO code always has one, but the type does not know it.
    if (row.icao === null) continue;
    found.set(row.icao, { ...row, icao: row.icao });
  }
  return found;
}

/**
 * What a station charges, from its own row.
 *
 * Falls back to the world's default rates for an airport the import never gave
 * a geography — the case `fuel.defaultStation` exists for — rather than throwing,
 * because a fuel price is not the right place to discover a data gap.
 */
export function stationFor(
  icao: string,
  row: AirportFuelRow | undefined,
  ctx: WorldFuelContext,
  economy: PinnedEconomyConfig,
): FuelStation {
  return stationFuelPricing(
    ctx.seed,
    {
      icao,
      continent: row?.continent ?? null,
      isoCountry: row?.isoCountry ?? null,
      tier: row?.tier ?? null,
    },
    fuelStationConfigOf(economy),
  );
}

/**
 * A resolver over a fixed set of stations, for a caller pricing several.
 *
 * Takes the rows it was given and nothing more, so the returned function does no
 * I/O and can be handed to a pure sim model.
 */
export async function createStationResolver(
  db: Database,
  icaos: readonly string[],
  ctx: WorldFuelContext,
  economy: PinnedEconomyConfig,
): Promise<(icao: string) => FuelStation> {
  const rows = await loadAirportFuelRows(db, icaos);
  return (icao) => stationFor(icao, rows.get(icao), ctx, economy);
}

/**
 * The world curve at an in-game instant (§11).
 *
 * `gameNow` is **game time**, like every instant in the queue: the curve runs on
 * the world's own calendar, so a world at 4× walks it four times as fast in real
 * time as one at 1×. That is deliberate and is the same choice a contract term
 * and a maintenance interval make — the price is a fact about the world's
 * history, not about how long the server has been up.
 */
export function marketAt(
  ctx: WorldFuelContext,
  gameNow: Date,
  economy: PinnedEconomyConfig,
): FuelMarket {
  return worldFuelMarket(
    {
      basePricePerTonne: economy.fuel.basePricePerTonne,
      worldSeed: ctx.seed,
      epoch: ctx.epoch,
      gameNow,
    },
    economy.fuel.curve,
  );
}

/**
 * The world curve as of *now*, for a caller holding a wall clock.
 *
 * The live half of {@link marketAt}: a fare-floor preview and a cost estimate are
 * §14 decision support, so they quote today's price and are *meant* to move as
 * the world's calendar walks the curve. A settlement never uses this — it prices
 * a stored instant, because a replay has to reproduce the bill.
 */
export function marketNow(
  ctx: WorldFuelContext,
  now: Date,
  economy: PinnedEconomyConfig,
): FuelMarket {
  return marketAt(ctx, gameTime(fuelClockOf(ctx), now), economy);
}
