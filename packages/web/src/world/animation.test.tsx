import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemeProvider } from '../theme/ThemeProvider';

import { WORLD_PROJECTION_STORAGE_KEY } from './projection';
import { WorldRenderer } from './WorldRenderer';

import type { WorldRoute } from './layers';

/**
 * The map animates what is on screen, and nothing else (WORLD-02).
 *
 * The loop used to be gated on `map.traffic.length > 0` — *the world* having any
 * active route, including every NPC's. What the phase actually drives is
 * narrower: planes filtered by the ownership toggles, and a shimmer that needs
 * the player's own routes to be drawn. Both default to your own work only, and
 * `Rivals` starts off — so a player who had founded an airline but not opened a
 * route ran a sixty-times-a-second state update producing nothing at all.
 */

vi.mock('@deck.gl/react', () => ({ default: () => null }));

vi.mock('./airports-api', () => ({ fetchWorldAirports: () => Promise.resolve([]) }));

/** One NPC route in the world, and nothing of the player's. */
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

vi.mock('./map-api', () => ({
  fetchWorldMap: () => Promise.resolve({ hubs: [], routes: [], traffic: [RIVAL] }),
}));

const OWN_ROUTE: WorldRoute = {
  id: 'own-1',
  source: [8.5622, 50.0379],
  target: [-0.4614, 51.4775],
};

let frames: ReturnType<typeof vi.fn>;
let cancels: ReturnType<typeof vi.fn>;

/**
 * Count frame requests without letting any of them run.
 *
 * A real loop would schedule the next frame from inside the callback, so a live
 * `requestAnimationFrame` turns "did it start" into a race against the timer.
 * The stub records the request and never calls back, which makes the count
 * exactly "how many times did the effect decide to animate".
 */
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(WORLD_PROJECTION_STORAGE_KEY, 'flat');
  frames = vi.fn(() => 1);
  cancels = vi.fn();
  vi.stubGlobal('requestAnimationFrame', frames);
  vi.stubGlobal('cancelAnimationFrame', cancels);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function renderWorld(routes: WorldRoute[]): Promise<void> {
  render(
    <MemoryRouter>
      <ThemeProvider>
        <WorldRenderer routes={routes} />
      </ThemeProvider>
    </MemoryRouter>,
  );
  await act(async () => {
    await Promise.resolve();
  });
}

describe('a world with traffic the player cannot see', () => {
  it('does not animate at all', async () => {
    // The world has an active route. The player has none, and `Rivals` is off,
    // so nothing on this screen moves — and nothing should be asked to.
    await renderWorld([]);
    expect(frames).not.toHaveBeenCalled();
  });

  it('starts as soon as the rivals are shown', async () => {
    await renderWorld([]);
    frames.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'Rivals' }));

    // Measured across the click. A gate that was already running would request
    // no *new* frame here, which is exactly the state this is distinguishing.
    expect(frames).toHaveBeenCalled();
  });
});

describe("a world with the player's own routes", () => {
  it('animates them', async () => {
    await renderWorld([OWN_ROUTE]);
    expect(frames).toHaveBeenCalled();
  });

  it('stops when their layer is turned off', async () => {
    await renderWorld([OWN_ROUTE]);
    frames.mockClear();
    cancels.mockClear();

    // "My routes" hides the player's lines, their planes and (since WORLD-01)
    // the shimmer. With the rivals still hidden that leaves nothing moving.
    fireEvent.click(screen.getByRole('button', { name: 'My routes' }));

    // The cancellation is the half that proves it *stopped*. Not requesting a
    // new frame is also true of a loop that simply carried on running, because
    // this stub never calls back to schedule the next one.
    expect(cancels).toHaveBeenCalled();
    expect(frames).not.toHaveBeenCalled();
  });

  it('picks up again when it comes back', async () => {
    await renderWorld([OWN_ROUTE]);
    fireEvent.click(screen.getByRole('button', { name: 'My routes' }));
    frames.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'My routes' }));
    expect(frames).toHaveBeenCalled();
  });
});

describe('a reader who has asked for less motion', () => {
  it('is not animated for, whatever is on the map', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));

    await renderWorld([OWN_ROUTE]);

    expect(frames).not.toHaveBeenCalled();
  });
});
