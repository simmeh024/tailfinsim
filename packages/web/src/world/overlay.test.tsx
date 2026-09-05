import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemeProvider } from '../theme/ThemeProvider';

import { WorldRenderer } from './WorldRenderer';

import type { Layer, MapViewState } from '@deck.gl/core';

/**
 * Three defects on the world map, none of which shared a cause (WORLD-01).
 *
 *   - The route shimmer travelled along routes that "My routes" had hidden.
 *   - "Open route planner" was a bare `<a href>` inside a single-page app.
 *   - Four surfaces were anchored to the same bottom-right corner, so they
 *     covered one another.
 *
 * The third is CSS, and CSS is not what jsdom measures — so what is asserted
 * here is the structure the CSS depends on: the transient surfaces are siblings
 * in one dock, which is what makes them stack instead of overlap.
 */

interface CapturedDeckProps {
  layers: (Layer | false)[];
  onError: () => void;
  onViewStateChange: (change: { viewState: MapViewState }) => void;
  _onMetrics: (metrics: { fps: number; framesRedrawn: number }) => void;
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
  tier: 'flagship',
};

vi.mock('./airports-api', () => ({
  fetchWorldAirports: () => Promise.resolve([HEATHROW]),
}));

/*
 * A hub and no traffic. `traffic` is deliberately empty: it is what starts the
 * animation loop, and none of these three tests needs a moving plane.
 */
vi.mock('./map-api', () => ({
  fetchWorldMap: () =>
    Promise.resolve({
      hubs: [{ position: [8.5622, 50.0379], icao: 'EDDF', name: 'Frankfurt' }],
      routes: [],
      traffic: [],
    }),
}));

const OWN_ROUTE = { id: 'own-1', source: [8.5622, 50.0379], target: [-0.4614, 51.4775] } as const;

/** Render the world at `/world`, with somewhere for a route link to go. */
async function renderWorld(): Promise<void> {
  render(
    <MemoryRouter initialEntries={['/world']}>
      <ThemeProvider>
        <Routes>
          <Route path="/world" element={<WorldRenderer routes={[OWN_ROUTE]} />} />
          {/* Not the words "Route planner": the panel's own eyebrow says that, and
              a query matching it would pass whether or not anything navigated. */}
          <Route path="/network" element={<p>The network page</p>} />
        </Routes>
      </ThemeProvider>
    </MemoryRouter>,
  );
  // The airports and the overlay both arrive from a promise.
  await act(async () => {
    await Promise.resolve();
  });
}

function layerIds(): string[] {
  return (deckCapture.props?.layers ?? [])
    .filter((layer): layer is Layer => Boolean(layer))
    .map((layer) => layer.id);
}

/** Open the airport panel the way a click does — through the layer's own handler. */
function clickAirport(): void {
  const airports = (deckCapture.props?.layers ?? []).find(
    (layer): layer is Layer => Boolean(layer) && layer.id === 'world-airports',
  );
  expect(airports).toBeDefined();
  const onClick = airports?.props.onClick as (info: { object: unknown }) => void;
  act(() => {
    onClick({ object: HEATHROW });
  });
}

beforeEach(() => {
  localStorage.clear();
  deckCapture.props = undefined;
});

describe('the route shimmer', () => {
  it('goes away with the routes it travels along', async () => {
    await renderWorld();
    expect(layerIds()).toContain('world-shimmer');

    fireEvent.click(screen.getByRole('button', { name: 'My routes' }));

    // The lines are gated on this flag too, so a shimmer that survived it would
    // be a bright trail sliding across an empty ocean.
    expect(layerIds()).not.toContain('world-routes');
    expect(layerIds()).not.toContain('world-shimmer');
  });
});

describe('leaving for the route planner', () => {
  it('navigates within the app instead of reloading it', async () => {
    await renderWorld();
    clickAirport();

    fireEvent.click(screen.getByRole('link', { name: 'Open route planner' }));

    // A bare `<a href>` would not move a MemoryRouter at all: the assertion that
    // this is a real client-side navigation is that the other route rendered.
    expect(screen.getByText('The network page')).toBeInTheDocument();
  });

  it('carries the airport it was opened from', async () => {
    await renderWorld();
    clickAirport();
    expect(screen.getByRole('link', { name: 'Open route planner' })).toHaveAttribute(
      'href',
      '/network?to=EGLL',
    );
  });
});

describe('the surfaces over the map', () => {
  it('puts the selection and the performance offer in one stack', async () => {
    await renderWorld();
    clickAirport();
    act(() => {
      for (let sample = 0; sample < 4; sample += 1) {
        deckCapture.props?._onMetrics({ fps: 40, framesRedrawn: 60 });
      }
    });

    const dock = document.querySelector('.world-renderer__dock');
    expect(dock).not.toBeNull();

    // Both in the dock, so the grid gives them a row each. While they were
    // separately anchored to `bottom right`, the offer landed underneath the
    // panel and the player could not read it.
    const panel = screen.getByRole('dialog', { name: 'Routes at London Heathrow' });
    const offer = screen.getByText(/Reduced detail is active/).closest('div');
    expect(dock?.contains(panel)).toBe(true);
    expect(dock?.contains(offer as Node)).toBe(true);
  });

  it('keeps the clock out of the corner the panels use', async () => {
    await renderWorld();
    clickAirport();

    const hud = document.querySelector('.world-renderer__hud');
    const dock = document.querySelector('.world-renderer__dock');
    const clock = document.querySelector('.world-clock');

    // The clock renders only once the world's time has synced, which needs a
    // founded airline; when it is there it belongs to the HUD, never the dock.
    expect(hud).not.toBeNull();
    if (clock !== null) expect(dock?.contains(clock)).toBe(false);
    expect(hud?.contains(dock as Node)).toBe(true);
  });

  /*
   * The stylesheet, read as text.
   *
   * jsdom loads no stylesheet, so `getComputedStyle` here would report the
   * initial value for every property and any assertion against it would pass
   * whatever the CSS said. The two rules that actually matter are worth a guard
   * anyway, so they get one in the style of `theme/tokens.test.ts`: the file is
   * the artefact, so the file is what is checked.
   */
  const shellCss = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'shell', 'shell.css'),
    'utf8',
  );

  function block(selector: string): string {
    const start = shellCss.indexOf(`${selector} {`);
    expect(start, `${selector} is missing from shell.css`).toBeGreaterThan(-1);
    return shellCss.slice(start, shellCss.indexOf('}', start));
  }

  it('lets the map through the gaps between them', () => {
    // The HUD covers the whole stage. Without this the map could not be dragged
    // at all — a hazard the six separately-anchored boxes did not have, and the
    // one thing a full-bleed grid introduces.
    expect(block('.world-renderer__hud')).toContain('pointer-events: none');
    expect(block('.world-renderer__hud > *')).toContain('pointer-events: auto');
  });

  it('no longer anchors anything to a corner of its own', () => {
    // Each of these used to carry `position: absolute` with its own `bottom` and
    // `right`, which is how four of them ended up in the same place.
    for (const selector of [
      '.world-clock',
      '.world-renderer__controls',
      '.world-renderer__legend',
      '.world-renderer__route-panel',
    ]) {
      expect(block(selector), selector).not.toContain('position: absolute');
    }
  });
});
