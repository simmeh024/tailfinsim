import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemeProvider } from '../theme/ThemeProvider';

import { WORLD_PROJECTION_STORAGE_KEY } from './projection';
import {
  cameraFromSearch,
  cameraSearch,
  icaoFromSearch,
  persistView,
  readStoredView,
  sameCamera,
  WORLD_VIEW_STORAGE_KEY,
} from './view-state';
import { WorldRenderer } from './WorldRenderer';

import type { WorldLayerVisibility } from './layers';
import type { MapViewState } from '@deck.gl/core';

/**
 * The map remembers where you were, and can be linked to (WORLD-05).
 *
 * It used to remember exactly one thing: globe-or-flat. The camera and all
 * seven layer toggles were plain state with a constant default, so setting the
 * map up the way you wanted it and stepping away to the Fleet page for ten
 * seconds threw the lot away. And `/world` was `/world` whether you were looking
 * at the whole planet or at one apron.
 */

const DEFAULTS: WorldLayerVisibility = {
  graticule: true,
  routes: true,
  terminator: true,
  borders: true,
  terrain: true,
  airports: true,
};

describe('what was stored', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('is nothing at all for a first visit', () => {
    // Empty rather than a filled-in default: the caller then falls back to its
    // own constants, and there is one place deciding what "unset" looks like.
    expect(readStoredView(DEFAULTS)).toEqual({});
  });

  it('comes back the way it went in', () => {
    persistView({
      longitude: 8.5,
      latitude: 50,
      zoom: 6,
      visibility: { ...DEFAULTS, terrain: false },
      rivals: true,
      legend: true,
    });

    expect(readStoredView(DEFAULTS)).toEqual({
      longitude: 8.5,
      latitude: 50,
      zoom: 6,
      visibility: { ...DEFAULTS, terrain: false },
      rivals: true,
      legend: true,
    });
  });

  it('fills in a layer a previous build had never heard of', () => {
    // The blob was written by an older bundle. A missing key would render as
    // "off", which reads as a layer that has stopped working rather than as one
    // that did not exist when this was saved.
    localStorage.setItem(
      WORLD_VIEW_STORAGE_KEY,
      JSON.stringify({ visibility: { terrain: false }, longitude: 1, latitude: 2, zoom: 3 }),
    );

    expect(readStoredView(DEFAULTS).visibility).toEqual({ ...DEFAULTS, terrain: false });
  });

  it('ignores a camera that is not three numbers', () => {
    // Two of them describe a place the camera cannot be put.
    localStorage.setItem(WORLD_VIEW_STORAGE_KEY, JSON.stringify({ longitude: 1, latitude: 2 }));
    expect(readStoredView(DEFAULTS).zoom).toBeUndefined();
    expect(readStoredView(DEFAULTS).longitude).toBeUndefined();
  });

  it('survives a store holding something that is not JSON', () => {
    localStorage.setItem(WORLD_VIEW_STORAGE_KEY, 'not json {');
    expect(readStoredView(DEFAULTS)).toEqual({});
  });
});

describe('a camera in a link', () => {
  it('needs all three parameters', () => {
    expect(cameraFromSearch(new URLSearchParams('lng=8&lat=50&z=6'))).toEqual({
      longitude: 8,
      latitude: 50,
      zoom: 6,
    });
    // Filling the third in from wherever the map happened to be is worse than
    // ignoring an incomplete link.
    expect(cameraFromSearch(new URLSearchParams('lng=8&lat=50'))).toBeNull();
    expect(cameraFromSearch(new URLSearchParams('lng=8&lat=fifty&z=6'))).toBeNull();
  });

  it('is written legibly enough to edit by hand', () => {
    expect(cameraSearch({ longitude: 8.56221234, latitude: 50.03791234, zoom: 6.123 })).toEqual({
      lng: '8.5622',
      lat: '50.0379',
      z: '6.12',
    });
  });

  it('knows when the camera has not really moved', () => {
    const a = { longitude: 8.56221, latitude: 50, zoom: 6 };
    expect(sameCamera(a, { ...a, longitude: 8.562212 })).toBe(true);
    expect(sameCamera(a, { ...a, longitude: 8.6 })).toBe(false);
  });

  it('reads an airport code, and only a plausible one', () => {
    expect(icaoFromSearch(new URLSearchParams('at=egll'))).toBe('EGLL');
    expect(icaoFromSearch(new URLSearchParams('at=LHR'))).toBe('LHR');
    expect(icaoFromSearch(new URLSearchParams('at=..%2Fetc'))).toBeNull();
    expect(icaoFromSearch(new URLSearchParams(''))).toBeNull();
  });
});

// --------------------------------------------------------------- the renderer

interface CapturedDeckProps {
  viewState: MapViewState;
  onViewStateChange: (change: { viewState: MapViewState }) => void;
}

