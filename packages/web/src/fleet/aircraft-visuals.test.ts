import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AIRCRAFT_CATALOGUE_V1_DESIGNATIONS } from '@tailfin/shared';

import { AIRCRAFT_VISUALS, aircraftVisual } from './aircraft-visuals';

describe('the aircraft type visual registry', () => {
  it('covers every current canonical catalogue type with one unique versioned asset', () => {
    expect(Object.keys(AIRCRAFT_VISUALS)).toHaveLength(AIRCRAFT_CATALOGUE_V1_DESIGNATIONS.length);
    const assets = AIRCRAFT_CATALOGUE_V1_DESIGNATIONS.map((designation) => {
      const asset = aircraftVisual(designation);
      expect(asset, designation).not.toBeNull();
      return asset!;
    });

    expect(new Set(assets.map((asset) => asset.id)).size).toBe(assets.length);
    expect(assets.every((asset) => asset.version === 'v1')).toBe(true);
    expect(assets.every((asset) => asset.width === 1440 && asset.height === 960)).toBe(true);
  });

  it('falls back without turning an unknown future type into a broken image', () => {
    expect(aircraftVisual('Future type not in this build')).toBeNull();
  });

  it('keeps both responsive variants inside the catalogue asset budget', async () => {
    const directory = resolve(process.cwd(), 'packages/web/src/fleet/assets/aircraft/v1');
    const files = (await readdir(directory)).filter((file) => file.endsWith('.webp'));
    const sizes = await Promise.all(
      files.map(async (file) => (await stat(join(directory, file))).size),
    );

    expect(files).toHaveLength(AIRCRAFT_CATALOGUE_V1_DESIGNATIONS.length * 2);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(50 * 1024);
    expect(sizes.reduce((total, size) => total + size, 0)).toBeLessThanOrEqual(1024 * 1024);
  });
});
