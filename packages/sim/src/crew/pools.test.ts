import { describe, expect, it } from 'vitest';

import { availableHeads, checkComplement, fragmentation, type CrewPool } from './pools';

/**
 * Crew pools, and the commonality mechanic (§9.2, M5-01).
 *
 * The acceptance criterion here is *"a mixed fleet visibly fragments the crew
 * pool and reduces availability"*, and the thing worth proving is that it does so
 * **arithmetically** — there is no penalty coefficient, only crew who are not
 * rated on the aeroplane in front of them.
 */

const pool = (family: string, rank: CrewPool['rank'], headcount: number, unavailable = 0) => ({
  family,
  rank,
  headcount,
  unavailable,
});

/** Enough of everything to fly a 180-seat narrowbody on a short sector. */
const narrowbodyCrew = (family: string): CrewPool[] => [
  pool(family, 'captain', 2),
  pool(family, 'first_officer', 2),
  pool(family, 'purser', 1),
  pool(family, 'cabin_crew', 4),
];

const shortSector = { seats: 180, blockMinutes: 90 };

describe('a complement is checked against the family that will fly it', () => {
  it('passes when the family has the ranks', () => {
    const result = checkComplement(shortSector, narrowbodyCrew('A320neo'), 'A320neo');
    expect(result.ok).toBe(true);
  });

  it('fails on the identical crew when they are rated on another family', () => {
    /*
     * The mechanic in one assertion. The airline has exactly the crew it needs
     * and cannot fly the aeroplane, because a type rating is per family and this
     * is a different one. No coefficient produced this — the pools simply are not
     * in the filter.
     */
    const result = checkComplement(shortSector, narrowbodyCrew('A320neo'), '737 MAX');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.shortfalls.map((s) => s.rank)).toContain('captain');
  });

  it('reports every unmet rank, not just the first', () => {
    // "Hire two Captains and a Purser" is an answer; "hire a Captain", three
    // times in a row as the player fixes them one by one, is not.
    const thin = [pool('A320neo', 'cabin_crew', 4)];
    const result = checkComplement(shortSector, thin, 'A320neo');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.shortfalls.map((s) => s.rank).sort()).toEqual([
      'captain',
      'first_officer',
      'purser',
    ]);
  });

  it('says how short it is, not merely that it is short', () => {
    const oneCaptain = [
      pool('A320neo', 'captain', 1),
      pool('A320neo', 'first_officer', 2),
      pool('A320neo', 'purser', 1),
      pool('A320neo', 'cabin_crew', 4),
    ];
    // A twelve-hour sector needs two of each on the flight deck.
    const result = checkComplement({ seats: 180, blockMinutes: 720 }, oneCaptain, 'A320neo');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.shortfalls).toContainEqual({ rank: 'captain', needed: 2, available: 1 });
  });
});

describe('seniority fills in from the bottom', () => {
  it('spends the juniormost adequate rank first', () => {
    /*
     * One Captain and one Training Captain, and a flight needing one Captain. If
     * the Training Captain were taken first the airline would look short of
     * Training Captains while a Captain stood idle — a shortage the arithmetic
     * invented rather than found.
     */
    const pools = [
      pool('A320neo', 'captain', 1),
      pool('A320neo', 'training_captain', 1),
      pool('A320neo', 'first_officer', 2),
      pool('A320neo', 'purser', 1),
      pool('A320neo', 'cabin_crew', 4),
    ];
    // Two sequential single-captain flights are coverable, which is only true if
    // the first one did not reach past the Captain for the Training Captain.
    expect(checkComplement(shortSector, pools, 'A320neo').ok).toBe(true);
    const bothNeeded = checkComplement({ seats: 180, blockMinutes: 720 }, pools, 'A320neo');
    expect(bothNeeded.ok).toBe(true);
  });

  it('lets a senior rank cover a junior slot', () => {
    const senior = [
      pool('A320neo', 'training_captain', 1),
      pool('A320neo', 'senior_first_officer', 1),
      pool('A320neo', 'cabin_service_manager', 1),
      pool('A320neo', 'senior_cabin_crew', 4),
    ];
    expect(checkComplement(shortSector, senior, 'A320neo').ok).toBe(true);
  });
});

describe('crew in training are not crew on the roster', () => {
  it('excludes the unavailable from a complement check', () => {
    const converting = narrowbodyCrew('A320neo').map((p) =>
      p.rank === 'captain' ? { ...p, unavailable: 2 } : p,
    );
    // The heads still exist — that is the point of showing them — but they are in
    // a classroom, and the flight cannot go.
    expect(availableHeads(converting[0]!)).toBe(0);
    expect(checkComplement(shortSector, converting, 'A320neo').ok).toBe(false);
  });
});

describe('fragmentation is reported, not charged', () => {
  it('strands nothing when the fleet is one family', () => {
    const report = fragmentation(narrowbodyCrew('A320neo'));
    expect(report.families).toEqual(['A320neo']);
    expect(report.strandedHeads).toBe(0);
    expect(report.totalAvailable).toBe(report.largestFamilyAvailable);
  });

  it('strands the smaller family once the fleet is mixed', () => {
    const mixed = [...narrowbodyCrew('A320neo'), ...narrowbodyCrew('737 MAX').slice(0, 2)];
    const report = fragmentation(mixed);
    expect(report.families).toEqual(['737 MAX', 'A320neo']);
    // Nine on the A320neo, four on the MAX: the four cannot cover an A320neo.
    expect(report.totalAvailable).toBe(13);
    expect(report.largestFamilyAvailable).toBe(9);
    expect(report.strandedHeads).toBe(4);
  });

  it('reports an airline with no crew as empty rather than throwing', () => {
    // Every new airline starts here; it is a state, not an error.
    expect(fragmentation([])).toEqual({
      families: [],
      totalAvailable: 0,
      largestFamilyAvailable: 0,
      strandedHeads: 0,
    });
  });
});
