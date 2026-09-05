import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ScheduleView } from '@tailfin/shared';

import { useScheduleEditor } from './editor';
import { restoreFromSchedules, toDrafts, toFrequency, toRepeat } from './persistence';

import type { RouteSummary } from '../api';
import type { PlannedFlight, PlannerAircraft } from './types';

/**
 * Publishing a timeline actually saves it (IMPROVE-04).
 *
 * The button used to mark the reducer's own copy of the draft as clean and do
 * nothing else, so it read "Published" while no schedule existed and a reload
 * lost the work. These tests are the ones that would fail if that came back.
 *
 * `fetch` is stubbed rather than the API module mocked, so the request bodies
 * are asserted as they would actually go over the wire — including that a
 * second publish is a `PUT` to the id the first one returned, which is the
 * difference between an edit and a duplicate rotation.
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

function leg(
  aircraftId: string,
  departureMinute: number,
  originIcao: string,
  destinationIcao: string,
): PlannedFlight {
  return {
    id: `f-${aircraftId}-${String(departureMinute)}`,
    aircraftId,
    routeId: ROUTE.id,
    originIcao,
    destinationIcao,
    departureMinute,
    blockMinutes: 105,
    direction: originIcao === ROUTE.originIcao ? 'out' : 'back',
    frequency: { kind: 'daily' },
  };
}

interface Call {
  url: string;
  method: string;
  body: unknown;
}

/**
 * A `fetch` that answers the schedule endpoints and records what it was sent.
 *
 * `schedules` is what `GET /api/schedules` returns, so the reload case is the
 * same stub with a different answer rather than a different harness.
 */
function stubFetch(
  options: {
    schedules?: ScheduleView[];
    onWrite?: (call: Call) => { status: number; body: unknown };
  } = {},
) {
  const calls: Call[] = [];
  let nextId = 1;

  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      const call: Call = { url, method, body };

      if (url === '/api/schedules' && method === 'GET') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ schedules: options.schedules ?? [] }),
        } as Response);
      }

      calls.push(call);
      const answer = options.onWrite?.(call) ?? {
        status: method === 'POST' ? 201 : 200,
        body: { schedule: { id: `sched-${String(nextId++)}` }, warning: null, cost: null },
      };
      return Promise.resolve({
        ok: answer.status < 300,
        status: answer.status,
        json: () => Promise.resolve(answer.body),
      } as Response);
    }),
  );

  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * The editor with one route's timeline laid by hand, so the draft is known.
 *
 * `setFlights` immediately rather than after waiting for the generated draft:
 * the seeder only fills a route it finds *undefined* or empty-with-flyers, so
 * laying flights first is what stops it overwriting them — and a route whose
 * only aircraft is the pool never gets a generated draft at all, which is the
 * case that made waiting for one hang.
 */
function editorWith(flights: PlannedFlight[], aircraft: PlannerAircraft[]) {
  const hook = renderHook(() => useScheduleEditor([ROUTE], aircraft));
  act(() => {
    hook.result.current.setFlights(ROUTE.id, flights);
  });
  return hook;
}

