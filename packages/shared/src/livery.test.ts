import { describe, expect, it } from 'vitest';

import {
  LIVERY_DOCUMENT_FORMAT,
  LIVERY_DOCUMENT_FORMAT_VERSION,
  LIVERY_DOCUMENT_LEGACY_VERSION,
  LIVERY_DOCUMENT_MAX_BYTES,
  Livery,
  LiveryApplication,
  LiveryApplicationTarget,
  LiveryDocument,
  LiveryDraft,
  PublishedLiveryVersion,
  LiveryZone,
  canonicalLiveryDocumentJson,
  liveryDocumentJsonSchema,
  migrateLiveryDocumentV1ToV2,
  serializedLiveryDocumentSize,
} from './index';

const AIRLINE_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const LIVERY_ID = '11111111-2222-4333-8444-555555555555';
const AIRFRAME_A = '22222222-3333-4444-8555-666666666666';
const AIRFRAME_B = '33333333-4444-4555-8666-777777777777';

function common(id: string, fill: string | null = '#0B1F3AFF') {
  return {
    id,
    name: `Layer ${id}`,
    zone: 'fuselage',
    visible: true,
    locked: false,
    transform: {
      translate: { x: 0, y: 0 },
      scale: { x: 1, y: 1 },
      rotationDeg: 0,
      skewDeg: { x: 0, y: 0 },
    },
    style: {
      fill,
      stroke: null,
      strokeWidth: 0,
      lineCap: 'round',
      lineJoin: 'round',
      shadow: null,
    },
    opacity: 1,
    blendMode: 'normal',
    mask: null,
    placement: { side: 'both', symmetry: 'repeat', anchorId: null },
  };
}

function layer(type: string, id: string) {
  switch (type) {
    case 'fill':
      return { ...common(id), type };
    case 'gradient':
      return {
        ...common(id, null),
        type,
        gradient: {
          kind: 'linear',
          from: { x: 0, y: 0 },
          to: { x: 1, y: 0 },
          stops: [
            { offset: 0, color: '#0B1F3AFF' },
            { offset: 1, color: '#31D7CFFF' },
          ],
        },
      };
    case 'cheatline':
      return {
        ...common(id, null),
        type,
        anchor: { x: 0, y: 0.52 },
        width: 0.08,
        angleDeg: -2,
        sweep: 0.25,
        taper: 0.35,
        stripes: [
          { color: '#31D7CFFF', share: 0.7 },
          { color: '#FFFFFFFF', share: 0.3 },
        ],
      };
    case 'shape':
      return {
        ...common(id, '#F4B942FF'),
        type,
        operation: 'add',
        shape: {
          kind: 'polygon',
          points: [
            { x: 0.1, y: 0.1 },
            { x: 0.9, y: 0.2 },
            { x: 0.4, y: 0.8 },
          ],
        },
      };
    case 'path':
      return {
        ...common(id, '#FFFFFFFF'),
        type,
        commands: [
          { command: 'move', to: { x: 0, y: 0.5 } },
          {
            command: 'cubic',
            control1: { x: 0.25, y: 0.25 },
            control2: { x: 0.75, y: 0.75 },
            to: { x: 1, y: 0.5 },
          },
        ],
      };
    case 'brush':
      return {
        ...common(id, '#FFFFFFFF'),
        type,
        strokes: [
          {
            points: [
              { x: 0.1, y: 0.2, pressure: 0.5 },
              { x: 0.8, y: 0.7, pressure: 1 },
            ],
            width: 0.04,
            hardness: 0.8,
            spacing: 0.01,
          },
        ],
      };
    case 'text':
      return {
        ...common(id, '#FFFFFFFF'),
        type,
        text: 'TAILFIN AIR',
        fontFamily: 'Inter',
        fontVersion: '1.0.0',
        fontSize: 0.12,
        letterSpacing: 0.01,
        align: 'middle',
        arc: { radius: 1.8, startAngleDeg: -8 },
      };
    case 'logo':
      return {
        ...common(id, '#31D7CFFF'),
        type,
        logoId: 'tailfin-chevron',
        logoVersion: '1.0.0',
        mirrored: false,
      };
    case 'decal':
      return {
        ...common(id, null),
        type,
        decalId: 'founder-mark',
        decalVersion: '1.0.0',
        mirrored: false,
      };
    case 'registration':
      return {
        ...common(id, '#0B1F3AFF'),
        type,
        source: 'airframe.registration',
        fontFamily: 'Inter',
        fontVersion: '1.0.0',
        fontSize: 0.08,
        letterSpacing: 0.01,
        align: 'middle',
      };
    default:
      throw new Error(`unknown fixture layer type ${type}`);
  }
}

function assetBinding(compatibilityId = 'a320neo-v1') {
  return {
    compatibilityId,
    aircraftAsset: { id: 'aircraft/a320neo', version: '1.0.0' },
    liveryUv: { id: 'livery-uv/a320neo', version: '1.0.0' },
    materialBinding: { id: 'materials/airliner-v1', version: '1.0.0' },
    anchorSet: { id: 'anchors/a320neo', version: '1.0.0' },
  };
}

