import { DoubleSide, FrontSide, MeshStandardMaterial, Texture } from 'three';
import { describe, expect, it } from 'vitest';

import { LiveryColor, LiveryDocument, type LiveryLayer } from '@tailfin/shared';

import {
  A320NEO_DEV_MODEL_STAGES,
  A320NEO_QUARANTINE_LIVERY_AUTHORING_STAGES,
  A320NEO_QUARANTINE_RECOVERY_STAGES,
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

  it('uses one explicit, quarantine-only endpoint for recovered-source review', () => {
    expect(A320NEO_QUARANTINE_RECOVERY_STAGES).toEqual([
      { level: 0, url: '/api/dev/assets/aircraft/quarantine-a320neo-recovery.glb' },
    ]);
  });

  it('uses a separate explicit endpoint for semantic authoring review', () => {
    expect(A320NEO_QUARANTINE_LIVERY_AUTHORING_STAGES).toEqual([
      { level: 0, url: '/api/dev/assets/aircraft/quarantine-a320neo-livery-authoring.glb' },
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

  it('makes all salvaged surfaces double-sided and seals exterior paint and windows', () => {
    const exterior = new MeshStandardMaterial({
      name: 'mat-fuselage',
      opacity: 0.25,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: FrontSide,
    });
    exterior.map = new Texture();
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
      map: null,
      metalnessMap: null,
      roughness: 0.72,
      roughnessMap: null,
      side: DoubleSide,
      transparent: false,
    });

    glass.map = new Texture();
    expect(configureA320neoDevelopmentExteriorMaterial(glass, DoubleSide)).toBe(false);
    expect(glass).toMatchObject({
      alphaTest: 0,
      depthTest: true,
      depthWrite: true,
      metalness: 0.12,
      map: null,
      metalnessMap: null,
      opacity: 1,
      roughness: 0.24,
      roughnessMap: null,
      side: DoubleSide,
      transparent: false,
    });
    expect(glass.color.getHexString()).toBe('244d68');
    expect(glass.emissive.getHexString()).toBe('07141e');
    expect(glass.emissiveIntensity).toBe(0.4);

    const engineInterior = new MeshStandardMaterial({ name: 'mat-engine-interiors' });
    expect(configureA320neoDevelopmentExteriorMaterial(engineInterior, DoubleSide)).toBe(false);
    expect(engineInterior).toMatchObject({
      depthTest: true,
      depthWrite: true,
      metalness: 0.3,
      opacity: 1,
      roughness: 0.48,
      side: DoubleSide,
      transparent: false,
    });
    expect(engineInterior.color.getHexString()).toBe('7f8992');
  });
});
