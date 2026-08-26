import { DoubleSide, FrontSide, MeshStandardMaterial, Texture } from 'three';
import { describe, expect, it } from 'vitest';

import { LiveryColor, LiveryDocument, type LiveryLayer } from '@tailfin/shared';

import {
  A320NEO_DEV_MODEL_STAGES,
  a320neoDevelopmentMaterialColors,
  configureA320neoDevelopmentExteriorMaterial,
} from './DevelopmentAircraftPreview';
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
  it('loads the smallest model first and upgrades through all three LODs', () => {
    expect(A320NEO_DEV_MODEL_STAGES).toEqual([
      { level: 2, url: '/api/dev/assets/aircraft/aircraft-lod2.glb' },
      { level: 1, url: '/api/dev/assets/aircraft/aircraft-lod1.glb' },
      { level: 0, url: '/api/dev/assets/aircraft/aircraft-lod0.glb' },
    ]);
  });

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

  it('makes all salvaged surfaces double-sided and only exterior paint opaque', () => {
    const exterior = new MeshStandardMaterial({
      name: 'mat-fuselage',
      opacity: 0.25,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: FrontSide,
    });
    exterior.metalnessMap = new Texture();
    exterior.roughnessMap = new Texture();
    const glass = new MeshStandardMaterial({
      name: 'mat-cockpit-glass',
      opacity: 0.4,
      transparent: true,
      side: FrontSide,
    });

    expect(configureA320neoDevelopmentExteriorMaterial(exterior, DoubleSide)).toBe(true);
    expect(exterior).toMatchObject({
      alphaTest: 0,
      depthTest: true,
      depthWrite: true,
      opacity: 1,
      metalness: 0.06,
      metalnessMap: null,
      roughness: 0.72,
      roughnessMap: null,
      side: DoubleSide,
      transparent: false,
    });

    expect(configureA320neoDevelopmentExteriorMaterial(glass, DoubleSide)).toBe(false);
    expect(glass).toMatchObject({ opacity: 0.4, side: DoubleSide, transparent: true });
  });
});
