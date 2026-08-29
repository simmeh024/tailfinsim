import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';

import type { AdminAlert, AdminGrantSummary, AdminOverviewResponse } from '@tailfin/shared';

import { fetchAdmins, fetchOverview } from './api';
import { Ago, usePolledData } from './polling';

import type { ReactNode } from 'react';

/**
 * The console's front page (M1A-07).
 *
 * Answers one question — *is anything wrong?* — and does it above the fold.
 * System status first, then the counts, then anything that wants attention.
 *
 * The alerts come from the server already decided. Whether a backup is overdue is
 * a judgement about the state of the system, and §21 puts those on the server;
 * the browser's job is to render them, not to work out when to worry.
 *
 * ## What the page owns, and what it does not
 *
 * Severity and staleness are the server's. **Where to go about it** is the
 * client's, because a route is a client fact — so the alert-to-action map below
 * keys on `alert.code`, which is stable and exists precisely so an alert can be
 * recognised without matching on prose.
 */

type Load<T> = { state: 'loading' } | { state: 'ready'; value: T } | { state: 'failed' };

/* ------------------------------------------------------------- statuses ---- */

type Tone = 'ok' | 'warn' | 'bad' | 'idle';

/**
 * Status colour is never the only signal (H.4, H.7).
 *
 * Each tone carries a glyph, so the meaning survives greyscale, colour
 * blindness and a monochrome print — the same rule `.status--*` follows in the
 * game's chrome.
 */
const TONE_GLYPH: Record<Tone, string> = { ok: '✔', warn: '▲', bad: '✕', idle: '—' };

function StatusRow({
  label,
  tone,
  headline,
  detail,
}: {
  label: string;
  tone: Tone;
  headline: string;
  detail?: ReactNode;
}): ReactNode {
  return (
    <div className={`sysrow sysrow--${tone}`}>
      <span className="sysrow__glyph" aria-hidden="true">
        {TONE_GLYPH[tone]}
      </span>
      <div className="sysrow__body">
        <span className="sysrow__label">{label}</span>
        <span className="sysrow__headline">{headline}</span>
        {detail !== undefined && <span className="sysrow__detail">{detail}</span>}
      </div>
    </div>
  );
}

/** Whole hours between two instants, or null when the input is not a date. */
function hoursSince(iso: string, now: number): number | null {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? (now - at) / 3_600_000 : null;
}

/**
 * The backup, keyed on **age** rather than on result.
 *
 * A run that succeeded nine days ago reads as "ok" if you only look at the
 * result field, and it is not ok. The server raises an alert past its own
 * threshold; this says the same thing in the place somebody is already looking.
 */
function backupRow(backup: AdminOverviewResponse['backup'], now: number): ReactNode {
  if (backup === null) {
    return (
      <StatusRow
        label="Backup"
        tone="warn"
        headline="Never recorded"
        detail="Either backups have never run here, or the status file is missing."
      />
    );
  }

  const age = hoursSince(backup.finishedAt, now);
  const failed = backup.result === 'failed';
  const stale = age !== null && age > 30;

  return (
    <StatusRow
      label="Backup"
      tone={failed || stale ? 'bad' : 'ok'}
      headline={
        failed
          ? 'Last run failed'
          : age === null
            ? 'Completed'
            : age < 1
              ? 'Completed under an hour ago'
              : `Completed ${String(Math.floor(age))}h ago`
      }
      detail={`${formatAt(backup.finishedAt)} UTC · ${String(backup.uploaded)} uploaded off-box · ${backup.databases}`}
    />
  );
}

/**
 * The engine, inferred from the queue.
 *
 * Nothing drains the event queue in any environment — `createTickLoop` and
 * `drainDueEvents` are called by no process — so the honest reading is almost
 * always "not running", and saying so is the point. A console that reports
 * counts and alerts without this looks healthy while the world is stopped.
 */
function engineRow(engine: AdminOverviewResponse['engine']): ReactNode {
  const { pendingEvents, lastProcessedAt } = engine;

  if (lastProcessedAt === null && pendingEvents === 0) {
    return (
      <StatusRow
        label="Engine"
        tone="idle"
        headline="Nothing has run"
        detail="The queue is empty and no event has ever been handled. Nothing drains it yet — OPS-08."
      />
    );
  }

  if (lastProcessedAt === null) {
    return (
      <StatusRow
        label="Engine"
        tone="bad"
        headline={`${pendingEvents.toLocaleString('en-US')} events queued, none handled`}
        detail="Work is accumulating and nothing is draining it."
      />
    );
  }

  return (
    <StatusRow
      label="Engine"
      tone={pendingEvents > 0 ? 'warn' : 'ok'}
      headline={
        pendingEvents === 0
          ? 'Queue empty'
          : `${pendingEvents.toLocaleString('en-US')} events queued`
      }
      detail={
        <>
          Last handled <Ago at={Date.parse(lastProcessedAt)} />
        </>
      }
    />
  );
}

