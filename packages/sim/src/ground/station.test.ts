import { describe, expect, it } from 'vitest';

import { stationVendors } from './station';

/**
 * Deriving a station's vendors (M5-06, §9.3).
 *
 * The two properties that matter: what a tier can support (a flagship has a
 * premium handler, a regional strip does not), and determinism (the same station
 * in the same world always offers the same thing, so two workers and a replay
 * agree).
 */
describe('a station’s vendors', () => {
  const SEED = 'world-seed-abc';

  it('offers every grade at a flagship, cheapest first', () => {
    const offers = stationVendors(SEED, 'KJFK', 'ramp_baggage', 'flagship');
    expect(offers.map((o) => o.grade)).toEqual(['budget', 'standard', 'premium']);
    for (const offer of offers) expect(offer.capacity).toBeGreaterThan(0);
  });

  it('offers only a budget handler at a regional strip', () => {
    const offers = stationVendors(SEED, 'EGHR', 'ramp_baggage', 'regional');
    expect(offers.map((o) => o.grade)).toEqual(['budget']);
  });

  it('is deterministic in the world seed, the airport and the service line', () => {
    const a = stationVendors(SEED, 'KJFK', 'fuelling', 'large');
    const b = stationVendors(SEED, 'KJFK', 'fuelling', 'large');
    expect(a).toEqual(b);
  });

  it('gives a station its own vendors, uncorrelated across service lines', () => {
    // Different streams: not required to differ, but derived independently, so a
    // change to one service line's generation never shifts another's.
    const ramp = stationVendors(SEED, 'KLAX', 'ramp_baggage', 'large');
    const fuel = stationVendors(SEED, 'KLAX', 'fuelling', 'large');
    expect(ramp.map((o) => o.grade)).toEqual(['budget', 'standard', 'premium']);
    expect(fuel.map((o) => o.grade)).toEqual(['budget', 'standard', 'premium']);
  });

  it('keeps premium scarce even at a flagship, so it can be exhausted', () => {
    const premium = stationVendors(SEED, 'KATL', 'ramp_baggage', 'flagship').find(
      (o) => o.grade === 'premium',
    );
    // Base 4, jittered ±1 — a handful of slots, not an open door.
    expect(premium?.capacity).toBeLessThanOrEqual(5);
    expect(premium?.capacity).toBeGreaterThanOrEqual(3);
  });
});
