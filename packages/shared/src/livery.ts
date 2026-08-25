import { z } from 'zod';

import { Timestamp, Uuid } from './primitives';

/** The media type discriminator stored with every livery document. */
export const LIVERY_DOCUMENT_FORMAT = 'tailfin-livery' as const;

/**
 * The newest document version this build can author and render.
 *
 * This is numeric because the migration registry in `@tailfin/sim` advances one
 * version at a time. It is deliberately separate from `SHARED_SCHEMA_VERSION`:
 * liveries survive deployments and need their own long-lived format history.
 */
export const LIVERY_DOCUMENT_LEGACY_VERSION = 1 as const;
export const LIVERY_DOCUMENT_FORMAT_VERSION = 2 as const;

/** M6-01's persisted payload budget. One kilobyte is 1,024 bytes here. */
export const LIVERY_DOCUMENT_MAX_BYTES = 20 * 1_024;

/** Aircraft-template zones shared by side-profile and top-down projections (§5.1). */
export const LiveryZone = z.enum([
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
export type LiveryZone = z.infer<typeof LiveryZone>;

/** §5.4's saved-brand variants. `alliance` is present because the design doc includes it. */
export const LiveryVariant = z.enum(['standard', 'retro', 'special', 'cargo', 'alliance']);
export type LiveryVariant = z.infer<typeof LiveryVariant>;

/** Blend modes supported by SVG/CSS and therefore by both builder and renderer. */
export const LiveryBlendMode = z.enum([
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color',
  'luminosity',
]);
export type LiveryBlendMode = z.infer<typeof LiveryBlendMode>;

/** Canonical stored colour. The builder may accept RGB input, but persists one spelling. */
export const LiveryColor = z
  .string()
  .regex(/^#[0-9A-F]{6}(?:[0-9A-F]{2})?$/, 'must be #RRGGBB or #RRGGBBAA uppercase hex');
export type LiveryColor = z.infer<typeof LiveryColor>;

const FiniteNumber = z.number().finite();
const UnitInterval = FiniteNumber.min(0).max(1);
const PositiveUnit = FiniteNumber.positive().max(1);

/** Coordinates are normalised within a zone, not pixels in either projection. */
export const LiveryPoint = z.object({ x: FiniteNumber, y: FiniteNumber }).strict();
export type LiveryPoint = z.infer<typeof LiveryPoint>;

/** One compact, stable local id. Masks use these ids rather than array indexes. */
export const LiveryLayerId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'must be a compact alphanumeric layer id');
export type LiveryLayerId = z.infer<typeof LiveryLayerId>;

export const LiveryTransform = z
  .object({
    translate: LiveryPoint,
    scale: z.object({ x: FiniteNumber.positive(), y: FiniteNumber.positive() }).strict(),
    rotationDeg: FiniteNumber,
    skewDeg: LiveryPoint,
  })
  .strict();
export type LiveryTransform = z.infer<typeof LiveryTransform>;

export const LiveryShadow = z
  .object({
    color: LiveryColor,
    offset: LiveryPoint,
    blur: FiniteNumber.nonnegative(),
  })
  .strict();
export type LiveryShadow = z.infer<typeof LiveryShadow>;

/**
 * Style is common to every layer so layer-list controls and renderers do not
 * need a second type switch. A gradient or source asset normally leaves `fill`
 * null; text outlines and shape strokes use the same stroke fields.
 */
export const LiveryStyle = z
  .object({
    fill: LiveryColor.nullable(),
    stroke: LiveryColor.nullable(),
    strokeWidth: FiniteNumber.nonnegative(),
    lineCap: z.enum(['butt', 'round', 'square']),
    lineJoin: z.enum(['miter', 'round', 'bevel']),
    shadow: LiveryShadow.nullable(),
  })
  .strict();
export type LiveryStyle = z.infer<typeof LiveryStyle>;

/** Zone clipping is implicit; this optional mask adds a second zone or an earlier layer. */
export const LiveryMask = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('zone'), zone: LiveryZone }).strict(),
  z
    .object({
      kind: z.literal('layer'),
      layerId: LiveryLayerId,
      mode: z.enum(['alpha', 'inverse_alpha']),
    })
    .strict(),
]);
export type LiveryMask = z.infer<typeof LiveryMask>;

