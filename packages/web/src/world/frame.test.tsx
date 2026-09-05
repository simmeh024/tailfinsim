import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemeProvider } from '../theme/ThemeProvider';

import { frameOf, networkPoints } from './frame';
import { WORLD_PROJECTION_STORAGE_KEY } from './projection';
import { WorldRenderer } from './WorldRenderer';

import type { LngLat } from './terminator';
import type { MapViewState } from '@deck.gl/core';

/**
 * The map opens on the player's own network (WORLD-04).
 *
 * `INITIAL_VIEW_STATE` was longitude 8, latitude 24 — the western Sahara — at a
 * whole-globe zoom, for everybody, on every visit. Nothing ever moved the camera
 * except the user, so a player whose whole network is in North America landed on
 * West Africa and dragged, every single time.
 */

const FRANKFURT: LngLat = [8.5622, 50.0379];
const HEATHROW: LngLat = [-0.4614, 51.4775];
const AUCKLAND: LngLat = [174.792, -37.008];
const LOS_ANGELES: LngLat = [-118.408, 33.9425];

describe('framing a set of points', () => {
  it('has no opinion about a player with no network', () => {
    // Not a default: a new player should still meet the whole world, and that
    // decision belongs to the caller rather than to the arithmetic.
    expect(frameOf([])).toBeNull();
  });

  it('centres between two airports and zooms in to hold them', () => {
    const frame = frameOf([FRANKFURT, HEATHROW]);
    expect(frame?.longitude).toBeCloseTo(4.05, 1);
    expect(frame?.latitude).toBeCloseTo(50.76, 1);
    // The whole-globe default is 0.35. Anything near it would mean the fit had
    // not happened.
    expect(frame?.zoom).toBeGreaterThan(4);
  });

  it('frames the Pacific rather than the Atlantic for a network across the date line', () => {
    // Auckland is near +180 and Los Angeles near −180. A plain min/max reads
    // that as a span of nearly the whole planet and centres on the empty half.
    const frame = frameOf([AUCKLAND, LOS_ANGELES]);
    expect(Math.abs(frame?.longitude ?? 0)).toBeGreaterThan(140);
    expect(frame?.zoom).toBeGreaterThan(0.35);
  });

  it('gives a lone hub a city-sized view rather than an infinite zoom', () => {
    // A single point has no span, and the fit equation divides by it.
    const frame = frameOf([FRANKFURT]);
    expect(frame).toMatchObject({ longitude: 8.5622, latitude: 50.0379, zoom: 5 });
  });

  it('takes whichever of the two dimensions is tighter', () => {
    // A network 4° wide and 40° tall must be framed by its height, or the top
    // and bottom of it fall off the canvas.
    const tall = frameOf([
      [0, 0],
      [4, 40],
    ]);
    const wide = frameOf([
      [0, 0],
      [40, 4],
    ]);
    expect(tall?.zoom).toBeLessThan(wide?.zoom ?? 0);
  });

  it('measures against the canvas it is given', () => {
    const narrow = frameOf([FRANKFURT, HEATHROW], { width: 400, height: 800 });
    const wide = frameOf([FRANKFURT, HEATHROW], { width: 2000, height: 800 });
    // The same network in a wider window can be held at a closer zoom.
    expect(wide?.zoom).toBeGreaterThan(narrow?.zoom ?? 0);
  });

  it('falls back to a reference canvas before deck.gl has measured one', () => {
    // The fit runs as soon as the overlay arrives, which can be before deck has
    // reported a viewport. Waiting would leave the player on the Sahara for
    // exactly as long as that took.
    expect(frameOf([FRANKFURT, HEATHROW], { width: 0, height: 0 })).toEqual(
      frameOf([FRANKFURT, HEATHROW]),
    );
  });
});

describe('the points a network puts on the map', () => {
  it('takes both ends of every route as well as the hubs', () => {
    expect(
      networkPoints([{ position: FRANKFURT }], [{ source: FRANKFURT, target: HEATHROW }]),
    ).toEqual([FRANKFURT, FRANKFURT, HEATHROW]);
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

vi.mock('./airports-api', () => ({ fetchWorldAirports: () => Promise.resolve([]) }));

const network = vi.hoisted(() => ({
  hubs: [{ position: [8.5622, 50.0379], icao: 'EDDF', name: 'Frankfurt' }],
  routes: [
    {
      id: 'r1',
      source: [8.5622, 50.0379],
      target: [-0.4614, 51.4775],
      originIcao: 'EDDF',
      destinationIcao: 'EGLL',
      originName: 'Frankfurt',
      destinationName: 'London Heathrow',
    },
  ],
  traffic: [],
}));

vi.mock('./map-api', () => ({
  fetchWorldMap: () => Promise.resolve({ ...network }),
}));

async function renderWorld(): Promise<void> {
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
}

describe('opening the World page', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(WORLD_PROJECTION_STORAGE_KEY, 'flat');
    deckCapture.props = undefined;
    network.hubs = [{ position: [8.5622, 50.0379], icao: 'EDDF', name: 'Frankfurt' }];
  });

  it('frames the network instead of the Sahara', async () => {
    await renderWorld();

    const view = deckCapture.props?.viewState;
    expect(view?.longitude).toBeCloseTo(4.05, 1);
    // 8 / 24 / 0.35 is the old constant, and what a failure here looks like.
    expect(view?.latitude).toBeGreaterThan(45);
    expect(view?.zoom).toBeGreaterThan(4);
  });

  it('leaves a player with no network looking at the whole world', async () => {
    network.hubs = [];
    network.routes = [];
    await renderWorld();

    expect(deckCapture.props?.viewState).toMatchObject({
      longitude: 8,
      latitude: 24,
      zoom: 0.35,
    });
    network.routes = [
      {
        id: 'r1',
        source: [8.5622, 50.0379],
        target: [-0.4614, 51.4775],
        originIcao: 'EDDF',
        destinationIcao: 'EGLL',
        originName: 'Frankfurt',
        destinationName: 'London Heathrow',
      },
    ];
  });

  it('does not drag the camera back once the player has moved it', async () => {
    await renderWorld();

    act(() => {
      deckCapture.props?.onViewStateChange({
        viewState: { longitude: -70, latitude: 40, zoom: 6, pitch: 0, bearing: 0 },
      });
    });
    // Any re-render would re-run the effect; the frame must happen once.
    fireEvent.click(screen.getByRole('button', { name: 'Terrain' }));

    expect(deckCapture.props?.viewState).toMatchObject({ longitude: -70, latitude: 40 });
  });

  it('goes back to the network when asked', async () => {
    await renderWorld();
    act(() => {
      deckCapture.props?.onViewStateChange({
        viewState: { longitude: -70, latitude: 40, zoom: 6, pitch: 0, bearing: 0 },
      });
    });

    fireEvent.click(screen.getByRole('button', { name: 'Recentre' }));

    expect(deckCapture.props?.viewState.longitude).toBeCloseTo(4.05, 1);
    // Animated, so it reads as the camera travelling rather than the map being
    // replaced. `clampViewState` carries a transition through deliberately.
    expect(deckCapture.props?.viewState.transitionDuration).toBe(700);
  });
});
