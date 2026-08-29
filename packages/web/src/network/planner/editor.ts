import { useCallback, useEffect, useMemo, useReducer } from 'react';

import { blockMinutes, buildRoutePlan } from './mock';

import type { RouteSummary } from '../api';
import type { Frequency, PlannedFlight, PlannerAircraft } from './types';

/**
 * The editable schedule model behind the planner.
 *
 * The map generates a first draft (`mock.ts`), and from there the player edits it:
 * add a rotation on a slot, drag a flight to retime or reassign it, cut one, change
 * the frequency, apply a template, accept a suggestion. Every edit is undoable, and
 * a route stays a **draft** until it is published — so experimenting is free and the
 * "unsaved" state is explicit. There is no schedule endpoint yet (M2-03), so publish
 * is local; the shape is the one a real save would take.
 */

interface Snapshot {
  flights: Record<string, PlannedFlight[]>;
  frequencies: Record<string, Frequency>;
}

interface EditorState {
  present: Snapshot;
  past: Snapshot[];
  future: Snapshot[];
  /** Serialised published state per route, to tell a dirty draft from a clean one. */
  published: Record<string, string>;
}

function serialiseRoute(snapshot: Snapshot, routeId: string): string {
  const flights = [...(snapshot.flights[routeId] ?? [])]
    .map((f) => ({
      a: f.aircraftId,
      d: f.departureMinute,
      b: f.blockMinutes,
      dir: f.direction,
      o: f.originIcao,
      t: f.destinationIcao,
    }))
    .sort((x, y) => x.d - y.d || x.a.localeCompare(y.a));
  return JSON.stringify({ flights, frequency: snapshot.frequencies[routeId] ?? { kind: 'daily' } });
}

type Action =
  | { type: 'seed'; routeId: string; flights: PlannedFlight[]; frequency: Frequency }
  | { type: 'set-flights'; routeId: string; flights: PlannedFlight[] }
  | { type: 'set-frequency'; routeId: string; frequency: Frequency }
  | { type: 'reset'; routeId: string; flights: PlannedFlight[]; frequency: Frequency }
  | { type: 'publish'; routeId: string }
  | { type: 'undo' }
  | { type: 'redo' };

const HISTORY_LIMIT = 50;

function withHistory(state: EditorState, next: Snapshot): EditorState {
  return {
    present: next,
    past: [...state.past, state.present].slice(-HISTORY_LIMIT),
    future: [],
    published: state.published,
  };
}

function reducer(state: EditorState, action: Action): EditorState {
  switch (action.type) {
    case 'seed': {
      // No history entry — seeding the first draft (or re-seeding a still-empty one
      // once the fleet loads) is not a user edit to undo.
      const present: Snapshot = {
        flights: { ...state.present.flights, [action.routeId]: action.flights },
        frequencies: { ...state.present.frequencies, [action.routeId]: action.frequency },
      };
      return {
        ...state,
        present,
        published: {
          ...state.published,
          [action.routeId]: serialiseRoute(present, action.routeId),
        },
      };
    }
    case 'set-flights':
      return withHistory(state, {
        flights: { ...state.present.flights, [action.routeId]: action.flights },
        frequencies: state.present.frequencies,
      });
    case 'set-frequency':
      return withHistory(state, {
        flights: state.present.flights,
        frequencies: { ...state.present.frequencies, [action.routeId]: action.frequency },
      });
    case 'reset':
      return withHistory(state, {
        flights: { ...state.present.flights, [action.routeId]: action.flights },
        frequencies: { ...state.present.frequencies, [action.routeId]: action.frequency },
      });
    case 'publish':
      return {
        ...state,
        published: {
          ...state.published,
          [action.routeId]: serialiseRoute(state.present, action.routeId),
        },
      };
    case 'undo': {
      const previous = state.past[state.past.length - 1];
      if (previous === undefined) return state;
      return {
        ...state,
        present: previous,
        past: state.past.slice(0, -1),
        future: [state.present, ...state.future].slice(0, HISTORY_LIMIT),
      };
    }
    case 'redo': {
      const next = state.future[0];
      if (next === undefined) return state;
      return {
        ...state,
        present: next,
        past: [...state.past, state.present].slice(-HISTORY_LIMIT),
        future: state.future.slice(1),
      };
    }
  }
}

const EMPTY: EditorState = {
  present: { flights: {}, frequencies: {} },
  past: [],
  future: [],
  published: {},
};

let sequence = 0;
function nextId(routeId: string): string {
  sequence += 1;
  return `edit-${routeId}-${String(sequence)}`;
}

/** Build the out-and-back legs of one rotation departing at `hour`. */
export function buildRotation(
  route: RouteSummary,
  aircraft: PlannerAircraft,
  hour: number,
): PlannedFlight[] {
  const block = blockMinutes(route.greatCircleNm, aircraft.aircraftClass);
  const depart = hour * 60;
  const back = depart + block + 40;
  return [
    {
      id: nextId(route.id),
      aircraftId: aircraft.id,
      routeId: route.id,
      originIcao: route.originIcao,
      destinationIcao: route.destinationIcao,
      departureMinute: depart,
      blockMinutes: block,
      direction: 'out',
      frequency: { kind: 'daily' },
    },
    {
      id: nextId(route.id),
      aircraftId: aircraft.id,
      routeId: route.id,
      originIcao: route.destinationIcao,
      destinationIcao: route.originIcao,
      departureMinute: back,
      blockMinutes: block,
      direction: 'back',
      frequency: { kind: 'daily' },
    },
  ];
}

