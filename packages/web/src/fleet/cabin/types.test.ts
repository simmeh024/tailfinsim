import { describe, expect, it } from 'vitest';

import { CABIN_PRESETS } from './presets';
import { isCabinConfig } from './types';

/**
 * Whether a stored draft is one this build can draw.
 *
 * Every field the page reads without a guard is checked, because a draft outlives
 * the build that wrote it — and one unknown value used to blank the whole app.
 */

function draftWith(element: Record<string, unknown>): unknown {
  return { typeDesignation: 'A320neo', version: 1, elements: [element] };
}

const ROW = {
  kind: 'seats',
  id: 'row-1',
  cabinClass: 'economy',
  productId: 'y-standard',
  seatLayout: '3-3',
  pitchIn: 30,
  isExitRow: false,
};

describe('isCabinConfig', () => {
  it('accepts every shipped preset', () => {
    for (const preset of CABIN_PRESETS) expect(isCabinConfig(preset.config)).toBe(true);
  });

  it('accepts a seat row and a known monument', () => {
    expect(isCabinConfig(draftWith(ROW))).toBe(true);
    expect(isCabinConfig(draftWith({ kind: 'galley', id: 'g-1' }))).toBe(true);
  });

  it.each([
    ['an unknown monument', { kind: 'bar_cart', id: 'x' }],
    ['an unknown class', { ...ROW, cabinClass: 'suite' }],
    ['a layout that is not text', { ...ROW, seatLayout: 6 }],
    ['a layout that is not groups of seats', { ...ROW, seatLayout: '3 3' }],
    ['a pitch that is not a number', { ...ROW, pitchIn: 'wide' }],
    ['a pitch of zero', { ...ROW, pitchIn: 0 }],
    ['an exit flag that is not a boolean', { ...ROW, isExitRow: 'no' }],
    ['an element with no id', { kind: 'galley' }],
  ])('refuses %s', (_label, element) => {
    expect(isCabinConfig(draftWith(element))).toBe(false);
  });

  it('refuses a document that is not a cabin at all', () => {
    for (const value of [null, 'text', [], { elements: 'rows' }, { version: 1, elements: [] }]) {
      expect(isCabinConfig(value)).toBe(false);
    }
  });
});