/* ---------------------------------------------------------------- stats ---- */

function Stat({
  label,
  value,
  to,
  trend,
  warn,
}: {
  label: string;
  value: number;
  to?: string;
  trend?: string;
  warn?: boolean;
}): ReactNode {
  const body = (
    <>
      <span className="stat__value figure">{value.toLocaleString('en-US')}</span>
      <span className="stat__label">{label}</span>
      {trend !== undefined && <span className="stat__trend">{trend}</span>}
    </>
  );

  // The spans sit flush against each other, so the accessible name a reader
  // would compose is "4Players+2 in 7 days". Naming the link explicitly is both
  // the readable version and the one a test can ask for.
  const name =
    trend === undefined ? `${String(value)} ${label}` : `${String(value)} ${label}, ${trend}`;

  // A tile that names a page the nav already goes to should go there. Tiles
  // without a destination stay inert rather than pretending to be clickable.
  return to === undefined ? (
    <div className={warn ? 'stat stat--warn' : 'stat'}>{body}</div>
  ) : (
    <Link
      className={warn ? 'stat stat--warn stat--link' : 'stat stat--link'}
      to={to}
      aria-label={name}
    >
      {body}
    </Link>
  );
}

/** English, for a tile whose count is one. */
function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/* --------------------------------------------------------------- alerts ---- */

/**
 * Where to go about an alert.
 *
 * Keyed on `code` because that is what the field is for. The server decides
 * that there is only one administrator; only the client knows that the place to
 * do something about it is `/admin/players`.
 *
 * An alert with no route stays a statement — better than a button that goes
 * somewhere unhelpful.
 */
const ALERT_ACTION: Record<string, { to: string; label: string }> = {
  'admin.single': { to: '/admin/players', label: 'Find a second admin' },
  'world.none': { to: '/admin/worlds', label: 'Create a world' },
};

function Alert({ alert }: { alert: AdminAlert }): ReactNode {
  const action = ALERT_ACTION[alert.code];

  return (
    <li className={`alert alert--${alert.severity}`}>
      <span className="alert__glyph" aria-hidden="true">
        {alert.severity === 'error' ? '✕' : alert.severity === 'warning' ? '▲' : 'i'}
      </span>
      <div className="alert__body">
        <span className="alert__message">{alert.message}</span>
        {alert.detail !== null && <span className="alert__detail">{alert.detail}</span>}
        {action !== undefined && (
          <Link className="alert__action" to={action.to}>
            {action.label} →
          </Link>
        )}
      </div>
    </li>
  );
}

