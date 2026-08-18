import { useEffect, useState } from 'react';

import type { AdminAlert, AdminGrantSummary, AdminOverviewResponse } from '@tailfin/shared';

import { fetchAdmins, fetchOverview } from './api';

import type { ReactNode } from 'react';

/**
 * The console's front page (M1A-07).
 *
 * Answers one question — *is anything wrong?* — and does it above the fold.
 * Counts, then anything that wants attention, then who can get in here.
 *
 * The alerts come from the server already decided. Whether a backup is overdue is
 * a judgement about the state of the system, and §21 puts those on the server;
 * the browser's job is to render them, not to work out when to worry.
 */

type Load<T> = { state: 'loading' } | { state: 'ready'; value: T } | { state: 'failed' };

function Stat({ label, value, warn }: { label: string; value: number; warn?: boolean }): ReactNode {
  return (
    <div className={warn ? 'stat stat--warn' : 'stat'}>
      <span className="stat__value figure">{value.toLocaleString('en-US')}</span>
      <span className="stat__label">{label}</span>
    </div>
  );
}

function Alert({ alert }: { alert: AdminAlert }): ReactNode {
  return (
    <li className={`alert alert--${alert.severity}`}>
      <span className="alert__message">{alert.message}</span>
      {alert.detail !== null && <span className="alert__detail">{alert.detail}</span>}
    </li>
  );
}

/** `2026-08-18 14:07` — UTC, matching the badge and every log line. */
function formatAt(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

export function OverviewPage(): ReactNode {
  const [overview, setOverview] = useState<Load<AdminOverviewResponse>>({ state: 'loading' });
  const [admins, setAdmins] = useState<Load<AdminGrantSummary[]>>({ state: 'loading' });

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const value = await fetchOverview();
        if (!cancelled) setOverview({ state: 'ready', value });
      } catch {
        if (!cancelled) setOverview({ state: 'failed' });
      }
    })();

    void (async () => {
      try {
        const value = await fetchAdmins();
        if (!cancelled) setAdmins({ state: 'ready', value });
      } catch {
        if (!cancelled) setAdmins({ state: 'failed' });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <section className="admin__section">
        <h2 className="admin__heading">At a glance</h2>
        {overview.state === 'loading' && <p className="admin__note">Loading…</p>}
        {overview.state === 'failed' && (
          <p className="admin__note" role="alert">
            Could not load the overview.
          </p>
        )}
        {overview.state === 'ready' && (
          <div className="stats">
            <Stat label="Players" value={overview.value.counts.players} />
            <Stat
              label="Worlds"
              value={overview.value.counts.worlds}
              warn={overview.value.counts.worlds === 0}
            />
            <Stat label="Administrators" value={overview.value.counts.admins} />
            {/* Zero here is the shape of a real incident, not an empty state — dev
                lost its whole airport dataset to a misdirected test run and nobody
                saw it for hours. */}
            <Stat
              label="Airports"
              value={overview.value.counts.airports}
              warn={overview.value.counts.airports === 0}
            />
            <Stat label="Audit entries" value={overview.value.counts.auditEntries} />
          </div>
        )}
      </section>

      <section className="admin__section">
        <h2 className="admin__heading">Alerts</h2>
        {overview.state === 'ready' &&
          (overview.value.alerts.length === 0 ? (
            // Silence has to mean silence, or the panel stops being read.
            <p className="admin__note">Nothing wants attention.</p>
          ) : (
            <ul className="alerts">
              {overview.value.alerts.map((alert) => (
                <Alert key={alert.code} alert={alert} />
              ))}
            </ul>
          ))}
        {overview.state === 'ready' && (
          <p className="admin__note">
            {overview.value.backup === null
              ? 'No backup result has been recorded on this instance.'
              : `Last backup ${formatAt(overview.value.backup.finishedAt)} UTC — ${
                  overview.value.backup.result
                }, ${String(overview.value.backup.uploaded)} uploaded off-box.`}
          </p>
        )}
      </section>

      <section className="admin__section">
        <h2 className="admin__heading">Administrators</h2>
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

      <section className="admin__section">
        <h2 className="admin__heading">Not built yet</h2>
        <ul className="admin__todo">
          <li>Browse players and airlines — M1A-05</li>
          <li>World health, tick loop and queue depth — M1A-06</li>
          <li>Deployment and version visibility — OPS-02</li>
        </ul>
      </section>
    </>
  );
}
