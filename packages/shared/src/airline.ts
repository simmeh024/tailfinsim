import { z } from 'zod';

import {
  AirlineIataCode,
  AirlineIcaoCode,
  CountryCode,
  MinorUnits,
  Reputation,
  Timestamp,
  Uuid,
} from './primitives';

/**
 * An airline — a player's presence in one world. Mirrors the `airline` table
 * from M0-06.
 */
export const Airline = z.object({
  id: Uuid,
  worldId: Uuid,
  playerId: Uuid,

  name: z.string().min(1).max(120),

  /** Unique per world, not globally — §24 notes ~1,300 usable IATA codes. */
  iataCode: AirlineIataCode,
  icaoCode: AirlineIcaoCode,

  callsign: z.string().min(1).max(60),
  baseCountry: CountryCode,

  cash: MinorUnits,
  reputation: Reputation,

  createdAt: Timestamp,
});
export type Airline = z.infer<typeof Airline>;

/**
 * What another player may see (§16: public airline profiles and leaderboards).
 *
 * Derived from `Airline` by picking, rather than being written out again, so a
 * field added to `Airline` cannot silently fail to appear here — and, more
 * importantly, a *private* field cannot silently leak into it. Cash is
 * deliberately absent.
 */
export const PublicAirline = Airline.pick({
  id: true,
  worldId: true,
  name: true,
  iataCode: true,
  icaoCode: true,
  baseCountry: true,
  reputation: true,
  createdAt: true,
});
export type PublicAirline = z.infer<typeof PublicAirline>;

/**
 * What a player supplies when founding an airline. Server-assigned fields
 * (`id`, `playerId`, `cash`, `reputation`, `createdAt`) are absent on purpose —
 * a client that could set its own starting cash would be a problem, and
 * omitting them from the input type makes that structurally impossible rather
 * than a validation rule someone has to remember.
 */
export const CreateAirlineInput = Airline.pick({
  worldId: true,
  name: true,
  iataCode: true,
  icaoCode: true,
  callsign: true,
  baseCountry: true,
});
export type CreateAirlineInput = z.infer<typeof CreateAirlineInput>;
