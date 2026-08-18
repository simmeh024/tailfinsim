import { describe, expect, it } from 'vitest';

import { loadReferenceLists, type ReferenceLists } from './reference';
import {
  classifyAirport,
  MEDIUM_MIN_RUNWAY_FT,
  REGIONAL_MAX_RUNWAY_FT,
  type ClassifiableAirport,
} from './tier';

/**
 * The tier rules.
 *
 * Pure, so this needs no database — which matters, because the thresholds are
 * the part most likely to be nudged later and the part where a nudge silently
 * reshapes the whole game economy.
 */

const reference = loadReferenceLists();

function airport(overrides: Partial<ClassifiableAirport> = {}): ClassifiableAirport {
  return {
    ident: 'TEST',
    iataCode: null,
    isoCountry: 'NL',
    kind: 'medium_airport',
    scheduledService: true,
    longestRunwayFt: 9_000,
    openRunways: 2,
    ...overrides,
  };
}

describe('reference lists', () => {
  it('loads both files, comments and all', () => {
    expect(reference.tiers.size).toBeGreaterThan(100);
    expect(reference.slotLevels.size).toBeGreaterThan(0);
  });

  it('seeds 25 flagships, as App. B.3 asks for', () => {
    const flagships = [...reference.tiers.values()].filter((t) => t === 'flagship');
    expect(flagships).toHaveLength(25);
  });

  it('includes every airport B.3 names as flagship', () => {
    // The acceptance criterion, as a unit test on the input rather than on the
    // database — if the list is wrong, this fails before anything is written.
    for (const iata of ['LHR', 'JFK', 'DXB', 'HND', 'CDG', 'SIN', 'LAX', 'HKG', 'AMS', 'FRA']) {
      expect(reference.tiers.get(iata), `${iata} should be flagship`).toBe('flagship');
    }
  });

  it('keeps the airports B.3 names as large out of the flagship tier', () => {
    // B.3 lists MAD, ZRH, YYZ, GRU, BOM and MEL as examples of *large*. Promoting
    // any of them would contradict the doc directly.
    for (const iata of ['MAD', 'ZRH', 'YYZ', 'GRU', 'BOM', 'MEL']) {
      expect(reference.tiers.get(iata), `${iata} should be large`).toBe('large');
    }
  });
});

