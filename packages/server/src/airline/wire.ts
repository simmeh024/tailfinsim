import { type Airline as AirlineContract } from '@tailfin/shared';

import { type AirlineRow } from '../db/schema';

/** Normalise one stored airline into the shared wire contract. */
export function wireAirline(row: AirlineRow): AirlineContract {
  return {
    id: row.id,
    worldId: row.worldId,
    playerId: row.playerId,
    name: row.name,
    iataCode: row.iataCode,
    icaoCode: row.icaoCode,
    callsign: row.callsign,
    baseCountry: row.baseCountry,
    cash: row.cashMinor,
    // `numeric(3,2)` is a string at the database boundary. The shared wire
    // schema is deliberately a number, so normalise once here.
    reputation: Number(row.reputation),
    status: row.status,
    statusChangedAt: row.statusChangedAt.toISOString(),
    ceasedAt: row.ceasedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
