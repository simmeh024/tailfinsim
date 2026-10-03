import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ContextPanelProbe } from '../shell/test-context-panel';
import { ThemeProvider } from '../theme/ThemeProvider';

import { AIRPORT_HANDOFF_ZOOM, TERMINAL_EXIT_ZOOM } from './bands';
import { MAX_ZOOM } from './camera';
import { WORLD_PROJECTION_STORAGE_KEY, type WorldProjection } from './projection';
import { WorldPage } from './WorldPage';

import type { MapViewState } from '@deck.gl/core';

/**
 * Zooming from the world into an airport map, and back (M7-07, §H.2, App. B.7).
 *
 * > *"Zoom is continuous through four bands: world → region → terminal area →
 * > airport map (App. B.7), where the airport view is always a stylised 2D
 * > schematic regardless of projection."*
 *
 * The rules are `bands.ts`'s and are proved there. What these prove is the
 * renderer acting on them: a zoom in over an airport the player operates at
 * opens its map and pushes it into history; the detail panel and a link open
 * any airport; leaving lands on the world centred on the airport in the
 * terminal-area band; and the browser's back button leaves it. Every hand-off
 * test runs on both projections — CI's runner picks the flat map unless one is
 * pinned, so both are pinned explicitly.
 *
 * `AirportMapView` is stubbed **by its props** — `icao` and `onExit` are the
 * whole contract this half depends on, and the schematic behind them is built
 * in parallel. The stub's label is the placeholder's own.
 */

interface CapturedDeckProps {
  viewState: MapViewState;
  onViewStateChange: (change: {
    viewState: MapViewState;
    interactionState?: { isZooming?: boolean };
  }) => void;
}

const deckCapture = vi.hoisted(() => ({ props: undefined as CapturedDeckProps | undefined }));

vi.mock('@deck.gl/react', () => ({
  default: (props: CapturedDeckProps) => {
    deckCapture.props = props;
    return null;
  },
}));

vi.mock('../airport/AirportMapView', () => ({
  AirportMapView: ({ icao, onExit }: { icao: string; onExit: () => void }) => (
    <section aria-label={`Airport map: ${icao}`}>
      <button type="button" onClick={onExit}>
        Back to the world
      </button>
    </section>
  ),
}));

const HEATHROW = {
  position: [-0.4614, 51.4775] as [number, number],
  name: 'London Heathrow',
  icao: 'EGLL',
  iata: 'LHR',
  tier: 'flagship',
};
const SCHIPHOL = {
  position: [4.7639, 52.3086] as [number, number],
  name: 'Amsterdam Schiphol',
  icao: 'EHAM',
  iata: 'AMS',
  tier: 'flagship',
};
/** Served, and flown by nobody in this airline: not one the player operates at. */
const CDG = {
  position: [2.55, 49.0097] as [number, number],
  name: 'Paris Charles de Gaulle',
  icao: 'LFPG',
  iata: 'CDG',
  tier: 'flagship',
};

vi.mock('./airports-api', () => ({
  fetchWorldAirports: () => Promise.resolve([HEATHROW, SCHIPHOL, CDG]),
}));

/** A hub at Schiphol and one route to Heathrow: both operated, Paris not. */
vi.mock('./map-api', () => ({
  fetchWorldMap: () =>
    Promise.resolve({
      hubs: [{ position: [4.7639, 52.3086], icao: 'EHAM', name: 'Amsterdam Schiphol' }],
      routes: [
        {
          id: 'r1',
          source: [4.7639, 52.3086],
          target: [-0.4614, 51.4775],
          originIcao: 'EHAM',
          destinationIcao: 'EGLL',
          originName: 'Amsterdam Schiphol',
          destinationName: 'London Heathrow',
        },
      ],
      traffic: [],
      flights: [],
    }),
}));

function Address(): React.ReactElement {
  const location = useLocation();
  return <span data-testid="address">{`${location.pathname}${location.search}`}</span>;
}

