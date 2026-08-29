import { z } from 'zod';

/**
 * The airline brand logo (§15/§16, the manage-airline page).
 *
 * A **procedural emblem**, not an uploaded image: a compact spec the client
 * renders as inline SVG and the server stores as one small jsonb value. Keeping
 * the logo declarative means there is no blob store, no file-type or size
 * gatekeeping and no arbitrary-image moderation surface — the whole logo is a
 * frame, a stack of layers and a small brand palette, so it is a few hundred
 * bytes and always renders crisply at any size.
 *
 * Changing it is a **paid identity event**, folded into AIR-08's rebrand: a logo
 * change costs the rebrand fee and is recorded in `airline_identity_change`
 * alongside a name or callsign change, exactly like one.
 *
 * ## Two shapes, one contract
 *
 * The original logo (#789) was a single frame + a single centred `mark` +
 * three colours (see {@link LegacyAirlineLogo}). The studio editor generalises
 * that into a **composed** logo ({@link ComposedAirlineLogo}): the same four
 * frames, a four-slot brand palette, and an ordered stack of up to 24 layers,
 * each a primitive / initials / built-in symbol with its own transform, palette
 * fill and stroke, opacity and visibility.
 *
 * `AirlineLogo` is the union of the two. The jsonb column is **not** re-validated
 * on read, so logos written under the old schema keep flowing through untouched;
 * the client renderer detects a composed logo by its `v` tag and renders the
 * legacy one otherwise, and {@link legacyToComposed} lifts an old logo into the
 * studio when a player opens it. New logos are always written composed.
 */

/** The frame the emblem sits in. */
export const AIRLINE_LOGO_SHAPES = ['roundel', 'shield', 'square', 'hexagon'] as const;
export const AirlineLogoShape = z.enum(AIRLINE_LOGO_SHAPES);
export type AirlineLogoShape = z.infer<typeof AirlineLogoShape>;

/** The built-in symbols a mark or layer may use instead of initials. Rendered client-side. */
export const AIRLINE_LOGO_SYMBOLS = ['wings', 'star', 'globe', 'mountain', 'bird'] as const;
export const AirlineLogoSymbol = z.enum(AIRLINE_LOGO_SYMBOLS);
export type AirlineLogoSymbol = z.infer<typeof AirlineLogoSymbol>;

/** #RRGGBB hex, either case — an `<input type="color">` yields lowercase. */
export const AirlineLogoColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'must be a #RRGGBB hex colour');
export type AirlineLogoColor = z.infer<typeof AirlineLogoColor>;

const Unit = z.number().finite().min(0).max(1);
const Rotation = z.number().finite().min(-180).max(180);
/** A short monogram — an airline's initials or code. Shared by the legacy mark and a text layer. */
const Monogram = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9]{1,3}$/, 'must be 1–3 letters or digits');

/* ======================================================================== *
 * Legacy logo (#789): frame + single mark + three colours.                 *
 * Kept whole so logos written before the studio still parse and render.    *
 * ======================================================================== */

export const CUSTOM_GRID_SIZE = 16;
const CUSTOM_GRID_CELLS = CUSTOM_GRID_SIZE * CUSTOM_GRID_SIZE;

export const AirlineLogoGridDesign = z
  .object({
    design: z.literal('grid'),
    /** Row-major 16×16 bitmap: 256 characters of '0' (off) or '1' (on). */
    cells: z
      .string()
      .regex(new RegExp(`^[01]{${String(CUSTOM_GRID_CELLS)}}$`), 'must be a 16×16 bitmap'),
  })
  .strict();
export type AirlineLogoGridDesign = z.infer<typeof AirlineLogoGridDesign>;

