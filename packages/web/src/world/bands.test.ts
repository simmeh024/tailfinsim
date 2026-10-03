import { describe, expect, it } from 'vitest';

import {
  AIRPORT_HANDOFF_ZOOM,
  airportMapFromSearch,
  bandForZoom,
  bandHint,
  HANDOFF_RADIUS_PX,
  handoffTarget,
  operatedAirportIcaos,
  REGION_FROM_ZOOM,
  screenDistancePx,
  TERMINAL_EXIT_ZOOM,
  TERMINAL_FROM_ZOOM,
  ZOOM_BANDS,
  type HandoffAirport,
} from './bands';
import { MAX_ZOOM, MIN_ZOOM } from './camera';
import { corridorGridForZoom } from './route-corridors';

/**
 * §H.2's four zoom bands and the hand-off into the airport map (M7-07).
 *
 * > *"Zoom is continuous through four bands: world → region → terminal area →
 * > airport map"*
 *
 * The renderer only supplies facts and acts on the answer, so the rules are
 * proved here, without WebGL: where the bands are, which airports a zoom may
 * enter, and the three conditions a hand-off needs.
 */

const HEATHROW: HandoffAirport = { icao: 'EGLL', position: [-0.4614, 51.4775] };
const GATWICK: HandoffAirport = { icao: 'EGKK', position: [-0.1903, 51.1481] };
const SCHIPHOL: HandoffAirport = { icao: 'EHAM', position: [4.7639, 52.3086] };
const AIRPORTS = [HEATHROW, GATWICK, SCHIPHOL];

describe('the four bands', () => {
  it('runs world → region → terminal area → airport map as the camera comes in', () => {
    expect(bandForZoom(MIN_ZOOM)).toBe('world');
    expect(bandForZoom(0.35)).toBe('world');
    expect(bandForZoom(REGION_FROM_ZOOM)).toBe('region');
    expect(bandForZoom(6)).toBe('region');
    expect(bandForZoom(TERMINAL_FROM_ZOOM)).toBe('terminal');
    expect(bandForZoom(TERMINAL_EXIT_ZOOM)).toBe('terminal');
    expect(bandForZoom(AIRPORT_HANDOFF_ZOOM)).toBe('airport');
    expect(bandForZoom(MAX_ZOOM)).toBe('airport');
  });

  it('tiles the camera’s whole range with no gap and no overlap', () => {
    expect(ZOOM_BANDS[0]?.from).toBe(MIN_ZOOM);
    expect(ZOOM_BANDS.at(-1)?.to).toBe(MAX_ZOOM);
    for (let i = 1; i < ZOOM_BANDS.length; i += 1) {
      expect(ZOOM_BANDS[i]?.from).toBe(ZOOM_BANDS[i - 1]?.to);
    }
    expect(ZOOM_BANDS.map((b) => b.band)).toEqual(['world', 'region', 'terminal', 'airport']);
    for (const { band, from, to } of ZOOM_BANDS) {
      expect(bandForZoom(from)).toBe(band);
      expect(bandForZoom((from + to) / 2)).toBe(band);
    }
  });

  it('hands off inside the camera’s range, so the approach can finish behind the schematic', () => {
    expect(AIRPORT_HANDOFF_ZOOM).toBeLessThan(MAX_ZOOM);
  });

  it('puts the world/region edge where the whole-world view stops bundling corridors', () => {
    expect(corridorGridForZoom(REGION_FROM_ZOOM - 0.01)).toBeGreaterThan(0);
    expect(corridorGridForZoom(REGION_FROM_ZOOM)).toBe(0);
  });

  it('returns from the airport map well inside the terminal area, not at its edge', () => {
    // At the edge, the next scroll tick would re-open what the player just left.
    expect(bandForZoom(TERMINAL_EXIT_ZOOM)).toBe('terminal');
    expect(AIRPORT_HANDOFF_ZOOM - TERMINAL_EXIT_ZOOM).toBeGreaterThanOrEqual(1);
  });
});

describe('the airports a player operates at', () => {
  it('is their hubs and both ends of every route', () => {
    expect(
      operatedAirportIcaos(
        [{ icao: 'EHAM' }],
        [
          { originIcao: 'EHAM', destinationIcao: 'EGLL' },
          { originIcao: 'EGKK', destinationIcao: 'EHAM' },
        ],
      ),
    ).toEqual(new Set(['EHAM', 'EGLL', 'EGKK']));
  });

  it('is nothing for a player with no airline yet', () => {
    expect(operatedAirportIcaos([], []).size).toBe(0);
  });
});

