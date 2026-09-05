import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ContextPanelProbe } from '../shell/test-context-panel';
import { ThemeProvider } from '../theme/ThemeProvider';

import { WORLD_PROJECTION_STORAGE_KEY } from './projection';
import { WorldRenderer } from './WorldRenderer';

import type { WorldAirport, WorldRoute } from './layers';
import type { Layer } from '@deck.gl/core';

/**
 * A selection on the map goes to the context panel (WORLD-07).
 *
 * The World page was the one surface in Tailfin that answered a selection with
 * a `role="dialog"` floating over its own bottom-right corner. Crew, the
 * aircraft marketplace, the livery studio and the route planner all publish
 * through `useContextSelection` — and App. H.4 asks for a context panel *"that
 * never covers the world"*, which this page then covered the world with.
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

const FRANKFURT: WorldAirport = {
  position: [8.5622, 50.0379],
  name: 'Frankfurt',
  icao: 'EDDF',
  iata: 'FRA',
  tier: 'flagship',
};

vi.mock('./airports-api', () => ({
  fetchWorldAirports: () => Promise.resolve([HEATHROW, FRANKFURT]),
}));

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

/** A hub at Frankfurt and one route of the player's own, EDDF→EGLL. */
vi.mock('./map-api', () => ({
  fetchWorldMap: () =>
    Promise.resolve({
      hubs: [{ position: [8.5622, 50.0379], icao: 'EDDF', name: 'Frankfurt' }],
      routes: [
        {
          id: 'own-1',
          source: [8.5622, 50.0379],
          target: [-0.4614, 51.4775],
          originIcao: 'EDDF',
          destinationIcao: 'EGLL',
          originName: 'Frankfurt',
          destinationName: 'London Heathrow',
        },
      ],
      traffic: [RIVAL],
    }),
}));

const OWN_ROUTE: WorldRoute = {
  id: 'own-1',
  source: [8.5622, 50.0379],
  target: [-0.4614, 51.4775],
};

function drawn(): Layer[] {
  return (deckCapture.props?.layers ?? []).filter((layer): layer is Layer => layer !== false);
}

function clickAirport(airport: WorldAirport): void {
  const layer = drawn().find((entry) => entry.id === 'world-airports');
  expect(layer, 'the airport layer is not on the map').toBeDefined();
  const onClick = layer?.props.onClick as (info: { object: unknown }) => void;
  act(() => {
    onClick({ object: airport });
  });
}

async function renderWorld(): Promise<void> {
  render(
    <MemoryRouter>
      <ThemeProvider>
        <ContextPanelProbe>
          <WorldRenderer routes={[OWN_ROUTE]} />
        </ContextPanelProbe>
      </ThemeProvider>
    </MemoryRouter>,
  );
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(WORLD_PROJECTION_STORAGE_KEY, 'flat');
  deckCapture.props = undefined;
});

describe('selecting an airport', () => {
  it('names it in the panel, with both codes', async () => {
    await renderWorld();
    clickAirport(HEATHROW);

    expect(screen.getByTestId('panel-title')).toHaveTextContent('London Heathrow');
    expect(screen.getByTestId('panel-subtitle')).toHaveTextContent('EGLL · LHR');
  });

  it('says when it is one of the player’s own hubs', async () => {
    await renderWorld();
    clickAirport(FRANKFURT);

    expect(screen.getByTestId('panel-subtitle')).toHaveTextContent('Your hub');
    expect(screen.getByTestId('panel-body')).toHaveTextContent('One of your hubs.');
  });

  it('lists the routes already running through it', async () => {
    await renderWorld();
    clickAirport(HEATHROW);

    const body = screen.getByTestId('panel-body');
    expect(body).toHaveTextContent('Frankfurt');
    expect(body).toHaveTextContent('EDDF');
  });

  it('offers the route planner, still as a router link', async () => {
    await renderWorld();
    clickAirport(HEATHROW);

    expect(screen.getByRole('link', { name: 'Open route planner' })).toHaveAttribute(
      'href',
      '/network?to=EGLL',
    );
  });

  it('replaces one selection with the next rather than stacking them', async () => {
    await renderWorld();
    clickAirport(HEATHROW);
    clickAirport(FRANKFURT);

    // Asserted on the subtitle rather than on the page: Frankfurt is a hub with
    // a route *to* London Heathrow, so the name is legitimately still on screen
    // in the route list — a `queryByText` here would fail on correct behaviour.
    expect(screen.getByTestId('panel-title')).toHaveTextContent('Frankfurt');
    expect(screen.getByTestId('panel-subtitle')).toHaveTextContent('EDDF · FRA');
    expect(screen.getByTestId('panel-subtitle')).not.toHaveTextContent('LHR');
  });
});

describe('dismissing from the panel', () => {
  it('clears the map’s own idea of what is selected', async () => {
    // `onClear` exists for exactly this: the shell owns the dismissal, and the
    // page has to hear about it or its next click on the same airport does
    // nothing at all.
    await renderWorld();
    clickAirport(HEATHROW);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss panel' }));
    expect(screen.getByTestId('panel-title')).toHaveTextContent('Context');

    clickAirport(HEATHROW);
    expect(screen.getByTestId('panel-title')).toHaveTextContent('London Heathrow');
  });
});

describe('selecting a flight', () => {
  it('names the carrier and the leg', async () => {
    await renderWorld();
    fireEvent.click(screen.getByRole('button', { name: 'Rivals' }));

    const planes = drawn().find((entry) => entry.id === 'world-planes');
    expect(planes, 'the plane layer is not on the map').toBeDefined();
    const onClick = planes?.props.onClick as (info: { object: unknown }) => void;
    act(() => {
      onClick({ object: { sourceId: 'npc-1' } });
    });

    expect(screen.getByTestId('panel-title')).toHaveTextContent('Rival Air');
    expect(screen.getByTestId('panel-subtitle')).toHaveTextContent('EDDF → EGLL');
  });
});

describe('leaving the World page', () => {
  it('takes its selection with it', async () => {
    // A selection outlives the route that made it unless somebody clears it,
    // and an airport shown while the player is looking at their fleet is worse
    // than an empty panel.
    const view = render(
      <MemoryRouter>
        <ThemeProvider>
          <ContextPanelProbe>
            <WorldRenderer routes={[OWN_ROUTE]} />
          </ContextPanelProbe>
        </ThemeProvider>
      </MemoryRouter>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    clickAirport(HEATHROW);
    expect(screen.getByTestId('panel-title')).toHaveTextContent('London Heathrow');

    view.rerender(
      <MemoryRouter>
        <ThemeProvider>
          <ContextPanelProbe>
            <p>Somewhere else</p>
          </ContextPanelProbe>
        </ThemeProvider>
      </MemoryRouter>,
    );

    expect(screen.getByTestId('panel-title')).toHaveTextContent('Context');
  });
});
