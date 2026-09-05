import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { buildRoutePlan } from './mock';
import { ScheduleTab } from './ScheduleTab';

import type { ScheduleEditor } from './editor';
import type { PlannedFlight, PlannerAircraft, RoutePlan } from './types';
import type { RouteSummary } from '../api';

/**
 * The timeline can be operated by keyboard (UX-03).
 *
 * Each flight has always been a real `<button>`, so it took focus and its click
 * selected — and then a keyboard user could go no further, because retiming and
 * reassigning ran through `onPointerDown` and nothing else. Those two edits are
 * what the Schedule tab is *for*, so the whole tab was unusable without a mouse.
 *
 * These tests drive the keys and assert the edit the editor was asked to make,
 * because that is the thing a user is trying to cause. A test that only checked
 * `preventDefault` would pass on a handler that did nothing.
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

const FLIGHT: PlannedFlight = {
  id: 'f-1',
  aircraftId: 'af-1',
  routeId: ROUTE.id,
  originIcao: 'EHAM',
  destinationIcao: 'LEBL',
  departureMinute: 480,
  blockMinutes: 105,
  direction: 'out',
  frequency: { kind: 'daily' },
};

/**
 * An editor that records what it was asked to do.
 *
 * The real reducer is `editor.test.ts`'s and `publish.test.ts`'s subject; what
 * matters here is that the keys reach `moveFlight` with the right arguments.
 */
function stubEditor(flights: PlannedFlight[]) {
  const moves: { flightId: string; departureMinute: number; aircraftId?: string }[] = [];
  const editor = {
    flightsFor: () => flights,
    frequencyFor: () => ({ kind: 'daily' as const }),
    isDirty: () => false,
    isSaving: () => false,
    problemFor: () => null,
    canUndo: false,
    canRedo: false,
    setFlights: vi.fn(),
    setFrequency: vi.fn(),
    addRotation: vi.fn(),
    removeFlight: vi.fn(),
    removeAircraft: vi.fn(),
    moveFlight: (
      _routeId: string,
      flightId: string,
      departureMinute: number,
      aircraftId?: string,
    ) => {
      moves.push({ flightId, departureMinute, aircraftId });
    },
    resetRoute: vi.fn(),
    publish: vi.fn(),
    restore: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
  } as unknown as ScheduleEditor;
  return { editor, moves };
}

/**
 * The page's own generated plan, with this test's flights laid on it.
 *
 * `buildRoutePlan` rather than a hand-written literal: the tab reads demand,
 * slots, competitors and unit economics off the plan to draw its footer, and a
 * partial fixture fails inside the render for reasons that have nothing to do
 * with the keyboard.
 */
function planWith(flights: PlannedFlight[], aircraft: PlannerAircraft[]): RoutePlan {
  return { ...buildRoutePlan(ROUTE, [...aircraft]), flights, frequency: { kind: 'daily' } };
}

function renderTab(aircraft: PlannerAircraft[], flights: PlannedFlight[] = [FLIGHT]) {
  const { editor, moves } = stubEditor(flights);
  render(
    <ScheduleTab
      plan={planWith(flights, aircraft)}
      aircraft={aircraft}
      editor={editor}
      selection={null}
      onSelect={vi.fn()}
    />,
  );
  return moves;
}

/** The flight's button, found by the accessible name the change added. */
function block(): HTMLElement {
  return screen.getByRole('button', { name: /EHAM to LEBL, departs/ });
}

