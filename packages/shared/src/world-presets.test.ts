import { describe, expect, it } from 'vitest';

import { ERA_PRESETS, FLAGSHIP_CONFIG, WorldConfig, WorldPreset } from './world-config';

/**
 * §22.2's era presets (M11-02).
 *
 * A preset is only useful if it is a *valid* starting config, so the load-bearing
 * assertion here is that each one parses with the very schema the create
 * endpoint validates against — which is also what makes "exported and recreated
 * identically" true by construction.
 */
describe('ERA_PRESETS', () => {
  it('offers the six eras §22.2 names', () => {
    expect(ERA_PRESETS.map((p) => p.id)).toEqual([
      'piston-prop-1950',
      'jet-age-1958',
      'widebody-1970',
      'deregulation-1978',
      'modern-2024',
      'sandbox',
    ]);
  });

  it('parses every preset, and every preset config, with the real schemas', () => {
    for (const preset of ERA_PRESETS) {
      expect(WorldPreset.safeParse(preset).success, `${preset.id} is not a valid preset`).toBe(
        true,
      );
      // The one that matters: this is the schema `POST /api/admin/worlds` guards
      // with, so a preset that fails here would be an offer the console cannot
      // accept back.
      expect(WorldConfig.safeParse(preset.config).success, `${preset.id} config`).toBe(true);
    }
  });

  it('keeps ids and names unique, so a picker cannot be ambiguous', () => {
    expect(new Set(ERA_PRESETS.map((p) => p.id)).size).toBe(ERA_PRESETS.length);
    expect(new Set(ERA_PRESETS.map((p) => p.config.name)).size).toBe(ERA_PRESETS.length);
  });

  it('never starts a world at a future epoch', () => {
    // The epoch is a historical date by design — the flagship note in
    // `world-config.ts` explains why a drifting one would make a reset meaningless.
    const now = Date.now();
    for (const preset of ERA_PRESETS) {
      expect(Date.parse(preset.config.epoch), `${preset.id}`).toBeLessThan(now);
    }
  });

  it('orders the four historical eras as history ran', () => {
    const historical = ERA_PRESETS.filter((p) => p.id.endsWith('1950') || /19\d\d$/.test(p.id));
    const epochs = historical.map((p) => Date.parse(p.config.epoch));
    for (let i = 1; i < epochs.length; i += 1) {
      expect(epochs[i]).toBeGreaterThan(epochs[i - 1]!);
    }
    // …and every one of them precedes the modern era.
    const modern = Date.parse(FLAGSHIP_CONFIG.epoch);
    for (const epoch of epochs) expect(epoch).toBeLessThan(modern);
  });

  it('marks the sandbox as fast, and leaves the playable eras at the flagship speed', () => {
    const sandbox = ERA_PRESETS.find((p) => p.id === 'sandbox');
    expect(sandbox?.config.speedMultiplier).toBeGreaterThan(FLAGSHIP_CONFIG.speedMultiplier);
    for (const preset of ERA_PRESETS.filter((p) => p.id !== 'sandbox')) {
      expect(preset.config.speedMultiplier, preset.id).toBe(FLAGSHIP_CONFIG.speedMultiplier);
    }
  });

  it('pins every preset to the shipped catalogue and economy versions', () => {
    // A preset must not quietly introduce a different balance payload; §22.5 and
    // §22.3 keep those versioned separately and deliberately.
    for (const preset of ERA_PRESETS) {
      expect(preset.config.aircraftCatalogueVersion).toBe(FLAGSHIP_CONFIG.aircraftCatalogueVersion);
      expect(preset.config.economyConfigVersion).toBe(FLAGSHIP_CONFIG.economyConfigVersion);
    }
  });
});