const deckCapture = vi.hoisted(() => ({ props: undefined as CapturedDeckProps | undefined }));

vi.mock('@deck.gl/react', () => ({
  default: (props: CapturedDeckProps) => {
    deckCapture.props = props;
    return null;
  },
}));

const HEATHROW = {
  position: [-0.4614, 51.4775] as [number, number],
  name: 'London Heathrow',
  icao: 'EGLL',
  iata: 'LHR',
  tier: 'flagship',
};

vi.mock('./airports-api', () => ({ fetchWorldAirports: () => Promise.resolve([HEATHROW]) }));

/** A hub in Frankfurt, so WORLD-04's fit has something to prefer. */
vi.mock('./map-api', () => ({
  fetchWorldMap: () =>
    Promise.resolve({
      hubs: [{ position: [8.5622, 50.0379], icao: 'EDDF', name: 'Frankfurt' }],
      routes: [],
      traffic: [],
    }),
}));

function Address(): React.ReactElement {
  const location = useLocation();
  return <span data-testid="address">{location.search}</span>;
}

async function renderWorld(entry = '/world'): Promise<void> {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <ThemeProvider>
        <Address />
        <Routes>
          <Route path="/world" element={<WorldRenderer />} />
        </Routes>
      </ThemeProvider>
    </MemoryRouter>,
  );
  await act(async () => {
    await Promise.resolve();
  });
}

describe('opening the map', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    localStorage.clear();
    localStorage.setItem(WORLD_PROJECTION_STORAGE_KEY, 'flat');
    deckCapture.props = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('restores the camera and the toggles it was left with', async () => {
    persistView({
      longitude: -74,
      latitude: 40.7,
      zoom: 7,
      visibility: { ...DEFAULTS, terrain: false },
      rivals: true,
      legend: false,
    });

    await renderWorld();

    expect(deckCapture.props?.viewState).toMatchObject({
      longitude: -74,
      latitude: 40.7,
      zoom: 7,
    });
    expect(screen.getByRole('button', { name: 'Terrain' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.getByRole('button', { name: 'Rivals' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('lets a remembered camera beat the network fit', async () => {
    // The hub is in Frankfurt. A player who left the map over New York meant to
    // leave it over New York.
    persistView({
      longitude: -74,
      latitude: 40.7,
      zoom: 7,
      visibility: DEFAULTS,
      rivals: false,
      legend: false,
    });

    await renderWorld();

    expect(deckCapture.props?.viewState.longitude).toBeCloseTo(-74, 1);
  });

  it('lets a link beat both', async () => {
    persistView({
      longitude: -74,
      latitude: 40.7,
      zoom: 7,
      visibility: DEFAULTS,
      rivals: false,
      legend: false,
    });

    await renderWorld('/world?lng=139.7&lat=35.6&z=8');

    // Somebody who sends you a view of Tokyo means for you to arrive at Tokyo.
    expect(deckCapture.props?.viewState).toMatchObject({
      longitude: 139.7,
      latitude: 35.6,
      zoom: 8,
    });
  });

  it('flies to an airport named by code, and selects it', async () => {
    await renderWorld('/world?at=EGLL');

    expect(deckCapture.props?.viewState.longitude).toBeCloseTo(-0.4614, 3);
    expect(deckCapture.props?.viewState.zoom).toBeGreaterThanOrEqual(6);
    expect(screen.getByRole('dialog', { name: 'Routes at London Heathrow' })).toBeInTheDocument();
  });
});

describe('as the map is used', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    localStorage.clear();
    localStorage.setItem(WORLD_PROJECTION_STORAGE_KEY, 'flat');
    deckCapture.props = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes the camera into the address bar', async () => {
    await renderWorld();

    act(() => {
      deckCapture.props?.onViewStateChange({
        viewState: { longitude: 139.7, latitude: 35.6, zoom: 8, pitch: 0, bearing: 0 },
      });
    });
    // Debounced: both halves run on a value that changes on every frame of a
    // drag, and `localStorage` is synchronous.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });

    expect(screen.getByTestId('address').textContent).toContain('lng=139.7');
    expect(screen.getByTestId('address').textContent).toContain('z=8');
  });

  it('remembers a layer the moment it is toggled', async () => {
    await renderWorld();

    fireEvent.click(screen.getByRole('button', { name: 'Terrain' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });

    expect(readStoredView(DEFAULTS).visibility?.terrain).toBe(false);
  });

  it('does not write until the camera settles', async () => {
    await renderWorld();

    act(() => {
      deckCapture.props?.onViewStateChange({
        viewState: { longitude: 100, latitude: 10, zoom: 4, pitch: 0, bearing: 0 },
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    // Still mid-drag. A write per frame is what the debounce exists to avoid.
    expect(screen.getByTestId('address').textContent).not.toContain('lng=100');
  });
});