describe('publishing a route', () => {
  it('sends one rotation per aircraft, with the legs in departure order', async () => {
    /*
     * The translation that makes the two models meet. The timeline is per route
     * with several aircraft on it; a schedule is one airframe and an ordered
     * cycle. Two aeroplanes therefore mean two requests.
     */
    const calls = stubFetch();
    const hook = editorWith(
      [
        leg('af-1', 480, 'EHAM', 'LEBL'),
        leg('af-1', 720, 'LEBL', 'EHAM'),
        leg('af-2', 600, 'EHAM', 'LEBL'),
      ],
      [flyer('af-1', 'PH-AAA'), flyer('af-2', 'PH-BBB')],
    );

    await act(async () => {
      await hook.result.current.publish(ROUTE.id, [
        flyer('af-1', 'PH-AAA'),
        flyer('af-2', 'PH-BBB'),
      ]);
    });

    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.method === 'POST')).toBe(true);

    const first = calls.find((call) => (call.body as { airframeId: string }).airframeId === 'af-1');
    expect(first?.body).toMatchObject({
      airframeId: 'af-1',
      // Ordered, because the server walks them as a cycle and checks the
      // aircraft ends where it started.
      legs: [
        { originIcao: 'EHAM', destinationIcao: 'LEBL', departureMinuteLocal: 480 },
        { originIcao: 'LEBL', destinationIcao: 'EHAM', departureMinuteLocal: 720 },
      ],
      // The timeline already lays the return as its own flight, so asking the
      // server to append one would fly the sector twice.
      autoReturn: false,
      repeat: { kind: 'daily' },
    });
  });

  it('says "Published" only once the server has answered', async () => {
    const hook = editorWith([leg('af-1', 480, 'EHAM', 'LEBL')], [flyer('af-1', 'PH-AAA')]);
    stubFetch();

    expect(hook.result.current.isDirty(ROUTE.id)).toBe(true);

    await act(async () => {
      await hook.result.current.publish(ROUTE.id, [flyer('af-1', 'PH-AAA')]);
    });

    expect(hook.result.current.isDirty(ROUTE.id)).toBe(false);
    expect(hook.result.current.problemFor(ROUTE.id)).toBeNull();
  });

  it('edits the schedule it created rather than making a second one', async () => {
    // The identity criterion. Without it, every publish would leave another
    // rotation for the same aeroplane and the player would find duplicate
    // flights rather than an error.
    const calls = stubFetch();
    const aircraft = [flyer('af-1', 'PH-AAA')];
    const hook = editorWith([leg('af-1', 480, 'EHAM', 'LEBL')], aircraft);

    await act(async () => {
      await hook.result.current.publish(ROUTE.id, aircraft);
    });
    act(() => {
      hook.result.current.setFlights(ROUTE.id, [leg('af-1', 540, 'EHAM', 'LEBL')]);
    });
    await act(async () => {
      await hook.result.current.publish(ROUTE.id, aircraft);
    });

    expect(calls.map((call) => call.method)).toEqual(['POST', 'PUT']);
    expect(calls[1]?.url).toBe('/api/schedules/sched-1');
    // A `PUT` replaces the legs and cannot move the aircraft, so the body
    // deliberately does not carry one.
    expect(calls[1]?.body).not.toHaveProperty('airframeId');
  });

  it('keeps the draft and names the leg when the server refuses', async () => {
    const calls = stubFetch({
      onWrite: () => ({
        status: 422,
        body: { problem: 'unreachable', detail: 'EHAM→LEBL cannot be flown: out of range.' },
      }),
    });
    const aircraft = [flyer('af-1', 'PH-AAA')];
    const flights = [leg('af-1', 480, 'EHAM', 'LEBL')];
    const hook = editorWith(flights, aircraft);

    await act(async () => {
      await hook.result.current.publish(ROUTE.id, aircraft);
    });

    expect(calls).toHaveLength(1);
    // Still dirty, so the button still offers to publish.
    expect(hook.result.current.isDirty(ROUTE.id)).toBe(true);
    // And the draft survived, which is the whole point of a draft.
    expect(hook.result.current.flightsFor(ROUTE.id)).toHaveLength(1);
    expect(hook.result.current.problemFor(ROUTE.id)).toEqual({
      problem: 'unreachable',
      detail: 'EHAM→LEBL cannot be flown: out of range.',
    });
  });

  it('keeps the draft when the request never arrives', async () => {
    // A 500 or a dead server. Different from a refusal: nothing decided, so the
    // message says to try again rather than naming a leg.
    vi.stubGlobal(
      'fetch',
      vi.fn((input: unknown) =>
        String(input) === '/api/schedules'
          ? Promise.reject(new Error('offline'))
          : Promise.reject(new Error('offline')),
      ),
    );
    const aircraft = [flyer('af-1', 'PH-AAA')];
    const hook = editorWith([leg('af-1', 480, 'EHAM', 'LEBL')], aircraft);

    await act(async () => {
      await hook.result.current.publish(ROUTE.id, aircraft);
    });

    expect(hook.result.current.isDirty(ROUTE.id)).toBe(true);
    expect(hook.result.current.problemFor(ROUTE.id)?.problem).toBe('network');
    expect(hook.result.current.problemFor(ROUTE.id)?.detail).toMatch(/still here/i);
  });

  it('refuses a timeline laid entirely against the fleet pool', async () => {
    /*
     * The pool is a synthetic row standing for "the unassigned fleet" and has no
     * airframe id the server could accept. Sending it would fabricate a resource;
     * saying nothing would leave the player wondering why the button did nothing.
     */
    const calls = stubFetch();
    const aircraft = [POOL];
    const hook = editorWith([leg('pool', 480, 'EHAM', 'LEBL')], aircraft);

    await act(async () => {
      await hook.result.current.publish(ROUTE.id, aircraft);
    });

    expect(calls).toHaveLength(0);
    expect(hook.result.current.problemFor(ROUTE.id)?.problem).toBe('no_aircraft');
    expect(hook.result.current.problemFor(ROUTE.id)?.detail).toMatch(/fleet pool/i);
    expect(hook.result.current.isDirty(ROUTE.id)).toBe(true);
  });

  it('ignores a second click while a save is in flight', async () => {
    // Two concurrent creates for the same aeroplane would both succeed and leave
    // a duplicate rotation.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: Call[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (url === '/api/schedules' && (init?.method ?? 'GET') === 'GET') {
          return {
            ok: true,
            status: 200,
            json: () => Promise.resolve({ schedules: [] }),
          } as Response;
        }
        calls.push({ url, method: init?.method ?? 'GET', body: undefined });
        await gate;
        return {
          ok: true,
          status: 201,
          json: () => Promise.resolve({ schedule: { id: 'sched-1' }, warning: null, cost: null }),
        } as Response;
      }),
    );

    const aircraft = [flyer('af-1', 'PH-AAA')];
    const hook = editorWith([leg('af-1', 480, 'EHAM', 'LEBL')], aircraft);

    let first: Promise<void> | undefined;
    act(() => {
      first = hook.result.current.publish(ROUTE.id, aircraft);
    });
    await waitFor(() => {
      expect(hook.result.current.isSaving(ROUTE.id)).toBe(true);
    });

    // The second click, while the first is still open.
    await act(async () => {
      await hook.result.current.publish(ROUTE.id, aircraft);
    });
    expect(calls).toHaveLength(1);

    release?.();
    await act(async () => {
      await first;
    });
    expect(hook.result.current.isSaving(ROUTE.id)).toBe(false);
    expect(hook.result.current.isDirty(ROUTE.id)).toBe(false);
  });

  it('leaves undo and redo working across a publish', async () => {
    // Publishing is not an edit, so it must not consume or add history.
    stubFetch();
    const aircraft = [flyer('af-1', 'PH-AAA')];
    const hook = editorWith([leg('af-1', 480, 'EHAM', 'LEBL')], aircraft);

    act(() => {
      hook.result.current.setFlights(ROUTE.id, [leg('af-1', 600, 'EHAM', 'LEBL')]);
    });
    await act(async () => {
      await hook.result.current.publish(ROUTE.id, aircraft);
    });

    expect(hook.result.current.canUndo).toBe(true);
    act(() => {
      hook.result.current.undo();
    });
    expect(hook.result.current.flightsFor(ROUTE.id)[0]?.departureMinute).toBe(480);
    // Undoing past the published state makes the route dirty again, which is
    // honest: the server holds the other one.
    expect(hook.result.current.isDirty(ROUTE.id)).toBe(true);
    expect(hook.result.current.canRedo).toBe(true);
  });
});

