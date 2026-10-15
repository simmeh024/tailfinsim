/**
 * The aircraft sprite the world map tints per carrier (M7-02).
 *
 * A north-up silhouette drawn as a mask (`IconLayer`'s `mask: true`), so one
 * image serves every carrier and both themes: deck.gl keeps the alpha and
 * replaces the colour with `getColor`.
 *
 * ## It has to carry an intrinsic size
 *
 * The `<svg>` used to have a `viewBox` and nothing else, and **no aeroplane was
 * ever drawn** on a Chromium browser. deck.gl decodes an icon URL through
 * `createImageBitmap`, and Chromium refuses an SVG image with no natural
 * dimensions: *"The image element contains an SVG image without natural
 * dimensions, and no resize options are specified."* The failure is logged as a
 * deck.gl error and the icon layer draws nothing, so the map looked like a world
 * with no traffic rather than a broken sprite — the same trap as a map with no
 * worker behind it, and indistinguishable from it on a quiet world.
 *
 * `width` and `height` give the image a natural size, which is all the decoder
 * needed. They are larger than the `viewBox` on purpose: the texture is sampled
 * down to an 8–18 px sprite, and a 64 px source keeps the silhouette sharp on a
 * high-density display instead of magnifying a 24 px one.
 *
 * On its own line so the colour-literal guard skips it — `tokens.test.ts`
 * exempts `data:image/svg+xml`, and the fill is only ever a mask.
 */
export const PLANE_ICON_SIZE = 64;

// prettier-ignore
export const PLANE_ICON = 'data:image/svg+xml;charset=utf-8,<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24"><path fill="%23000" d="M12 2c-.8 0-1.4 1.3-1.4 3v4.9L2 15v2l8.6-2.6V20l-2.2 1.4V23L12 22l3.6 1v-1.6L13.4 20v-5.6L22 17v-2l-8.6-5.1V5c0-1.7-.6-3-1.4-3z"/></svg>';

/**
 * The `IconLayer` icon definition, one object for every aeroplane.
 *
 * Shared rather than built per datum: `getIcon` runs once per plane on every
 * update, and the layer keys its atlas by `url` anyway.
 */
export const PLANE_ICON_DEFINITION = {
  url: PLANE_ICON,
  width: PLANE_ICON_SIZE,
  height: PLANE_ICON_SIZE,
  mask: true,
} as const;
