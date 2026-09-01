import { describe, expect, it } from 'vitest';

import { validateAircraftLiveryResourceBundle } from './index';

const aircraftAsset = { id: 'aircraft/a320neo', version: 'quarantine-v1' };

function validBundle() {
  return {
    liveryUv: {
      format: 'tailfin-aircraft-livery-resource',
      formatVersion: 1,
      kind: 'livery_uv',
      resource: { id: 'livery-uv/a320neo', version: 'quarantine-v1' },
      aircraftAsset,
      sourcePbrTexCoord: 'TEXCOORD_0',
      liveryTexCoord: 'TEXCOORD_1',
      atlasResolution: 4096,
      gutterPx: 16,
      islands: [
        {
          id: 'fuselage-port',
          materialName: 'mat-fuselage',
          surface: 'fuselage',
          side: 'port',
          zone: 'fuselage',
          bounds: { x: 0.02, y: 0.02, width: 0.46, height: 0.8 },
        },
        {
          id: 'fuselage-starboard',
          materialName: 'mat-fuselage',
          surface: 'fuselage',
          side: 'starboard',
          zone: 'fuselage',
          bounds: { x: 0.52, y: 0.02, width: 0.46, height: 0.8 },
        },
      ],
    },
    materialBinding: {
      format: 'tailfin-aircraft-livery-resource',
      formatVersion: 1,
      kind: 'material_binding',
      resource: { id: 'materials/a320neo', version: 'quarantine-v1' },
      aircraftAsset,
      materials: [
        {
          materialName: 'mat-fuselage',
          kind: 'paintable',
          surface: 'fuselage',
          receivesLivery: true,
          finish: { roughnessMin: 0.15, roughnessMax: 0.85, metallicMax: 0.2 },
        },
        {
          materialName: 'mat-cockpit-glass',
          kind: 'protected',
          surface: 'cockpit_glass',
          receivesLivery: false,
        },
      ],
    },
    anchorSet: {
      format: 'tailfin-aircraft-livery-resource',
      formatVersion: 1,
      kind: 'anchor_set',
      resource: { id: 'anchors/a320neo', version: 'quarantine-v1' },
      aircraftAsset,
      anchors: [
        {
          id: 'registration-port',
          nodeName: 'anchor_registration_port',
          zone: 'registration_area',
          side: 'port',
          safeArea: { x: 0.1, y: 0.2, width: 0.2, height: 0.1 },
        },
      ],
    },
  };
}

describe('aircraft livery resources', () => {
  it('accepts a complete immutable livery resource bundle', () => {
    expect(validateAircraftLiveryResourceBundle(validBundle()).success).toBe(true);
  });

  it('rejects overlapping livery islands', () => {
    const bundle = validBundle();
    bundle.liveryUv.islands[1]!.bounds.x = 0.4;
    expect(validateAircraftLiveryResourceBundle(bundle).success).toBe(false);
  });

  it('does not allow protected materials to be painted', () => {
    const bundle = validBundle();
    bundle.liveryUv.islands[0]!.materialName = 'mat-cockpit-glass';
    expect(validateAircraftLiveryResourceBundle(bundle).success).toBe(false);
  });

  it('does not silently combine different aircraft versions', () => {
    const bundle = validBundle();
    bundle.anchorSet.aircraftAsset = { id: 'aircraft/a320neo', version: 'other' };
    expect(validateAircraftLiveryResourceBundle(bundle).success).toBe(false);
  });
});