describe('restoring what the server holds', () => {
  const saved: ScheduleView = {
    id: 'sched-9',
    airframeId: 'af-1',
    legs: [
      {
        routeId: ROUTE.id,
        originIcao: 'EHAM',
        destinationIcao: 'LEBL',
        departureMinute: 480,
        blockMinutes: 105,
        turnaroundMinutes: 45,
      },
      {
        routeId: ROUTE.id,
        originIcao: 'LEBL',
        destinationIcao: 'EHAM',
        departureMinute: 630,
        blockMinutes: 105,
        turnaroundMinutes: 45,
      },
    ],
    repeat: { kind: 'weekdays', days: [1, 3, 5] },
    active: true,
    upcomingFlights: 12,
    createdAt: '2026-09-05T10:00:00.000Z',
  };

  it('rebuilds the timeline from a saved rotation', () => {
    const restored = restoreFromSchedules([saved]);
    const route = restored.get(ROUTE.id);

    expect(route?.flights).toHaveLength(2);
    expect(route?.flights[0]).toMatchObject({
      aircraftId: 'af-1',
      originIcao: 'EHAM',
      destinationIcao: 'LEBL',
      departureMinute: 480,
      direction: 'out',
    });
    expect(route?.flights[1]?.direction).toBe('back');
    expect(route?.frequency).toEqual({ kind: 'weekdays', days: [1, 3, 5] });
    // The identity, so the next publish edits this schedule.
    expect(route?.scheduleIds).toEqual({ 'af-1': 'sched-9' });
  });

  it('arrives clean, so the button reads "Published" without a save', () => {
    const restored = restoreFromSchedules([saved]).get(ROUTE.id);
    if (!restored) throw new Error('nothing restored');

    const aircraft = [flyer('af-1', 'PH-AAA')];
    const hook = renderHook(() => useScheduleEditor([ROUTE], aircraft));
    act(() => {
      hook.result.current.restore(
        ROUTE.id,
        restored.flights,
        restored.frequency,
        restored.scheduleIds,
      );
    });

    expect(hook.result.current.isDirty(ROUTE.id)).toBe(false);
    expect(hook.result.current.flightsFor(ROUTE.id)).toHaveLength(2);
  });

  it('publishes a restored route as an edit, not as a new rotation', async () => {
    // The reason `scheduleIds` is restored at all. Without it a reload followed
    // by an edit would create a second rotation for the same aeroplane.
    const calls = stubFetch();
    const restored = restoreFromSchedules([saved]).get(ROUTE.id);
    if (!restored) throw new Error('nothing restored');

    const aircraft = [flyer('af-1', 'PH-AAA')];
    const hook = renderHook(() => useScheduleEditor([ROUTE], aircraft));
    act(() => {
      hook.result.current.restore(
        ROUTE.id,
        restored.flights,
        restored.frequency,
        restored.scheduleIds,
      );
      hook.result.current.setFlights(ROUTE.id, [leg('af-1', 540, 'EHAM', 'LEBL')]);
    });

    await act(async () => {
      await hook.result.current.publish(ROUTE.id, aircraft);
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.url).toBe('/api/schedules/sched-9');
  });

  it('skips a leg whose route has been closed', () => {
    // `routeId` is nullable because the join back to a route is deferred. A leg
    // with none has nothing for the timeline to lay it against, and inventing a
    // row would show a flight on a route the airline no longer serves.
    const orphan: ScheduleView = {
      ...saved,
      legs: [{ ...saved.legs[0]!, routeId: null }, saved.legs[1]!],
    };
    const restored = restoreFromSchedules([orphan]);
    expect(restored.get(ROUTE.id)?.flights).toHaveLength(1);
  });
});

describe('the repeat pattern', () => {
  it('round-trips a weekday selection', () => {
    expect(toRepeat({ kind: 'weekdays', days: [5, 1, 1, 3] })).toEqual({
      kind: 'weekdays',
      days: [1, 3, 5],
    });
    expect(toFrequency({ kind: 'weekdays', days: [2, 4] })).toEqual({
      kind: 'weekdays',
      days: [2, 4],
    });
  });

  it('reads an empty weekday selection as daily', () => {
    // The timeline allows no days ticked and the contract requires at least one,
    // so sending it would earn a refusal the player cannot act on.
    expect(toRepeat({ kind: 'weekdays', days: [] })).toEqual({ kind: 'daily' });
  });
});

describe('toDrafts', () => {
  it('counts the pool flights it left behind', () => {
    const { drafts, skippedPool } = toDrafts(
      [leg('af-1', 480, 'EHAM', 'LEBL'), leg('pool', 600, 'EHAM', 'LEBL')],
      { kind: 'daily' },
      [flyer('af-1', 'PH-AAA'), POOL],
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.aircraftId).toBe('af-1');
    expect(skippedPool).toBe(1);
  });
});