function document(layers: unknown[]) {
  return {
    format: LIVERY_DOCUMENT_FORMAT,
    formatVersion: LIVERY_DOCUMENT_FORMAT_VERSION,
    artwork: {
      coordinateSpace: 'tailfin-aircraft-artwork',
      coordinateSpaceVersion: 1,
      viewBox: { x: 0, y: 0, width: 1, height: 1 },
      sideMode: 'mirrored',
    },
    renderMode: 'legacy_svg',
    assetBindings: [],
    familyOverrides: [],
    palette: ['#0B1F3AFF', '#31D7CFFF', '#FFFFFFFF', '#F4B942FF'],
    layers,
  };
}

describe('livery document v2', () => {
  it('admits every M6-01 layer type and preserves array paint order', () => {
    const types = [
      'fill',
      'gradient',
      'cheatline',
      'shape',
      'path',
      'brush',
      'text',
      'logo',
      'decal',
      'registration',
    ];
    const parsed = LiveryDocument.parse(
      document(types.map((type, index) => layer(type, `${String(index)}-${type}`))),
    );

    expect(parsed.layers.map((entry) => entry.type)).toEqual(types);
    expect(LiveryZone.options).toEqual([
      'fuselage',
      'nose',
      'belly',
      'tail_fin',
      'winglets',
      'engine_nacelles',
      'wings',
      'cheatline_band',
      'door_surrounds',
      'registration_area',
    ]);
  });

  it('derives JSON Schema from the same zod document contract', () => {
    expect(liveryDocumentJsonSchema).toMatchObject({
      type: 'object',
      properties: {
        format: { const: LIVERY_DOCUMENT_FORMAT },
        formatVersion: { const: LIVERY_DOCUMENT_FORMAT_VERSION },
      },
    });
  });

  it('binds true-3D documents to exact versioned resources and scoped family overrides', () => {
    const uv3d = {
      ...document([layer('logo', 'tail-logo')]),
      renderMode: 'uv3d',
      assetBindings: [assetBinding()],
      familyOverrides: [
        {
          compatibilityId: 'a320neo-v1',
          layerOverrides: [
            {
              layerId: 'tail-logo',
              placement: { side: 'starboard', symmetry: 'none', anchorId: 'tail-logo-safe' },
            },
          ],
        },
      ],
    };

    expect(LiveryDocument.safeParse(uv3d).success).toBe(true);
    expect(LiveryDocument.safeParse({ ...uv3d, assetBindings: [] }).success).toBe(false);
    expect(
      LiveryDocument.safeParse({
        ...uv3d,
        familyOverrides: [{ ...uv3d.familyOverrides[0], compatibilityId: 'unbound-family' }],
      }).success,
    ).toBe(false);
  });

  it('models port and starboard placement without aircraft-name conditionals', () => {
    const starboard = layer('registration', 'registration') as Record<string, unknown>;
    starboard.placement = { side: 'starboard', symmetry: 'none', anchorId: 'registration-safe' };
    expect(LiveryDocument.safeParse(document([starboard])).success).toBe(true);

    starboard.placement = { side: 'starboard', symmetry: 'reflect', anchorId: null };
    expect(LiveryDocument.safeParse(document([starboard])).success).toBe(false);
  });

  it('rejects renderer payloads and canonicalizes object-key order for stable identity', () => {
    const parsed = LiveryDocument.parse(document([layer('fill', 'base')]));
    const reordered = {
      layers: parsed.layers,
      palette: parsed.palette,
      familyOverrides: parsed.familyOverrides,
      assetBindings: parsed.assetBindings,
      renderMode: parsed.renderMode,
      artwork: parsed.artwork,
      formatVersion: parsed.formatVersion,
      format: parsed.format,
    };

    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(parsed));
    expect(canonicalLiveryDocumentJson(reordered)).toBe(canonicalLiveryDocumentJson(parsed));
    expect(
      LiveryDocument.safeParse({
        ...parsed,
        rendererPayload: { glb: 'data:model/gltf;base64,...' },
      }).success,
    ).toBe(false);
  });

  it('lifts v1 documents losslessly into the explicit legacy renderer fallback', () => {
    const { placement: _placement, ...legacyBase } = common('legacy-text', '#FFFFFFFF');
    const legacy = {
      format: LIVERY_DOCUMENT_FORMAT,
      formatVersion: LIVERY_DOCUMENT_LEGACY_VERSION,
      palette: ['#FFFFFFFF'],
      layers: [
        {
          ...legacyBase,
          type: 'text',
          text: 'TAILFIN AIR',
          fontFamily: 'Inter',
          fontSize: 0.12,
          letterSpacing: 0.01,
          align: 'middle',
          arc: null,
        },
      ],
    };
    const migrated = migrateLiveryDocumentV1ToV2(legacy);

    expect(migrated.renderMode).toBe('legacy_svg');
    expect(migrated.assetBindings).toEqual([]);
    expect(migrated.layers[0]).toMatchObject({
      type: 'text',
      text: 'TAILFIN AIR',
      fontVersion: 'legacy-v1',
      placement: { side: 'both', symmetry: 'repeat', anchorId: null },
    });
    expect(legacy.formatVersion).toBe(1);
  });

  it('rejects ambiguous order, invalid masks and out-of-order gradients', () => {
    const duplicate = document([layer('fill', 'base'), layer('fill', 'base')]);
    expect(LiveryDocument.safeParse(duplicate).success).toBe(false);

    const forwardMask = layer('shape', 'masked') as Record<string, unknown>;
    forwardMask.mask = { kind: 'layer', layerId: 'future', mode: 'alpha' };
    expect(LiveryDocument.safeParse(document([forwardMask, layer('fill', 'future')])).success).toBe(
      false,
    );

    const badGradient = layer('gradient', 'gradient');
    if (badGradient.type !== 'gradient') throw new Error('bad fixture');
    badGradient.gradient.stops.reverse();
    expect(LiveryDocument.safeParse(document([badGradient])).success).toBe(false);
  });

  it('keeps a representative 30-layer complex scheme below the 20KB budget', () => {
    const types = [
      'fill',
      'gradient',
      'cheatline',
      'shape',
      'path',
      'brush',
      'text',
      'logo',
      'decal',
      'registration',
    ];
    const complex = document(
      Array.from({ length: 30 }, (_, index) => {
        const type = types[index % types.length];
        if (!type) throw new Error('missing fixture layer type');
        return layer(type, `complex-${String(index)}`);
      }),
    );

    const size = serializedLiveryDocumentSize(complex);
    expect(size).toBeLessThan(LIVERY_DOCUMENT_MAX_BYTES);
    expect(LiveryDocument.safeParse(complex).success).toBe(true);
  });

  it('rejects a syntactically valid document once its compact UTF-8 JSON reaches the cap', () => {
    const oversized = document(
      Array.from({ length: 80 }, (_, index) => ({
        ...layer('text', `text-${String(index)}`),
        text: 'W'.repeat(256),
      })),
    );

    expect(serializedLiveryDocumentSize(oversized)).toBeGreaterThanOrEqual(
      LIVERY_DOCUMENT_MAX_BYTES,
    );
    const parsed = LiveryDocument.safeParse(oversized);
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues.at(-1)?.message).toMatch(/must be under/);
  });

  it('counts non-ASCII text as UTF-8 bytes rather than JavaScript code units', () => {
    expect(serializedLiveryDocumentSize({ text: '✈' })).toBe(14);
  });
});

