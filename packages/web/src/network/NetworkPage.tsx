import { useCallback, useEffect, useMemo, useState } from 'react';

import type { FleetAirframeView } from '@tailfin/shared';

import { fetchFleetAirframes } from '../fleet/api';
import { useContextSelection } from '../shell/context-selection';

import { closeRoute, fetchRoutes, type RouteSummary } from './api';
import { CompetitionTab } from './planner/CompetitionTab';
import { describeSelection } from './planner/ContextBodies';
import { FleetScheduleView } from './planner/FleetScheduleView';
import { buildRoutePlan, plannerAircraft } from './planner/mock';
import { OpenRouteForm } from './planner/OpenRouteForm';
import { OverviewTab } from './planner/OverviewTab';
import { PerformanceTab } from './planner/PerformanceTab';
import { PricingTab } from './planner/PricingTab';
import { ScheduleTab } from './planner/ScheduleTab';
import { Chip, Segmented } from './planner/ui';

import type { Frequency, NetworkSelection } from './planner/types';
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
  const [frequencies, setFrequencies] = useState<Record<string, Frequency>>({});
  const [view, setView] = useState<View>('route');
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [selection, setSelection] = useState<NetworkSelection | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [closing, setClosing] = useState(false);

  const { select, clear } = useContextSelection();

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
  const plans = useMemo(
    () =>
      (routes ?? []).map((route) =>
        buildRoutePlan(route, aircraft, frequencies[route.id] ?? { kind: 'daily' }),
      ),
    [routes, aircraft, frequencies],
  );
  const planById = useMemo(() => new Map(plans.map((plan) => [plan.route.id, plan])), [plans]);
  const allFlights = useMemo(() => plans.flatMap((plan) => plan.flights), [plans]);
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
    const planForContext = currentPlan ?? plans[0];
    if (selection === null || planForContext === undefined) {
      clear();
      return;
    }
    const described = describeSelection(selection, planForContext, aircraft, allFlights);
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
  }, [selection, currentPlan, plans, aircraft, allFlights, select, clear]);

  useEffect(() => () => clear(), [clear]);

  const setFrequency = useCallback(
    (frequency: Frequency) => {
      if (selectedRouteId === null) return;
      setFrequencies((current) => ({ ...current, [selectedRouteId]: frequency }));
    },
    [selectedRouteId],
  );

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
          <ul className="net-rail__list">
            {plans.map((plan) => {
              const isActive = view === 'route' && plan.route.id === selectedRouteId;
              return (
                <li key={plan.route.id}>
                  <button
                    type="button"
                    className={`net-rail__route${isActive ? ' net-rail__route--active' : ''}`}
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
          </ul>
        </aside>

        <div className="net-main">
          {view === 'fleet' ? (
            <FleetScheduleView
              plans={plans}
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
                    onSetFrequency={setFrequency}
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
