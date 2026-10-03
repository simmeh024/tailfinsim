import { describe, expect, it } from 'vitest';

import { EfficiencyQuantityReadout } from '@tailfin/shared';

import {
  ceilingFill,
  formatReduction,
  quantitySummary,
  sourceShares,
} from './efficiency-presentation';

function readout(overrides: Partial<EfficiencyQuantityReadout> = {}): EfficiencyQuantityReadout {
  return EfficiencyQuantityReadout.parse({
    quantity: 'fuelBurn',
    ceiling: 0.08,
    uncapped: 0,
    fraction: 0,
    capped: false,
    bySource: { skills: 0, trainingCaptains: 0, doctrine: 0 },
    ...overrides,
  });
}

describe('formatReduction', () => {
  it('reads as a reduction, to a tenth of a percent below ten', () => {
    expect(formatReduction(0.032)).toBe('−3.2%');
    expect(formatReduction(0.15)).toBe('−15%');
    expect(formatReduction(0)).toBe('0%');
  });
});

describe('sourceShares', () => {
  it('sums to the applied fraction, so the bar is never longer than the boost', () => {
    // Two sources at 4% each stack to 7.84%, not 8%.
    const stacked = 1 - 0.96 * 0.96;
    const shares = sourceShares(
      readout({
        uncapped: stacked,
        fraction: stacked,
        bySource: { skills: 0.04, trainingCaptains: 0, doctrine: 0.04 },
      }),
    );
    const total = shares.reduce((sum, share) => sum + share.applied, 0);
    expect(total).toBeCloseTo(stacked, 12);
    // Equal sources take equal shares.
    expect(shares.find((s) => s.source === 'skills')?.applied).toBeCloseTo(stacked / 2, 12);
    expect(shares.find((s) => s.source === 'trainingCaptains')?.applied).toBe(0);
  });

  it('scales every share down together when the ceiling clips the stack', () => {
    const shares = sourceShares(
      readout({
        uncapped: 0.19,
        fraction: 0.08,
        capped: true,
        bySource: { skills: 0.1, trainingCaptains: 0, doctrine: 0.1 },
      }),
    );
    expect(shares.reduce((sum, share) => sum + share.applied, 0)).toBeCloseTo(0.08, 12);
    expect(shares.find((s) => s.source === 'doctrine')?.alone).toBe(0.1);
  });

  it('gives nothing to anyone when nothing is held', () => {
    expect(sourceShares(readout()).every((share) => share.applied === 0)).toBe(true);
  });
});

describe('ceilingFill and quantitySummary', () => {
  it('fills against the ceiling and says when the ceiling has stopped it', () => {
    const capped = readout({ uncapped: 0.11, fraction: 0.08, capped: true });
    expect(ceilingFill(capped)).toBe(1);
    expect(quantitySummary(capped)).toContain('another boost here buys nothing');

    const half = readout({ uncapped: 0.04, fraction: 0.04 });
    expect(ceilingFill(half)).toBeCloseTo(0.5, 12);
    expect(quantitySummary(half)).toBe('−4.0% of a −8.0% ceiling.');

    expect(quantitySummary(readout())).toBe('Nothing reduces fuel burn yet.');
  });
});
