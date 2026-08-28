import { z } from 'zod';

/**
 * The airline brand logo (§15/§16, the manage-airline page).
 *
 * A **procedural emblem**, not an uploaded image: a compact spec the client
 * renders as inline SVG and the server stores as one small jsonb value. Keeping
 * the logo declarative means there is no blob store, no file-type or size
 * gatekeeping and no arbitrary-image moderation surface — the whole logo is a
 * shape, a mark (initials or a built-in symbol) and three colours, so it is a few
 * dozen bytes and always renders crisply at any size.
 *
 * Changing it is a **paid identity event**, folded into AIR-08's rebrand: a logo
 * change costs the rebrand fee and is recorded in `airline_identity_change`
 * alongside a name or callsign change, exactly like one.
 */

/** The frame the emblem sits in. */
export const AIRLINE_LOGO_SHAPES = ['roundel', 'shield', 'square', 'hexagon'] as const;
export const AirlineLogoShape = z.enum(AIRLINE_LOGO_SHAPES);
export type AirlineLogoShape = z.infer<typeof AirlineLogoShape>;

/** The built-in symbols a mark may use instead of initials. Rendered client-side. */
export const AIRLINE_LOGO_SYMBOLS = ['wings', 'star', 'globe', 'mountain', 'bird'] as const;
export const AirlineLogoSymbol = z.enum(AIRLINE_LOGO_SYMBOLS);
export type AirlineLogoSymbol = z.infer<typeof AirlineLogoSymbol>;

/** #RRGGBB hex, either case — an `<input type="color">` yields lowercase. */
export const AirlineLogoColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'must be a #RRGGBB hex colour');
export type AirlineLogoColor = z.infer<typeof AirlineLogoColor>;

/**
 * A player-designed custom mark (the custom symbol designer). Three depths of
 * tool, one output — every design renders into the emblem's central region in the
 * mark colour, so a viewer never needs to know which tool drew it:
 *
 *  - **grid**: a 16×16 monochrome bitmap, painted cell by cell;
 *  - **shapes**: a short stack of primitives (circle/rect/triangle/line);
 *  - **path**: a freeform polygon of points, open (stroked) or closed (filled).
 *
 * Coordinates are normalised 0..1 within the mark region — independent of the
 * emblem's pixel size — exactly as the livery document keeps its artwork. Arrays
 * are bounded so the whole logo stays a few hundred bytes of jsonb.
 */
export const CUSTOM_GRID_SIZE = 16;
const CUSTOM_GRID_CELLS = CUSTOM_GRID_SIZE * CUSTOM_GRID_SIZE;

const Unit = z.number().finite().min(0).max(1);
const Rotation = z.number().finite().min(-180).max(180);

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

/** The centre mark: a short monogram, a built-in symbol, or a custom design. */
export const AirlineLogoMark = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('monogram'),
      /** One to three characters — an airline's initials or code. */
      text: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9]{1,3}$/, 'must be 1–3 letters or digits'),
    })
    .strict(),
  z.object({ kind: z.literal('symbol'), symbol: AirlineLogoSymbol }).strict(),
  z.object({ kind: z.literal('custom'), custom: AirlineLogoCustomDesign }).strict(),
]);
export type AirlineLogoMark = z.infer<typeof AirlineLogoMark>;

/**
 * The whole emblem: a framed shape, a mark, and three colours — the fill behind
 * the mark, the mark itself, and the ring/accent around the frame.
 */
export const AirlineLogo = z
  .object({
    shape: AirlineLogoShape,
    mark: AirlineLogoMark,
    background: AirlineLogoColor,
    foreground: AirlineLogoColor,
    accent: AirlineLogoColor,
  })
  .strict();
export type AirlineLogo = z.infer<typeof AirlineLogo>;

/**
 * A sensible starting emblem for an airline with no logo yet: a navy roundel with
 * a gold ring and the airline's own code as its monogram. Pure, so the client can
 * seed the editor and the viewer can show it wherever a stored logo is still null.
 */
export function defaultAirlineLogo(code: string): AirlineLogo {
  const text =
    code
      .replace(/[^A-Za-z0-9]/g, '')
      .slice(0, 3)
      .toUpperCase() || 'AIR';
  return {
    shape: 'roundel',
    mark: { kind: 'monogram', text },
    background: '#0b3d91',
    foreground: '#ffffff',
    accent: '#e6b800',
  };
}

/** A starting design for each custom tool, so switching to it shows something. */
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

/** Value equality for two logos (or their absence). jsonb has no key order to trust. */
export function airlineLogoEquals(a: AirlineLogo | null, b: AirlineLogo | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.shape !== b.shape) return false;
  if (a.background !== b.background) return false;
  if (a.foreground !== b.foreground) return false;
  if (a.accent !== b.accent) return false;
  if (a.mark.kind !== b.mark.kind) return false;
  if (a.mark.kind === 'monogram' && b.mark.kind === 'monogram') {
    return a.mark.text === b.mark.text;
  }
  if (a.mark.kind === 'symbol' && b.mark.kind === 'symbol') {
    return a.mark.symbol === b.mark.symbol;
  }
  if (a.mark.kind === 'custom' && b.mark.kind === 'custom') {
    return stableStringify(a.mark.custom) === stableStringify(b.mark.custom);
  }
  return false;
}