describe('classifyAirport', () => {
  it('gives no tier to an airport without scheduled service', () => {
    // B.3's counts sum to the playable subset, not to all 86,000 aerodromes.
    const result = classifyAirport(airport({ scheduledService: false }), reference);
    expect(result.tier).toBeNull();
    expect(result.slotLevel).toBeNull();
  });

  it('gives no tier to a closed airport', () => {
    expect(classifyAirport(airport({ kind: 'closed' }), reference).tier).toBeNull();
  });

  it('takes a seeded tier from the reference list over the runway facts', () => {
    // These runway facts would otherwise make it small. The seed has to win,
    // because hub status is a traffic fact and not a tarmac fact.
    const result = classifyAirport(
      airport({ iataCode: 'LGA', longestRunwayFt: 7_000, openRunways: 2 }),
      reference,
    );
    expect(result.tier).toBe('large');
    expect(result.basis.seeded).toBe(true);
  });

  it('classifies a big two-runway jet airport as medium', () => {
    const result = classifyAirport(airport({ longestRunwayFt: 9_000, openRunways: 2 }), reference);
    expect(result.tier).toBe('medium');
    expect(result.slotLevel).toBe(2);
  });

  it('classifies a long single-runway airport as small', () => {
    const result = classifyAirport(airport({ longestRunwayFt: 9_000, openRunways: 1 }), reference);
    expect(result.tier).toBe('small');
    expect(result.slotLevel).toBe(1);
  });

  it('classifies a short-runway airport as regional with no slot coordination', () => {
    const result = classifyAirport(airport({ longestRunwayFt: 4_000, openRunways: 1 }), reference);
    expect(result.tier).toBe('regional');
    expect(result.slotLevel).toBeNull();
  });

  it('treats an unknown runway length as regional, not as long', () => {
    // 311 scheduled-service airports have no runway data at all. Assuming they
    // are big would promote them into the contested tiers on missing data.
    const result = classifyAirport(airport({ longestRunwayFt: null, openRunways: 0 }), reference);
    expect(result.tier).toBe('regional');
    expect(result.basis.rule).toMatch(/no open runway/);
  });

  it.each(['small_airport', 'heliport', 'seaplane_base'])(
    'keeps %s regional however long its runway',
    (kind) => {
      const result = classifyAirport(
        airport({ kind, longestRunwayFt: 13_000, openRunways: 4 }),
        reference,
      );
      expect(result.tier).toBe('regional');
      expect(result.basis.rule).toContain(kind);
    },
  );

  it('sits exactly on the regional boundary as documented', () => {
    // Just below is regional, at the threshold is not. A fencepost error here
    // moves hundreds of airports between tiers.
    expect(
      classifyAirport(airport({ longestRunwayFt: REGIONAL_MAX_RUNWAY_FT - 1 }), reference).tier,
    ).toBe('regional');
    expect(
      classifyAirport(airport({ longestRunwayFt: REGIONAL_MAX_RUNWAY_FT }), reference).tier,
    ).not.toBe('regional');
  });

  it('sits exactly on the medium boundary as documented', () => {
    expect(
      classifyAirport(
        airport({ longestRunwayFt: MEDIUM_MIN_RUNWAY_FT - 1, openRunways: 2 }),
        reference,
      ).tier,
    ).toBe('small');
    expect(
      classifyAirport(airport({ longestRunwayFt: MEDIUM_MIN_RUNWAY_FT, openRunways: 2 }), reference)
        .tier,
    ).toBe('medium');
  });

  describe('slot levels', () => {
    it('follows B.3 when there is no override', () => {
      expect(classifyAirport(airport({ iataCode: 'LHR' }), reference).slotLevel).toBe(3);
      expect(
        classifyAirport(airport({ longestRunwayFt: 9_000, openRunways: 2 }), reference).slotLevel,
      ).toBe(2);
      expect(
        classifyAirport(airport({ longestRunwayFt: 9_000, openRunways: 1 }), reference).slotLevel,
      ).toBe(1);
    });

    it('applies the US override, so the busiest airport on earth is not Level 3', () => {
      // ATL is not slot-coordinated. Deriving level 3 from "this is huge" would
      // hand the US a scarcity mechanic it does not have (B.3, §8.1).
      const atl = classifyAirport(airport({ iataCode: 'ATL', isoCountry: 'US' }), reference);
      expect(atl.tier).toBe('flagship');
      expect(atl.slotLevel).toBe(2);
      expect(atl.basis.slotRule).toMatch(/override/);
    });

    it('keeps the three US airports that really are slot-controlled at level 3', () => {
      for (const iata of ['JFK', 'LGA', 'DCA']) {
        expect(classifyAirport(airport({ iataCode: iata }), reference).slotLevel).toBe(3);
      }
    });
  });

  describe('audit trail', () => {
    it('records the rule that fired and the numbers it fired on', () => {
      // M1-02: "Store the classification inputs so a human can audit why an
      // airport got its tier."
      const result = classifyAirport(
        airport({ longestRunwayFt: 10_500, openRunways: 3, kind: 'large_airport' }),
        reference,
      );
      expect(result.basis).toMatchObject({
        longestRunwayFt: 10_500,
        openRunways: 3,
        kind: 'large_airport',
        seeded: false,
      });
      expect(result.basis.rule).toContain('10500');
    });

    it('says so when the tier came from the seed rather than the rules', () => {
      const result = classifyAirport(airport({ iataCode: 'AMS' }), reference);
      expect(result.basis.seeded).toBe(true);
      expect(result.basis.rule).toMatch(/seeded flagship/);
    });
  });

  it('is deterministic', () => {
    const input = airport({ iataCode: 'BCN', longestRunwayFt: 11_000, openRunways: 3 });
    expect(classifyAirport(input, reference)).toEqual(classifyAirport(input, reference));
  });

  it('classifies an airport with no IATA code at all', () => {
    // Thousands of scheduled-service airports have none, so an unseeded lookup
    // must not be a special case.
    const empty: ReferenceLists = { tiers: new Map(), slotLevels: new Map() };
    expect(classifyAirport(airport({ iataCode: null, longestRunwayFt: 6_000 }), empty).tier).toBe(
      'regional',
    );
  });
});
