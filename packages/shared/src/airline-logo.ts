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

/** The centre mark: a short monogram, or one of the built-in symbols. */
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
  return false;
}
