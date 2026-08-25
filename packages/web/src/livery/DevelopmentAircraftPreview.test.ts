import { describe, expect, it } from 'vitest';

import { LiveryColor, LiveryDocument, type LiveryLayer } from '@tailfin/shared';

import { a320neoDevelopmentMaterialColors } from './DevelopmentAircraftPreview';
import { createBaseFillLayer } from './editor-model';

function paintStyle(color: string) {
  return {
    fill: LiveryColor.parse(color),
    stroke: null,
    strokeWidth: 0,
    lineCap: 'round' as const,
    lineJoin: 'round' as const,
    shadow: null,
  };
}

function fill(overrides: Partial<LiveryLayer> = {}): LiveryLayer {
  return LiveryDocument.shape.layers.element.parse({
    ...createBaseFillLayer(
      crypto.randomUUID(),
      'Paint',
      'fuselage',
      'solid',
      '#204060FF',
      '#204060FF',
    ),
    opacity: 1,
    ...overrides,
  });
}

describe('A320neo dev material preview', () => {
  it('maps only whole-surface livery zones onto the named 3D materials', () => {
    const colors = a320neoDevelopmentMaterialColors([
      fill(),
      fill({ zone: 'tail_fin', style: paintStyle('#FF0000FF') }),
      fill({ zone: 'engine_nacelles', style: paintStyle('#00FF00FF') }),
      fill({ zone: 'nose', style: paintStyle('#000000FF') }),
    ]);

    expect(colors).toMatchObject({
      'mat-fuselage': '#204060',
      'mat-fin': '#ff0000',
      'mat-nacelle-exteriors': '#00ff00',
    });
    expect(Object.values(colors)).not.toContain('#000000');
  });

  it('composites opacity and visibility without changing protected materials', () => {
    const colors = a320neoDevelopmentMaterialColors([
      fill({ opacity: 0.5, style: paintStyle('#000000FF') }),
      fill({ visible: false, style: paintStyle('#FF0000FF') }),
    ]);

    expect(colors['mat-fuselage']).toBe('#808080');
    expect(colors['mat-cockpit-glass']).toBeUndefined();
    expect(colors['mat-cabin-windows']).toBeUndefined();
  });
});
