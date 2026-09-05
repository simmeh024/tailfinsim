import { useCallback, useEffect, useMemo, useReducer } from 'react';

import { publishSchedule, updateSchedule } from '../api';

import { blockMinutes, buildRoutePlan } from './mock';
import { toDrafts } from './persistence';

import type { RouteSummary } from '../api';
import type { Frequency, PlannedFlight, PlannerAircraft } from './types';

/**
 * The editable schedule model behind the planner.
 *
 * The map generates a first draft (`mock.ts`), and from there the player edits it:
 * add a rotation on a slot, drag a flight to retime or reassign it, cut one, change
 * the frequency, apply a template, accept a suggestion. Every edit is undoable, and
 * a route stays a **draft** until it is published — so experimenting is free and the
 * "unsaved" state is explicit.
 *
 * ## Publish saves (IMPROVE-04)
 *
 * It used to mark the reducer's own copy of the draft as clean and nothing else,
 * so the button read "Published" while no schedule existed and a reload lost the
 * work. It now goes through `POST`/`PUT /api/schedules`, and "Published" appears
 * only after the server has said so.
 *
 * Three things follow from that, and each is a state this reducer has to carry:
 *
 *   - **A rotation per aircraft.** The timeline is per route with several
 *     aircraft on it; a server schedule is one airframe and an ordered cycle. So
 *     one Publish is several requests, and `persistence.ts` does the translation.
 *   - **Identity.** `scheduleIds` remembers which schedule holds which aircraft
 *     on which route, so the second publish is an edit rather than a duplicate.
 *   - **In flight, and refused.** `saving` and `problems` exist so the button can
 *     say which it is, and so a repeated click cannot start a second save.
 *
 * The draft itself is untouched by a failure. A refusal keeps the edits, which is
 * the whole point of having a draft: the player fixes the leg the server named
 * and publishes again.
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
  /**
   * `routeId` → `aircraftId` → the schedule the server holds it in.
   *
   * What turns the second publish into an edit. Without it every save would
   * create another rotation for the same aeroplane, which the player would find
   * as duplicate flights rather than as an error.
   */
  scheduleIds: Record<string, Record<string, string>>;
  /** Routes with a save in flight. A second click while saving is ignored. */
  saving: Record<string, true>;
  /** The last refusal per route, kept until the next attempt. */
  problems: Record<string, PublishProblem>;
}