describe('saved livery ownership and application scope', () => {
  it('makes the owning airline part of the saved brand object', () => {
    const saved = Livery.parse({
      id: LIVERY_ID,
      airlineId: AIRLINE_ID,
      name: 'Tailfin standard',
      variant: 'standard',
      document: document([layer('fill', 'base')]),
    });

    expect(saved.airlineId).toBe(AIRLINE_ID);
    expect(Livery.safeParse({ ...saved, airlineId: undefined }).success).toBe(false);
  });

  it('separates mutable draft revisions from immutable publication snapshots', () => {
    const visualDocument = document([layer('fill', 'base')]);
    const draft = LiveryDraft.parse({
      id: LIVERY_ID,
      airlineId: AIRLINE_ID,
      name: 'Tailfin standard',
      variant: 'standard',
      revision: 3,
      updatedAt: '2026-08-24T18:30:00+02:00',
      document: visualDocument,
    });
    const published = PublishedLiveryVersion.parse({
      liveryId: draft.id,
      airlineId: draft.airlineId,
      publishedVersion: 1,
      publishedAt: '2026-08-24T18:31:00+02:00',
      contentSha256: 'a'.repeat(64),
      document: draft.document,
    });

    expect(draft.revision).toBe(3);
    expect(published.publishedVersion).toBe(1);
    expect(
      PublishedLiveryVersion.safeParse({ ...published, contentSha256: 'mutable' }).success,
    ).toBe(false);
  });

  it('represents fleet, explicit sub-fleet and single-airframe targets without a fake entity', () => {
    expect(LiveryApplicationTarget.parse({ scope: 'fleet' })).toEqual({ scope: 'fleet' });
    expect(
      LiveryApplicationTarget.parse({
        scope: 'subfleet',
        airframeIds: [AIRFRAME_A, AIRFRAME_B],
      }),
    ).toMatchObject({ scope: 'subfleet', airframeIds: [AIRFRAME_A, AIRFRAME_B] });
    expect(LiveryApplicationTarget.parse({ scope: 'airframe', airframeId: AIRFRAME_A })).toEqual({
      scope: 'airframe',
      airframeId: AIRFRAME_A,
    });

    expect(
      LiveryApplicationTarget.safeParse({
        scope: 'subfleet',
        airframeIds: [AIRFRAME_A, AIRFRAME_A],
      }).success,
    ).toBe(false);

    expect(
      LiveryApplication.parse({
        liveryId: LIVERY_ID,
        target: { scope: 'airframe', airframeId: AIRFRAME_A },
      }),
    ).toMatchObject({ liveryId: LIVERY_ID, target: { scope: 'airframe' } });
  });
});