export const AirlineLogoShapePrimitive = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('circle'),
      cx: Unit,
      cy: Unit,
      r: z.number().finite().min(0.02).max(0.5),
    })
    .strict(),
  z
    .object({
      type: z.literal('rect'),
      cx: Unit,
      cy: Unit,
      w: z.number().finite().min(0.02).max(1),
      h: z.number().finite().min(0.02).max(1),
      rot: Rotation,
    })
    .strict(),
  z
    .object({
      type: z.literal('triangle'),
      cx: Unit,
      cy: Unit,
      size: z.number().finite().min(0.04).max(1),
      rot: Rotation,
    })
    .strict(),
  z
    .object({
      type: z.literal('line'),
      x1: Unit,
      y1: Unit,
      x2: Unit,
      y2: Unit,
      width: z.number().finite().min(0.01).max(0.3),
    })
    .strict(),
]);
export type AirlineLogoShapePrimitive = z.infer<typeof AirlineLogoShapePrimitive>;

export const AirlineLogoShapesDesign = z
  .object({
    design: z.literal('shapes'),
    shapes: z.array(AirlineLogoShapePrimitive).min(1).max(24),
  })
  .strict();
export type AirlineLogoShapesDesign = z.infer<typeof AirlineLogoShapesDesign>;

export const AirlineLogoPathDesign = z
  .object({
    design: z.literal('path'),
    points: z
      .array(z.object({ x: Unit, y: Unit }).strict())
      .min(2)
      .max(64),
    closed: z.boolean(),
  })
  .strict();
export type AirlineLogoPathDesign = z.infer<typeof AirlineLogoPathDesign>;

export const AirlineLogoCustomDesign = z.discriminatedUnion('design', [
  AirlineLogoGridDesign,
  AirlineLogoShapesDesign,
  AirlineLogoPathDesign,
]);
export type AirlineLogoCustomDesign = z.infer<typeof AirlineLogoCustomDesign>;

/** The legacy centre mark: a short monogram, a built-in symbol, or a custom design. */
export const AirlineLogoMark = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('monogram'), text: Monogram }).strict(),
  z.object({ kind: z.literal('symbol'), symbol: AirlineLogoSymbol }).strict(),
  z.object({ kind: z.literal('custom'), custom: AirlineLogoCustomDesign }).strict(),
]);
export type AirlineLogoMark = z.infer<typeof AirlineLogoMark>;

/** The original emblem: a framed shape, a mark, and three colours. */
export const LegacyAirlineLogo = z
  .object({
    shape: AirlineLogoShape,
    mark: AirlineLogoMark,
    background: AirlineLogoColor,
    foreground: AirlineLogoColor,
    accent: AirlineLogoColor,
  })
  .strict();
export type LegacyAirlineLogo = z.infer<typeof LegacyAirlineLogo>;

/* ======================================================================== *
 * Composed logo (studio editor): frame + palette + a stack of layers.      *
 * ======================================================================== */

/** The four named brand colours. Every layer paints from one of these slots. */
export const AIRLINE_LOGO_PALETTE_SLOTS = ['background', 'mark', 'ring', 'accent'] as const;
export const AirlineLogoPaletteSlot = z.enum(AIRLINE_LOGO_PALETTE_SLOTS);
export type AirlineLogoPaletteSlot = z.infer<typeof AirlineLogoPaletteSlot>;

export const AirlineLogoPalette = z
  .object({
    background: AirlineLogoColor,
    mark: AirlineLogoColor,
    ring: AirlineLogoColor,
    accent: AirlineLogoColor,
  })
  .strict();
export type AirlineLogoPalette = z.infer<typeof AirlineLogoPalette>;

/**
 * A fill or stroke reference. Three forms, distinguished by shape:
 *  - a palette slot name (tracks the brand palette),
 *  - a literal `#RRGGBB` (this layer's own colour, independent of the palette),
 *  - `none` (transparent — no paint at all).
 */
export const AirlineLogoPaint = z.union([
  AirlineLogoPaletteSlot,
  z.literal('none'),
  AirlineLogoColor,
]);
export type AirlineLogoPaint = z.infer<typeof AirlineLogoPaint>;

const Sides = z.number().int().min(3).max(12);

/**
 * One layer's geometry. Coordinates are normalised 0..1 over the **whole** emblem
 * (unlike the legacy custom mark, which lived in a small centred region), so a
 * layer can be a full-bleed outer ring or a small accent dot with the same maths.
 *
 * Rotation is **not** here — it lives on the layer ({@link AirlineLogoLayer}),
 * applied around the content's centre, so every element rotates the same way.
 */
