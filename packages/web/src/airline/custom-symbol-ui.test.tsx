import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import {
  AirlineLogoCustomDesign,
  defaultCustomDesign,
  type AirlineLogo,
  type AirlineLogoCustomDesign as CustomDesign,
} from '@tailfin/shared';

import { AirlineLogoEmblem } from './AirlineLogoEmblem';
import { CustomSymbolDesigner } from './CustomSymbolDesigner';

/**
 * The custom symbol designer.
 *
 * The pointer-driven painting and dragging need real element geometry, which jsdom
 * does not give — those are the province of a browser. What these cover is the
 * logic the buttons drive: the three tools switch and remember their work, and the
 * grid / shapes / path controls each produce a valid design the emblem can render.
 */

function Harness(): React.ReactNode {
  const [value, setValue] = useState<CustomDesign>(defaultCustomDesign('grid'));
  return (
    <>
      <CustomSymbolDesigner value={value} onChange={setValue} color="#ffffff" />
      <pre data-testid="state">{JSON.stringify(value)}</pre>
    </>
  );
}

function state(): CustomDesign {
  return JSON.parse(screen.getByTestId('state').textContent ?? '{}') as CustomDesign;
}

describe('the custom symbol designer', () => {
  it('fills, clears and inverts the grid, always producing a valid design', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Fill' }));
    let current = state();
    expect(current.design === 'grid' && /^1+$/.test(current.cells)).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    current = state();
    expect(current.design === 'grid' && /^0+$/.test(current.cells)).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Invert' }));
    current = state();
    expect(current.design === 'grid' && /^1+$/.test(current.cells)).toBe(true);
    expect(AirlineLogoCustomDesign.safeParse(current).success).toBe(true);
  });

  it('switches tools and remembers each tool’s work', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Fill' })); // grid all-on

    fireEvent.click(screen.getByRole('button', { name: 'Shapes' }));
    expect(state().design).toBe('shapes');
    fireEvent.click(screen.getByRole('button', { name: '+ Triangle' }));
    const shapes = state();
    expect(shapes.design === 'shapes' && shapes.shapes.length).toBe(2);

    // Back to grid — the filled grid is remembered, not reset.
    fireEvent.click(screen.getByRole('button', { name: 'Grid' }));
    const grid = state();
    expect(grid.design === 'grid' && /^1+$/.test(grid.cells)).toBe(true);
  });

  it('drives the path tool: close toggle, undo and reset', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Path' }));
    let current = state();
    expect(current.design === 'path' && current.closed).toBe(true);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Closed' }));
    current = state();
    expect(current.design === 'path' && current.closed).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Undo point' }));
    current = state();
    expect(current.design === 'path' && current.points.length).toBe(2);
    // At two points, undo cannot go lower.
    expect(screen.getByRole('button', { name: 'Undo point' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    current = state();
    expect(current.design === 'path' && current.points.length).toBe(3);
  });

  it('renders every custom design in the emblem without error', () => {
    const base = {
      shape: 'roundel' as const,
      background: '#0b3d91',
      foreground: '#ffffff',
      accent: '#e6b800',
    };
    for (const design of ['grid', 'shapes', 'path'] as const) {
      const logo: AirlineLogo = {
        ...base,
        mark: { kind: 'custom', custom: defaultCustomDesign(design) },
      };
      const { container, unmount } = render(<AirlineLogoEmblem logo={logo} label="mark" />);
      expect(container.querySelector('svg')).not.toBeNull();
      unmount();
    }
  });
});
