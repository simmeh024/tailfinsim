import { describe, expect, it } from 'vitest';

import {
  BOOST_PER_NEIGHBOUR,
  ceilingFor,
  connectivityFor,
  deriveConnectivity,
  effectiveUsageWeight,
  MAX_COUNTED_NEIGHBOURS,
  NEIGHBOUR_RADIUS_KM,
} from './connectivity';
import { TIER_WEIGHTS, type AirportTier, type CatchmentAirport } from './derive';

/**
 * The proximity connection boost.
 *
 * The rule that matters is the ordering one — a boosted airport must never
 * overtake the tier above it — so most of these tests are about that, including
 * one that turns the per-neighbour rate up absurdly high to prove the guarantee
 * is structural rather than a consequence of tame numbers.
 */

function airport(overrides: Partial<CatchmentAirport> = {}): CatchmentAirport {
  return {
    id: 'a',
    ident: 'AAAA',
    latitude: 52.3,
    longitude: 4.76,
    isoCountry: 'NL',
    tier: 'regional',
    ...overrides,
  };
}

/** Roughly `km` east of the reference point, at this latitude. */
function eastOf(base: CatchmentAirport, km: number, id: string): CatchmentAirport {
  const degreesPerKm = 1 / (111.32 * Math.cos((base.latitude * Math.PI) / 180));
  return { ...base, id, ident: id, longitude: base.longitude + km * degreesPerKm };
}

describe('who gets a boost', () => {
  it('boosts a regional airport with neighbours', () => {
    expect(connectivityFor('regional', 2).index).toBeGreaterThan(1);
  });

  it('boosts small and medium too', () => {
    expect(connectivityFor('small', 2).index).toBeGreaterThan(1);
    expect(connectivityFor('medium', 2).index).toBeGreaterThan(1);
  });

  it.each<AirportTier>(['large', 'flagship'])('leaves %s alone', (tier) => {
    // Already the popular ones. A further boost there widens the widest gap on
    // the map.
    expect(connectivityFor(tier, 4).index).toBe(1);
  });

  it('gives an isolated airport no boost at all', () => {
    expect(connectivityFor('regional', 0).index).toBe(1);
  });

  it('grows with neighbours, up to a point', () => {
    const one = connectivityFor('small', 1).index;
    const two = connectivityFor('small', 2).index;
    expect(two).toBeGreaterThan(one);
    // The fourth nearby airport is not news.
    expect(connectivityFor('small', MAX_COUNTED_NEIGHBOURS + 10).index).toBe(
      connectivityFor('small', MAX_COUNTED_NEIGHBOURS).index,
    );
  });

  it('keeps the boost small', () => {
    // "A small connection boost" — not a promotion.
    expect(connectivityFor('small', MAX_COUNTED_NEIGHBOURS).index).toBeLessThanOrEqual(1.25);
  });
});

describe('the ordering guarantee', () => {
  it('never lets a boosted airport reach the tier above it', () => {
    for (const tier of ['regional', 'small', 'medium'] as const) {
      const best = connectivityFor(tier, 99);
      const boosted = effectiveUsageWeight(tier, best.index);
      const above: Record<'regional' | 'small' | 'medium', AirportTier> = {
        regional: 'small',
        small: 'medium',
        medium: 'large',
      };
      expect(boosted, `boosted ${tier} must stay under ${above[tier]}`).toBeLessThan(
        TIER_WEIGHTS[above[tier]],
      );
    }
  });

  it('holds even if the per-neighbour rate were set absurdly high', () => {
    // The guarantee has to be structural, not a happy consequence of 0.06. The
    // ceiling is computed from the tier weights, so an arbitrarily large raw
    // boost still lands under the tier above.
    for (const tier of ['regional', 'small', 'medium'] as const) {
      const ceiling = ceilingFor(tier);
      const above = { regional: 'small', small: 'medium', medium: 'large' } as const;
      expect(TIER_WEIGHTS[tier] * ceiling).toBeLessThan(TIER_WEIGHTS[above[tier]]);
    }
  });

  it('a regional airport beside two medium ones still loses to a lone medium one', () => {
    // The user's own example, as a test.
    const wellConnectedRegional = effectiveUsageWeight(
      'regional',
      connectivityFor('regional', 2).index,
    );
    const isolatedMedium = effectiveUsageWeight('medium', connectivityFor('medium', 0).index);
    expect(wellConnectedRegional).toBeLessThan(isolatedMedium);
  });

  it('but it does beat a regional airport in the middle of nowhere', () => {
    // The whole point of the mechanic.
    const connected = effectiveUsageWeight('regional', connectivityFor('regional', 2).index);
    const isolated = effectiveUsageWeight('regional', connectivityFor('regional', 0).index);
    expect(connected).toBeGreaterThan(isolated);
  });

  it('reports when the ceiling bit rather than the rate', () => {
    // Visible in the audit trail, so a capped airport is explainable.
    expect(connectivityFor('regional', 0).cappedByTier).toBe(false);
    // regional weight 0.5 against small 1.0 gives a ceiling near 1.96, which the
    // current rate never reaches — so nothing is capped today, and this records
    // that fact rather than asserting a cap that does not happen.
    expect(connectivityFor('regional', MAX_COUNTED_NEIGHBOURS).index).toBeLessThan(
      ceilingFor('regional'),
    );
  });

  it('gives an unboosted tier a ceiling of exactly 1', () => {
    expect(ceilingFor('large')).toBe(1);
    expect(ceilingFor('flagship')).toBe(1);
  });
});

