import { z } from 'zod';

import {
  AirportIcaoCode,
  CabinClass,
  Latitude,
  Longitude,
  MinorUnits,
  Timestamp,
  Uuid,
} from './primitives';

/**
 * Flights.
 *
 * **Provisional.** M1-07 implements the state machine and M1-08 the position
 * interpolation. This defines the vocabulary those milestones use, taken
 * straight from §3.3.
 */

/**
 * The nominal lifecycle from §3.3:
 *
 *   Scheduled → Boarding → Pushback → Taxi → Departure → Climb → Cruise →
 *   Descent → Approach → Landing → Taxi-in → Turnaround → Idle
 *
 * The doc calls the outbound one simply "Taxi"; it is `taxi_out` here so the two
 * taxi phases cannot be confused at a call site.
 */
export const FlightPhase = z.enum([
  'scheduled',
  'boarding',
  'pushback',
  'taxi_out',
  'departure',
  'climb',
  'cruise',
  'descent',
  'approach',
  'landing',
  'taxi_in',
  'turnaround',
  'idle',
]);
export type FlightPhase = z.infer<typeof FlightPhase>;

/**
 * The failure branches from §3.3, "reachable from the phases where they make
 * sense". Modelled alongside `phase` rather than inside it, because they are not
 * all mutually exclusive with progress: a flight can be `delayed` while still
 * moving through its phases, whereas `cancelled` and `diverted` end the story.
 *
 * Each carries its own cost, rebooking obligation and reputation consequence
 * (§8.4, §15), which is why the reason is part of the contract.
 */
export const FlightDisruption = z.enum([
  'delayed',
  'cancelled',
  'returned_to_stand',
  'air_return',
  'diverted',
]);
export type FlightDisruption = z.infer<typeof FlightDisruption>;

/**
 * Why the aircraft is flying (M2-07).
 *
 * `scheduled` is a flight that exists to carry people and earn money. `ferry` is
 * one that exists only to put the aircraft somewhere else: a delivery arriving
 * from the factory, a base change, an aircraft stranded by a diversion, or the
 * repositioning §18 charges for when an event pulls capacity across the network.
 *
 * A ferry carries **no passengers and no revenue, and every cost of a real
 * flight** — fuel, crew, maintenance, landing and handling all fall due. That
 * asymmetry is the whole point of the type: it is what makes a badly-planned
 * network expensive rather than merely untidy, and it is why the type exists in
 * the model rather than being expressed as "a scheduled flight nobody booked".
 *
 * §24's gap list names *"aircraft delivery positioning and ferry flights"* among
 * the areas the design doc does not specify, so this is M2-07 deciding it rather
 * than implementing a decision already taken.
 */
export const FlightKind = z.enum(['scheduled', 'ferry']);
export type FlightKind = z.infer<typeof FlightKind>;

/** Per-class seats sold and revenue. Partial: a flight has only the classes its cabin has. */
export const FlightLoad = z.partialRecord(
  CabinClass,
  z.object({
    seats: z.number().int().nonnegative(),
    passengers: z.number().int().nonnegative(),
    revenue: MinorUnits,
  }),
);
export type FlightLoad = z.infer<typeof FlightLoad>;

/**
 * A live or historical flight.
 *
 * §21 requires that flight state is *computed, not stored per tick*: departure
 * time, route, aircraft and config are persisted, and position is interpolated
 * on read. `position` therefore appears here as part of the wire shape — it is
 * something the server derives when asked, not a column.
 */
export const Flight = z.object({
  id: Uuid,
  worldId: Uuid,
  airlineId: Uuid,
  scheduleId: Uuid.nullable(),
  airframeId: Uuid,

  originIcao: AirportIcaoCode,
  destinationIcao: AirportIcaoCode,
  /** Set only when diverted, and then it is where the aircraft actually went. */
  diversionIcao: AirportIcaoCode.nullable(),

  kind: FlightKind,
  phase: FlightPhase,
  disruption: FlightDisruption.nullable(),

  scheduledDeparture: Timestamp,
  actualDeparture: Timestamp.nullable(),
  estimatedArrival: Timestamp,
  actualArrival: Timestamp.nullable(),

  load: FlightLoad,
  /** Belly cargo in kilograms (§12.1). */
  cargoKg: z.number().nonnegative(),

  createdAt: Timestamp,
});
export type Flight = z.infer<typeof Flight>;

/**
 * Interpolated position for the map (§4.1, M1-08). Separate from `Flight`
 * because the map layer refreshes this far more often than it needs the rest,
 * and shipping the whole flight record per tick per aircraft would be wasteful
 * at world scale.
 */
export const FlightPosition = z.object({
  flightId: Uuid,
  latitude: Latitude,
  longitude: Longitude,
  altitudeFt: z.number().int().nonnegative(),
  groundSpeedKt: z.number().nonnegative(),
  /** Degrees true, 0–359. */
  headingDeg: z.number().min(0).lt(360),
  /** 0–1 along the great circle. */
  progress: z.number().min(0).max(1),
  phase: FlightPhase,
});
export type FlightPosition = z.infer<typeof FlightPosition>;