const LayerBaseV1 = {
  id: LiveryLayerId,
  name: z.string().trim().min(1).max(80),
  zone: LiveryZone,
  visible: z.boolean(),
  locked: z.boolean(),
  transform: LiveryTransform,
  style: LiveryStyle,
  opacity: UnitInterval,
  blendMode: LiveryBlendMode,
  mask: LiveryMask.nullable(),
} as const;

export const LiveryGradientStop = z.object({ offset: UnitInterval, color: LiveryColor }).strict();
export type LiveryGradientStop = z.infer<typeof LiveryGradientStop>;

const LiveryGradientStops = z
  .array(LiveryGradientStop)
  .min(2)
  .max(16)
  .superRefine((stops, context) => {
    for (let index = 1; index < stops.length; index += 1) {
      const previous = stops[index - 1];
      const current = stops[index];
      if (previous && current && current.offset <= previous.offset) {
        context.addIssue({
          code: 'custom',
          path: [index, 'offset'],
          message: 'gradient stops must be in strictly increasing offset order',
        });
      }
    }
  });

export const LiveryGradient = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('linear'),
      from: LiveryPoint,
      to: LiveryPoint,
      stops: LiveryGradientStops,
    })
    .strict(),
  z
    .object({
      kind: z.literal('radial'),
      center: LiveryPoint,
      focal: LiveryPoint,
      radius: FiniteNumber.positive(),
      stops: LiveryGradientStops,
    })
    .strict(),
]);
export type LiveryGradient = z.infer<typeof LiveryGradient>;

export const LiveryCheatlineStripe = z.object({ color: LiveryColor, share: PositiveUnit }).strict();
export type LiveryCheatlineStripe = z.infer<typeof LiveryCheatlineStripe>;

const LiveryCheatlineStripes = z
  .array(LiveryCheatlineStripe)
  .min(1)
  .max(8)
  .superRefine((stripes, context) => {
    const total = stripes.reduce((sum, stripe) => sum + stripe.share, 0);
    if (Math.abs(total - 1) > 1e-9) {
      context.addIssue({
        code: 'custom',
        message: 'cheatline stripe shares must sum to 1',
      });
    }
  });

export const LiveryShape = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('rectangle'),
      origin: LiveryPoint,
      width: FiniteNumber.positive(),
      height: FiniteNumber.positive(),
      cornerRadius: FiniteNumber.nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('ellipse'),
      center: LiveryPoint,
      radiusX: FiniteNumber.positive(),
      radiusY: FiniteNumber.positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('polygon'),
      points: z.array(LiveryPoint).min(3).max(64),
    })
    .strict(),
]);
export type LiveryShape = z.infer<typeof LiveryShape>;

export const LiveryPathCommand = z.discriminatedUnion('command', [
  z.object({ command: z.literal('move'), to: LiveryPoint }).strict(),
  z.object({ command: z.literal('line'), to: LiveryPoint }).strict(),
  z.object({ command: z.literal('quadratic'), control: LiveryPoint, to: LiveryPoint }).strict(),
  z
    .object({
      command: z.literal('cubic'),
      control1: LiveryPoint,
      control2: LiveryPoint,
      to: LiveryPoint,
    })
    .strict(),
  z.object({ command: z.literal('close') }).strict(),
]);
export type LiveryPathCommand = z.infer<typeof LiveryPathCommand>;

