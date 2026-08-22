import { describe, expect, it } from 'vitest';

import { colourDistance, compositeOver, parseHexColor, readWorldPalette } from './palette';

describe('world renderer palette', () => {
  it('turns a theme token into deck.gl channels', () => {
    expect(parseHexColor('#5eb8ff', [0, 0, 0, 0], 230)).toEqual([94, 184, 255, 230]);
  });

  it('uses the semantic fallback when a CSS token is absent or invalid', () => {
    expect(parseHexColor('', [1, 2, 3, 4])).toEqual([1, 2, 3, 4]);
    expect(parseHexColor('rgb(1 2 3)', [4, 5, 6, 7])).toEqual([4, 5, 6, 7]);
  });

  /**
   * The night side has to be legible.
   *
   * Roughly half of any moment is night, and §1's whole promise is that a player
   * comes back to *see* where their aircraft ended up. Night that erases the map
   * breaks that for half the day, so these are assertions about what the shading
   * actually composites to rather than about the alpha it uses to get there.
   */
  describe('night shades the world rather than erasing it', () => {
    const palette = readWorldPalette();

    it('keeps land and ocean apart under full night', () => {
      const land = compositeOver(palette.night, palette.land);
      const ocean = compositeOver(palette.night, palette.ocean);

      // At the previous alpha of 215 this distance was under 3 — land became
      // rgb(8, 14, 22) and ocean rgb(4, 8, 16), which is two blacks.
      expect(colourDistance(land, ocean)).toBeGreaterThan(6);
    });

    it('leaves the night side lighter than the night colour itself', () => {
      const land = compositeOver(palette.night, palette.land);
      // If the composite equalled the night colour, the shading would be opaque
      // and the world underneath would be gone.
      expect(land[1]).toBeGreaterThan(palette.night[1] + 8);
    });

    it('leaves the day side untouched', () => {
      const day = compositeOver(
        [...palette.night.slice(0, 3), 0] as typeof palette.night,
        palette.land,
      );
      expect(day).toEqual([palette.land[0], palette.land[1], palette.land[2]]);
    });

    it('still darkens night noticeably', () => {
      const land = compositeOver(palette.night, palette.land);
      // Shading that cannot be seen is not shading. The terminator has to read as
      // a real boundary, not a faint tint.
      expect(
        colourDistance(land, [palette.land[0], palette.land[1], palette.land[2]]),
      ).toBeGreaterThan(6);
    });
  });
});
