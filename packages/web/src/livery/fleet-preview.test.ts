import { describe, expect, it } from 'vitest';

import { createBaseFillLayer } from './editor-model';
import { fleetPreviewBlendMode, fleetPreviewPaint, liveryFamilyVisual } from './fleet-preview';

describe('fleet livery preview', () => {
  it('maps every authoring family to a catalogue render', () => {
    for (const family of [
      'ATR 72',
      'Dash 8',
      'E-Jet E2',
      'A220',
      '737NG',
      '737 MAX',
      'A320neo',
      '787',
      'A350',
      '777',
      '777X',
      'A380',
      '747',
    ]) {
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
});
