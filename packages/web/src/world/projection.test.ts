import { describe, expect, it } from 'vitest';

import { chooseInitialProjection, isLowPowerDevice, isWorldProjection } from './projection';

describe('world projection preference', () => {
  it('defaults a capable desktop to the globe', () => {
    expect(
      chooseInitialProjection({
        stored: null,
        narrowOrCoarse: false,
        deviceMemoryGb: 16,
        hardwareConcurrency: 12,
      }),
    ).toEqual({ projection: 'globe', lowPower: false, source: 'device-default' });
  });

  it.each([
    { narrowOrCoarse: true, deviceMemoryGb: 16, hardwareConcurrency: 12 },
    { narrowOrCoarse: false, deviceMemoryGb: 4, hardwareConcurrency: 12 },
    { narrowOrCoarse: false, deviceMemoryGb: 16, hardwareConcurrency: 4 },
  ])('defaults mobile and low-power devices to flat', (signals) => {
    expect(chooseInitialProjection({ stored: null, ...signals }).projection).toBe('flat');
  });

  it.each(['flat', 'globe'] as const)(
    'lets a stored %s choice override the device default',
    (stored) => {
      expect(
        chooseInitialProjection({
          stored,
          narrowOrCoarse: true,
          deviceMemoryGb: 2,
          hardwareConcurrency: 2,
        }),
      ).toMatchObject({ projection: stored, source: 'stored', lowPower: true });
    },
  );

  it('ignores a corrupt stored value', () => {
    expect(
      chooseInitialProjection({
        stored: 'mercator-ish',
        narrowOrCoarse: false,
        deviceMemoryGb: 16,
        hardwareConcurrency: 12,
      }).projection,
    ).toBe('globe');
  });

  it('recognises only the two supported projections', () => {
    expect(isWorldProjection('flat')).toBe(true);
    expect(isWorldProjection('globe')).toBe(true);
    expect(isWorldProjection('sphere')).toBe(false);
    expect(isWorldProjection(null)).toBe(false);
  });

  it('does not call missing device information low power', () => {
    expect(isLowPowerDevice({ deviceMemoryGb: undefined, hardwareConcurrency: undefined })).toBe(
      false,
    );
  });
});
