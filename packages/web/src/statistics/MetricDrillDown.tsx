import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router';

import type { Metric, MetricBreakdownResponse, MetricId } from '@tailfin/shared';

import { fetchBreakdown, fetchStatistics } from '../dashboard/api';
import { drillHref, formatMetric, formatTrend, trendTone } from '../dashboard/format';
import { Button } from '../ui/Button';
import { StateBlock } from '../ui/StateBlock';

import { horizonLabel, useHorizon } from './horizon';

import type { ReactNode } from 'react';

/**
 * §14.1's drill-down, as one component (SURFACE-06).
 *
 * > **Every figure drills down to its cause.** Load factor → by route → by
 * > flight → by segment → the Appendix A waterfall. A number you cannot
 * > interrogate is a number players will not trust.
 *
 * M8-09 built the API that makes a metric drillable and nothing consumed it.
 * This is the one place a metric is opened, used by every metric that has a
 * breakdown — the Finance page's headline figures and the Executive
 * dashboard's load factor and on-time rate today — so the interaction is
 * learned once rather than once per page.
 *
 * ## The interaction contract
 *
 * - **What drillable looks like**: the metric's own drill label (*"by route"*),
 *   as a button carrying `aria-expanded`. Words, not a chevron alone.
 * - **What activating it does**: the tile opens in place to the full width of
 *   its grid (`.tile:has(.drill[data-open])`), and focus moves to the
 *   breakdown's heading, so a screen reader announces the change of context.
 * - **How a breakdown is presented**: the metric's three horizons first — now,
 *   the trend over the page's period, the forecast band for the same distance —
 *   then the rows that make up the figure, biggest first, each linking to its
 *   own next rung where the server says there is one.
 * - **How a player gets back**: *Close*, or Escape anywhere inside, and focus
 *   returns to the button that opened it.
 *
 * ## Identity comes from the server's registry
 *
 * A metric is named by its `MetricId` — the server's enum — and everything
 * else about it (label, unit, polarity, description, where it drills) is read
 * from `GET /api/statistics`, which serves the registry. A caller that already
 * holds the metric passes it; one that does not (the Executive dashboard) lets
 * the component fetch it on open. There is no client table of metric labels to
 * forget a metric in.
 *
 * ## The three horizons are this component's, not each caller's
 *
 * The period comes from the page's `HorizonProvider` (§14.2, SURFACE-03); the
 * component reads the trend and forecast for it and asks the breakdown for the
 * same window, so the rows explain the figure printed beside them.
 *
 * ## A metric with no breakdown is a state, not a broken panel
 *
 * Some figures are not decomposed by the statistics API at all — revenue and
 * cost drill into the P&L, net worth into the credit standing. Those render as
 * a link to the page that explains them, or as a plain statement of where the
 * answer lives when no page consumes it yet. And a breakdown with no rows says
 * so in words: an empty table reads as *"this figure has no causes"*.
 *
 * ## Debt
 *
 * This is the **decomposition** half of a metric. Its presentation is
 * `dashboard/MetricTile`, a local component standing in for UX-03 (#464)'s *"one
 * metric component"*; the two are separated along exactly the line that issue
 * draws, so UX-03 can replace the tile without touching this. Focus and
 * announcement follow UX-10 (#471)'s disclosure pattern as far as it is
 * written; the shared table it renders is UX-06 (#467)'s to replace.
 */

const BREAKDOWN_ENDPOINT = '/api/statistics/:metricId/breakdown';

export interface MetricDrillDownProps {
  /** The metric, by the server's own id. */
  metricId: MetricId;
  /** The metric as already read from `/api/statistics`, when the caller has it. */
  metric?: Metric | null;
  /** The drill-down's label and endpoint, as the figure carries them. */
  drillDown: { endpoint: string; label: string };
}

export function MetricDrillDown({ metricId, metric, drillDown }: MetricDrillDownProps): ReactNode {
  if (drillDown.endpoint !== BREAKDOWN_ENDPOINT) {
    // Not decomposed here: say where the answer lives instead of opening an
    // empty panel (§14.1). A link when this build has a page for it.
    const href = drillHref(drillDown.endpoint);
    return href === null ? (
      <p className="tile__drill tile__drill--absent">{drillDown.label}</p>
    ) : (
      <Link className="tile__drill" to={href}>
        {drillDown.label} →
      </Link>
    );
  }
  return <Disclosure metricId={metricId} metric={metric ?? null} label={drillDown.label} />;
}

type Loaded<T> =
  { state: 'idle' } | { state: 'loading' } | { state: 'broken' } | { state: 'ready'; value: T };

