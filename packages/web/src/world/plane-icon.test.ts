import { describe, expect, it } from 'vitest';

import { PLANE_ICON, PLANE_ICON_DEFINITION, PLANE_ICON_SIZE } from './plane-icon';

/**
 * The aircraft sprite (M7-02).
 *
 * The regression this holds: the SVG had a `viewBox` and no `width`/`height`,
 * Chromium's `createImageBitmap` refused it for having no natural dimensions,
 * and deck.gl's icon layer drew no aeroplanes at all — only a console error said
 * so. jsdom has no image decoder, so the test asserts the property the decoder
 * needs rather than decoding.
 */
describe('the aircraft sprite', () => {
  const svg = decodeURIComponent(PLANE_ICON.slice(PLANE_ICON.indexOf(',') + 1));

  it('is an SVG with an intrinsic width and height', () => {
    expect(PLANE_ICON.startsWith('data:image/svg+xml')).toBe(true);
    const root = /<svg\b[^>]*>/.exec(svg)?.[0] ?? '';
    expect(root).toMatch(new RegExp(`\\bwidth="${String(PLANE_ICON_SIZE)}"`));
    expect(root).toMatch(new RegExp(`\\bheight="${String(PLANE_ICON_SIZE)}"`));
    expect(root).toMatch(/\bviewBox="0 0 24 24"/);
  });

  it('declares the same size to the icon layer as the image has', () => {
    // A mismatch makes deck.gl pack the atlas at one size and sample it at
    // another, which blurs or crops the silhouette.
    expect(PLANE_ICON_DEFINITION).toEqual({
      url: PLANE_ICON,
      width: PLANE_ICON_SIZE,
      height: PLANE_ICON_SIZE,
      mask: true,
    });
  });

  it('is large enough to stay sharp at the biggest sprite on a dense display', () => {
    // `planeSpriteSize` tops out at 18 px; at a device-pixel ratio of 3 that is
    // 54 texels, which a 24 px source would have to magnify.
    expect(PLANE_ICON_SIZE).toBeGreaterThanOrEqual(54);
  });
});
