import { describe, expect, it } from 'vitest';

import { ECONOMY_CONFIG_V1_VERSION, FLAGSHIP_CONFIG } from '@tailfin/shared';

import { assertUsableConfig } from './config';

const NOW = new Date('2026-08-20T12:00:00.000Z');

/** Stands in for `economy_config`, so this stays a test about the rule. */
const known = (...versions: string[]) => {
  return (version: string) => Promise.resolve(versions.includes(version));
};

describe('usable world config', () => {
  it('accepts a world that pins an economy version the database has', async () => {
    await expect(
      assertUsableConfig(FLAGSHIP_CONFIG, NOW, known(ECONOMY_CONFIG_V1_VERSION)),
    ).resolves.toBeUndefined();
  });

  it('refuses an unknown economy version at creation rather than at airline founding', async () => {
    await expect(
      assertUsableConfig(
        { ...FLAGSHIP_CONFIG, economyConfigVersion: 'missing' },
        NOW,
        known(ECONOMY_CONFIG_V1_VERSION),
      ),
    ).rejects.toThrow(/Economy config missing is not in economy_config/);
  });

  it('refuses an epoch that is not in the past, before it asks about the economy', async () => {
    // Order matters: the epoch check needs no database and the economy check
    // does, so a world with both problems should fail on the cheap one.
    let asked = false;
    await expect(
      assertUsableConfig({ ...FLAGSHIP_CONFIG, epoch: NOW.toISOString() }, NOW, () => {
        asked = true;
        return Promise.resolve(true);
      }),
    ).rejects.toThrow(/not in the past/);
    expect(asked).toBe(false);
  });
});