export const LiveryLayerV1 = z.discriminatedUnion('type', [
  z.object({ ...LayerBaseV1, type: z.literal('fill') }).strict(),
  z.object({ ...LayerBaseV1, type: z.literal('gradient'), gradient: LiveryGradient }).strict(),
  z
    .object({
      ...LayerBaseV1,
      type: z.literal('cheatline'),
      anchor: LiveryPoint,
      width: PositiveUnit,
      angleDeg: FiniteNumber,
      sweep: FiniteNumber.min(-1).max(1),
      taper: UnitInterval,
      stripes: LiveryCheatlineStripes,
    })
    .strict(),
  z
    .object({
      ...LayerBaseV1,
      type: z.literal('shape'),
      operation: z.enum(['add', 'subtract', 'intersect', 'exclude']),
      shape: LiveryShape,
    })
    .strict(),
  z
    .object({
      ...LayerBaseV1,
      type: z.literal('path'),
      commands: z.array(LiveryPathCommand).min(2).max(256),
    })
    .strict(),
  z
    .object({
      ...LayerBaseV1,
      type: z.literal('text'),
      text: z.string().min(1).max(256),
      fontFamily: z.string().trim().min(1).max(80),
      fontSize: FiniteNumber.positive(),
      letterSpacing: FiniteNumber,
      align: z.enum(['start', 'middle', 'end']),
      arc: z
        .object({ radius: FiniteNumber.positive(), startAngleDeg: FiniteNumber })
        .strict()
        .nullable(),
    })
    .strict(),
  z
    .object({
      ...LayerBaseV1,
      type: z.literal('logo'),
      logoId: z.string().min(1).max(128),
      mirrored: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...LayerBaseV1,
      type: z.literal('decal'),
      decalId: z.string().min(1).max(128),
      mirrored: z.boolean(),
    })
    .strict(),
]);
export type LiveryLayerV1 = z.infer<typeof LiveryLayerV1>;

/** Stable ids and versions name authored resources without embedding their payloads. */
export const LiveryResourceId = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/, 'must be an opaque resource id');
export type LiveryResourceId = z.infer<typeof LiveryResourceId>;

export const LiveryResourceVersion = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'must be a stable resource version');
export type LiveryResourceVersion = z.infer<typeof LiveryResourceVersion>;

export const LiveryVersionedResource = z
  .object({
    id: LiveryResourceId,
    version: LiveryResourceVersion,
  })
  .strict();
export type LiveryVersionedResource = z.infer<typeof LiveryVersionedResource>;

/**
 * Canonical artwork coordinates are independent of every GLB and UV layout.
 * A versioned UV binding maps this logical 0..1 space onto an aircraft asset.
 */
export const LiveryArtworkSpace = z
  .object({
    coordinateSpace: z.literal('tailfin-aircraft-artwork'),
    coordinateSpaceVersion: z.literal(1),
    viewBox: z
      .object({
        x: z.literal(0),
        y: z.literal(0),
        width: z.literal(1),
        height: z.literal(1),
      })
      .strict(),
    sideMode: z.enum(['mirrored', 'independent']),
  })
  .strict();
export type LiveryArtworkSpace = z.infer<typeof LiveryArtworkSpace>;

/** Exact compatibility tuple. Updating any resource creates a new binding identity. */
export const LiveryAssetBinding = z
  .object({
    compatibilityId: LiveryResourceId,
    aircraftAsset: LiveryVersionedResource,
    liveryUv: LiveryVersionedResource,
    materialBinding: LiveryVersionedResource,
    anchorSet: LiveryVersionedResource,
  })
  .strict();
export type LiveryAssetBinding = z.infer<typeof LiveryAssetBinding>;

export const LiveryPlacement = z
  .object({
    side: z.enum(['both', 'port', 'starboard']),
    symmetry: z.enum(['none', 'repeat', 'reflect']),
    anchorId: LiveryResourceId.nullable(),
  })
  .strict()
  .superRefine((placement, context) => {
    if (placement.side === 'both' && placement.symmetry === 'none') {
      context.addIssue({
        code: 'custom',
        path: ['symmetry'],
        message: 'a both-side placement must repeat or reflect its artwork',
      });
    }
    if (placement.side !== 'both' && placement.symmetry !== 'none') {
      context.addIssue({
        code: 'custom',
        path: ['symmetry'],
        message: 'a single-side placement cannot repeat or reflect its artwork',
      });
    }
  });
