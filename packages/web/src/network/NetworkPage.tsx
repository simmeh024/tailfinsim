import { useCallback, useEffect, useMemo, useState } from 'react';

import type { FleetAirframeView } from '@tailfin/shared';

import { fetchFleetAirframes } from '../fleet/api';
import { useContextSelection } from '../shell/context-selection';
import { StateBlock } from '../ui/StateBlock';
import { useUnsavedGuard } from '../ui/unsaved';

import { closeRoute, fetchRoutes, fetchSchedules, setRouteActive, type RouteSummary } from './api';
import { AirportSlotsView } from './planner/AirportSlotsView';
import { liveEconomics } from './planner/analysis';
import { CompetitionTab } from './planner/CompetitionTab';
import { describeSelection } from './planner/ContextBodies';
import { useScheduleEditor } from './planner/editor';
import { FleetScheduleView } from './planner/FleetScheduleView';
import { HubConnectionsView } from './planner/HubConnectionsView';
import { buildRoutePlan, plannerAircraft } from './planner/mock';
import { OpenRouteForm } from './planner/OpenRouteForm';
import { OverviewTab } from './planner/OverviewTab';
import { PerformanceTab } from './planner/PerformanceTab';
import { restoreFromSchedules } from './planner/persistence';
import { PricingTab } from './planner/PricingTab';
import { RotationPublisher } from './planner/RotationPublisher';
import { ScheduleTab } from './planner/ScheduleTab';
import { Chip, Segmented } from './planner/ui';

import type { NetworkSelection } from './planner/types';
import type { ReactNode } from 'react';

import './network.css';

/**
 * The Network page — a route-planning workspace (M2/M3, App. B & §8).
 *
 * A route rail with the "Open a route" flow on the left; a per-route workspace of
 * tabs (Overview, Schedule, Pricing, Competition, Performance) in the middle; and
 * the shell's context panel on the right, which this page fills with detail for
 * whatever is selected — a route, a flight, an aircraft or a slot. A second view
 * switches the middle to the whole-airline Fleet Schedule.
 *
 * Real data: routes and fares, the fleet, and — since IMPROVE-04 — **the
 * schedule**. The Schedule tab's Publish saves through `POST`/`PUT
 * /api/schedules`, and this page restores what the server holds on load, so a
 * reload shows the player's own rotations rather than a regenerated draft.
 *
 * Still mock, structured to mirror the endpoints that will replace it
 * (`planner/mock.ts`): slots, competition and performance, plus the *first
 * draft* a route with no saved rotation opens with. That draft is a proposal to
 * edit, not a saved result, and nothing presents it as one — the button says
 * "Publish" until the server has taken it.
 */

type Tab = 'overview' | 'schedule' | 'pricing' | 'competition' | 'performance';
type View = 'route' | 'fleet' | 'connections' | 'slots';
type RouteSort = 'name' | 'profit' | 'load' | 'distance';

const SORTS: readonly { value: RouteSort; label: string }[] = [
  { value: 'name', label: 'A–Z' },
  { value: 'profit', label: 'Profit' },
  { value: 'load', label: 'Load' },
  { value: 'distance', label: 'Distance' },
];

const TABS: readonly { value: Tab; label: string }[] = [
  { value: 'overview', label: 'Overview' },
  { value: 'schedule', label: 'Schedule' },
  { value: 'pricing', label: 'Pricing' },
  { value: 'competition', label: 'Competition' },
  { value: 'performance', label: 'Performance' },
];

