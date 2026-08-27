import { describe, expect, it } from 'vitest';

import {
  DEFAULT_GROUND_HANDLING,
  groundVendorRisk,
  HANDLER_GRADES,
  handlerProfile,
} from './vendor';

/**
 * The ground-handler grades (M5-06, §9.3).
 *
 * The invariant that makes the trade legible: a cheaper grade is worse on every
 * operational axis, monotonically, so "budget" always means slower and less
 * reliable — never a free win hiding in the numbers.
 */
describe('ground handler grades', () => {
  const budget = handlerProfile('budget');
  const standard = handlerProfile('standard');
  const premium = handlerProfile('premium');

  it('lists the three grades', () => {
    expect(HANDLER_GRADES).toEqual(['budget', 'standard', 'premium']);
  });

  it('is monotonic — money buys reliability, speed and quality', () => {
    expect(budget.reliability).toBeLessThan(standard.reliability);
    expect(standard.reliability).toBeLessThan(premium.reliability);

    // A higher speed factor is *slower* — budget takes longest.
    expect(budget.speedFactor).toBeGreaterThan(standard.speedFactor);
    expect(standard.speedFactor).toBeGreaterThan(premium.speedFactor);

    expect(budget.quality).toBeLessThan(standard.quality);
    expect(standard.quality).toBeLessThan(premium.quality);

    // And it costs what it is worth.
    expect(budget.priceIndex).toBeLessThan(standard.priceIndex);
    expect(standard.priceIndex).toBeLessThan(premium.priceIndex);
  });

  it('turns reliability into the ground-vendor disruption risk', () => {
    // The complement of reliability, and a cheap handler carries far more of it.
    expect(groundVendorRisk(budget)).toBeCloseTo(1 - budget.reliability, 10);
    expect(groundVendorRisk(budget)).toBeGreaterThan(groundVendorRisk(premium));
  });

  it('clamps the risk into [0, 1]', () => {
    expect(groundVendorRisk({ reliability: 1, speedFactor: 1, quality: 1, priceIndex: 1 })).toBe(0);
    expect(groundVendorRisk({ reliability: 0, speedFactor: 1, quality: 1, priceIndex: 1 })).toBe(1);
    // Defensive against a mis-tuned config beyond the sane range.
    expect(groundVendorRisk({ reliability: 1.5, speedFactor: 1, quality: 1, priceIndex: 1 })).toBe(
      0,
    );
  });

  it('exposes a versioned default config', () => {
    expect(DEFAULT_GROUND_HANDLING.grades.standard.speedFactor).toBe(1);
  });
});