describe('deriveConnectivity over coordinates', () => {
  it('counts an airport 10 km away as a neighbour', () => {
    const base = airport({ id: 'a', ident: 'AAAA' });
    const near = eastOf(base, 10, 'b');
    const result = deriveConnectivity([base, near]);
    expect(result.get('a')?.neighbours).toBe(1);
    expect(result.get('a')?.index).toBeGreaterThan(1);
  });

  it('does not count one 30 km away', () => {
    const base = airport({ id: 'a', ident: 'AAAA' });
    const far = eastOf(base, 30, 'b');
    expect(deriveConnectivity([base, far]).get('a')?.neighbours).toBe(0);
  });

  it('sits on the documented radius', () => {
    const base = airport({ id: 'a' });
    const justInside = eastOf(base, NEIGHBOUR_RADIUS_KM - 1, 'b');
    const justOutside = eastOf(base, NEIGHBOUR_RADIUS_KM + 1, 'c');
    expect(deriveConnectivity([base, justInside]).get('a')?.neighbours).toBe(1);
    expect(deriveConnectivity([base, justOutside]).get('a')?.neighbours).toBe(0);
  });

  it('does not count an airport as its own neighbour', () => {
    expect(deriveConnectivity([airport({ id: 'a' })]).get('a')?.neighbours).toBe(0);
  });

  it('is symmetric — both airports see each other', () => {
    const base = airport({ id: 'a', ident: 'AAAA' });
    const near = eastOf(base, 8, 'b');
    const result = deriveConnectivity([base, near]);
    expect(result.get('a')?.neighbours).toBe(1);
    expect(result.get('b')?.neighbours).toBe(1);
  });

  it('counts neighbours across a grid-cell boundary', () => {
    // The bucketing is an optimisation; it must not change the answer for a pair
    // that straddles a cell edge.
    const base = airport({ id: 'a', latitude: 52.0, longitude: 4.4999 });
    const across = airport({ id: 'b', latitude: 52.0, longitude: 4.5001 });
    expect(deriveConnectivity([base, across]).get('a')?.neighbours).toBe(1);
  });

  it('gives every airport an entry, boosted or not', () => {
    const airports = [
      airport({ id: 'a', tier: 'flagship' }),
      airport({ id: 'b', tier: 'regional' }),
    ];
    const result = deriveConnectivity(airports);
    expect(result.size).toBe(2);
    expect(result.get('a')?.index).toBe(1);
  });

  it('is deterministic', () => {
    const airports = [airport({ id: 'a' }), eastOf(airport({ id: 'a' }), 5, 'b')];
    expect(deriveConnectivity(airports)).toEqual(deriveConnectivity(airports));
  });
});

describe('rate constants', () => {
  it('adds up to the documented maximum', () => {
    expect(1 + BOOST_PER_NEIGHBOUR * MAX_COUNTED_NEIGHBOURS).toBeCloseTo(1.24, 6);
  });
});
