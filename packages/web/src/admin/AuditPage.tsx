import { useEffect, useState } from 'react';

import type { AdminAuditEntry } from '@tailfin/shared';

import { fetchAdminAudit } from './api';

import type { ReactNode } from 'react';

/**
 * The audit log, on its own (M1A-07).
 *
 * It started out beneath the world controls, on the theory that reading the log
 * next to the control that wrote to it was the point. It is not: the log records
 * **every** admin action, not only the ones about worlds, and burying a global
 * record under one section's controls understates what it is. It is also the
 * thing you go looking for deliberately — after something happened, wanting to
 * know who did it — which is the definition of a destination rather than a
 * footnote.
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

export function AuditPage(): ReactNode {
  const [audit, setAudit] = useState<Load<AdminAuditEntry[]>>({ state: 'loading' });
  const [includeViews, setIncludeViews] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setAudit({ state: 'loading' });
    void (async () => {
      try {
        const value = await fetchAdminAudit(includeViews);
        if (!cancelled) setAudit({ state: 'ready', value });
      } catch {
        if (!cancelled) setAudit({ state: 'failed' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [includeViews]);

  return (
    <section className="admin__section">
      <h2 className="admin__heading">Audit log</h2>
      <p className="admin__note">
        Every action taken by an administrator, newest first. Append-only, enforced by database
        triggers that refuse UPDATE, DELETE and TRUNCATE — nothing here can be edited or removed,
        including by whoever wrote it.
      </p>

      {/*
        Views are recorded and hidden by default (M1A-08). Both halves matter:
        opening somebody's account is an act worth a record, and a log where
        "who reset the world?" is buried under three hundred page views is a log
        nobody reads at the moment it counts.
      */}
      <label className="admin__toggle" htmlFor="audit-include-views">
        <input
          id="audit-include-views"
          type="checkbox"
          checked={includeViews}
          onChange={(event) => {
            setIncludeViews(event.target.checked);
          }}
        />
        Include views
      </label>
      <p className="admin__hint">
        Looking at a player’s account is recorded too. Those entries are left out by default so they
        cannot bury the ones that changed something.
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

      {audit.state === 'ready' && audit.value.length >= 100 && (
        <p className="admin__note">
          Showing the most recent 100. Paging is not built yet, and the only filter is the one above
          — the log is capped server-side so a stray request cannot pull the whole history.
        </p>
      )}
    </section>
  );
}