export interface ScheduleEditor {
  flightsFor: (routeId: string) => PlannedFlight[];
  frequencyFor: (routeId: string) => Frequency;
  isDirty: (routeId: string) => boolean;
  canUndo: boolean;
  canRedo: boolean;
  setFlights: (routeId: string, flights: PlannedFlight[]) => void;
  setFrequency: (routeId: string, frequency: Frequency) => void;
  addRotation: (route: RouteSummary, aircraft: PlannerAircraft, hour: number) => void;
  removeFlight: (routeId: string, flightId: string) => void;
  /** Drop every flight this aircraft flies on the route, leaving the airframe idle. */
  removeAircraft: (routeId: string, aircraftId: string) => void;
  moveFlight: (
    routeId: string,
    flightId: string,
    departureMinute: number,
    aircraftId?: string,
  ) => void;
  resetRoute: (route: RouteSummary, aircraft: readonly PlannerAircraft[]) => void;
  publish: (routeId: string) => void;
  undo: () => void;
  redo: () => void;
}

/** The planner's editable schedule, seeded from the mock and edited from there. */
export function useScheduleEditor(
  routes: readonly RouteSummary[],
  aircraft: readonly PlannerAircraft[],
): ScheduleEditor {
  const [state, dispatch] = useReducer(reducer, EMPTY);

  // Seed a first draft for each route from the mock generator. Also re-seeds a route
  // that is still empty and unedited once the fleet arrives — otherwise a routes-load
  // that beats the fleet-load would lock in an empty schedule with no aircraft to fly.
  useEffect(() => {
    const hasFlyers = aircraft.some((a) => !a.isPool);
    for (const route of routes) {
      const existing = state.present.flights[route.id];
      const clean =
        existing === undefined ||
        state.published[route.id] === serialiseRoute(state.present, route.id);
      const emptyButShouldFly = existing?.length === 0 && hasFlyers;
      if ((existing === undefined || emptyButShouldFly) && clean) {
        const plan = buildRoutePlan(route, [...aircraft]);
        dispatch({
          type: 'seed',
          routeId: route.id,
          flights: plan.flights,
          frequency: plan.frequency,
        });
      }
    }
  }, [routes, aircraft, state.present, state.published]);

  const flightsFor = useCallback(
    (routeId: string) => state.present.flights[routeId] ?? [],
    [state.present.flights],
  );
  const frequencyFor = useCallback(
    (routeId: string): Frequency => state.present.frequencies[routeId] ?? { kind: 'daily' },
    [state.present.frequencies],
  );
  const isDirty = useCallback(
    (routeId: string) =>
      state.published[routeId] !== undefined &&
      serialiseRoute(state.present, routeId) !== state.published[routeId],
    [state.present, state.published],
  );

  const setFlights = useCallback((routeId: string, flights: PlannedFlight[]) => {
    dispatch({ type: 'set-flights', routeId, flights });
  }, []);
  const setFrequency = useCallback((routeId: string, frequency: Frequency) => {
    dispatch({ type: 'set-frequency', routeId, frequency });
  }, []);
  const addRotation = useCallback(
    (route: RouteSummary, frame: PlannerAircraft, hour: number) => {
      const existing = state.present.flights[route.id] ?? [];
      dispatch({
        type: 'set-flights',
        routeId: route.id,
        flights: [...existing, ...buildRotation(route, frame, hour)],
      });
    },
    [state.present.flights],
  );
  const removeFlight = useCallback(
    (routeId: string, flightId: string) => {
      const existing = state.present.flights[routeId] ?? [];
      dispatch({
        type: 'set-flights',
        routeId,
        flights: existing.filter((f) => f.id !== flightId),
      });
    },
    [state.present.flights],
  );
  const removeAircraft = useCallback(
    (routeId: string, aircraftId: string) => {
      const existing = state.present.flights[routeId] ?? [];
      dispatch({
        type: 'set-flights',
        routeId,
        flights: existing.filter((f) => f.aircraftId !== aircraftId),
      });
    },
    [state.present.flights],
  );
  const moveFlight = useCallback(
    (routeId: string, flightId: string, departureMinute: number, aircraftId?: string) => {
      const existing = state.present.flights[routeId] ?? [];
      dispatch({
        type: 'set-flights',
        routeId,
        flights: existing.map((f) =>
          f.id === flightId
            ? {
                ...f,
                departureMinute: Math.max(0, Math.min(1439 - f.blockMinutes, departureMinute)),
                aircraftId: aircraftId ?? f.aircraftId,
              }
            : f,
        ),
      });
    },
    [state.present.flights],
  );
  const resetRoute = useCallback((route: RouteSummary, frames: readonly PlannerAircraft[]) => {
    const plan = buildRoutePlan(route, [...frames]);
    dispatch({
      type: 'reset',
      routeId: route.id,
      flights: plan.flights,
      frequency: plan.frequency,
    });
  }, []);
  const publish = useCallback((routeId: string) => {
    dispatch({ type: 'publish', routeId });
  }, []);
  const undo = useCallback(() => {
    dispatch({ type: 'undo' });
  }, []);
  const redo = useCallback(() => {
    dispatch({ type: 'redo' });
  }, []);

  return useMemo(
    () => ({
      flightsFor,
      frequencyFor,
      isDirty,
      canUndo: state.past.length > 0,
      canRedo: state.future.length > 0,
      setFlights,
      setFrequency,
      addRotation,
      removeFlight,
      removeAircraft,
      moveFlight,
      resetRoute,
      publish,
      undo,
      redo,
    }),
    [
      flightsFor,
      frequencyFor,
      isDirty,
      state.past.length,
      state.future.length,
      setFlights,
      setFrequency,
      addRotation,
      removeFlight,
      removeAircraft,
      moveFlight,
      resetRoute,
      publish,
      undo,
      redo,
    ],
  );
}