describe('retiming a flight from the keyboard', () => {
  it('carries the departure time in its accessible name', () => {
    // The visible label is `→ LEBL`, which is right on a dense timeline and says
    // nothing on its own. The time is the value the arrow keys change, so a
    // screen reader has to be able to hear it before and after.
    renderTab([flyer('af-1', 'PH-AAA')]);
    expect(block()).toHaveAccessibleName(/departs 08:00/);
    expect(block()).toHaveAccessibleName(/PH-AAA/);
  });

  it('moves the departure five minutes at a time, snapped like a drag', () => {
    // Five matches `snap`, so a nudged flight lands exactly where a dragged one
    // would — two inputs that disagreed about valid times would be worse than
    // one input.
    const moves = renderTab([flyer('af-1', 'PH-AAA')]);

    fireEvent.keyDown(block(), { key: 'ArrowRight' });
    expect(moves).toEqual([{ flightId: 'f-1', departureMinute: 485, aircraftId: undefined }]);

    fireEvent.keyDown(block(), { key: 'ArrowLeft' });
    expect(moves[1]).toEqual({ flightId: 'f-1', departureMinute: 475, aircraftId: undefined });
  });

  it('takes a half-hour step with shift', () => {
    // Retiming a departure by half an hour is a thing people do, and six presses
    // to get there is not an interaction anybody keeps using.
    const moves = renderTab([flyer('af-1', 'PH-AAA')]);
    fireEvent.keyDown(block(), { key: 'ArrowRight', shiftKey: true });
    expect(moves[0]?.departureMinute).toBe(510);
  });

  it('moves the flight between aircraft with up and down', () => {
    const moves = renderTab([flyer('af-1', 'PH-AAA'), flyer('af-2', 'PH-BBB')]);

    fireEvent.keyDown(block(), { key: 'ArrowDown' });
    expect(moves[0]).toEqual({ flightId: 'f-1', departureMinute: 480, aircraftId: 'af-2' });
  });

  it('does nothing at the ends of the aircraft list', () => {
    // Rather than wrapping. A flight that jumped from the last aeroplane to the
    // first would be a surprise, and the row order is not a cycle.
    const moves = renderTab([flyer('af-1', 'PH-AAA')]);
    fireEvent.keyDown(block(), { key: 'ArrowUp' });
    fireEvent.keyDown(block(), { key: 'ArrowDown' });
    expect(moves).toEqual([]);
  });

  it('will not move a flight onto the fleet pool', () => {
    /*
     * The pool is a synthetic row standing for the unassigned fleet, with no
     * airframe id the server would accept — `publish` skips it and refuses a
     * route that has nothing else. Offering it here would be offering a dead
     * end, so the keyboard walks real aircraft only.
     */
    const moves = renderTab([flyer('af-1', 'PH-AAA'), POOL]);
    fireEvent.keyDown(block(), { key: 'ArrowDown' });
    expect(moves).toEqual([]);
  });

  it('announces the new time, because a nudge is invisible to a screen reader', () => {
    // The block moves a few pixels and nothing reaches the accessibility tree.
    // Without this the keys work and the user cannot tell.
    renderTab([flyer('af-1', 'PH-AAA')]);
    fireEvent.keyDown(block(), { key: 'ArrowRight' });

    const live = screen.getByRole('status');
    expect(live).toHaveTextContent('EHAM to LEBL now departs 08:05.');
  });

  it('announces a move between aircraft by registration', () => {
    renderTab([flyer('af-1', 'PH-AAA'), flyer('af-2', 'PH-BBB')]);
    fireEvent.keyDown(block(), { key: 'ArrowDown' });
    expect(screen.getByRole('status')).toHaveTextContent('moved to PH-BBB');
  });

  it('leaves other keys to the browser', () => {
    // Tab has to keep moving focus and Enter has to keep activating the button.
    // A handler that swallowed everything would trade one broken interaction for
    // several.
    const moves = renderTab([flyer('af-1', 'PH-AAA')]);
    fireEvent.keyDown(block(), { key: 'Tab' });
    fireEvent.keyDown(block(), { key: 'a' });
    expect(moves).toEqual([]);
  });
});

describe('the timeline row', () => {
  it('still selects on click, which the keyboard change must not have broken', () => {
    const onSelect = vi.fn();
    const { editor } = stubEditor([FLIGHT]);
    render(
      <ScheduleTab
        plan={planWith([FLIGHT], [flyer('af-1', 'PH-AAA')])}
        aircraft={[flyer('af-1', 'PH-AAA')]}
        editor={editor}
        selection={null}
        onSelect={onSelect}
      />,
    );

    fireEvent.click(within(document.body).getByRole('button', { name: /EHAM to LEBL, departs/ }));
    expect(onSelect).toHaveBeenCalledWith({ kind: 'flight', id: 'f-1' });
  });
});
