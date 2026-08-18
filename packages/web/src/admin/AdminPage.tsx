import { useEffect, useState } from 'react';
import { Link } from 'react-router';

import type { AdminAuditEntry, AdminGrantSummary } from '@tailfin/shared';

import { useSession } from '../auth/SessionProvider';

import { fetchAdminAudit, fetchAdmins } from './api';

import type { ReactNode } from 'react';

/**
 * The admin console (M1A-01, design doc §22).
 *
 * What exists so far is the floor the rest of the milestone stands on: who holds
 * a grant, and the record of everything anyone with one has done. Creating
 * worlds, changing the speed multiplier and resetting are M1A-02 to M1A-04.
 *
 * The unbuilt sections are **named rather than mocked up**. An admin console
 * showing a disabled "Reset world" button implies the button will work, and the
 * first person to click it and get nothing learns not to trust the page. Saying
 * plainly that it is not built yet costs nothing and misleads nobody.
 *
 * This page is a convenience, not a boundary: reaching it without a grant shows
 * the refusal below, and every request it makes is refused by the server too.
 */

type Load<T> = { state: 'loading' } | { state: 'ready'; value: T } | { state: 'failed' };

/**
 * Loads the console's data, or nothing at all.
 *
 * `enabled` rather than an early return, because a hook cannot be called
 * conditionally. It matters: without it, every stray navigation to `/admin` by
 * someone without a grant fires two requests that are certain to be refused, and
 * each one writes a warning to the server log. A page that knows it will be told
 * no should not ask.
 */
function useAdminData(enabled: boolean): {
  audit: Load<AdminAuditEntry[]>;
  admins: Load<AdminGrantSummary[]>;
} {
  const [audit, setAudit] = useState<Load<AdminAuditEntry[]>>({ state: 'loading' });
  const [admins, setAdmins] = useState<Load<AdminGrantSummary[]>>({ state: 'loading' });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    void (async () => {
      try {
        const entries = await fetchAdminAudit();
        if (!cancelled) setAudit({ state: 'ready', value: entries });
      } catch {
        if (!cancelled) setAudit({ state: 'failed' });
      }
    })();

    void (async () => {
      try {
        const list = await fetchAdmins();
        if (!cancelled) setAdmins({ state: 'ready', value: list });
      } catch {
        if (!cancelled) setAdmins({ state: 'failed' });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return { audit, admins };
}

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

export function AdminPage(): ReactNode {
  const { isAdmin } = useSession();
  const { audit, admins } = useAdminData(isAdmin);

  if (!isAdmin) {
    return (
      <section className="admin admin--refused">
        <h1 className="admin__title">Administrators only</h1>
        <p className="admin__note">
          This account does not hold an admin grant. If that is wrong, ask someone who does.
        </p>
        <Link className="admin__back" to="/world">
          Back to the world
        </Link>
      </section>
    );
  }

  return (
    <section className="admin">
      <header className="admin__header">
        <h1 className="admin__title">Admin console</h1>
        <Link className="admin__back" to="/world">
          Back to the world
        </Link>
      </header>

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
          <li>Create a world from config — M1A-02</li>
          <li>Set and change the speed multiplier — M1A-03</li>
          <li>Open, lock, archive and reset a world — M1A-04</li>
          <li>Browse players and airlines — M1A-05</li>
          <li>World health and statistics — M1A-06</li>
        </ul>
        <p className="admin__note">
          Worlds are created and reset from the command line until M1A-02 and M1A-04 land:{' '}
          <code className="admin__action">pnpm world:seed</code>.
        </p>
      </section>
    </section>
  );
}
