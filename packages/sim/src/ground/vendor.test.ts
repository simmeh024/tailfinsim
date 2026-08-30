import { describe, expect, it } from 'vitest';

import { HANDLER_GRADES } from '@tailfin/shared';

import {
  contractExpiring,
  contractTermEnd,
  DEFAULT_GROUND_HANDLING,
  groundVendorRisk,
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

/**
 * Contract terms (M5-06, §9.3: "Contracts run for a fixed term").
 *
 * Game time in, game time out — the span is the world's calendar, not real weeks.
 */
describe('ground contract terms', () => {
  const DAY = 86_400_000;
  const signed = new Date('2024-10-20T00:00:00.000Z');

  it('ends a term termDays after signing', () => {
    const end = contractTermEnd(signed);
    expect(end.getTime() - signed.getTime()).toBe(DEFAULT_GROUND_HANDLING.termDays * DAY);
  });

  it('is not expiring early in the term', () => {
    const end = contractTermEnd(signed);
    // The day after signing: a full term still to run.
    expect(contractExpiring(end, new Date(signed.getTime() + DAY))).toBe(false);
  });

  it('is expiring once inside the warning window', () => {
    const end = contractTermEnd(signed);
    // One day before the term ends: well inside the fortnight's warning.
    expect(contractExpiring(end, new Date(end.getTime() - DAY))).toBe(true);
  });

  it('is still expiring once overdue but not yet swept', () => {
    const end = contractTermEnd(signed);
    expect(contractExpiring(end, new Date(end.getTime() + DAY))).toBe(true);
  });

  it('never flags a term-less legacy contract', () => {
    expect(contractExpiring(null, signed)).toBe(false);
  });

  it('flags exactly at the edge of the warning window', () => {
    const end = contractTermEnd(signed);
    const window = DEFAULT_GROUND_HANDLING.expiryWarningDays * DAY;
    expect(contractExpiring(end, new Date(end.getTime() - window))).toBe(true);
    expect(contractExpiring(end, new Date(end.getTime() - window - 1))).toBe(false);
  });
});