/** The browser's back button, as the router sees it. */
function BrowserBack(): React.ReactElement {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => void navigate(-1)}>
      Browser back
    </button>
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderWorld(entries: string[]): Promise<void> {
  render(
    <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
      <ThemeProvider>
        <ContextPanelProbe>
          <Address />
          <BrowserBack />
          <Routes>
            <Route path="/world" element={<WorldPage />} />
            <Route path="/fleet" element={<p>Fleet page</p>} />
          </Routes>
        </ContextPanelProbe>
      </ThemeProvider>
    </MemoryRouter>,
  );
  await settle();
}

function zoomTo(centre: [number, number], zoom: number, isZooming = false): void {
  act(() => {
    deckCapture.props?.onViewStateChange({
      viewState: {
        longitude: centre[0],
        latitude: centre[1],
        zoom,
        pitch: 0,
        bearing: 0,
      },
      interactionState: { isZooming },
    });
  });
}

/** Let a hand-off's animation finish, and the debounced address writer run. */
async function finishAnimations(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(600);
  });
}

function airportMap(icao: string): HTMLElement | null {
  return screen.queryByRole('region', { name: `Airport map: ${icao}` });
}

/** At Heathrow in the terminal area, by link. */
const AT_HEATHROW = `/world?lng=${String(HEATHROW.position[0])}&lat=${String(HEATHROW.position[1])}&z=11`;

const PROJECTIONS: WorldProjection[] = ['flat', 'globe'];

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  localStorage.clear();
  deckCapture.props = undefined;
});

afterEach(() => {
  vi.useRealTimers();
});