/** Why a publish did not happen, in words the player can act on. */
export interface PublishProblem {
  /** The server's `problem` code, or `network` when it never got there. */
  problem: string;
  detail: string;
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
  | { type: 'publish'; routeId: string; scheduleIds: Record<string, string> }
  | { type: 'saving'; routeId: string }
  | { type: 'refused'; routeId: string; problem: PublishProblem }
  | {
      type: 'restore';
      routeId: string;
      flights: PlannedFlight[];
      frequency: Frequency;
      scheduleIds: Record<string, string>;
    }
  | { type: 'undo' }
  | { type: 'redo' };

const HISTORY_LIMIT = 50;

function withHistory(state: EditorState, next: Snapshot): EditorState {
  return {
    ...state,
    present: next,
    past: [...state.past, state.present].slice(-HISTORY_LIMIT),
    future: [],
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
    case 'saving':
      return {
        ...state,
        saving: { ...state.saving, [action.routeId]: true },
        // The previous refusal goes as soon as a new attempt starts: leaving it
        // up while a save is in flight tells the player about a problem that may
        // already be fixed.
        problems: without(state.problems, action.routeId),
      };
    case 'refused':
      return {
        ...state,
        saving: without(state.saving, action.routeId),
        problems: { ...state.problems, [action.routeId]: action.problem },
      };
    case 'publish':
      /*
       * Only reached after the server has accepted every rotation on the route.
       *
       * `published` is serialised from the draft *as it is now*, which is the
       * dirty comparison the button reads. An edit made while the save was in
       * flight therefore shows as dirty again immediately — correct, because the
       * server does not have that edit.
       */
      return {
        ...state,
        published: {
          ...state.published,
          [action.routeId]: serialiseRoute(state.present, action.routeId),
        },
        scheduleIds: {
          ...state.scheduleIds,
          [action.routeId]: { ...state.scheduleIds[action.routeId], ...action.scheduleIds },
        },
        saving: without(state.saving, action.routeId),
        problems: without(state.problems, action.routeId),
      };
    case 'restore': {
      /*
       * What the server holds, laid on the timeline (IMPROVE-04).
       *
       * No history entry and no dirty flag: this *is* the saved state, so the
       * route arrives clean. Undo deliberately cannot reach back past it — there
       * is nothing before a reload to go back to.
       */
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
        scheduleIds: { ...state.scheduleIds, [action.routeId]: action.scheduleIds },
      };
    }
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
  scheduleIds: {},
  saving: {},
  problems: {},
};

/** A record without one key, so a cleared state is a new object rather than a delete. */
function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

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
  /**
   * Save the route's timeline as real rotations (IMPROVE-04).
   *
   * Resolves when the server has answered. A refusal is reported through
   * `problemFor` rather than thrown, because a leg the aircraft cannot fly is an
   * answer the player has to read — App. B.4's whole point — and the draft has
   * to survive it.
   */
  publish: (routeId: string, aircraft: readonly PlannerAircraft[]) => Promise<void>;
  /** True while a save for this route is in flight. */
  isSaving: (routeId: string) => boolean;
  /** The last refusal for this route, or null. */
  problemFor: (routeId: string) => PublishProblem | null;
  /** Lay what the server holds on the timeline, clean and undirty. */
  restore: (
    routeId: string,
    flights: PlannedFlight[],
    frequency: Frequency,
    scheduleIds: Record<string, string>,
  ) => void;
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
  /**
   * One request per aircraft on the route, then one dispatch if all of them took.
   *
   * All-or-nothing on the *dirty flag*, not on the server: there is no
   * cross-schedule transaction, so a rotation the server accepted stays
   * accepted. What the flag says is whether the timeline as drawn is now what the
   * server holds, and after a partial failure it is not — so the route stays
   * dirty and the ids of whatever did save are kept, which makes the retry an
   * edit of those and a create of the rest.
   *
   * A second click while one is in flight is dropped rather than queued. Two
   * concurrent creates for the same aeroplane would both succeed and leave a
   * duplicate rotation, which is the criterion about repeated clicks.
   */
  const publish = useCallback(
    async (routeId: string, frames: readonly PlannerAircraft[]) => {
      if (state.saving[routeId] === true) return;

      const { drafts, skippedPool } = toDrafts(
        state.present.flights[routeId] ?? [],
        state.present.frequencies[routeId] ?? { kind: 'daily' },
        frames,
      );

      if (drafts.length === 0) {
        dispatch({
          type: 'refused',
          routeId,
          problem: {
            problem: 'no_aircraft',
            detail:
              skippedPool > 0
                ? 'Every flight on this route is laid against the fleet pool. Assign a real aircraft before publishing.'
                : 'There is nothing to publish on this route yet.',
          },
        });
        return;
      }

      dispatch({ type: 'saving', routeId });
      const known = state.scheduleIds[routeId] ?? {};
      const saved: Record<string, string> = {};

      for (const { aircraftId, draft } of drafts) {
        const existing = known[aircraftId];
        let outcome;
        try {
          outcome =
            existing === undefined
              ? await publishSchedule(draft)
              : await updateSchedule(existing, {
                  legs: draft.legs,
                  autoReturn: draft.autoReturn,
                  repeat: draft.repeat,
                });
        } catch {
          // A dead server or a 500. The draft is untouched and the player is
          // told it did not reach anywhere, which is a different problem from a
          // rotation being refused.
          dispatch({
            type: 'refused',
            routeId,
            problem: {
              problem: 'network',
              detail: 'The schedule could not be saved. Your draft is still here — try again.',
            },
          });
          return;
        }

        if (!outcome.ok) {
          // Narrowed to the two fields, not spread: the outcome also carries
          // `ok`, and a `PublishProblem` with an `ok: false` on it would leak
          // the client's own result shape into the state the UI renders.
          dispatch({
            type: 'refused',
            routeId,
            problem: { problem: outcome.problem, detail: outcome.detail },
          });
          return;
        }
        saved[aircraftId] = outcome.response.schedule.id;
      }

      dispatch({ type: 'publish', routeId, scheduleIds: saved });
    },
    [state.present.flights, state.present.frequencies, state.saving, state.scheduleIds],
  );

  const isSaving = useCallback((routeId: string) => state.saving[routeId] === true, [state.saving]);
  const problemFor = useCallback(
    (routeId: string) => state.problems[routeId] ?? null,
    [state.problems],
  );
  const restore = useCallback(
    (
      routeId: string,
      flights: PlannedFlight[],
      frequency: Frequency,
      scheduleIds: Record<string, string>,
    ) => {
      dispatch({ type: 'restore', routeId, flights, frequency, scheduleIds });
    },
    [],
  );
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
      isSaving,
      problemFor,
      restore,
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
      isSaving,
      problemFor,
      restore,
      undo,
      redo,
    ],
  );
}
