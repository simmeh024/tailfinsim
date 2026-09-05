import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ContextPanelProbe } from '../shell/test-context-panel';
import { ThemeProvider } from '../theme/ThemeProvider';

import { flightProgress, planesForFlights } from './flight';
import { WORLD_PROJECTION_STORAGE_KEY } from './projection';
import { departureDelay, minutesBetween } from './SelectionDetail';
import { WorldRenderer } from './WorldRenderer';

import type { WorldMapFlight } from './map-api';
import type { Layer } from '@deck.gl/core';

/**
 * The aeroplanes are flights now (WORLD-10).
 *
 * They used to be decoration: one per *active route* in the world, riding a
 * looping animation phase, whether or not an aeroplane was flying that leg — or
 * ever had. `flight.ts` said so in its own header. `readWorldMap` selected from
 * `route` and never touched `flight`, while `flight` has carried `phase`,
 * `actual_departure`, `estimated_arrival` and `actual_arrival` all along.
 */

const LEG = {
  source: [8.5622, 50.0379] as [number, number],
  target: [-0.4614, 51.4775] as [number, number],
};

const AIRBORNE: WorldMapFlight = {
  id: 'flight-1',
  ...LEG,
  originIcao: 'EDDF',
  destinationIcao: 'EGLL',
  originName: 'Frankfurt',
  destinationName: 'London Heathrow',
  airlineId: 'own',
  airlineName: 'Mine',
  own: true,
  colour: '#336699',
  registration: 'D-AIRV',
  typeDesignation: 'A320',
  scheduledDeparture: '2024-10-01T08:00:00.000Z',
  departedAt: '2024-10-01T08:20:00.000Z',
  arrivesAt: '2024-10-01T10:20:00.000Z',
};

describe('how far along a flight is', () => {
  it('is measured between the two instants the server sent', () => {
    expect(flightProgress(AIRBORNE, new Date('2024-10-01T09:20:00.000Z'))).toBeCloseTo(0.5, 3);
  });

  it('holds at the gate before it left', () => {
    // A second either side of a clock resync would otherwise put an aeroplane
    // behind its own departure airport.
    expect(flightProgress(AIRBORNE, new Date('2024-10-01T08:00:00.000Z'))).toBe(0);
  });

  it('holds at the destination once it is overdue', () => {
    // Past the estimate and not landed. The honest place to draw that is at the
    // airport it is trying to reach, not somewhere out beyond it.
    expect(flightProgress(AIRBORNE, new Date('2024-10-01T12:00:00.000Z'))).toBe(1);
  });

  it('does not divide by a leg with no duration', () => {
    const instant = { ...AIRBORNE, arrivesAt: AIRBORNE.departedAt };
    expect(flightProgress(instant, new Date('2024-10-01T09:00:00.000Z'))).toBe(1);
  });
});

describe('placing the aeroplanes', () => {
  it('puts each one at its own progress rather than a shared phase', () => {
    const early = { ...AIRBORNE, id: 'a' };
    const late = {
      ...AIRBORNE,
      id: 'b',
      departedAt: '2024-10-01T07:00:00.000Z',
      arrivesAt: '2024-10-01T09:00:00.000Z',
    };

    // The *same* seed for both, so they ride the identical track and the only
    // thing that can separate them is their own progress. Seeding them apart
    // would let a shared-phase implementation pass on the seeded wander alone.
    const [first, second] = planesForFlights(
      [early, late],
      new Date('2024-10-01T08:50:00.000Z'),
      () => 'one-track',
    );

    // `early` is half an hour into a two-hour leg; `late` is fifty minutes from
    // the end of its own. They cannot be in the same place.
    expect(first?.position[0]).not.toBeCloseTo(second?.position[0] ?? 0, 2);
  });

  it('rides the seeded track the map drew for that route', () => {
    // The route line has its own seeded wander. A plane on a clean great circle
    // would visibly float beside its own line.
    const onRoute = planesForFlights([AIRBORNE], new Date('2024-10-01T09:20:00.000Z'), () => 'r-1');
    const onLeg = planesForFlights(
      [AIRBORNE],
      new Date('2024-10-01T09:20:00.000Z'),
      () => 'EDDF-EGLL',
    );
    expect(onRoute[0]?.position).not.toEqual(onLeg[0]?.position);
  });

  it('names the flight, so a click resolves to it', () => {
    expect(planesForFlights([AIRBORNE], new Date(), (f) => f.id)[0]?.sourceId).toBe('flight-1');
  });
});

