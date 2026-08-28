import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  AIRLINE_LOGO_LAYER_TYPES,
  defaultAirlineLogo,
  newLayer,
  type LegacyAirlineLogo,
} from '@tailfin/shared';

import { AirlineLogoEmblem } from './AirlineLogoEmblem';

/**
 * The emblem renderer draws two shapes of logo — the composed studio model and
 * the legacy #789 one. jsdom does not lay SVG out, so what these cover is that
 * every layer content type and every legacy mark produces valid SVG without
 * throwing, which is the contract the viewer and the studio's live preview share.
 */

describe('AirlineLogoEmblem', () => {
  it('renders a composed logo for every layer content type', () => {
    const base = defaultAirlineLogo('TF');
    for (const type of AIRLINE_LOGO_LAYER_TYPES) {
      const logo = { ...base, layers: [newLayer(type)] };
      const { container, unmount } = render(<AirlineLogoEmblem logo={logo} label="composed" />);
      expect(container.querySelector('svg')).not.toBeNull();
      unmount();
    }
  });

  it('renders a composed logo that stacks several layers and a none-fill ring', () => {
    const base = defaultAirlineLogo('TF');
    const ring = {
      ...newLayer('circle'),
      fill: 'none' as const,
      stroke: 'ring' as const,
      strokeWidth: 0.08,
    };
    const logo = { ...base, layers: [ring, newLayer('text'), newLayer('symbol')] };
    const { container } = render(<AirlineLogoEmblem logo={logo} label="stacked" />);
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('still renders every legacy mark (monogram, symbol, custom shapes/path/grid)', () => {
    const base: Omit<LegacyAirlineLogo, 'mark'> = {
      shape: 'roundel',
      background: '#0b3d91',
      foreground: '#ffffff',
      accent: '#e6b800',
    };
    const marks: LegacyAirlineLogo['mark'][] = [
      { kind: 'monogram', text: 'TF' },
      { kind: 'symbol', symbol: 'globe' },
      {
        kind: 'custom',
        custom: { design: 'shapes', shapes: [{ type: 'circle', cx: 0.5, cy: 0.5, r: 0.3 }] },
      },
      {
        kind: 'custom',
        custom: {
          design: 'path',
          points: [
            { x: 0.2, y: 0.2 },
            { x: 0.8, y: 0.8 },
          ],
          closed: false,
        },
      },
      { kind: 'custom', custom: { design: 'grid', cells: '1'.repeat(256) } },
    ];
    for (const mark of marks) {
      const { container, unmount } = render(
        <AirlineLogoEmblem logo={{ ...base, mark }} label="legacy" />,
      );
      expect(container.querySelector('svg')).not.toBeNull();
      unmount();
    }
  });
});