export function NetworkPage(): ReactNode {
  const [routes, setRoutes] = useState<RouteSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [fleet, setFleet] = useState<readonly FleetAirframeView[]>([]);
  const [view, setView] = useState<View>('route');
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [selection, setSelection] = useState<NetworkSelection | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [closing, setClosing] = useState(false);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<RouteSort>('name');

  const { select, clear } = useContextSelection();

  // Deep-link prefill: the world map links here as `/network?from=EHAM&to=LEBL` so
  // the "Open a route" form arrives filled in. Read from the URL rather than a
  // router hook, so a bare-rendered test needs no Router around the page. Read once
  // at mount — the page mounts fresh when navigated to.
  const prefill = useMemo(() => {
    const params = new URLSearchParams(globalThis.location?.search ?? '');
    return {
      from: (params.get('from') ?? '').toUpperCase().slice(0, 4),
      to: (params.get('to') ?? '').toUpperCase().slice(0, 4),
    };
  }, []);
  const prefillFrom = prefill.from;
  const prefillTo = prefill.to;

  const load = useCallback(async () => {
    try {
      setRoutes(await fetchRoutes());
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let live = true;
    void fetchFleetAirframes()
      .then((response) => {
        if (live) setFleet(response.airframes);
      })
      .catch(() => {
        /* no fleet yet, or not signed in — the planner shows the pool row only. */
      });
    return () => {
      live = false;
    };
  }, []);

  const aircraft = useMemo(() => plannerAircraft(fleet), [fleet]);
  const editor = useScheduleEditor(routes ?? [], aircraft);

  /*
   * Lay what the server already holds on the timeline (IMPROVE-04).
   *
   * Before this, a reload regenerated the mock draft and the player's published
   * rotations were invisible on the tab that authored them — so "Published" was
   * followed by a page that had forgotten. Fetched once, then restored per
   * route; the editor's own seeding leaves a restored route alone because it is
   * no longer empty.
   *
   * A route with no saved rotation keeps the generated first draft, which is
   * still the right starting point: the planner's job is to propose something
   * to edit, and an empty timeline proposes nothing.
   *
   * Failures are silent on purpose. An unauthenticated visitor and a player with
   * no schedules are indistinguishable here and neither is a problem worth an
   * alert on a page that otherwise works — a *save* that fails is loud, which is
   * the direction that matters.
   */
  useEffect(() => {
    let live = true;
    void fetchSchedules()
      .then((schedules) => {
        if (!live) return;
        for (const [routeId, restored] of restoreFromSchedules(schedules)) {
          editor.restore(routeId, restored.flights, restored.frequency, restored.scheduleIds);
        }
      })
      .catch(() => {
        /* no schedules yet, or not signed in — the generated draft stands. */
      });
    return () => {
      live = false;
    };
    // Once, on mount. `editor.restore` is stable, and the fetch must not re-run
    // when a draft changes — restoring over a live edit would discard it.
  }, []);

  // Base plans hold the stable mock (demand, slots, competitors, unit economics); the
  // live layer overlays the editor's current flights/frequency and recomputes the
  // economics from them, so every tab reflects the schedule as it is being edited.
  const basePlans = useMemo(
    () => (routes ?? []).map((route) => buildRoutePlan(route, aircraft)),
    [routes, aircraft],
  );
  const livePlans = useMemo(
    () =>
      basePlans.map((base) => {
        const flights = editor.flightsFor(base.route.id);
        const withLive = { ...base, flights, frequency: editor.frequencyFor(base.route.id) };
        return { ...withLive, economics: liveEconomics(withLive, flights) };
      }),
    [basePlans, editor],
  );
  const planById = useMemo(
    () => new Map(livePlans.map((plan) => [plan.route.id, plan])),
    [livePlans],
  );
  const allFlights = useMemo(() => livePlans.flatMap((plan) => plan.flights), [livePlans]);
  const currentPlan = selectedRouteId !== null ? (planById.get(selectedRouteId) ?? null) : null;

  // The airports the airline flies from and to — the ones whose slots are worth
  // managing. Slots are held at an airport, so this is the Slots view's context.
  const operatedAirports = useMemo(() => {
    const codes = new Set<string>();
    for (const route of routes ?? []) {
      codes.add(route.originIcao);
      codes.add(route.destinationIcao);
    }
    return [...codes];
  }, [routes]);

  // Land on the first route once they load.
  useEffect(() => {
    if (routes !== null && routes.length > 0 && selectedRouteId === null) {
      setSelectedRouteId(routes[0]?.id ?? null);
    }
  }, [routes, selectedRouteId]);

  // The panel defaults to the selected route, and clears when the whole-fleet view
  // takes over until a flight or aircraft is picked there.
  useEffect(() => {
    if (view === 'route' && selectedRouteId !== null) {
      setSelection({ kind: 'route', id: selectedRouteId });
    } else if (view === 'fleet') {
      setSelection(null);
    }
  }, [view, selectedRouteId]);

  // Push the selection into the shell's context panel, and rebuild it when the
  // underlying plan changes (a frequency edit). Cleared on unmount so a route's
  // detail does not linger over the next page.
  useEffect(() => {
    const planForContext = currentPlan ?? livePlans[0];
    if (selection === null || planForContext === undefined) {
      clear();
      return;
    }
    const described = describeSelection(selection, planForContext, aircraft, allFlights, {
      addRotation: (aircraftId, hour) => {
        const frame = aircraft.find((a) => a.id === aircraftId);
        if (frame) editor.addRotation(planForContext.route, frame, hour);
      },
      removeFlight: (flightId) => {
        editor.removeFlight(planForContext.route.id, flightId);
      },
      reassignFlight: (flightId, aircraftId) => {
        const flight = allFlights.find((f) => f.id === flightId);
        if (flight)
          editor.moveFlight(planForContext.route.id, flightId, flight.departureMinute, aircraftId);
      },
      removeAircraft: (aircraftId) => {
        editor.removeAircraft(planForContext.route.id, aircraftId);
      },
    });
    if (described === null) {
      clear();
      return;
    }
    select({
      kind: selection.kind,
      id: selection.id,
      title: described.title,
      subtitle: described.subtitle,
      body: described.body,
      onClear: () => {
        setSelection(null);
      },
    });
  }, [selection, currentPlan, livePlans, aircraft, allFlights, editor, select, clear]);

  useEffect(() => () => clear(), [clear]);

  /**
   * Ask before throwing away an unpublished draft (UX-05).
   *
   * The editor has tracked a per-route dirty flag since it was built and shown
   * an "Unsaved" chip from it, and that was all it did — clicking another route
   * discarded the edits with no warning. Since IMPROVE-04 made Publish actually
   * persist, a player reasonably believes a draft is saveable, which makes
   * silently discarding one a bigger betrayal than it was when nothing saved.
   *
   * Scoped to the route being edited rather than to "any route is dirty": a
   * player switching *away* from a clean route should not be asked about edits
   * they are not leaving.
   */
  const dirtyHere = selectedRouteId !== null && editor.isDirty(selectedRouteId);
  const guard = useUnsavedGuard(
    dirtyHere,
    'This route has unpublished changes. Leave without publishing them?',
  );

  const selectRoute = useCallback(
    (id: string) => {
      if (id === selectedRouteId) return;
      if (!guard.confirmLeave()) return;
      setView('route');
      setSelectedRouteId(id);
      setConfirmClose(false);
    },
    [guard, selectedRouteId],
  );

  /**
   * The tab switch, guarded too.
   *
   * The case a router blocker would not catch, and the one a player hits most
   * often: the Schedule tab's draft is lost by clicking "Pricing", which does
   * not change the URL at all.
   */
  const selectTab = useCallback(
    (next: Tab) => {
      if (next === tab) return;
      if (tab === 'schedule' && !guard.confirmLeave()) return;
      setTab(next);
    },
    [guard, tab],
  );

  const onCloseRoute = useCallback(async () => {
    if (selectedRouteId === null) return;
    setClosing(true);
    try {
      const outcome = await closeRoute(selectedRouteId);
      if (outcome.ok) {
        const remaining = (routes ?? []).filter((r) => r.id !== selectedRouteId);
        setRoutes(remaining);
        setSelectedRouteId(remaining[0]?.id ?? null);
        setSelection(remaining[0] ? { kind: 'route', id: remaining[0].id } : null);
      }
    } catch {
      /* leave the route in place; a transient failure is not a close. */
    } finally {
      setClosing(false);
      setConfirmClose(false);
    }
  }, [selectedRouteId, routes]);

  const onToggleActive = useCallback(async () => {
    if (selectedRouteId === null) return;
    const row = (routes ?? []).find((r) => r.id === selectedRouteId);
    if (!row) return;
    const next = !row.active;
    const outcome = await setRouteActive(selectedRouteId, next);
    if (outcome.ok) {
      setRoutes((current) =>
        (current ?? []).map((r) => (r.id === selectedRouteId ? { ...r, active: next } : r)),
      );
    }
  }, [selectedRouteId, routes]);

  // The rail's route list: filtered by an ICAO search and sorted by the chosen key.
  const railPlans = useMemo(() => {
    const needle = search.trim().toUpperCase();
    const filtered = needle
      ? livePlans.filter(
          (p) => p.route.originIcao.includes(needle) || p.route.destinationIcao.includes(needle),
        )
      : livePlans;
    const profit = (p: (typeof livePlans)[number]) =>
      p.economics.weeklyRevenueMinor - p.economics.weeklyCostMinor;
    return [...filtered].sort((a, b) => {
      if (sort === 'profit') return profit(b) - profit(a);
      if (sort === 'load') return b.economics.loadFactor - a.economics.loadFactor;
      if (sort === 'distance') return b.route.greatCircleNm - a.route.greatCircleNm;
      return `${a.route.originIcao}${a.route.destinationIcao}`.localeCompare(
        `${b.route.originIcao}${b.route.destinationIcao}`,
      );
    });
  }, [livePlans, search, sort]);

  return (
    <section className="page net-page">
      <header className="net-page__head">
        <div>
          <h1 className="page__title">Network</h1>
          <p className="net-page__sub">
            {routes === null ? 'Loading…' : `${String(routes.length)} routes`}
          </p>
        </div>
        <Segmented
          label="Workspace view"
          value={view}
          onChange={setView}
          options={[
            { value: 'route', label: 'Route planner' },
            { value: 'fleet', label: 'Fleet schedule' },
            { value: 'connections', label: 'Connections' },
            { value: 'slots', label: 'Slots' },
          ]}
        />
      </header>

      {failed && <StateBlock kind="broken">Could not load your routes.</StateBlock>}

      <div className="net-layout">
        <aside className="net-rail" aria-label="Routes">
          <div className="net-rail__open">
            <h2 className="net-rail__title">Open a route</h2>
            <OpenRouteForm
              key={`${prefillFrom}:${prefillTo}`}
              initialOrigin={prefillFrom}
              initialDestination={prefillTo}
              onOpened={(id) => {
                void load();
                selectRoute(id);
              }}
            />
          </div>

          <button
            type="button"
            className={`net-rail__fleet${view === 'fleet' ? ' net-rail__fleet--active' : ''}`}
            onClick={() => {
              setView('fleet');
            }}
          >
            <span className="net-rail__fleet-glyph" aria-hidden="true">
              ⛴
            </span>
            Fleet schedule
          </button>

          <div className="net-rail__list-head">Routes</div>
          {livePlans.length > 1 && (
            <div className="net-rail__filter">
              <input
                type="search"
                className="net-rail__search"
                placeholder="Search ICAO…"
                value={search}
                aria-label="Search routes by ICAO"
                onChange={(event) => {
                  setSearch(event.target.value);
                }}
              />
              <label className="net-rail__sort">
                <span className="visually-hidden">Sort routes</span>
                <select
                  value={sort}
                  onChange={(event) => {
                    setSort(event.target.value as RouteSort);
                  }}
                >
                  {SORTS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          <ul className="net-rail__list">
            {railPlans.map((plan) => {
              const isActive = view === 'route' && plan.route.id === selectedRouteId;
              return (
                <li key={plan.route.id}>
                  <button
                    type="button"
                    className={`net-rail__route${isActive ? ' net-rail__route--active' : ''}${
                      plan.route.active ? '' : ' net-rail__route--paused'
                    }`}
                    onClick={() => {
                      selectRoute(plan.route.id);
                    }}
                  >
                    <span className="net-rail__route-pair">
                      <span>{plan.route.originIcao}</span>
                      <span className="net-rail__route-arrow" aria-hidden="true">
                        →
                      </span>
                      <span>{plan.route.destinationIcao}</span>
                    </span>
                    <span className="net-rail__route-meta figure">
                      {plan.economics.weeklyFrequency}× · {plan.route.greatCircleNm.toFixed(0)} nm
                    </span>
                  </button>
                </li>
              );
            })}
            {routes !== null && routes.length === 0 && (
              <li className="net-rail__empty">No routes yet.</li>
            )}
            {routes !== null && routes.length > 0 && railPlans.length === 0 && (
              <li className="net-rail__empty">No route matches “{search}”.</li>
            )}
          </ul>
        </aside>

        <div className="net-main">
          {view === 'slots' ? (
            <AirportSlotsView airports={operatedAirports} />
          ) : view === 'connections' ? (
            <HubConnectionsView />
          ) : view === 'fleet' ? (
            <FleetScheduleView
              plans={livePlans}
              aircraft={aircraft}
              selection={selection}
              onSelect={setSelection}
            />
          ) : currentPlan ? (
            <>
              <div className="net-route__header">
                <h2 className="net-route__pair">
                  {currentPlan.route.originIcao} → {currentPlan.route.destinationIcao}
                </h2>
                <span className="net-route__distance figure">
                  {currentPlan.route.greatCircleNm.toFixed(0)} nm
                </span>
                <Chip tone={currentPlan.route.active ? 'positive' : 'neutral'}>
                  {currentPlan.route.active ? 'Active' : 'Paused'}
                </Chip>
                <div className="net-route__actions">
                  {!confirmClose && (
                    <button
                      type="button"
                      className="net-route__close"
                      onClick={() => void onToggleActive()}
                    >
                      {currentPlan.route.active ? 'Pause' : 'Reopen'}
                    </button>
                  )}
                  {confirmClose ? (
                    <>
                      <span className="net-route__confirm">Close this route?</span>
                      <button
                        type="button"
                        className="net-route__close net-route__close--danger"
                        disabled={closing}
                        onClick={() => void onCloseRoute()}
                      >
                        {closing ? 'Closing…' : 'Close route'}
                      </button>
                      <button
                        type="button"
                        className="net-route__close"
                        onClick={() => {
                          setConfirmClose(false);
                        }}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="net-route__close"
                      onClick={() => {
                        setConfirmClose(true);
                      }}
                    >
                      Close route
                    </button>
                  )}
                </div>
              </div>

              <Segmented label="Route tabs" value={tab} onChange={selectTab} options={TABS} />

              <div className="net-tabpanel">
                {tab === 'overview' && <OverviewTab plan={currentPlan} />}
                {tab === 'schedule' && (
                  <>
                    <RotationPublisher
                      seedOrigin={currentPlan.route.originIcao}
                      seedDestination={currentPlan.route.destinationIcao}
                    />
                    <ScheduleTab
                      plan={currentPlan}
                      aircraft={aircraft}
                      selection={selection}
                      onSelect={setSelection}
                      editor={editor}
                    />
                  </>
                )}
                {tab === 'pricing' && <PricingTab route={currentPlan.route} />}
                {tab === 'competition' && <CompetitionTab routeId={currentPlan.route.id} />}
                {tab === 'performance' && <PerformanceTab routeId={currentPlan.route.id} />}
              </div>
            </>
          ) : (
            <div className="net-empty">
              <h2 className="net-empty__title">No routes yet</h2>
              <p className="net-empty__note">
                Open your first route with the form on the left, and it becomes a full planning
                workspace here — schedule, pricing, competition and performance.
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
