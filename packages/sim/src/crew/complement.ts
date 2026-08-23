import { ECONOMY_CONFIG_V1 } from '@tailfin/shared';
import type {
  CabinRank,
  CrewRegulationBalance,
  FlightDeckRank,
  CrewBalance,
} from '@tailfin/shared';

/**
 * What a flight legally needs on board (§9.2, M5-01).
 *
 * ## Seats fitted, not seats sold
 *
 * The cabin requirement scales with the seats **installed in the aeroplane**, and
 * that is the whole reason this is not a function of the booking. A flight that
 * sells nine tickets on a 180-seat aircraft still carries four cabin crew,
 * because the regulation counts what is bolted to the floor. It is also what
 * makes a densified cabin a two-sided decision: §7.2's high-density
 * configuration earns more fares *and* costs a crew member at every fiftieth
 * seat.
 *
 * ## Rank is a floor, not an exact demand
 *
 * A complement says "at least a Captain and a First Officer", not "exactly". A
 * Training Captain may fly as a Captain and a Senior First Officer as a First
 * Officer; the ladder in §9.2 is a promotion order, so anyone above the rank can
 * cover it. {@link coversRank} is the single place that decides this, so a rule
 * change lands in one function rather than in every caller that compares two
 * ranks.
 */

/** The flight-deck ladder in promotion order. Index is seniority. */
export const FLIGHT_DECK_LADDER: readonly FlightDeckRank[] = [
  'cadet',
  'first_officer',
  'senior_first_officer',
  'captain',
  'training_captain',
];

/** The cabin ladder in promotion order. Index is seniority. */
export const CABIN_LADDER: readonly CabinRank[] = [
  'cabin_crew',
  'senior_cabin_crew',
  'purser',
  'cabin_service_manager',
];

export type CrewRank = FlightDeckRank | CabinRank;

/** Whether `held` is senior enough to fill a slot asking for `needed`. */
export function coversRank(held: CrewRank, needed: CrewRank): boolean {
  const deckHeld = FLIGHT_DECK_LADDER.indexOf(held as FlightDeckRank);
  const deckNeeded = FLIGHT_DECK_LADDER.indexOf(needed as FlightDeckRank);
  if (deckHeld >= 0 && deckNeeded >= 0) return deckHeld >= deckNeeded;

  const cabinHeld = CABIN_LADDER.indexOf(held as CabinRank);
  const cabinNeeded = CABIN_LADDER.indexOf(needed as CabinRank);
  if (cabinHeld >= 0 && cabinNeeded >= 0) return cabinHeld >= cabinNeeded;

  // Different ladders. A Purser cannot fly the aeroplane and a Captain does not
  // serve the cabin, whatever the seniority numbers happen to be.
  return false;
}

/** One rank, and how many of it a flight needs. */
export interface ComplementSlot {
  rank: CrewRank;
  count: number;
}

export interface Complement {
  flightDeck: readonly ComplementSlot[];
  cabin: readonly ComplementSlot[];
  /** Everyone, for the cost and availability arithmetic that does not care which. */
  totalHeads: number;
}

export interface ComplementInput {
  /** Seats **fitted**, from the airframe's configuration. */
  seats: number;
  /** Scheduled block time, which is what decides relief crew. */
  blockMinutes: number;
}

/**
 * The legal complement for one flight.
 *
 * Deterministic and total: any non-negative seat count and block time produces a
 * complement, because there is no input a schedule can offer that should make
 * this throw rather than answer.
 */
export function requiredComplement(
  { seats, blockMinutes }: ComplementInput,
  regulation: CrewRegulationBalance = DEFAULT_CREW.regulation,
): Complement {
  const flightDeckSets = blockMinutes >= regulation.reliefCrewFromBlockMinutes ? 2 : 1;
  /*
   * Relief is a second *set*, so it is a second Captain and a second First
   * Officer rather than one more body. A relief crew has to be able to operate
   * the aeroplane while the operating crew rest, which a single extra pilot
   * cannot do.
   */
  const perSet = Math.max(1, Math.floor(regulation.flightDeckPerFlight / 2));
  const flightDeck: ComplementSlot[] = (
    [
      { rank: 'captain', count: perSet * flightDeckSets },
      { rank: 'first_officer', count: (regulation.flightDeckPerFlight - perSet) * flightDeckSets },
    ] satisfies ComplementSlot[]
  ).filter((slot) => slot.count > 0);

  const cabinTotal =
    seats <= 0
      ? 0
      : Math.max(regulation.minimumCabinCrew, Math.ceil(seats / regulation.seatsPerCabinCrew));

  const cabin: ComplementSlot[] = [];
  let remaining = cabinTotal;
  if (cabinTotal > 0 && seats >= regulation.cabinServiceManagerFromSeats) {
    cabin.push({ rank: 'cabin_service_manager', count: 1 });
    remaining -= 1;
  }
  if (remaining > 0 && seats >= regulation.purserFromSeats) {
    cabin.push({ rank: 'purser', count: 1 });
    remaining -= 1;
  }
  if (remaining > 0) cabin.push({ rank: 'cabin_crew', count: remaining });

  const totalHeads =
    flightDeck.reduce((n, slot) => n + slot.count, 0) +
    cabin.reduce((n, slot) => n + slot.count, 0);

  return { flightDeck, cabin, totalHeads };
}

/** The shipped crew balance, as a slice of the economy config rather than a copy. */
export const DEFAULT_CREW: CrewBalance = ECONOMY_CONFIG_V1.crew;
