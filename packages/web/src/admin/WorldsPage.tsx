import { useEffect, useState } from 'react';

import type { AdminAuditEntry } from '@tailfin/shared';

import { fetchAdminAudit } from './api';
import { WorldsPanel } from './WorldsPanel';

import type { ReactNode } from 'react';

/**
 * Worlds, and the record of what has been done to them (M1A-07).
 *
 * The audit log sits here rather than on its own page because worlds are what
 * the console currently *does* — creating one is the only mutating action that
 * exists, and M1A-03's speed change and M1A-04's reset will join it. Reading the
 * log next to the control that wrote to it is the point.
 *
 * The log is global, not per world: it records every admin action, including
 * grants. If it grows enough to want filtering, or the console gains actions that
 * are not about worlds, it earns its own page — splitting it then is moving one
 * component.
 */

type Load<T> = { state: 'loading' } | { state: 'ready'; value: T } | { state: 'failed' };

/** `2026-08-18 14:07:03` — UTC, matching the build badge and every log line. */
function formatAt(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
}

function AuditRow({ entry }: { entry: AdminAuditEntry }): ReactNode {
  return (
    <tr>
      <td className="figure">{formatAt(entry.at)}</td>
      <td>{entry.actorLabel}</td>
      <td>
        <code className="admin__action">{entry.action}</code>
      </td>
      <td>
        {entry.subjectType}
        {entry.subjectId !== null && <span className="admin__subject"> {entry.subjectId}</span>}
      </td>
    </tr>
  );
}

export function WorldsPage(): ReactNode {
  const [audit, setAudit] = useState<Load<AdminAuditEntry[]>>({ state: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const value = await fetchAdminAudit();
        if (!cancelled) setAudit({ state: 'ready', value });
      } catch {
        if (!cancelled) setAudit({ state: 'failed' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <WorldsPanel />

      <section className="admin__section">
        <h2 className="admin__heading">Audit log</h2>
        <p className="admin__note">
          Append-only, enforced by the database. Nothing here can be edited or deleted.
        </p>
        {audit.state === 'loading' && <p className="admin__note">Loading…</p>}
        {audit.state === 'failed' && (
          <p className="admin__note" role="alert">
            Could not load the audit log.
          </p>
        )}
        {audit.state === 'ready' &&
          (audit.value.length === 0 ? (
            <p className="admin__note">Nothing recorded yet.</p>
          ) : (
            <table className="admin__table">
              <thead>
                <tr>
                  <th scope="col">When (UTC)</th>
                  <th scope="col">Who</th>
                  <th scope="col">Action</th>
                  <th scope="col">Subject</th>
                </tr>
              </thead>
              <tbody>
                {audit.value.map((entry) => (
                  <AuditRow key={entry.id} entry={entry} />
                ))}
              </tbody>
            </table>
          ))}
      </section>

      <section className="admin__section">
        <h2 className="admin__heading">Not built yet</h2>
        <ul className="admin__todo">
          <li>Change the speed multiplier of a running world — M1A-03</li>
          <li>Open, lock, archive and reset a world — M1A-04</li>
        </ul>
        <p className="admin__note">
          Worlds are reset from the command line until M1A-04 lands:{' '}
          <code className="admin__action">pnpm world:seed --reset</code>.
        </p>
      </section>
    </>
  );
}
