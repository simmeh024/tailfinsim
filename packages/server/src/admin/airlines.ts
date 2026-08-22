import { asc, count, desc, eq, inArray } from 'drizzle-orm';

import { type AdminAirlineDetailResponse } from '@tailfin/shared';

import { type Database } from '../db/client';
import { airline, airport, cashMovement, player, route, world } from '../db/schema';
import { parseFares } from '../network/fares';

/** One ledger page by default; bounded so the support view cannot request an unbounded history. */
export const AIRLINE_MOVEMENT_PAGE_LIMIT = 50;
const MAX_MOVEMENT_LIMIT = 200;

export interface AirlineReadOptions {
  movementLimit?: number;
  movementOffset?: number;
}

function boundedInteger(value: number | undefined, fallback: number, maximum?: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const integer = Math.max(Math.trunc(value), 0);
  return maximum === undefined ? integer : Math.min(Math.max(integer, 1), maximum);
}

/**
 * One airline's read-only support record (AIR-10, design doc §22.6).
 *
 * There is deliberately no neighbouring write function. Cash changes remain
 * structurally confined to AIR-06's `moveAirlineCash`, where the balance and
 * its immutable explanation are inserted in the same transaction. A support
 * page that offered a naked balance edit would undo that guarantee.
 *
 * The projection is read under one repeatable snapshot. In particular, the
 * headline balance and newest ledger row must not come from opposite sides of
 * a flight settlement that committed while the page was being assembled.
 */
export async function readAirline(
  db: Database,
  airlineId: string,
  options: AirlineReadOptions = {},
): Promise<AdminAirlineDetailResponse | null> {
  const movementLimit = boundedInteger(
    options.movementLimit,
    AIRLINE_MOVEMENT_PAGE_LIMIT,
    MAX_MOVEMENT_LIMIT,
  );
  const movementOffset = boundedInteger(options.movementOffset, 0);

  return db.transaction(
    async (tx) => {
      const rows = await tx
        .select({
          id: airline.id,
          worldId: airline.worldId,
          worldName: world.name,
          playerId: airline.playerId,
          kind: airline.kind,
          archetype: airline.archetype,
          name: airline.name,
          iataCode: airline.iataCode,
          icaoCode: airline.icaoCode,
          callsign: airline.callsign,
          baseCountry: airline.baseCountry,
          cashMinor: airline.cashMinor,
          reputation: airline.reputation,
          status: airline.status,
          statusChangedAt: airline.statusChangedAt,
          ceasedAt: airline.ceasedAt,
          createdAt: airline.createdAt,
        })
        .from(airline)
        .innerJoin(world, eq(world.id, airline.worldId))
        .where(eq(airline.id, airlineId))
        .limit(1);

      const row = rows[0];
      if (!row) return null;

      const routeRows = await tx
        .select({
          id: route.id,
          originIcao: route.originIcao,
          destinationIcao: route.destinationIcao,
          greatCircleNm: route.greatCircleNm,
          fares: route.fares,
          active: route.active,
          createdAt: route.createdAt,
          updatedAt: route.updatedAt,
        })
        .from(route)
        .where(eq(route.airlineId, airlineId))
        .orderBy(
          desc(route.active),
          asc(route.originIcao),
          asc(route.destinationIcao),
          asc(route.id),
        );

      const airportCodes = [
        ...new Set(routeRows.flatMap((entry) => [entry.originIcao, entry.destinationIcao])),
      ];
      const airportRows =
        airportCodes.length === 0
          ? []
          : await tx
              .select({ icaoCode: airport.icaoCode, name: airport.name })
              .from(airport)
              .where(inArray(airport.icaoCode, airportCodes));
      const airportNames = new Map(
        airportRows.flatMap((entry) =>
          entry.icaoCode === null ? [] : [[entry.icaoCode, entry.name] as const],
        ),
      );

      const ownerRows =
        row.playerId === null
          ? []
          : await tx
              .select({ id: player.id, displayName: player.displayName })
              .from(player)
              .where(eq(player.id, row.playerId))
              .limit(1);

      const movementTotals = await tx
        .select({ n: count() })
        .from(cashMovement)
        .where(eq(cashMovement.airlineId, airlineId));
      const movementRows = await tx
        .select({
          id: cashMovement.id,
          amountMinor: cashMovement.amountMinor,
          cause: cashMovement.cause,
          reference: cashMovement.reference,
          balanceAfterMinor: cashMovement.balanceAfterMinor,
          occurredAt: cashMovement.occurredAt,
          recordedAt: cashMovement.recordedAt,
        })
        .from(cashMovement)
        .where(eq(cashMovement.airlineId, airlineId))
        .orderBy(
          desc(cashMovement.occurredAt),
          desc(cashMovement.recordedAt),
          desc(cashMovement.id),
        )
        .limit(movementLimit)
        .offset(movementOffset);

      const owner = ownerRows[0] ?? null;
      return {
        airline: {
          id: row.id,
          worldId: row.worldId,
          worldName: row.worldName,
          owner,
          kind: row.kind,
          archetype: row.archetype,
          name: row.name,
          iataCode: row.iataCode,
          icaoCode: row.icaoCode,
          callsign: row.callsign,
          baseCountry: row.baseCountry,
          cashMinor: row.cashMinor,
          reputation: Number(row.reputation),
          status: row.status,
          statusChangedAt: row.statusChangedAt.toISOString(),
          ceasedAt: row.ceasedAt?.toISOString() ?? null,
          createdAt: row.createdAt.toISOString(),
          routes: routeRows.map((entry) => ({
            id: entry.id,
            originIcao: entry.originIcao,
            originName: airportNames.get(entry.originIcao) ?? entry.originIcao,
            destinationIcao: entry.destinationIcao,
            destinationName: airportNames.get(entry.destinationIcao) ?? entry.destinationIcao,
            greatCircleNm: entry.greatCircleNm,
            fares: parseFares(entry.fares),
            active: entry.active,
            createdAt: entry.createdAt.toISOString(),
            updatedAt: entry.updatedAt.toISOString(),
          })),
        },
        cashMovements: {
          entries: movementRows.map((entry) => ({
            id: entry.id,
            amountMinor: entry.amountMinor,
            cause: entry.cause,
            reference: entry.reference,
            balanceAfterMinor: entry.balanceAfterMinor,
            occurredAt: entry.occurredAt.toISOString(),
            recordedAt: entry.recordedAt.toISOString(),
          })),
          total: movementTotals[0]?.n ?? 0,
          limit: movementLimit,
          offset: movementOffset,
        },
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}
