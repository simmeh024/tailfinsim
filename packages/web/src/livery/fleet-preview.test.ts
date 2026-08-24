import { describe, expect, it } from 'vitest';

import { createBaseFillLayer } from './editor-model';
import {
  fleetPreviewBlendMode,
  fleetPreviewPaint,
  fleetPreviewZoneShapes,
  liveryFamilyVisual,
} from './fleet-preview';
import { AIRCRAFT_LIVERY_TEMPLATES } from './templates';

const FAMILY_NAMES = AIRCRAFT_LIVERY_TEMPLATES.map(({ family }) => family);

describe('fleet livery preview', () => {
  it('maps every authoring family to a catalogue render', () => {
    for (const family of FAMILY_NAMES) {
      expect(liveryFamilyVisual(family), family).toMatchObject({ version: 'v1' });
    }
    expect(liveryFamilyVisual('unknown')).toBeNull();
  });

  it('projects solid, linear, radial and split fills into material paint', () => {
    const solid = createBaseFillLayer('solid', 'Solid', 'fuselage', 'solid', '#112233', '#445566');
    const linear = createBaseFillLayer(
      'linear',
      'Linear',
      'fuselage',
      'linear',
      '#112233',
      '#445566',
    );
    const radial = createBaseFillLayer(
      'radial',
      'Radial',
      'fuselage',
      'radial',
      '#112233',
      '#445566',
    );
    const split = createBaseFillLayer('split', 'Split', 'fuselage', 'split', '#112233', '#445566');

    expect(fleetPreviewPaint(solid)).toBe('#112233');
    expect(fleetPreviewPaint(linear)).toContain('linear-gradient');
    expect(fleetPreviewPaint(radial)).toContain('radial-gradient');
    expect(fleetPreviewPaint(split)).toContain('50.01%');
    expect(fleetPreviewBlendMode(solid)).toBe('color');
  });

  it('registers visible wings and nacelles for every catalogue pose', () => {
    for (const family of FAMILY_NAMES) {
      expect(fleetPreviewZoneShapes(family, 'wings'), `${family} wings`).toHaveLength(2);
      expect(
        fleetPreviewZoneShapes(family, 'engine_nacelles').length,
        `${family} engine nacelles`,
      ).toBeGreaterThan(0);
    }

    expect(fleetPreviewZoneShapes('unknown', 'wings')).toEqual([]);
    expect(fleetPreviewZoneShapes('unknown', 'engine_nacelles')).toEqual([]);
  });

  it('uses family-aware shapes for the catalogue outliers', () => {
    expect(fleetPreviewZoneShapes('ATR 72', 'engine_nacelles')).toHaveLength(2);
    expect(
      fleetPreviewZoneShapes('ATR 72', 'engine_nacelles').every(
        (shape) => shape.kind === 'polygon',
      ),
    ).toBe(true);
    expect(fleetPreviewZoneShapes('ATR 72', 'winglets')).toEqual([]);
    expect(fleetPreviewZoneShapes('A380', 'engine_nacelles')).toHaveLength(2);
    expect(fleetPreviewZoneShapes('747', 'engine_nacelles')).toHaveLength(2);
    expect(fleetPreviewZoneShapes('A320neo', 'engine_nacelles')).toHaveLength(1);
    expect(fleetPreviewZoneShapes('737NG', 'engine_nacelles')).toHaveLength(1);
    expect(fleetPreviewZoneShapes('737NG', 'registration_area')).toHaveLength(1);
  });
});
