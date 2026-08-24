import { z } from 'zod';

import { Uuid } from './primitives';

/** The media type discriminator stored with every livery document. */
export const LIVERY_DOCUMENT_FORMAT = 'tailfin-livery' as const;

/**
 * The newest document version this build can author and render.
 *
 * This is numeric because the migration registry in `@tailfin/sim` advances one
 * version at a time. It is deliberately separate from `SHARED_SCHEMA_VERSION`:
 * liveries survive deployments and need their own long-lived format history.
 */
export const LIVERY_DOCUMENT_FORMAT_VERSION = 1 as const;

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

const LayerBase = {
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

export const LiveryLayer = z.discriminatedUnion('type', [
  z.object({ ...LayerBase, type: z.literal('fill') }).strict(),
  z.object({ ...LayerBase, type: z.literal('gradient'), gradient: LiveryGradient }).strict(),
  z
    .object({
      ...LayerBase,
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
      ...LayerBase,
      type: z.literal('shape'),
      operation: z.enum(['add', 'subtract', 'intersect', 'exclude']),
      shape: LiveryShape,
    })
    .strict(),
  z
    .object({
      ...LayerBase,
      type: z.literal('path'),
      commands: z.array(LiveryPathCommand).min(2).max(256),
    })
    .strict(),
  z
    .object({
      ...LayerBase,
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
      ...LayerBase,
      type: z.literal('logo'),
      logoId: z.string().min(1).max(128),
      mirrored: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...LayerBase,
      type: z.literal('decal'),
      decalId: z.string().min(1).max(128),
      mirrored: z.boolean(),
    })
    .strict(),
]);
export type LiveryLayer = z.infer<typeof LiveryLayer>;

/** Exact UTF-8 size of the compact JSON representation persisted and content-hashed. */
export function serializedLiveryDocumentSize(document: unknown): number {
  const json = JSON.stringify(document);
  if (json === undefined) throw new TypeError('livery document is not JSON-serializable');

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
 * The visual document consumed unchanged by the SVG builder and raster renderer.
 * Array order is paint order: first is furthest back, last is furthest forward.
 */
export const LiveryDocumentV1 = z
  .object({
    format: z.literal(LIVERY_DOCUMENT_FORMAT),
    formatVersion: z.literal(LIVERY_DOCUMENT_FORMAT_VERSION),
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

    const size = serializedLiveryDocumentSize(document);
    if (size >= LIVERY_DOCUMENT_MAX_BYTES) {
      context.addIssue({
        code: 'custom',
        message: `livery document must be under ${String(LIVERY_DOCUMENT_MAX_BYTES)} bytes; received ${String(size)}`,
      });
    }
  });
export type LiveryDocumentV1 = z.infer<typeof LiveryDocumentV1>;

/** Current authoring contract. Add a union only when a second readable version exists. */
export const LiveryDocument = LiveryDocumentV1;
export type LiveryDocument = z.infer<typeof LiveryDocument>;

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