function Disclosure({
  metricId,
  metric: given,
  label,
}: {
  metricId: MetricId;
  metric: Metric | null;
  label: string;
}): ReactNode {
  const horizon = useHorizon();
  const [open, setOpen] = useState(false);
  const [metric, setMetric] = useState<Loaded<Metric>>(
    given === null ? { state: 'idle' } : { state: 'ready', value: given },
  );
  const [rows, setRows] = useState<Loaded<MetricBreakdownResponse>>({ state: 'idle' });
  const trigger = useRef<HTMLButtonElement | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);
  const panelId = useId();
  const headingId = useId();

  // A caller's fresher copy of the metric wins over the one fetched on open.
  useEffect(() => {
    if (given !== null) setMetric({ state: 'ready', value: given });
  }, [given]);

  /*
   * Identity from the registry, read once, on the first open. A ref rather than
   * the state it sets as the guard: guarding on `metric.state` would re-run this
   * effect the moment it set `loading`, and that run's cleanup would discard the
   * answer still in flight.
   */
  const mounted = useRef(true);
  useEffect(() => {
    // Set here as well as initialised: StrictMode mounts, unmounts and mounts again.
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const requested = useRef(false);
  useEffect(() => {
    if (!open || given !== null || requested.current) return;
    requested.current = true;
    setMetric({ state: 'loading' });
    void fetchStatistics().then((stats) => {
      if (!mounted.current) return;
      const found = stats?.metrics.find((entry) => entry.id === metricId);
      setMetric(found === undefined ? { state: 'broken' } : { state: 'ready', value: found });
    });
  }, [open, given, metricId]);

  // The rows, over the page's period — refetched when the period changes.
  useEffect(() => {
    if (!open) return;
    let live = true;
    setRows({ state: 'loading' });
    void fetchBreakdown(metricId, horizon).then((breakdown) => {
      if (!live) return;
      setRows(breakdown === null ? { state: 'broken' } : { state: 'ready', value: breakdown });
    });
    return () => {
      live = false;
    };
  }, [open, metricId, horizon]);

  // Focus follows the change of context: into the breakdown on open.
  useEffect(() => {
    if (open) heading.current?.focus();
  }, [open]);

  const close = useCallback(() => {
    setOpen(false);
    // And back to where the player was on close (UX-10).
    trigger.current?.focus();
  }, []);

  const name = metric.state === 'ready' ? metric.value.label : null;

  return (
    <div className="drill" data-open={open}>
      <button
        ref={trigger}
        type="button"
        className="drill__trigger"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => {
          if (open) close();
          else setOpen(true);
        }}
      >
        {open ? `Close ${label}` : `${label} →`}
      </button>

      {open && (
        <section
          id={panelId}
          className="drill__panel"
          aria-labelledby={headingId}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              close();
            }
          }}
        >
          <h4 className="drill__title" id={headingId} ref={heading} tabIndex={-1}>
            {`${name ?? 'This figure'} ${label}, ${horizonLabel(horizon)}`}
          </h4>

          {metric.state === 'ready' && <Horizons metric={metric.value} horizon={horizon} />}
          {metric.state === 'broken' && (
            <StateBlock kind="broken">This metric could not be read.</StateBlock>
          )}

          <Rows
            rows={rows}
            unit={metric.state === 'ready' ? metric.value.unit : null}
            horizon={horizon}
          />

          <Button variant="tertiary" size="sm" className="drill__close" onClick={close}>
            Close
          </Button>
        </section>
      )}
    </div>
  );
}

/** §14.2's three horizons for one metric, at the page's period. */
function Horizons({ metric, horizon }: { metric: Metric; horizon: number }): ReactNode {
  const trend = metric.trends.find((entry) => entry.days === horizon);
  const forecast = metric.forecasts.find((entry) => entry.horizonDays === horizon);
  return (
    <dl className="drill__horizons">
      <div>
        <dt>Now</dt>
        <dd className="figure">{formatMetric(metric.value, metric.unit)}</dd>
      </div>
      <div>
        <dt>Trend</dt>
        <dd
          className={`figure tile__trend--${trend ? trendTone(trend, metric.polarity) : 'unknown'}`}
        >
          {trend ? formatTrend(trend, metric.unit) : 'no earlier period'}
        </dd>
      </div>
      <div>
        <dt>Forecast</dt>
        <dd className="figure">
          {/* A band, never a single number (§14.2) — and none at all without history. */}
          {forecast
            ? `${formatMetric(forecast.low, metric.unit)} – ${formatMetric(forecast.high, metric.unit)} in ${String(horizon)} days`
            : 'not enough history to forecast'}
        </dd>
      </div>
    </dl>
  );
}

/** The rows behind the figure, or which of the four states it is in. */
function Rows({
  rows,
  unit,
  horizon,
}: {
  rows: Loaded<MetricBreakdownResponse>;
  unit: Metric['unit'] | null;
  horizon: number;
}): ReactNode {
  if (rows.state === 'idle' || rows.state === 'loading') {
    return <StateBlock kind="loading">Breaking the figure down.</StateBlock>;
  }
  if (rows.state === 'broken') {
    return <StateBlock kind="broken">The breakdown could not be read.</StateBlock>;
  }
  const breakdown = rows.value;
  if (breakdown.rows.length === 0) {
    return (
      <StateBlock kind="empty">
        Nothing has flown in {horizonLabel(horizon)}, so there is nothing to break this figure into.
        Only the worker settles a flight; on a node without one this stays empty.
      </StateBlock>
    );
  }
  const shown = unit ?? 'ratio';
  const anyShare = breakdown.rows.some((row) => row.share !== null);
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">Route</th>
            <th scope="col" className="data-table__num">
              Value
            </th>
            {anyShare && (
              <th scope="col" className="data-table__num">
                Share
              </th>
            )}
            <th scope="col">Next</th>
          </tr>
        </thead>
        <tbody>
          {breakdown.rows.map((row) => {
            const next =
              row.drillDown === null
                ? null
                : drillHref(row.drillDown.endpoint, { routeId: row.key });
            return (
              <tr key={row.key}>
                <th scope="row">{row.label}</th>
                <td className="data-table__num figure">{formatMetric(row.value, shown)}</td>
                {anyShare && (
                  <td className="data-table__num figure">
                    {row.share === null ? '—' : `${(row.share * 100).toFixed(1)}%`}
                  </td>
                )}
                <td>
                  {row.drillDown === null ? (
                    // The last rung: a route since deleted has nowhere to go.
                    <span className="tile__drill--absent">end of the chain</span>
                  ) : next === null ? (
                    <span className="tile__drill--absent">{row.drillDown.label}</span>
                  ) : (
                    <Link to={next}>{row.drillDown.label}</Link>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
