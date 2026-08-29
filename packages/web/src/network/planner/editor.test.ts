import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useScheduleEditor } from './editor';

import type { RouteSummary } from '../api';
import type { PlannerAircraft } from './types';

/**
 * The schedule editor's aircraft removal (the Network Schedule tab's "Remove from
 * route"). The seed lays flights on up to two flyers; removing one must drop only
 * that airframe's flying, leave the other's untouched, and stay undoable — it goes
 * through the same history as every other edit.
 */

const ROUTE: RouteSummary = {
  id: 'route-1',
  originIcao: 'EHAM',
  destinationIcao: 'LEBL',
  greatCircleNm: 700,
  fares: { business: 30_000, economy: 12_000 },
  active: true,
};

function flyer(id: string, registration: string): PlannerAircraft {
  return {
    id,
    registration,
    typeDesignation: 'ATR 72-600',
    aircraftClass: 'turboprop',
    utilisationHoursPerDay: 0,
    isPool: false,
  };
}

const POOL: PlannerAircraft = {
  id: 'pool',
  registration: 'Fleet pool',
  typeDesignation: 'unassigned',
  aircraftClass: '',
  utilisationHoursPerDay: 0,
  isPool: true,
};

describe('removeAircraft', () => {
  it('drops only the named aircraft’s flights and leaves the other flyer alone', async () => {
    const aircraft = [flyer('ac-a', 'TF-AAA'), flyer('ac-b', 'TF-BBB'), POOL];
    const { result } = renderHook(() => useScheduleEditor([ROUTE], aircraft));

    // The seed lays flights on both flyers.
    await waitFor(() => {
      const seeded = result.current.flightsFor('route-1');
      expect(seeded.some((f) => f.aircraftId === 'ac-a')).toBe(true);
      expect(seeded.some((f) => f.aircraftId === 'ac-b')).toBe(true);
    });
    const bBefore = result.current.flightsFor('route-1').filter((f) => f.aircraftId === 'ac-b');

    act(() => {
      result.current.removeAircraft('route-1', 'ac-a');
    });

    const after = result.current.flightsFor('route-1');
    expect(after.some((f) => f.aircraftId === 'ac-a')).toBe(false);
    expect(after.filter((f) => f.aircraftId === 'ac-b')).toEqual(bBefore);
  });

  it('is undoable — it is an ordinary history edit', async () => {
    const aircraft = [flyer('ac-a', 'TF-AAA'), flyer('ac-b', 'TF-BBB'), POOL];
    const { result } = renderHook(() => useScheduleEditor([ROUTE], aircraft));

    await waitFor(() => {
      expect(result.current.flightsFor('route-1').some((f) => f.aircraftId === 'ac-a')).toBe(true);
    });
    const before = result.current.flightsFor('route-1');

    act(() => {
      result.current.removeAircraft('route-1', 'ac-a');
    });
    expect(result.current.canUndo).toBe(true);

    act(() => {
      result.current.undo();
    });
    expect(result.current.flightsFor('route-1')).toEqual(before);
  });
});
