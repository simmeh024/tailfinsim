import { describe, expect, it } from 'vitest';

import { parseHexColor } from './palette';

describe('world renderer palette', () => {
  it('turns a theme token into deck.gl channels', () => {
    expect(parseHexColor('#5eb8ff', [0, 0, 0, 0], 230)).toEqual([94, 184, 255, 230]);
  });

  it('uses the semantic fallback when a CSS token is absent or invalid', () => {
    expect(parseHexColor('', [1, 2, 3, 4])).toEqual([1, 2, 3, 4]);
    expect(parseHexColor('rgb(1 2 3)', [4, 5, 6, 7])).toEqual([4, 5, 6, 7]);
  });
});