export type LiveryPlacement = z.infer<typeof LiveryPlacement>;

const LayerBaseV2 = {
  ...LayerBaseV1,
  placement: LiveryPlacement,
} as const;

export const LiveryBrushPoint = z
  .object({
    x: FiniteNumber,
    y: FiniteNumber,
    pressure: UnitInterval,
  })
  .strict();
export type LiveryBrushPoint = z.infer<typeof LiveryBrushPoint>;

export const LiveryBrushStroke = z
  .object({
    points: z.array(LiveryBrushPoint).min(2).max(512),
    width: FiniteNumber.positive(),
    hardness: UnitInterval,
    spacing: FiniteNumber.positive(),
  })
  .strict();
export type LiveryBrushStroke = z.infer<typeof LiveryBrushStroke>;

/**
 * Version 2 keeps authored instructions compact and semantic. It never embeds
 * model, texture or renderer-private data; VIS resolves the referenced assets.
 */
export const LiveryLayer = z.discriminatedUnion('type', [
  z.object({ ...LayerBaseV2, type: z.literal('fill') }).strict(),
  z.object({ ...LayerBaseV2, type: z.literal('gradient'), gradient: LiveryGradient }).strict(),
  z
    .object({
      ...LayerBaseV2,
      type: z.literal('cheatline'),
      anchor: LiveryPoint,
      width: PositiveUnit,
      angleDeg: FiniteNumber,
      sweep: FiniteNumber.min(-1).max(1),
      taper: UnitInterval,
      stripes: LiveryCheatlineStripes,
    })
    .strict(),
  z
    .object({
      ...LayerBaseV2,
      type: z.literal('shape'),
      operation: z.enum(['add', 'subtract', 'intersect', 'exclude']),
      shape: LiveryShape,
    })
    .strict(),
  z
    .object({
      ...LayerBaseV2,
      type: z.literal('path'),
      commands: z.array(LiveryPathCommand).min(2).max(256),
    })
    .strict(),
  z
    .object({
      ...LayerBaseV2,
      type: z.literal('brush'),
      strokes: z.array(LiveryBrushStroke).min(1).max(64),
    })
    .strict(),
  z
    .object({
      ...LayerBaseV2,
      type: z.literal('text'),
      text: z.string().min(1).max(256),
      fontFamily: z.string().trim().min(1).max(80),
      fontVersion: LiveryResourceVersion,
      fontSize: FiniteNumber.positive(),
      letterSpacing: FiniteNumber,
      align: z.enum(['start', 'middle', 'end']),
      arc: z
        .object({ radius: FiniteNumber.positive(), startAngleDeg: FiniteNumber })
        .strict()
        .nullable(),
    })
    .strict(),
  z
    .object({
      ...LayerBaseV2,
      type: z.literal('logo'),
      logoId: LiveryResourceId,
      logoVersion: LiveryResourceVersion,
      mirrored: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...LayerBaseV2,
      type: z.literal('decal'),
      decalId: LiveryResourceId,
      decalVersion: LiveryResourceVersion,
      mirrored: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...LayerBaseV2,
      type: z.literal('registration'),
      source: z.literal('airframe.registration'),
      fontFamily: z.string().trim().min(1).max(80),
      fontVersion: LiveryResourceVersion,
      fontSize: FiniteNumber.positive(),
      letterSpacing: FiniteNumber,
      align: z.enum(['start', 'middle', 'end']),
    })
    .strict(),
]);
export type LiveryLayer = z.infer<typeof LiveryLayer>;