describe.each(PROJECTIONS)('zooming into an airport map, on the %s projection', (projection) => {
  beforeEach(() => {
    localStorage.setItem(WORLD_PROJECTION_STORAGE_KEY, projection);
  });

  it('hands off from the terminal area into an airport the player operates at', async () => {
    await renderWorld([AT_HEATHROW]);
    expect(screen.getByTestId('world-band')).toHaveTextContent(/Terminal area/);
    expect(airportMap('EGLL')).toBeNull();

    zoomTo(HEATHROW.position, AIRPORT_HANDOFF_ZOOM + 0.2, true);
    await settle();

    expect(airportMap('EGLL')).not.toBeNull();
    expect(screen.getByTestId('address').textContent).toContain('airport=EGLL');
    // The world finishes its approach behind the schematic: centred, at the
    // camera's ceiling.
    expect(deckCapture.props?.viewState.zoom).toBe(MAX_ZOOM);
    expect(deckCapture.props?.viewState.longitude).toBeCloseTo(HEATHROW.position[0], 4);
    // The world's controls are not reachable through the floor plan.
    expect(screen.queryByRole('button', { name: 'Globe' })).toBeNull();
  });

  it('stays on the world for an airport the player does not operate at', async () => {
    await renderWorld([
      `/world?lng=${String(CDG.position[0])}&lat=${String(CDG.position[1])}&z=11`,
    ]);

    zoomTo(CDG.position, MAX_ZOOM, true);
    await settle();

    expect(airportMap('LFPG')).toBeNull();
    expect(screen.getByTestId('world-band')).toHaveTextContent(/Close in/);
    expect(screen.getByTestId('address').textContent).not.toContain('airport=');
  });

  it('never hands off on a zoom out, however close in it stays', async () => {
    await renderWorld([
      `/world?lng=${String(HEATHROW.position[0])}&lat=${String(HEATHROW.position[1])}&z=12`,
    ]);

    zoomTo(HEATHROW.position, 11.8, true);
    await settle();

    expect(airportMap('EGLL')).toBeNull();
  });

  it('returns to the world centred on the airport, in the terminal area, on exit', async () => {
    await renderWorld([AT_HEATHROW]);
    zoomTo(HEATHROW.position, AIRPORT_HANDOFF_ZOOM + 0.2, true);
    await settle();

    fireEvent.click(screen.getByRole('button', { name: 'Back to the world' }));
    await finishAnimations();

    expect(airportMap('EGLL')).toBeNull();
    expect(screen.getByTestId('address').textContent).not.toContain('airport=');
    expect(deckCapture.props?.viewState.zoom).toBe(TERMINAL_EXIT_ZOOM);
    expect(deckCapture.props?.viewState.longitude).toBeCloseTo(HEATHROW.position[0], 4);
    expect(deckCapture.props?.viewState.latitude).toBeCloseTo(HEATHROW.position[1], 4);
    // Still saying where you are: the airport just left is the selection.
    expect(screen.getByTestId('panel-title')).toHaveTextContent('London Heathrow');
    // And the world's controls are back.
    expect(screen.getByRole('button', { name: 'Globe' })).toBeInTheDocument();
  });

  it('leaves the airport map on the browser’s back button', async () => {
    await renderWorld(['/fleet', AT_HEATHROW]);
    zoomTo(HEATHROW.position, AIRPORT_HANDOFF_ZOOM + 0.2, true);
    await settle();
    expect(airportMap('EGLL')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Browser back' }));
    await finishAnimations();

    // Back leaves the airport map, and only the airport map: still the world.
    expect(airportMap('EGLL')).toBeNull();
    expect(screen.getByTestId('address').textContent).toMatch(/^\/world/);
    expect(deckCapture.props?.viewState.zoom).toBe(TERMINAL_EXIT_ZOOM);
  });

  it('can be zoomed into again after leaving', async () => {
    await renderWorld([AT_HEATHROW]);
    zoomTo(HEATHROW.position, AIRPORT_HANDOFF_ZOOM + 0.2, true);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Back to the world' }));
    await finishAnimations();

    zoomTo(HEATHROW.position, AIRPORT_HANDOFF_ZOOM + 0.1, true);
    await settle();

    expect(airportMap('EGLL')).not.toBeNull();
  });
});

describe('entering an airport map on purpose', () => {
  beforeEach(() => {
    localStorage.setItem(WORLD_PROJECTION_STORAGE_KEY, 'flat');
  });

  it('opens any airport from its detail panel, operated or not', async () => {
    await renderWorld(['/world?at=LFPG']);
    await settle();
    expect(screen.getByTestId('panel-title')).toHaveTextContent('Paris Charles de Gaulle');
    expect(screen.getByTestId('panel-body')).toHaveTextContent(/You do not operate here yet/);

    fireEvent.click(screen.getByRole('button', { name: 'Open airport map' }));
    await settle();

    expect(airportMap('LFPG')).not.toBeNull();
    expect(screen.getByTestId('address').textContent).toContain('airport=LFPG');
    expect(deckCapture.props?.viewState.longitude).toBeCloseTo(CDG.position[0], 4);
  });

  it('opens straight from a link, and places the world on the airport behind it', async () => {
    await renderWorld(['/world?airport=EHAM']);
    await settle();

    expect(airportMap('EHAM')).not.toBeNull();
    expect(deckCapture.props?.viewState.longitude).toBeCloseTo(SCHIPHOL.position[0], 4);
    expect(deckCapture.props?.viewState.zoom).toBe(MAX_ZOOM);
  });

  it('opens straight from a link on the globe too: the schematic is the same either way', async () => {
    localStorage.setItem(WORLD_PROJECTION_STORAGE_KEY, 'globe');
    await renderWorld(['/world?airport=EHAM']);
    await settle();

    expect(airportMap('EHAM')).not.toBeNull();
  });

  it('leaves a linked airport map onto the world, not out of Tailfin', async () => {
    // Opened by a link from another page: there is no history entry of the
    // world's own to pop, so leaving rewrites the address instead of going back.
    await renderWorld(['/fleet', '/world?airport=EHAM']);
    await settle();

    fireEvent.click(screen.getByRole('button', { name: 'Back to the world' }));
    await finishAnimations();

    expect(airportMap('EHAM')).toBeNull();
    expect(screen.getByTestId('address').textContent).toMatch(/^\/world/);
    expect(screen.getByTestId('address').textContent).not.toContain('airport=');
    expect(deckCapture.props?.viewState.zoom).toBe(TERMINAL_EXIT_ZOOM);
    expect(deckCapture.props?.viewState.longitude).toBeCloseTo(SCHIPHOL.position[0], 4);
  });

  it('ignores a link to something that is not an airport code', async () => {
    await renderWorld(['/world?airport=..%2Fadmin']);
    await settle();

    expect(screen.queryByRole('region', { name: /Airport map/ })).toBeNull();
  });
});
