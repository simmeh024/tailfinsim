import { z } from 'zod';

import {
  AirlineIataCode,
  AirlineIcaoCode,
  AirportIdent,
  CountryCode,
  MinorUnits,
  Reputation,
  Timestamp,
  Uuid,
} from './primitives';

/**
 * The starting point of the reputation scale (§15), not a balance lever.
 *
 * AIR-03 deliberately keeps this out of economy config: changing it would
 * redefine what the 0.00–1.00 scale means rather than retune an economy.
 */
export const INITIAL_AIRLINE_REPUTATION = 0.35 as const;

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
}).extend({
  /** The first hub is chosen at founding and granted without a purchase (App. B.5). */
  hubIdent: AirportIdent,
});
export type CreateAirlineInput = z.infer<typeof CreateAirlineInput>;

/** One airport at which an airline is based. M7-04 adds purchases and facilities. */
export const AirlineHub = z.object({
  id: Uuid,
  airlineId: Uuid,
  airportIdent: AirportIdent,
  /** True only when consumed from the world's free-hub starting allowance. */
  founderGrant: z.boolean(),
  createdAt: Timestamp,
});
export type AirlineHub = z.infer<typeof AirlineHub>;

/** The complete result of AIR-01's one transactional founding operation. */
export const CreateAirlineResponse = z.object({
  airline: Airline,
  hub: AirlineHub,
});
export type CreateAirlineResponse = z.infer<typeof CreateAirlineResponse>;