export const LiveryFamilyLayerOverride = z
  .object({
    layerId: LiveryLayerId,
    visible: z.boolean().optional(),
    transform: LiveryTransform.optional(),
    placement: LiveryPlacement.optional(),
  })
  .strict()
  .superRefine((override, context) => {
    if (
      override.visible === undefined &&
      override.transform === undefined &&
      override.placement === undefined
    ) {
      context.addIssue({
        code: 'custom',
        message: 'a layer override must change at least one field',
      });
    }
  });
export type LiveryFamilyLayerOverride = z.infer<typeof LiveryFamilyLayerOverride>;

export const LiveryFamilyOverride = z
  .object({
    compatibilityId: LiveryResourceId,
    layerOverrides: z.array(LiveryFamilyLayerOverride).min(1).max(100),
  })
  .strict();
export type LiveryFamilyOverride = z.infer<typeof LiveryFamilyOverride>;

function canonicalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJsonValue);
  if (value === null || typeof value !== 'object') return value;

  const canonical: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const child = canonicalizeJsonValue((value as Record<string, unknown>)[key]);
    if (child !== undefined) canonical[key] = child;
  }
  return canonical;
}

/** Stable JSON bytes used as the document's content-identity input. */
export function canonicalLiveryDocumentJson(document: unknown): string {
  const json = JSON.stringify(canonicalizeJsonValue(document));
  if (json === undefined) throw new TypeError('livery document is not JSON-serializable');
  return json;
}

