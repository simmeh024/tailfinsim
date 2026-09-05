import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ContextPanelProbe } from '../shell/test-context-panel';
import { ThemeProvider } from '../theme/ThemeProvider';

import { searchAirports, SEARCH_MINIMUM } from './places';
import { WORLD_PROJECTION_STORAGE_KEY } from './projection';
import { WorldRenderer } from './WorldRenderer';

import type { WorldAirport } from './layers';
import type { MapViewState } from '@deck.gl/core';

/**
 * Finding an airport (WORLD-09).
 *
 * "Show me Heathrow" used to mean: guess where London is, drag the globe there,
 * and zoom until the dot appears. There was no search anywhere on the page —
 * and the map deliberately hides most of its four thousand airports until the
 * camera is already in the right place, while offering no way to get it there.
 */

const HEATHROW: WorldAirport = {
  position: [-0.4614, 51.4775],
  name: 'London Heathrow',
  icao: 'EGLL',
  iata: 'LHR',
  tier: 'flagship',
};

const GATWICK: WorldAirport = {
  position: [-0.1903, 51.1537],
  name: 'London Gatwick',
  icao: 'EGKK',
  iata: 'LGW',
  tier: 'large',
};

const FRANKFURT: WorldAirport = {
  position: [8.5622, 50.0379],
  name: 'Frankfurt',
  icao: 'EDDF',
  iata: 'FRA',
  tier: 'flagship',
};

/** Contains "lhr" in its name, and is not what somebody typing LHR meant. */
const KILHRA: WorldAirport = {
  position: [30, 10],
  name: 'Kilhra Field',
  icao: 'ZZZZ',
  iata: null,
  tier: 'regional',
};

/**
 * A flagship whose name also contains "lhr", and which sorts before "London".
 *
 * Without it the ranking test passes on a plain substring match: every score
 * ties, the tie-breaks are tier then name, and Heathrow wins those anyway. This
 * is the decoy that makes the rank do the work.
 */
const AYLHRTON: WorldAirport = {
  position: [20, 20],
  name: 'Aylhrton Field',
  icao: 'YYYY',
  iata: null,
  tier: 'flagship',
};

const ALL = [KILHRA, AYLHRTON, GATWICK, HEATHROW, FRANKFURT];

describe('matching what was typed', () => {
  it('puts an exact code first', () => {
    // Somebody typing LHR means Heathrow, not the airports with "lhr" somewhere
    // in their name.
    expect(searchAirports(ALL, 'LHR').map((row) => row.label)).toEqual([
      'London Heathrow',
      'Aylhrton Field',
      'Kilhra Field',
    ]);
  });

  it('takes an ICAO code too, in any case', () => {
    expect(searchAirports(ALL, 'eddf')[0]?.label).toBe('Frankfurt');
  });

  it('matches a name, biggest airport first among equals', () => {
    expect(searchAirports(ALL, 'London').map((row) => row.label)).toEqual([
      'London Heathrow',
      'London Gatwick',
    ]);
  });

  it('waits for two characters', () => {
    // One letter matches most of the world, and the result is a list that
    // changes wildly as you type rather than one that narrows.
    expect(searchAirports(ALL, 'L')).toHaveLength(0);
    expect(SEARCH_MINIMUM).toBe(2);
  });

  it('finds nothing rather than everything for a query nothing matches', () => {
    expect(searchAirports(ALL, 'Narnia')).toHaveLength(0);
  });
});

// --------------------------------------------------------------- the renderer

interface CapturedDeckProps {
  viewState: MapViewState;
}

const deckCapture = vi.hoisted(() => ({ props: undefined as CapturedDeckProps | undefined }));

vi.mock('@deck.gl/react', () => ({
  default: (props: CapturedDeckProps) => {
    deckCapture.props = props;
    return null;
  },
}));

vi.mock('./airports-api', () => ({
  fetchWorldAirports: () => Promise.resolve([KILHRA, GATWICK, HEATHROW, FRANKFURT]),
}));

vi.mock('./map-api', () => ({
  fetchWorldMap: () => Promise.resolve({ hubs: [], routes: [], traffic: [], flights: [] }),
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

function search(query: string): HTMLElement {
  const field = screen.getByRole('searchbox', { name: 'Search airports' });
  fireEvent.change(field, { target: { value: query } });
  return field;
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(WORLD_PROJECTION_STORAGE_KEY, 'flat');
  deckCapture.props = undefined;
});

describe('searching from the map', () => {
  it('replaces the in-view list with the whole world’s answer', async () => {
    await renderWorld();
    fireEvent.click(screen.getByRole('button', { name: 'Places' }));

    // Kilhra is a regional field: it is not drawn at this zoom and so is not in
    // the list at all — until it is searched for.
    expect(screen.queryByRole('button', { name: /Kilhra/ })).not.toBeInTheDocument();

    search('Kilhra');

    expect(screen.getByRole('list', { name: 'Search results' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Kilhra/ })).toBeInTheDocument();
  });

  it('flies to the airport it is given and selects it', async () => {
    await renderWorld();
    fireEvent.click(screen.getByRole('button', { name: 'Places' }));
    search('Heathrow');

    fireEvent.click(screen.getByRole('button', { name: /London Heathrow/ }));

    expect(deckCapture.props?.viewState.longitude).toBeCloseTo(-0.4614, 3);
    expect(deckCapture.props?.viewState.zoom).toBeGreaterThanOrEqual(6);
    expect(screen.getByTestId('panel-title')).toHaveTextContent('London Heathrow');
  });

  it('takes the first result on Enter', async () => {
    await renderWorld();
    fireEvent.click(screen.getByRole('button', { name: 'Places' }));
    const field = search('LHR');

    fireEvent.keyDown(field, { key: 'Enter' });

    // Without this the only way from the query to a result is the mouse, which
    // is the thing WORLD-08 and this issue are both about.
    expect(screen.getByTestId('panel-title')).toHaveTextContent('London Heathrow');
  });

  it('hands the arrow key down to the results', async () => {
    await renderWorld();
    fireEvent.click(screen.getByRole('button', { name: 'Places' }));
    const field = search('London');

    fireEvent.keyDown(field, { key: 'ArrowDown' });

    expect(document.activeElement).toBe(screen.getByRole('button', { name: /London Heathrow/ }));
  });

  it('says so when nothing matches, naming what was asked for', async () => {
    await renderWorld();
    fireEvent.click(screen.getByRole('button', { name: 'Places' }));
    search('Narnia');

    expect(screen.getByText(/Nothing matches/)).toHaveTextContent('Narnia');
  });

  it('moves the camera when it cannot tell what is on screen', async () => {
    // The "already in view, so do not move" case is decided by `within()` against
    // deck.gl's own bounds, and deck is mocked here — `getViewports()` gives
    // nothing, so the bounds are null. That fallback is deliberate and this is
    // the test of it: not knowing means moving, because a selection nobody can
    // see is a worse outcome than a camera that travelled unnecessarily.
    //
    // The comparison itself, including the date-line case, is tested directly in
    // `places.test.tsx`.
    await renderWorld();
    fireEvent.click(screen.getByRole('button', { name: 'Places' }));

    fireEvent.click(screen.getByRole('button', { name: /Frankfurt/ }));

    expect(deckCapture.props?.viewState.longitude).toBeCloseTo(8.5622, 3);
    expect(screen.getByTestId('panel-title')).toHaveTextContent('Frankfurt');
  });
});
