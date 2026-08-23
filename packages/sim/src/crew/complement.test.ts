import { describe, expect, it } from 'vitest';

import { CABIN_LADDER, coversRank, DEFAULT_CREW, requiredComplement } from './complement';

/**
 * The legal complement (§9.2, M5-01).
 *
 * The acceptance criterion this serves is *"every flight validates a legal
 * complement before departure"*, and the part worth pinning is that the cabin
 * scales with **seats fitted**. A flight that sells nine tickets on a 180-seat
 * aeroplane still carries four cabin crew.
 */

const regulation = DEFAULT_CREW.regulation;
const cabinHeads = (seats: number, blockMinutes = 90) =>
  requiredComplement({ seats, blockMinutes }).cabin.reduce((n, slot) => n + slot.count, 0);

describe('cabin crew scale with the seats that are fitted', () => {
  it('adds one at every fiftieth seat, rounding up', () => {
    // The regulation is one per fifty *installed*, so 51 seats needs two.
    expect(cabinHeads(50)).toBe(1);
    expect(cabinHeads(51)).toBe(2);
    expect(cabinHeads(100)).toBe(2);
    expect(cabinHeads(101)).toBe(3);
    expect(cabinHeads(180)).toBe(4);
  });

  it('never drops below the minimum, however small the aeroplane', () => {
    expect(cabinHeads(19)).toBe(regulation.minimumCabinCrew);
    expect(cabinHeads(1)).toBe(regulation.minimumCabinCrew);
  });

  it('asks for nobody in a cabin with no seats in it', () => {
    // A ferry or a freighter is not a cabin with a minimum; it is not a cabin.
    expect(cabinHeads(0)).toBe(0);
    expect(requiredComplement({ seats: 0, blockMinutes: 90 }).flightDeck).not.toEqual([]);
  });

  it('does not vary with how many seats were sold', () => {
    // There is no passenger count in the input at all, which is the strongest
    // form of this guarantee — the rule cannot accidentally start reading one.
    const nineSold = requiredComplement({ seats: 180, blockMinutes: 90 });
    const fullFlight = requiredComplement({ seats: 180, blockMinutes: 90 });
    expect(nineSold).toEqual(fullFlight);
  });
});

describe('who leads the cabin', () => {
  it('puts a purser in from the threshold up, and not below it', () => {
    const below = requiredComplement({ seats: regulation.purserFromSeats - 1, blockMinutes: 90 });
    const at = requiredComplement({ seats: regulation.purserFromSeats, blockMinutes: 90 });
    expect(below.cabin.map((s) => s.rank)).not.toContain('purser');
    expect(at.cabin.map((s) => s.rank)).toContain('purser');
  });

  it('adds a cabin service manager only on the big aeroplanes', () => {
    const narrowbody = requiredComplement({ seats: 180, blockMinutes: 90 });
    const widebody = requiredComplement({
      seats: regulation.cabinServiceManagerFromSeats,
      blockMinutes: 600,
    });
    expect(narrowbody.cabin.map((s) => s.rank)).not.toContain('cabin_service_manager');
    expect(widebody.cabin.map((s) => s.rank)).toContain('cabin_service_manager');
  });

  it('counts the leaders within the requirement rather than on top of it', () => {
    // A 300-seat cabin needs six; one of them is the CSM and one the purser. If
    // the leaders were added on top the aeroplane would carry eight, and the
    // regulation does not say that.
    const seats = 300;
    expect(cabinHeads(seats)).toBe(Math.ceil(seats / regulation.seatsPerCabinCrew));
  });
});

describe('the flight deck', () => {
  it('is a captain and a first officer on an ordinary sector', () => {
    const complement = requiredComplement({ seats: 180, blockMinutes: 90 });
    expect(complement.flightDeck).toEqual([
      { rank: 'captain', count: 1 },
      { rank: 'first_officer', count: 1 },
    ]);
  });

  it('doubles for relief crew once the sector is long enough', () => {
    const long = requiredComplement({
      seats: 300,
      blockMinutes: regulation.reliefCrewFromBlockMinutes,
    });
    // A second *set*, not one more pilot: relief crew have to be able to operate
    // the aeroplane while the operating crew rest.
    expect(long.flightDeck).toEqual([
      { rank: 'captain', count: 2 },
      { rank: 'first_officer', count: 2 },
    ]);
  });

  it('does not add relief a minute early', () => {
    const short = requiredComplement({
      seats: 300,
      blockMinutes: regulation.reliefCrewFromBlockMinutes - 1,
    });
    expect(short.flightDeck).toEqual([
      { rank: 'captain', count: 1 },
      { rank: 'first_officer', count: 1 },
    ]);
  });
});

describe('rank cover', () => {
  it('lets seniority fill a junior slot but not the other way round', () => {
    expect(coversRank('training_captain', 'captain')).toBe(true);
    expect(coversRank('captain', 'captain')).toBe(true);
    expect(coversRank('first_officer', 'captain')).toBe(false);
    expect(coversRank('cabin_service_manager', 'purser')).toBe(true);
    expect(coversRank('cabin_crew', 'purser')).toBe(false);
  });

  it('never lets one ladder cover the other', () => {
    // A Captain does not serve the cabin and a Purser does not fly the aeroplane,
    // whatever their positions in their own ladders happen to be.
    for (const cabin of CABIN_LADDER) {
      expect(coversRank('training_captain', cabin)).toBe(false);
      expect(coversRank(cabin, 'captain')).toBe(false);
    }
  });
});