/** Exact UTF-8 size of the canonical compact JSON persisted and content-hashed. */
export function serializedLiveryDocumentSize(document: unknown): number {
  const json = canonicalLiveryDocumentJson(document);

  let bytes = 0;
  for (const symbol of json) {
    const codePoint = symbol.codePointAt(0);
    if (codePoint === undefined) continue;
    if (codePoint <= 0x7f) bytes += 1;
    else if (codePoint <= 0x7ff) bytes += 2;
    else if (codePoint <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

/**
 * Legacy visual document consumed unchanged by the retained SVG compatibility renderer.
 * Array order is paint order: first is furthest back, last is furthest forward.
 */
export const LiveryDocumentV1 = z
  .object({
    format: z.literal(LIVERY_DOCUMENT_FORMAT),
    formatVersion: z.literal(LIVERY_DOCUMENT_LEGACY_VERSION),
    palette: z.array(LiveryColor).max(16),
    layers: z.array(LiveryLayerV1).max(100),
  })
  .strict()
  .superRefine((document, context) => {
    const layerIndexes = new Map<string, number>();
    for (const [index, layer] of document.layers.entries()) {
      if (layerIndexes.has(layer.id)) {
        context.addIssue({
          code: 'custom',
          path: ['layers', index, 'id'],
          message: `duplicate layer id "${layer.id}"`,
        });
      } else {
        layerIndexes.set(layer.id, index);
      }

      if (layer.mask?.kind === 'layer') {
        const maskIndex = layerIndexes.get(layer.mask.layerId);
        if (maskIndex === undefined || maskIndex >= index) {
          context.addIssue({
            code: 'custom',
            path: ['layers', index, 'mask', 'layerId'],
            message: 'a layer mask must reference an earlier layer id',
          });
        }
      }
    }

    const size = serializedLiveryDocumentSize(document);
    if (size >= LIVERY_DOCUMENT_MAX_BYTES) {
      context.addIssue({
        code: 'custom',
        message: `livery document must be under ${String(LIVERY_DOCUMENT_MAX_BYTES)} bytes; received ${String(size)}`,
      });
    }
  });
export type LiveryDocumentV1 = z.infer<typeof LiveryDocumentV1>;

/**
 * Current authoring contract. Paint order is back-to-front; family overrides
 * only adjust placement/visibility and never replace canonical artwork.
 */
export const LiveryDocument = z
  .object({
    format: z.literal(LIVERY_DOCUMENT_FORMAT),
    formatVersion: z.literal(LIVERY_DOCUMENT_FORMAT_VERSION),
    artwork: LiveryArtworkSpace,
    renderMode: z.enum(['legacy_svg', 'uv3d']),
    assetBindings: z.array(LiveryAssetBinding).max(64),
    familyOverrides: z.array(LiveryFamilyOverride).max(64),
    palette: z.array(LiveryColor).max(16),
    layers: z.array(LiveryLayer).max(100),
  })
  .strict()
  .superRefine((document, context) => {
    const layerIndexes = new Map<string, number>();
    for (const [index, layer] of document.layers.entries()) {
      if (layerIndexes.has(layer.id)) {
        context.addIssue({
          code: 'custom',
          path: ['layers', index, 'id'],
          message: `duplicate layer id "${layer.id}"`,
        });
      } else {
        layerIndexes.set(layer.id, index);
      }

      if (layer.mask?.kind === 'layer') {
        const maskIndex = layerIndexes.get(layer.mask.layerId);
        if (maskIndex === undefined || maskIndex >= index) {
          context.addIssue({
            code: 'custom',
            path: ['layers', index, 'mask', 'layerId'],
            message: 'a layer mask must reference an earlier layer id',
          });
        }
      }
    }

    const bindingIds = new Set<string>();
    for (const [index, binding] of document.assetBindings.entries()) {
      if (bindingIds.has(binding.compatibilityId)) {
        context.addIssue({
          code: 'custom',
          path: ['assetBindings', index, 'compatibilityId'],
          message: `duplicate compatibility id "${binding.compatibilityId}"`,
        });
      }
      bindingIds.add(binding.compatibilityId);
    }

    if (document.renderMode === 'legacy_svg' && document.assetBindings.length > 0) {
      context.addIssue({
        code: 'custom',
        path: ['assetBindings'],
        message: 'legacy_svg documents cannot declare 3D asset bindings',
      });
    }
    if (document.renderMode === 'uv3d' && document.assetBindings.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['assetBindings'],
        message: 'uv3d documents require at least one exact asset binding',
      });
    }

    const overrideIds = new Set<string>();
    for (const [overrideIndex, familyOverride] of document.familyOverrides.entries()) {
      if (overrideIds.has(familyOverride.compatibilityId)) {
        context.addIssue({
          code: 'custom',
          path: ['familyOverrides', overrideIndex, 'compatibilityId'],
          message: `duplicate family override "${familyOverride.compatibilityId}"`,
        });
      }
      overrideIds.add(familyOverride.compatibilityId);

      if (!bindingIds.has(familyOverride.compatibilityId)) {
        context.addIssue({
          code: 'custom',
          path: ['familyOverrides', overrideIndex, 'compatibilityId'],
          message: 'family override must target an exact asset binding',
        });
      }

      const overriddenLayers = new Set<string>();
      for (const [layerOverrideIndex, layerOverride] of familyOverride.layerOverrides.entries()) {
        if (!layerIndexes.has(layerOverride.layerId)) {
          context.addIssue({
            code: 'custom',
            path: [
              'familyOverrides',
              overrideIndex,
              'layerOverrides',
              layerOverrideIndex,
              'layerId',
            ],
            message: 'family override must reference a document layer',
          });
        }
        if (overriddenLayers.has(layerOverride.layerId)) {
          context.addIssue({
            code: 'custom',
            path: [
              'familyOverrides',
              overrideIndex,
              'layerOverrides',
              layerOverrideIndex,
              'layerId',
            ],
            message: 'a family override cannot target the same layer twice',
          });
        }
        overriddenLayers.add(layerOverride.layerId);
      }
    }

    if (document.renderMode === 'legacy_svg' && document.familyOverrides.length > 0) {
      context.addIssue({
        code: 'custom',
        path: ['familyOverrides'],
        message: 'legacy_svg documents cannot declare 3D family overrides',
      });
    }

    const size = serializedLiveryDocumentSize(document);
    if (size >= LIVERY_DOCUMENT_MAX_BYTES) {
      context.addIssue({
        code: 'custom',
        message: `livery document must be under ${String(LIVERY_DOCUMENT_MAX_BYTES)} bytes; received ${String(size)}`,
      });
    }
  });
export type LiveryDocument = z.infer<typeof LiveryDocument>;

/** Lossless compatibility lift; rendering remains on the explicit SVG fallback. */
export function migrateLiveryDocumentV1ToV2(input: unknown): LiveryDocument {
  const legacy = LiveryDocumentV1.parse(input);
  const layers = legacy.layers.map((layer) => {
    const placement = { side: 'both', symmetry: 'repeat', anchorId: null } as const;
    switch (layer.type) {
      case 'text':
        return { ...layer, placement, fontVersion: 'legacy-v1' };
      case 'logo':
        return { ...layer, placement, logoVersion: 'legacy-v1' };
      case 'decal':
        return { ...layer, placement, decalVersion: 'legacy-v1' };
      default:
        return { ...layer, placement };
    }
  });

  return LiveryDocument.parse({
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
    palette: legacy.palette,
    layers,
  });
}

/** The airline-owned saved brand object; visual data stays isolated in `document`. */
export const Livery = z
  .object({
    id: Uuid,
    airlineId: Uuid,
    name: z.string().trim().min(1).max(80),
    variant: LiveryVariant,
    document: LiveryDocument,
  })
  .strict();
export type Livery = z.infer<typeof Livery>;

/** Mutable working copy. Persistence uses revision for optimistic concurrency. */
export const LiveryDraft = z
  .object({
    id: Uuid,
    airlineId: Uuid,
    name: z.string().trim().min(1).max(80),
    variant: LiveryVariant,
    revision: z.number().int().nonnegative(),
    updatedAt: Timestamp,
    document: LiveryDocument,
  })
  .strict();
export type LiveryDraft = z.infer<typeof LiveryDraft>;

export const LiveryContentSha256 = z
  .string()
  .regex(/^[a-f0-9]{64}$/, 'must be a lowercase SHA-256 content identity');
export type LiveryContentSha256 = z.infer<typeof LiveryContentSha256>;

/**
 * Immutable publication snapshot. Services may append a new version but must
 * never mutate a row carrying a publishedVersion/contentSha256 pair.
 */
export const PublishedLiveryVersion = z
  .object({
    liveryId: Uuid,
    airlineId: Uuid,
    publishedVersion: z.number().int().positive(),
    publishedAt: Timestamp,
    contentSha256: LiveryContentSha256,
    document: LiveryDocument,
  })
  .strict();
export type PublishedLiveryVersion = z.infer<typeof PublishedLiveryVersion>;

/**
 * The three §5.4 application scopes, without M6-07's repaint cost or downtime.
 * A sub-fleet is an explicit airframe set so this contract does not invent a
 * persistent `subfleet` entity before that milestone chooses its mechanics.
 */
export const LiveryApplicationTarget = z
  .discriminatedUnion('scope', [
    z.object({ scope: z.literal('fleet') }).strict(),
    z.object({ scope: z.literal('subfleet'), airframeIds: z.array(Uuid).min(1) }).strict(),
    z.object({ scope: z.literal('airframe'), airframeId: Uuid }).strict(),
  ])
  .superRefine((target, context) => {
    if (target.scope !== 'subfleet') return;
    const unique = new Set(target.airframeIds);
    if (unique.size !== target.airframeIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['airframeIds'],
        message: 'a sub-fleet cannot contain the same airframe twice',
      });
    }
  });
export type LiveryApplicationTarget = z.infer<typeof LiveryApplicationTarget>;

/** A format-only application command; M6-07 adds ownership checks, cost and downtime. */
export const LiveryApplication = z
  .object({
    liveryId: Uuid,
    target: LiveryApplicationTarget,
  })
  .strict();
export type LiveryApplication = z.infer<typeof LiveryApplication>;