export const AirlineLogoLayerContent = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('circle'),
      cx: Unit,
      cy: Unit,
      r: z.number().finite().min(0.01).max(0.6),
    })
    .strict(),
  z
    .object({
      type: z.literal('ellipse'),
      cx: Unit,
      cy: Unit,
      rx: z.number().finite().min(0.01).max(0.6),
      ry: z.number().finite().min(0.01).max(0.6),
    })
    .strict(),
  z
    .object({
      type: z.literal('rect'),
      cx: Unit,
      cy: Unit,
      w: z.number().finite().min(0.01).max(1),
      h: z.number().finite().min(0.01).max(1),
    })
    .strict(),
  z
    .object({
      type: z.literal('triangle'),
      cx: Unit,
      cy: Unit,
      size: z.number().finite().min(0.02).max(1),
    })
    .strict(),
  z
    .object({
      type: z.literal('polygon'),
      cx: Unit,
      cy: Unit,
      size: z.number().finite().min(0.02).max(1),
      sides: Sides,
    })
    .strict(),
  z
    .object({
      type: z.literal('star'),
      cx: Unit,
      cy: Unit,
      size: z.number().finite().min(0.02).max(1),
      points: Sides,
    })
    .strict(),
  z.object({ type: z.literal('line'), x1: Unit, y1: Unit, x2: Unit, y2: Unit }).strict(),
  z
    .object({
      type: z.literal('path'),
      points: z
        .array(z.object({ x: Unit, y: Unit }).strict())
        .min(2)
        .max(64),
      closed: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal('text'),
      cx: Unit,
      cy: Unit,
      text: Monogram,
      size: z.number().finite().min(0.05).max(1),
    })
    .strict(),
  z
    .object({
      type: z.literal('symbol'),
      cx: Unit,
      cy: Unit,
      symbol: AirlineLogoSymbol,
      size: z.number().finite().min(0.05).max(1),
    })
    .strict(),
]);
export type AirlineLogoLayerContent = z.infer<typeof AirlineLogoLayerContent>;
export type AirlineLogoLayerType = AirlineLogoLayerContent['type'];

/** The layer content types the studio can add, in palette order. */
export const AIRLINE_LOGO_LAYER_TYPES = [
  'circle',
  'ellipse',
  'rect',
  'triangle',
  'polygon',
  'star',
  'line',
  'path',
  'text',
  'symbol',
] as const satisfies readonly AirlineLogoLayerType[];

export const MAX_LOGO_LAYERS = 24;

export const AirlineLogoLayer = z
  .object({
    /** Stable id for React keys and selection — client-generated, opaque. */
    id: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
    /** A short human label shown in the elements list. */
    name: z.string().trim().min(1).max(40),
    hidden: z.boolean(),
    locked: z.boolean(),
    opacity: z.number().finite().min(0).max(1),
    /** Rotation in degrees, applied around the content's centre. Every element rotates. */
    rotation: Rotation,
    fill: AirlineLogoPaint,
    stroke: AirlineLogoPaint,
    /** Stroke thickness as a fraction of the emblem; also the width of a `line`. */
    strokeWidth: z.number().finite().min(0).max(0.5),
    content: AirlineLogoLayerContent,
  })
  .strict();
export type AirlineLogoLayer = z.infer<typeof AirlineLogoLayer>;

export const ComposedAirlineLogo = z
  .object({
    /** Format tag: distinguishes a composed logo from a legacy one in the union. */
    v: z.literal(2),
    shape: AirlineLogoShape,
    frameFill: AirlineLogoPaint,
    frameStroke: AirlineLogoPaint,
    palette: AirlineLogoPalette,
    layers: z.array(AirlineLogoLayer).min(1).max(MAX_LOGO_LAYERS),
  })
  .strict();
export type ComposedAirlineLogo = z.infer<typeof ComposedAirlineLogo>;