describe('screen distance', () => {
  it('doubles with every zoom level', () => {
    const a = screenDistancePx(HEATHROW.position, GATWICK.position, 8);
    expect(screenDistancePx(HEATHROW.position, GATWICK.position, 9)).toBeCloseTo(a * 2, 6);
  });

  it('measures across the antimeridian the short way round', () => {
    const west: [number, number] = [179.99, 0];
    const east: [number, number] = [-179.99, 0];
    expect(screenDistancePx(west, east, 0)).toBeLessThan(1);
  });

  it('puts the neighbouring city’s airport well outside the hand-off disc', () => {
    // Heathrow and Gatwick are ~40 km apart: never mistaken for each other.
    expect(
      screenDistancePx(HEATHROW.position, GATWICK.position, AIRPORT_HANDOFF_ZOOM),
    ).toBeGreaterThan(HANDOFF_RADIUS_PX * 10);
  });
});

describe('the hand-off', () => {
  const operated = new Set(['EGLL', 'EHAM']);
  const base = {
    previousZoom: 11,
    zoom: 11.8,
    centre: HEATHROW.position,
    airports: AIRPORTS,
    operated,
  };

  it('opens an operated airport the camera is centred on when zooming in past the terminal area', () => {
    expect(handoffTarget(base)).toBe(HEATHROW);
  });

  it('allows a little slack around the centre, and no more', () => {
    const near: [number, number] = [HEATHROW.position[0] + 0.002, HEATHROW.position[1]];
    expect(handoffTarget({ ...base, centre: near })).toBe(HEATHROW);
    const far: [number, number] = [HEATHROW.position[0] + 0.05, HEATHROW.position[1]];
    expect(handoffTarget({ ...base, centre: far })).toBeNull();
  });

  it('stays on the world below the hand-off zoom', () => {
    expect(handoffTarget({ ...base, zoom: AIRPORT_HANDOFF_ZOOM - 0.01 })).toBeNull();
  });

  it('never opens on a zoom out, even one that stays close in', () => {
    expect(handoffTarget({ ...base, previousZoom: 12, zoom: 11.8 })).toBeNull();
    // A pinch out is a zoom gesture too; it must not count.
    expect(handoffTarget({ ...base, previousZoom: 12, zoom: 11.8, zoomGesture: true })).toBeNull();
  });

  it('never opens on a pan or a camera that merely arrived close in', () => {
    expect(handoffTarget({ ...base, previousZoom: 12, zoom: 12 })).toBeNull();
  });

  it('opens on a scroll at the camera’s ceiling, where the zoom can rise no further', () => {
    expect(handoffTarget({ ...base, previousZoom: 12, zoom: 12, zoomGesture: true })).toBe(
      HEATHROW,
    );
  });

  it('does not open an airport the player does not operate at', () => {
    expect(handoffTarget({ ...base, centre: GATWICK.position })).toBeNull();
  });

  it('prefers the airport under the pointer to the one at the centre', () => {
    // Scroll-zoom keeps the point under the cursor fixed, so that is the aim.
    expect(handoffTarget({ ...base, hovered: SCHIPHOL })).toBe(SCHIPHOL);
  });

  it('ignores a hovered airport the player does not operate at, and falls back to the centre', () => {
    expect(handoffTarget({ ...base, hovered: GATWICK })).toBe(HEATHROW);
  });

  it('is a function of the camera alone, so it answers the same for both projections', () => {
    // Nothing in the input says which projection drew the camera, by design.
    const first = handoffTarget(base);
    const second = handoffTarget({ ...base });
    expect(first).toBe(second);
  });

  it('picks the nearest when two operated airports share the disc', () => {
    const twin: HandoffAirport = {
      icao: 'XXXX',
      position: [HEATHROW.position[0] + 0.003, HEATHROW.position[1]],
    };
    const centre: [number, number] = [HEATHROW.position[0] + 0.0025, HEATHROW.position[1]];
    expect(
      handoffTarget({
        ...base,
        centre,
        airports: [HEATHROW, twin],
        operated: new Set(['EGLL', 'XXXX']),
      }),
    ).toBe(twin);
  });
});

describe('the airport map in a link', () => {
  it('reads a plausible code, upper-cased', () => {
    expect(airportMapFromSearch(new URLSearchParams('airport=egll'))).toBe('EGLL');
    expect(airportMapFromSearch(new URLSearchParams('airport=LHR'))).toBe('LHR');
  });

  it('refuses anything that is not one', () => {
    expect(airportMapFromSearch(new URLSearchParams('airport=..%2Fadmin'))).toBeNull();
    expect(airportMapFromSearch(new URLSearchParams('airport='))).toBeNull();
    expect(airportMapFromSearch(new URLSearchParams(''))).toBeNull();
  });
});

describe('the band hint', () => {
  it('says nothing on the world and regional views', () => {
    expect(bandHint('world', 3)).toBeNull();
    expect(bandHint('region', 3)).toBeNull();
  });

  it('tells a player in the terminal area that the airport map is one zoom away', () => {
    expect(bandHint('terminal', 3)).toMatch(/zoom in on one of your airports/);
  });

  it('does not promise an airport map to a player who operates nowhere', () => {
    expect(bandHint('terminal', 0)).toBe('Terminal area');
    expect(bandHint('airport', 0)).toBe('Close in');
  });
});
