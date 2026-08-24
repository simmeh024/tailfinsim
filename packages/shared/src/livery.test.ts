import { describe, expect, it } from 'vitest';

import {
  LIVERY_DOCUMENT_FORMAT,
  LIVERY_DOCUMENT_FORMAT_VERSION,
  LIVERY_DOCUMENT_MAX_BYTES,
  Livery,
  LiveryApplication,
  LiveryApplicationTarget,
  LiveryDocument,
  LiveryZone,
  liveryDocumentJsonSchema,
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
    case 'text':
      return {
        ...common(id, '#FFFFFFFF'),
        type,
        text: 'TAILFIN AIR',
        fontFamily: 'Inter',
        fontSize: 0.12,
        letterSpacing: 0.01,
        align: 'middle',
        arc: { radius: 1.8, startAngleDeg: -8 },
      };
    case 'logo':
      return { ...common(id, '#31D7CFFF'), type, logoId: 'tailfin-chevron', mirrored: false };
    case 'decal':
      return { ...common(id, null), type, decalId: 'founder-mark', mirrored: false };
    default:
      throw new Error(`unknown fixture layer type ${type}`);
  }
}

function document(layers: unknown[]) {
  return {
    format: LIVERY_DOCUMENT_FORMAT,
    formatVersion: LIVERY_DOCUMENT_FORMAT_VERSION,
    palette: ['#0B1F3AFF', '#31D7CFFF', '#FFFFFFFF', '#F4B942FF'],
    layers,
  };
}

describe('livery document v1', () => {
  it('admits every M6-01 layer type and preserves array paint order', () => {
    const types = ['fill', 'gradient', 'cheatline', 'shape', 'path', 'text', 'logo', 'decal'];
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
    const types = ['fill', 'gradient', 'cheatline', 'shape', 'path', 'text', 'logo', 'decal'];
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
