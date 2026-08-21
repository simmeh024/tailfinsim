import { describe, expect, it } from 'vitest';

import { ECONOMY_CONFIG_V1_VERSION, FLAGSHIP_CONFIG } from '@tailfin/shared';

import { assertUsableConfig } from './config';

const NOW = new Date('2026-08-20T12:00:00.000Z');

/** Stands in for the two pin tables, so this stays a test about the rule. */
const known = (...versions: string[]) => {
  const check = (version: string) => Promise.resolve(versions.includes(version));
  return { economyVersionExists: check, catalogueVersionExists: check };
};

describe('usable world config', () => {
  it('accepts a world that pins an economy version the database has', async () => {
    await expect(
      assertUsableConfig(
        FLAGSHIP_CONFIG,
        NOW,
        known(ECONOMY_CONFIG_V1_VERSION, FLAGSHIP_CONFIG.aircraftCatalogueVersion),
      ),
    ).resolves.toBeUndefined();
  });

  it('refuses an unknown economy version at creation rather than at airline founding', async () => {
    await expect(
      assertUsableConfig(
        { ...FLAGSHIP_CONFIG, economyConfigVersion: 'missing' },
        NOW,
        known(ECONOMY_CONFIG_V1_VERSION, FLAGSHIP_CONFIG.aircraftCatalogueVersion),
      ),
    ).rejects.toThrow(/Economy config missing is not in economy_config/);
  });

  it('refuses an epoch that is not in the past, before it asks about the economy', async () => {
    // Order matters: the epoch check needs no database and the economy check
    // does, so a world with both problems should fail on the cheap one.
    let asked = false;
    await expect(
      assertUsableConfig({ ...FLAGSHIP_CONFIG, epoch: NOW.toISOString() }, NOW, {
        economyVersionExists: () => {
          asked = true;
          return Promise.resolve(true);
        },
        catalogueVersionExists: () => {
          asked = true;
          return Promise.resolve(true);
        },
      }),
    ).rejects.toThrow(/not in the past/);
    expect(asked).toBe(false);
  });

  it('refuses an aircraft catalogue version the database does not have', async () => {
    // The second pin, and it fails the same way the first does. §22.5 versions
    // the catalogue separately from the economy so that retuning aircraft
    // cannot retroactively change a running world's fares — which only works if
    // a world cannot be created pinned to a catalogue that is not there.
    await expect(
      assertUsableConfig(
        { ...FLAGSHIP_CONFIG, aircraftCatalogueVersion: 'missing' },
        NOW,
        known(ECONOMY_CONFIG_V1_VERSION, FLAGSHIP_CONFIG.aircraftCatalogueVersion),
      ),
    ).rejects.toThrow(/Aircraft catalogue missing is not in aircraft_type/);
  });
});
