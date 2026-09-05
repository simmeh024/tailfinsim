import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemeProvider } from '../theme/ThemeProvider';

import { airportCodes, airportLabel, flightLabel, tipPlacement } from './hover';
import { WORLD_PROJECTION_STORAGE_KEY } from './projection';
import { WorldRenderer } from './WorldRenderer';

import type { WorldAirport } from './layers';
import type { Layer } from '@deck.gl/core';

/**
 * Hovering says what a thing is (WORLD-03).
 *
 * The map draws around four thousand airports and, until this, hovering any of
 * them did nothing at all: no `getTooltip`, no `onHover`, nowhere in the folder.
 * The only way to learn a dot was Heathrow was to click it and open a panel.
 */

interface CapturedDeckProps {
  layers: (Layer | false)[];
}

const deckCapture = vi.hoisted(() => ({ props: undefined as CapturedDeckProps | undefined }));

vi.mock('@deck.gl/react', () => ({
  default: (props: CapturedDeckProps) => {
    deckCapture.props = props;
    return null;
  },
}));

const HEATHROW: WorldAirport = {
  position: [-0.4614, 51.4775],
  name: 'London Heathrow',
  icao: 'EGLL',
  iata: 'LHR',
  tier: 'flagship',
};

/** A field with no IATA code, which is most of the four thousand. */
const LUKLA: WorldAirport = {
  position: [86.7292, 27.6869],
  name: 'Lukla',
  icao: 'VNLK',
  iata: null,
  tier: 'regional',
};

const RIVAL = {
  id: 'npc-1',
  source: [8.5622, 50.0379] as [number, number],
  target: [-0.4614, 51.4775] as [number, number],
  originIcao: 'EDDF',
  destinationIcao: 'EGLL',
  originName: 'Frankfurt',
  destinationName: 'London Heathrow',
  airlineId: 'npc',
  airlineName: 'Rival Air',
  own: false,
  colour: '#3366cc',
};

vi.mock('./airports-api', () => ({
  fetchWorldAirports: () => Promise.resolve([HEATHROW, LUKLA]),
}));

vi.mock('./map-api', () => ({
  fetchWorldMap: () => Promise.resolve({ hubs: [], routes: [], traffic: [RIVAL] }),
}));

describe('what a label says', () => {
  it('gives an airport its name, both codes and its tier', () => {
    expect(airportLabel(HEATHROW)).toEqual({
      title: 'London Heathrow',
      detail: 'EGLL · LHR · Flagship hub',
    });
  });

  it('says only the ICAO for a field with no IATA code', () => {
    // Most of the four thousand. A dangling separator would read as a missing
    // value rather than as an airport that simply has no code.
    expect(airportCodes(LUKLA)).toBe('VNLK');
    expect(airportLabel(LUKLA).detail).toBe('VNLK · Regional field');
  });

  it('leads with the carrier, because that is the question a plane provokes', () => {
    expect(flightLabel(RIVAL)).toEqual({ title: 'Rival Air', detail: 'EDDF → EGLL' });
  });

  it('does not repeat the player their own airline name', () => {
    expect(flightLabel({ ...RIVAL, own: true }).title).toBe('Your flight');
  });
});

describe('where the label goes', () => {
  const canvas = { width: 1000, height: 800 };

  it('follows the pointer in the top left', () => {
    expect(tipPlacement({ x: 100, y: 100, ...canvas })).toEqual({ left: 114, top: 114 });
  });

  it('grows away from the edges it is near', () => {
    // The map fills the stage, so there is no page scroll to rescue a label that
    // runs off it: anything in the eastern half is anchored to the right edge
    // instead, and anything low to the bottom.
    expect(tipPlacement({ x: 900, y: 700, ...canvas })).toEqual({ right: 114, bottom: 114 });
  });

  it('places by the pointer when the canvas size is unknown', () => {
    // deck.gl reports no viewport before it has measured; a label that vanished
    // until it had would flicker on the first hover of every session.
    expect(tipPlacement({ x: 40, y: 60, width: 0, height: 0 })).toEqual({ left: 54, top: 74 });
  });
});

describe('hovering the map', () => {
  function layerNamed(id: string): Layer {
    const layer = (deckCapture.props?.layers ?? [])
      .filter((entry): entry is Layer => entry !== false)
      .find((entry) => entry.id === id);
    expect(layer, `${id} is not on the map`).toBeDefined();
    return layer!;
  }

  function hover(id: string, object: unknown): void {
    const onHover = layerNamed(id).props.onHover as (info: {
      object?: unknown;
      x: number;
      y: number;
      viewport?: { width: number; height: number };
    }) => void;
    act(() => {
      onHover({ object, x: 120, y: 90, viewport: { width: 1000, height: 800 } });
    });
  }

  beforeEach(async () => {
    localStorage.clear();
    localStorage.setItem(WORLD_PROJECTION_STORAGE_KEY, 'flat');
    deckCapture.props = undefined;
    render(
      <MemoryRouter>
        <ThemeProvider>
          <WorldRenderer />
        </ThemeProvider>
      </MemoryRouter>,
    );
    await act(async () => {
      await Promise.resolve();
    });
  });

  it('names the airport under the pointer', () => {
    hover('world-airports', HEATHROW);

    const tip = screen.getByTestId('world-tip');
    expect(tip).toHaveTextContent('London Heathrow');
    expect(tip).toHaveTextContent('EGLL · LHR · Flagship hub');
  });

  it('clears the label on the way out', () => {
    // deck.gl fires the same handler with no object as the pointer leaves, so
    // there is no separate leave path to forget — but it does have to be handled.
    hover('world-airports', HEATHROW);
    hover('world-airports', undefined);
    expect(screen.queryByTestId('world-tip')).not.toBeInTheDocument();
  });

  it('names the carrier behind an aircraft', () => {
    // Rivals are off by default, so their aeroplanes are not drawn at all.
    fireEvent.click(screen.getByRole('button', { name: 'Rivals' }));

    // A plane icon carries only the id of the route it is flying; the carrier
    // behind it — the interesting half — is resolved through the world's traffic.
    hover('world-planes', { sourceId: 'npc-1' });

    const tip = screen.getByTestId('world-tip');
    expect(tip).toHaveTextContent('Rival Air');
    expect(tip).toHaveTextContent('EDDF → EGLL');
  });

  it('keeps the label out of the pointer', () => {
    hover('world-airports', HEATHROW);
    // 120 and 90 are both in the top-left half of a 1000x800 canvas, so the label
    // is offset down and right of the dot rather than sitting on top of it.
    expect(screen.getByTestId('world-tip')).toHaveStyle({ left: '134px', top: '104px' });
  });
});