/** `2026-08-18 14:07` — UTC, matching the badge and every log line. */
function formatAt(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/**
 * Thirty seconds (M1A-09).
 *
 * The counts move slowly and the alerts move slower — this is a status page, not
 * a live dashboard. Short enough that a backup alert appearing is noticed while
 * somebody is still looking; long enough that it is not a load.
 */
const REFRESH_MS = 30_000;

export function OverviewPage(): ReactNode {
  // The timer refreshes the overview only: one request per refresh, as the
  // criterion asks. Admin grants change rarely, are audited when they do, and
  // are re-read by the refresh button rather than every thirty seconds.
  const overview = usePolledData(fetchOverview, REFRESH_MS);
  const [admins, setAdmins] = useState<Load<AdminGrantSummary[]>>({ state: 'loading' });

  const loadAdmins = useCallback(async () => {
    try {
      setAdmins({ state: 'ready', value: await fetchAdmins() });
    } catch {
      setAdmins({ state: 'failed' });
    }
  }, []);

  useEffect(() => {
    void loadAdmins();
  }, [loadAdmins]);

  const value = overview.value;
  const now = overview.lastLoadedAt ?? Date.now();

  return (
    <>
      <div className="admin__pagehead">
        <h1 className="admin__title">Overview</h1>
        <span className="admin__freshness">
          {overview.lastLoadedAt !== null && (
            <>
              checked <Ago at={overview.lastLoadedAt} />
            </>
          )}
          <button
            className="admin__refresh"
            type="button"
            onClick={() => {
              overview.refresh();
              void loadAdmins();
            }}
          >
            Refresh
          </button>
        </span>
      </div>

      {/*
        A failed refresh keeps the numbers and says so. Blanking the page on a
        blip would turn a momentary network hiccup into an empty console —
        which is the failure this issue is mostly about.
      */}
      {overview.failed && value !== null && (
        <p className="admin__note admin__stale" role="alert">
          The last refresh failed. These figures are from <Ago at={overview.lastLoadedAt} />.
        </p>
      )}
      {overview.loading && <p className="admin__note">Loading overview…</p>}
      {overview.failed && value === null && (
        <p className="admin__note" role="alert">
          Could not load the overview.
        </p>
      )}

      {value !== null && (
        <>
          {/* Live and actionable first; reference data set apart, because a
              number that only moves when somebody runs an import does not
              belong beside one that moves on its own. */}
          <div className="stats">
            <Stat
              label={plural(value.counts.players, 'Player', 'Players')}
              value={value.counts.players}
              to="/admin/players"
              trend={
                value.trend.newPlayers7d > 0
                  ? `+${String(value.trend.newPlayers7d)} in 7 days`
                  : 'none in 7 days'
              }
            />
            <Stat
              label={plural(value.counts.worlds, 'World', 'Worlds')}
              value={value.counts.worlds}
              to="/admin/worlds"
              warn={value.counts.worlds === 0}
            />
            <Stat
              label={plural(value.counts.admins, 'Administrator', 'Administrators')}
              value={value.counts.admins}
              to="/admin/players"
            />
            <Stat
              label="Audit entries"
              value={value.counts.auditEntries}
              to="/admin/audit"
              trend={
                value.trend.auditEntries24h > 0
                  ? `${String(value.trend.auditEntries24h)} in 24 hours`
                  : 'quiet for 24 hours'
              }
            />
            <div className="stats__spacer" aria-hidden="true" />
            {/* Zero here is the shape of a real incident, not an empty state — dev
                lost its whole airport dataset to a misdirected test run and nobody
                saw it for hours. */}
            <Stat
              label="Airports"
              value={value.counts.airports}
              warn={value.counts.airports === 0}
              trend="reference data"
            />
          </div>

          <div className="admin__columns">
            <div className="admin__column">
              <section className="card">
                <h2 className="card__heading">
                  Alerts
                  {value.alerts.length > 0 && (
                    <span className="card__count">{value.alerts.length}</span>
                  )}
                </h2>
                {value.alerts.length === 0 ? (
                  // Silence has to mean silence, or the panel stops being read.
                  <p className="admin__note">Nothing wants attention.</p>
                ) : (
                  <ul className="alerts">
                    {value.alerts.map((alert) => (
                      <Alert key={alert.code} alert={alert} />
                    ))}
                  </ul>
                )}
              </section>

              <section className="card">
                <h2 className="card__heading">Administrators</h2>
                {admins.state === 'loading' && <p className="admin__note">Loading…</p>}
                {admins.state === 'failed' && (
                  <p className="admin__note" role="alert">
                    Could not load the administrator list.
                  </p>
                )}
                {admins.state === 'ready' && (
                  <table className="admin__table">
                    <thead>
                      <tr>
                        <th scope="col">Name</th>
                        <th scope="col">Granted</th>
                        <th scope="col">By</th>
                      </tr>
                    </thead>
                    <tbody>
                      {admins.value.map((entry) => (
                        <tr key={entry.playerId}>
                          <td>{entry.displayName}</td>
                          <td className="figure">{formatAt(entry.grantedAt)}</td>
                          <td>{entry.grantedByLabel ?? 'bootstrap'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>
            </div>

            <div className="admin__column admin__column--side">
              <section className="card">
                <h2 className="card__heading">System</h2>
                <div className="sysrows">
                  {backupRow(value.backup, now)}
                  {engineRow(value.engine)}
                </div>
              </section>

              <section className="card card--quiet">
                <h2 className="card__heading">Not built yet</h2>
                <ul className="admin__todo">
                  <li>Deployment and version visibility, per node — OPS-02, OPS-15</li>
                </ul>
                <p className="admin__note">
                  Players and world health used to be listed here. Both are built — a list that
                  names something already on the page is worse than no list.
                </p>
              </section>
            </div>
          </div>
        </>
      )}
    </>
  );
}
