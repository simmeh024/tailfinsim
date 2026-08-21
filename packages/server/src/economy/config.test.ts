import { describe, expect, it } from 'vitest';

import { canonicalEconomyJson, ECONOMY_CONFIG_V1 as SHIPPED } from '@tailfin/shared';

import {
  defineEconomyConfig,
  ECONOMY_CONFIG_V1,
  economyChecksum,
  UnknownEconomyConfigError,
} from './config';

/**
 * The server's side of an economy version: parse it, freeze it, identify it.
 *
 * The numbers themselves are `@tailfin/shared`'s and are tested there. What
 * matters here is that a payload from an untrusted place cannot become a live
 * config without being checked, and that a version can be identified
 * independently of how its JSON happened to be written.
 */

describe('the shipped payload, as the server holds it', () => {
  it('is the payload from shared, parsed rather than cast', () => {
    expect(ECONOMY_CONFIG_V1).toEqual(SHIPPED);
    expect(ECONOMY_CONFIG_V1.version).toBe('v1');
  });

  it('cannot be mutated after a world has pinned it, at any depth', () => {
    expect(Object.isFrozen(ECONOMY_CONFIG_V1)).toBe(true);
    expect(Object.isFrozen(ECONOMY_CONFIG_V1.airlineStartingPosition)).toBe(true);
    // The deep freeze is what actually holds: a shallow one would leave every
    // β coefficient writable by anything holding the object.
    expect(Object.isFrozen(ECONOMY_CONFIG_V1.demand.logit.beta.leisure)).toBe(true);
    expect(Object.isFrozen(ECONOMY_CONFIG_V1.demand.schedFit.curve.business)).toBe(true);
    expect(Object.isFrozen(ECONOMY_CONFIG_V1.demand.bookingCurve.bands[0])).toBe(true);
  });

  it('throws rather than silently ignoring a write to a coefficient', () => {
    // Frozen objects swallow writes outside strict mode; modules are strict, so
    // an attempt to retune in place is an error at the point it happens.
    expect(() => {
      (ECONOMY_CONFIG_V1.demand.logit.beta.leisure as { price: number }).price = 9;
    }).toThrow(TypeError);
    expect(ECONOMY_CONFIG_V1.demand.logit.beta.leisure.price).toBe(3.0);
  });
});

describe('parsing a payload from an untrusted place', () => {
  it('accepts a valid one and freezes it', () => {
    const parsed = defineEconomyConfig(JSON.parse(canonicalEconomyJson(SHIPPED)) as unknown);
    expect(parsed).toEqual(SHIPPED);
    expect(Object.isFrozen(parsed.costs.settlement)).toBe(true);
  });

  it('refuses one that is missing a field', () => {
    // The case this exists for: a row written by an older build, read back by a
    // newer one whose schema has grown. A clear refusal at load beats a NaN
    // fare six hours later.
    const { pricing: _pricing, ...incomplete } = SHIPPED;
    expect(() => defineEconomyConfig(incomplete)).toThrow();
  });

  it('refuses one with a coefficient of the wrong type', () => {
    const wrong = JSON.parse(canonicalEconomyJson(SHIPPED)) as Record<string, unknown>;
    (
      wrong.demand as { logit: { beta: { leisure: { price: unknown } } } }
    ).logit.beta.leisure.price = '3.0';
    expect(() => defineEconomyConfig(wrong)).toThrow();
  });
});

describe('identifying a version', () => {
  it('is stable across key order', () => {
    // Built by reversing the payload's own key order rather than by listing the
    // sections, so adding a section to `EconomyConfig` cannot silently stop this
    // test reordering anything — which is exactly what happened when M3-12
    // added `npc` to a hand-written list.
    const reordered = defineEconomyConfig(Object.fromEntries(Object.entries(SHIPPED).reverse()));

    // Which is the whole point: the seed compares a stored v1 against the
    // shipped v1 on every boot, and a checksum over raw JSON text would cry
    // wolf whenever a serialiser wrote the keys in a different order.
    expect(economyChecksum(reordered)).toBe(economyChecksum(SHIPPED));
  });

  it('changes when any single number changes', () => {
    const retuned = defineEconomyConfig({
      ...JSON.parse(canonicalEconomyJson(SHIPPED)),
      pricing: { fareFloorRatio: 0.55 },
    });
    expect(economyChecksum(retuned)).not.toBe(economyChecksum(SHIPPED));
  });

  it('is a sha-256 hex digest', () => {
    expect(economyChecksum(SHIPPED)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('a version that is not there', () => {
  it('says which one, and says it does not fall back', () => {
    // The refusal matters more than the message. A world quietly running the
    // shipped numbers instead of the ones it was tuned with is invariant 3
    // failing in the way that is hardest to notice.
    const error = new UnknownEconomyConfigError('autumn-retune');
    expect(error.version).toBe('autumn-retune');
    expect(error.message).toMatch(/autumn-retune/);
    expect(error.message).toMatch(/nothing falls back/);
  });
});
