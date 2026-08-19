import { Link } from 'react-router';

import { WorldHealth } from './WorldHealth';
import { WorldsPanel } from './WorldsPanel';

import type { ReactNode } from 'react';

/**
 * Worlds (M1A-07).
 *
 * The audit log used to sit under here, on the theory that reading it next to the
 * control that wrote to it was the point. It has its own section now: the log
 * records every admin action rather than only the ones about worlds, and burying
 * a global record under one section's controls understated what it is.
 */
export function WorldsPage(): ReactNode {
  return (
    <>
      <WorldHealth />

      <WorldsPanel />

      <section className="admin__section">
        <p className="admin__note">
          Every change made here is recorded in the <Link to="/admin/audit">audit log</Link>, which
          nobody can edit or remove — including whoever made the change.
        </p>
      </section>
    </>
  );
}
