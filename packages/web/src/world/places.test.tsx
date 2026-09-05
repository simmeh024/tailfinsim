import { act, fireEvent, render, screen, within as withinElement } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ContextPanelProbe } from '../shell/test-context-panel';
import { ThemeProvider } from '../theme/ThemeProvider';

import { airportRows, flightRows, nextIndex, PLACE_LIMIT, within } from './places';
import { WORLD_PROJECTION_STORAGE_KEY } from './projection';
import { WorldRenderer } from './WorldRenderer';

import type { WorldAirport } from './layers';
import type { Layer } from '@deck.gl/core';

/**
 * The map can be operated without a pointer (WORLD-08).
 *
 * A keyboard could pan and zoom — deck's controller has `keyboard: true` — and
 * could select nothing at all: airports and aeroplanes were reachable only
 * through `onClick`, there was no focusable representation of any of them, and
 * neither panel handled Escape. The same shape as UX-03 on the planner timeline:
 * a surface that can be focused and not operated.
 */

const HEATHROW: WorldAirport = {
  position: [-0.4614, 51.4775],
  name: 'London Heathrow',
  icao: 'EGLL',
  iata: 'LHR',
  tier: 'flagship',
};

const FRANKFURT: WorldAirport = {
  position: [8.5622, 50.0379],
  name: 'Frankfurt',
  icao: 'EDDF',
  iata: 'FRA',
  tier: 'flagship',
};

const LUKLA: WorldAirport = {
  position: [86.7292, 27.6869],
  name: 'Lukla',
  icao: 'VNLK',
  iata: null,
  tier: 'regional',
};

describe('what counts as in view', () => {
  it('accepts a point inside the box', () => {
    expect(within([8.5, 50], [-10, 40, 20, 60])).toBe(true);
    expect(within([8.5, 30], [-10, 40, 20, 60])).toBe(false);
  });

  it('handles a camera sitting over the date line', () => {
    // A camera over the Pacific has a western edge *greater* than its eastern
    // one. A plain `west <= lng <= east` there excludes everything on screen and
    // includes everything off it, which is exactly backwards.
    const pacific: [number, number, number, number] = [150, -40, -150, 40];
    expect(within([175, 0], pacific)).toBe(true);
    expect(within([-175, 0], pacific)).toBe(true);
    expect(within([0, 0], pacific)).toBe(false);
  });
});

describe('the rows', () => {
  it('put the biggest airports first, then alphabetically', () => {
    const rows = airportRows([LUKLA, HEATHROW, FRANKFURT], null);
    expect(rows.map((row) => row.label)).toEqual(['Frankfurt', 'London Heathrow', 'Lukla']);
  });

  it('carry the codes a player reads', () => {
    expect(airportRows([HEATHROW], null)[0]?.detail).toBe('EGLL · LHR');
    expect(airportRows([LUKLA], null)[0]?.detail).toBe('VNLK');
  });

  it('are narrowed to the camera when it will say where it is', () => {
    const overEurope: [number, number, number, number] = [-15, 35, 25, 60];
    expect(airportRows([HEATHROW, FRANKFURT, LUKLA], overEurope).map((r) => r.label)).toEqual([
      'Frankfurt',
      'London Heathrow',
    ]);
  });

  it('are capped, because four thousand rows is not a list', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      ...HEATHROW,
      icao: `X${String(i).padStart(3, '0')}`,
      name: `Airport ${String(i)}`,
    }));
    expect(airportRows(many, null)).toHaveLength(PLACE_LIMIT);
  });

  it("put the player's own flights above the competition's", () => {
    const base = {
      source: [0, 0] as [number, number],
      target: [1, 1] as [number, number],
      originIcao: 'AAAA',
      destinationIcao: 'BBBB',
      originName: 'A',
      destinationName: 'B',
      airlineId: 'x',
      colour: '#336699',
    };
    const rows = flightRows([
      { ...base, id: '1', airlineName: 'Rival Air', own: false },
      { ...base, id: '2', airlineName: 'Mine', own: true },
    ]);
    expect(rows.map((row) => row.label)).toEqual(['Your flight', 'Rival Air']);
  });
});

