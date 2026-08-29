import { useCallback, useEffect, useMemo, useState } from 'react';

import type { FleetAirframeView } from '@tailfin/shared';

import { fetchFleetAirframes } from '../fleet/api';
import { useContextSelection } from '../shell/context-selection';

import { closeRoute, fetchRoutes, setRouteActive, type RouteSummary } from './api';
import { liveEconomics } from './planner/analysis';
import { CompetitionTab } from './planner/CompetitionTab';
import { describeSelection } from './planner/ContextBodies';
import { useScheduleEditor } from './planner/editor';
import { FleetScheduleView } from './planner/FleetScheduleView';
import { buildRoutePlan, plannerAircraft } from './planner/mock';
import { OpenRouteForm } from './planner/OpenRouteForm';
import { OverviewTab } from './planner/OverviewTab';
import { PerformanceTab } from './planner/PerformanceTab';
import { PricingTab } from './planner/PricingTab';
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
 * Real data: routes and fares (the endpoints that exist). Mock data, structured to
 * mirror the future endpoints (`planner/mock.ts`): the schedule, slots, competition
 * and performance surfaces — there is no M2-03 schedule API yet.
 */

type Tab = 'overview' | 'schedule' | 'pricing' | 'competition' | 'performance';
type View = 'route' | 'fleet';
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

  const selectRoute = useCallback((id: string) => {
    setView('route');
    setSelectedRouteId(id);
    setConfirmClose(false);
  }, []);

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
          ]}
        />
      </header>

      {failed && (
        <p className="page__note" role="alert">
          Could not load your routes.
        </p>
      )}

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
          {view === 'fleet' ? (
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

              <Segmented label="Route tabs" value={tab} onChange={setTab} options={TABS} />

              <div className="net-tabpanel">
                {tab === 'overview' && <OverviewTab plan={currentPlan} />}
                {tab === 'schedule' && (
                  <ScheduleTab
                    plan={currentPlan}
                    aircraft={aircraft}
                    selection={selection}
                    onSelect={setSelection}
                    editor={editor}
                  />
                )}
                {tab === 'pricing' && <PricingTab route={currentPlan.route} />}
                {tab === 'competition' && <CompetitionTab plan={currentPlan} />}
                {tab === 'performance' && <PerformanceTab plan={currentPlan} />}
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
