import { describe, expect, it } from 'vitest';

import { FLAGSHIP_CONFIG } from '@tailfin/shared';

import { assertUsableConfig } from './config';

const NOW = new Date('2026-08-20T12:00:00.000Z');

describe('usable world config', () => {
  it('accepts a world that pins the shipped economy version', () => {
    expect(() => assertUsableConfig(FLAGSHIP_CONFIG, NOW)).not.toThrow();
  });

  it('refuses an unknown economy version at creation rather than at airline founding', () => {
    expect(() =>
      assertUsableConfig({ ...FLAGSHIP_CONFIG, economyConfigVersion: 'missing' }, NOW),
    ).toThrow(/Economy config missing is not registered.*pin a known immutable version/s);
  });
});