/**
 * The whole emblem: either the composed studio logo or a legacy one. New writes
 * are always composed; the legacy member exists so an old stored logo still
 * validates if it is ever round-tripped through a write path unchanged.
 */
export const AirlineLogo = z.union([ComposedAirlineLogo, LegacyAirlineLogo]);
export type AirlineLogo = z.infer<typeof AirlineLogo>;

/** Type guard: a composed logo carries the `v` tag; a legacy one does not. */
export function isComposedLogo(logo: AirlineLogo): logo is ComposedAirlineLogo {
  return (logo as Partial<ComposedAirlineLogo>).v === 2;
}

/** A stable brand hue from a seed, for a carrier that has set no logo yet. */
function hueFromSeed(seed: string): string {
  let hash = 2166136261 >>> 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const hue = (hash >>> 0) % 360;
  // Fixed saturation/lightness so every derived colour is legible on the map,
  // whatever hue the seed lands on.
  const saturation = 0.62;
  const lightness = 0.55;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const huePrime = hue / 60;
  const second = chroma * (1 - Math.abs((huePrime % 2) - 1));
  const [r1, g1, b1] =
    huePrime < 1
      ? [chroma, second, 0]
      : huePrime < 2
        ? [second, chroma, 0]
        : huePrime < 3
          ? [0, chroma, second]
          : huePrime < 4
            ? [0, second, chroma]
            : huePrime < 5
              ? [second, 0, chroma]
              : [chroma, 0, second];
  const match = lightness - chroma / 2;
  const channel = (value: number): string =>
    Math.round((value + match) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(r1)}${channel(g1)}${channel(b1)}`;
}

/**
 * A single brand colour for an airline on the world map — the dominant hue its
 * planes and its route line carry (M7-02's "coloured mark carrying the livery's
 * dominant colour"). Prefers the emblem's main colour; falls back to a stable hue
 * derived from `seed` (the airline's code or id) when there is no logo yet, so
 * even an unbranded NPC reads as its own carrier rather than a generic dot.
 */
export function airlineMapColour(logo: AirlineLogo | null | undefined, seed: string): string {
  if (logo) {
    const hex = isComposedLogo(logo) ? logo.palette.mark : logo.foreground;
    if (/^#[0-9a-fA-F]{6}$/.test(hex)) return hex.toLowerCase();
  }
  return hueFromSeed(seed);
}

/* ------------------------------------------------------------------ Builders */

let layerIdCounter = 0;
/** A short, unique-enough opaque id for a new layer. */
export function makeLayerId(): string {
  layerIdCounter += 1;
  return `l${layerIdCounter.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** A sensible fresh layer of a given content type, painted from the mark slot. */
export function defaultLayerContent(
  type: AirlineLogoLayerType,
  code = 'AIR',
): AirlineLogoLayerContent {
  switch (type) {
    case 'circle':
      return { type: 'circle', cx: 0.5, cy: 0.5, r: 0.22 };
    case 'ellipse':
      return { type: 'ellipse', cx: 0.5, cy: 0.5, rx: 0.28, ry: 0.18 };
    case 'rect':
      return { type: 'rect', cx: 0.5, cy: 0.5, w: 0.34, h: 0.34 };
    case 'triangle':
      return { type: 'triangle', cx: 0.5, cy: 0.5, size: 0.4 };
    case 'polygon':
      return { type: 'polygon', cx: 0.5, cy: 0.5, size: 0.4, sides: 6 };
    case 'star':
      return { type: 'star', cx: 0.5, cy: 0.5, size: 0.44, points: 5 };
    case 'line':
      return { type: 'line', x1: 0.3, y1: 0.5, x2: 0.7, y2: 0.5 };
    case 'path':
      return {
        type: 'path',
        points: [
          { x: 0.5, y: 0.28 },
          { x: 0.72, y: 0.72 },
          { x: 0.28, y: 0.72 },
        ],
        closed: true,
      };
    case 'text':
      return { type: 'text', cx: 0.5, cy: 0.5, text: monogramFromCode(code), size: 0.42 };
    case 'symbol':
      return { type: 'symbol', cx: 0.5, cy: 0.5, symbol: 'wings', size: 0.5 };
  }
}

const LAYER_TYPE_LABEL: Record<AirlineLogoLayerType, string> = {
  circle: 'Circle',
  ellipse: 'Ellipse',
  rect: 'Square',
  triangle: 'Triangle',
  polygon: 'Polygon',
  star: 'Star',
  line: 'Line',
  path: 'Path',
  text: 'Initials',
  symbol: 'Symbol',
};

/** A fresh, valid layer wrapping a default of the given type. */
export function newLayer(type: AirlineLogoLayerType, code = 'AIR'): AirlineLogoLayer {
  const line = type === 'line';
  return {
    id: makeLayerId(),
    name: LAYER_TYPE_LABEL[type],
    hidden: false,
    locked: false,
    opacity: 1,
    rotation: 0,
    // A line has no area to fill; everything else fills from the mark slot.
    fill: line ? 'none' : 'mark',
    stroke: line ? 'mark' : 'none',
    strokeWidth: line ? 0.08 : 0.04,
    content: defaultLayerContent(type, code),
  };
}

function monogramFromCode(code: string): string {
  return (
    code
      .replace(/[^A-Za-z0-9]/g, '')
      .slice(0, 3)
      .toUpperCase() || 'AIR'
  );
}

/**
 * A sensible starting emblem for an airline with no logo yet: a navy roundel with
 * a gold ring and the airline's own code as an initials layer. Composed, so it
 * seeds the studio directly.
 */
export function defaultAirlineLogo(code: string): ComposedAirlineLogo {
  return {
    v: 2,
    shape: 'roundel',
    frameFill: 'background',
    frameStroke: 'ring',
    palette: {
      background: '#0b3d91',
      mark: '#ffffff',
      ring: '#e6b800',
      accent: '#56b1ff',
    },
    layers: [
      {
        id: makeLayerId(),
        name: 'Initials',
        hidden: false,
        locked: false,
        opacity: 1,
        rotation: 0,
        fill: 'mark',
        stroke: 'none',
        strokeWidth: 0,
        content: {
          type: 'text',
          cx: 0.5,
          cy: 0.5,
          text: monogramFromCode(code),
          size: 0.44,
        },
      },
    ],
  };
}

/** A starting design for each legacy custom tool, so switching to it shows something. */
export function defaultCustomDesign(
  design: AirlineLogoCustomDesign['design'],
): AirlineLogoCustomDesign {
  switch (design) {
    case 'grid': {
      // A centred diamond, so a fresh grid is a mark rather than a blank square.
      const mid = (CUSTOM_GRID_SIZE - 1) / 2;
      let cells = '';
      for (let row = 0; row < CUSTOM_GRID_SIZE; row += 1) {
        for (let col = 0; col < CUSTOM_GRID_SIZE; col += 1) {
          cells += Math.abs(row - mid) + Math.abs(col - mid) <= 5.5 ? '1' : '0';
        }
      }
      return { design: 'grid', cells };
    }
    case 'shapes':
      return { design: 'shapes', shapes: [{ type: 'circle', cx: 0.5, cy: 0.5, r: 0.32 }] };
    case 'path':
      return {
        design: 'path',
        points: [
          { x: 0.5, y: 0.12 },
          { x: 0.9, y: 0.85 },
          { x: 0.1, y: 0.85 },
        ],
        closed: true,
      };
  }
}

/* --------------------------------------------------------- Legacy → composed */

/**
 * Lift a legacy logo into the composed model so the studio can open one written
 * before the editor existed. The three legacy colours map onto the palette
 * (background, mark = foreground, ring = accent) with a derived accent, and the
 * single mark becomes a single layer:
 *
 *  - monogram → a `text` layer;
 *  - symbol   → a `symbol` layer;
 *  - custom shapes → one layer per primitive;
 *  - custom path → a `path` layer;
 *  - custom grid → kept as-is is not expressible as layers, so it becomes a
 *    single centred `text` layer of the code fallback — the one lossy case, and
 *    only for the rare hand-painted bitmap. The legacy renderer still draws the
 *    original until the player saves a new composed logo.
 */
export function legacyToComposed(legacy: LegacyAirlineLogo, code = 'AIR'): ComposedAirlineLogo {
  const palette: AirlineLogoPalette = {
    background: legacy.background,
    mark: legacy.foreground,
    ring: legacy.accent,
    accent: legacy.accent,
  };
  const layers = markToLayers(legacy.mark);
  return {
    v: 2,
    shape: legacy.shape,
    frameFill: 'background',
    frameStroke: 'ring',
    palette,
    layers: layers.length > 0 ? layers : [newLayer('text', code)],
  };
}

function markToLayers(mark: AirlineLogoMark): AirlineLogoLayer[] {
  const base = (
    content: AirlineLogoLayerContent,
    name: string,
    line = false,
    rotation = 0,
  ): AirlineLogoLayer => ({
    id: makeLayerId(),
    name,
    hidden: false,
    locked: false,
    opacity: 1,
    rotation,
    fill: line ? 'none' : 'mark',
    stroke: line ? 'mark' : 'none',
    strokeWidth: line ? 0.06 : 0,
    content,
  });

  if (mark.kind === 'monogram') {
    return [base({ type: 'text', cx: 0.5, cy: 0.5, text: mark.text, size: 0.44 }, 'Initials')];
  }
  if (mark.kind === 'symbol') {
    return [base({ type: 'symbol', cx: 0.5, cy: 0.5, symbol: mark.symbol, size: 0.5 }, 'Symbol')];
  }
  // custom: legacy marks live in a centred region; map their normalised 0..1 into
  // the emblem's mark inset (18..82 of 100 → 0.18..0.82) so they land where they did.
  const into = (u: number): number => 0.18 + u * 0.64;
  const c = mark.custom;
  if (c.design === 'shapes') {
    return c.shapes.map((shape, index) => {
      if (shape.type === 'circle') {
        return base(
          { type: 'circle', cx: into(shape.cx), cy: into(shape.cy), r: shape.r * 0.64 },
          `Circle ${String(index + 1)}`,
        );
      }
      if (shape.type === 'rect') {
        return base(
          {
            type: 'rect',
            cx: into(shape.cx),
            cy: into(shape.cy),
            w: shape.w * 0.64,
            h: shape.h * 0.64,
          },
          `Square ${String(index + 1)}`,
          false,
          shape.rot,
        );
      }
      if (shape.type === 'triangle') {
        return base(
          {
            type: 'triangle',
            cx: into(shape.cx),
            cy: into(shape.cy),
            size: shape.size * 0.64,
          },
          `Triangle ${String(index + 1)}`,
          false,
          shape.rot,
        );
      }
      return {
        ...base(
          {
            type: 'line',
            x1: into(shape.x1),
            y1: into(shape.y1),
            x2: into(shape.x2),
            y2: into(shape.y2),
          },
          `Line ${String(index + 1)}`,
          true,
        ),
        strokeWidth: shape.width * 0.64,
      };
    });
  }
  if (c.design === 'path') {
    return [
      {
        ...base(
          {
            type: 'path',
            points: c.points.map((p) => ({ x: into(p.x), y: into(p.y) })),
            closed: c.closed,
          },
          'Path',
          !c.closed,
        ),
        strokeWidth: c.closed ? 0 : 0.06,
      },
    ];
  }
  // grid: not expressible as layers — see the doc comment above.
  return [];
}

/* ------------------------------------------------------------------ Equality */

/** Stable JSON with sorted keys — jsonb round-trips lose key order, so compare canonically. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
      );
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Value equality for two logos (or their absence). jsonb has no key order to
 * trust, so both members compare by canonical JSON — a composed and a legacy
 * logo are never equal, which is correct: they are different values.
 */
export function airlineLogoEquals(a: AirlineLogo | null, b: AirlineLogo | null): boolean {
  if (a === null || b === null) return a === b;
  return stableStringify(a) === stableStringify(b);
}