describe('the delay a card reports', () => {
  it('is the difference between the two departures', () => {
    expect(minutesBetween(AIRBORNE.scheduledDeparture, AIRBORNE.departedAt)).toBe(20);
    expect(departureDelay(AIRBORNE)).toBe('Left 20 min late.');
  });

  it('says nothing at all about a punctual flight', () => {
    // A card that reads "0 min late" on every punctual flight teaches a player
    // to stop reading it.
    expect(departureDelay({ ...AIRBORNE, departedAt: AIRBORNE.scheduledDeparture })).toBeNull();
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

vi.mock('./airports-api', () => ({ fetchWorldAirports: () => Promise.resolve([]) }));

const world = vi.hoisted(() => ({
  flights: [] as unknown[],
  traffic: [] as unknown[],
}));

vi.mock('./map-api', () => ({
  fetchWorldMap: () =>
    Promise.resolve({ hubs: [], routes: [], traffic: world.traffic, flights: world.flights }),
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

function drawn(): Layer[] {
  return (deckCapture.props?.layers ?? []).filter((layer): layer is Layer => layer !== false);
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(WORLD_PROJECTION_STORAGE_KEY, 'flat');
  deckCapture.props = undefined;
  world.flights = [AIRBORNE];
  world.traffic = [];
});

describe('the map', () => {
  it('draws an aeroplane for a flight in the air', async () => {
    await renderWorld();
    expect(drawn().map((layer) => layer.id)).toContain('world-planes');
  });

  it('draws none at all when nothing has departed', async () => {
    // Which is the permanent state of a node with no worker: schedules are never
    // materialised and nothing ever departs.
    world.flights = [];
    await renderWorld();
    expect(drawn().map((layer) => layer.id)).not.toContain('world-planes');
  });

  it('says why the sky is empty over a drawn network', async () => {
    world.flights = [];
    world.traffic = [
      {
        id: 'r-1',
        ...LEG,
        originIcao: 'EDDF',
        destinationIcao: 'EGLL',
        originName: 'Frankfurt',
        destinationName: 'London Heathrow',
        airlineId: 'own',
        airlineName: 'Mine',
        own: true,
        colour: '#336699',
      },
    ];
    await renderWorld();

    fireEvent.click(screen.getByRole('button', { name: 'Places' }));

    // An empty sky over drawn routes reads as a broken map rather than as a
    // world where nothing is flying — the same trap as "ticks: 0, errors: 0".
    expect(screen.getByText(/No aircraft airborne/)).toBeInTheDocument();
  });

  it('shows the aeroplane, the times and the delay when one is selected', async () => {
    await renderWorld();

    const planes = drawn().find((layer) => layer.id === 'world-planes');
    const onClick = planes?.props.onClick as (info: { object: unknown }) => void;
    act(() => {
      onClick({ object: { sourceId: 'flight-1' } });
    });

    const body = screen.getByTestId('panel-body');
    expect(screen.getByTestId('panel-title')).toHaveTextContent('Your flight');
    expect(screen.getByTestId('panel-subtitle')).toHaveTextContent('EDDF → EGLL');
    expect(body).toHaveTextContent('D-AIRV');
    expect(body).toHaveTextContent('A320');
    expect(body).toHaveTextContent('Left 20 min late.');
  });
});