describe('moving through the list', () => {
  it('stops at the ends rather than wrapping', () => {
    // Wrapping turns "I am at the end" into a silent jump to the other end, and
    // the reader has no way to tell that from the list having scrolled.
    expect(nextIndex(0, -1, 5)).toBe(0);
    expect(nextIndex(4, 1, 5)).toBe(4);
    expect(nextIndex(2, 1, 5)).toBe(3);
  });
});

// --------------------------------------------------------------- the renderer

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

vi.mock('./airports-api', () => ({
  fetchWorldAirports: () => Promise.resolve([HEATHROW, FRANKFURT, LUKLA]),
}));

vi.mock('./map-api', () => ({
  fetchWorldMap: () => Promise.resolve({ hubs: [], routes: [], traffic: [] }),
}));

async function renderWorld(): Promise<void> {
  render(
    <MemoryRouter>
      <ThemeProvider>
        <ContextPanelProbe>
          <WorldRenderer />
        </ContextPanelProbe>
      </ThemeProvider>
    </MemoryRouter>,
  );
  await act(async () => {
    await Promise.resolve();
  });
}

function openPlaces(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Places' }));
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(WORLD_PROJECTION_STORAGE_KEY, 'flat');
  deckCapture.props = undefined;
});

describe('the places list', () => {
  it('lists what the map is drawing', async () => {
    await renderWorld();
    openPlaces();

    const list = screen.getByRole('group', { name: 'Places on the map' });
    // Lukla is a regional field: the map does not draw it at the opening zoom,
    // so the list does not offer it either.
    expect(
      withinElement(list).getByRole('button', { name: /London Heathrow/ }),
    ).toBeInTheDocument();
    expect(withinElement(list).queryByRole('button', { name: /Lukla/ })).not.toBeInTheDocument();
  });

  it('takes focus when it opens, one row at a time', async () => {
    await renderWorld();
    openPlaces();

    const rows = screen.getAllByRole('button', { name: /EGLL|EDDF/ });
    // Roving tabindex: sixty focusable rows would put sixty presses between the
    // list and whatever follows it.
    expect(rows.filter((row) => row.getAttribute('tabindex') === '0')).toHaveLength(1);
    expect(document.activeElement).toBe(rows[0]);
  });

  it('walks with the arrow keys and stops at the end', async () => {
    await renderWorld();
    openPlaces();
    const rows = screen.getAllByRole('button', { name: /EGLL|EDDF/ });

    fireEvent.keyDown(rows[0]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rows[1]);

    fireEvent.keyDown(rows[1]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rows[1]);
  });

  it('selects a row into the context panel, and says so', async () => {
    await renderWorld();
    openPlaces();

    fireEvent.click(screen.getByRole('button', { name: /London Heathrow/ }));

    expect(screen.getByTestId('panel-title')).toHaveTextContent('London Heathrow');
    // A highlighted dot on a canvas is invisible to a screen reader, and the
    // panel it opens is somewhere else on the page.
    expect(screen.getByTestId('world-announcement')).toHaveTextContent('London Heathrow selected');
  });

  it('closes on Escape and hands focus back to the control that opened it', async () => {
    await renderWorld();
    openPlaces();

    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });

    expect(screen.queryByRole('group', { name: 'Places on the map' })).not.toBeInTheDocument();
    // Closing while focus is inside leaves it on nothing, and the next Tab
    // starts again from the top of the document.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Places' }));
  });
});

describe('Escape on the map', () => {
  it('clears a selection', async () => {
    await renderWorld();
    openPlaces();
    fireEvent.click(screen.getByRole('button', { name: /London Heathrow/ }));
    expect(screen.getByTestId('panel-title')).toHaveTextContent('London Heathrow');

    fireEvent.keyDown(screen.getByLabelText('Interactive world renderer'), { key: 'Escape' });

    expect(screen.getByTestId('panel-title')).toHaveTextContent('Context');
    expect(screen.getByTestId('world-announcement')).toHaveTextContent('Selection cleared');
  });
});
