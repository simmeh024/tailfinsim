import { Link, NavLink, Outlet } from 'react-router';

import { useSession } from '../auth/SessionProvider';

import type { ReactNode } from 'react';

/**
 * The admin console's frame (M1A-07, design doc §22).
 *
 * A bar across the top rather than the game's left rail: the console is a
 * different place with a different job, and borrowing the game's chrome would
 * blur which one you are in. "Admin console" on the left is the mark that says
 * where you are, and it is also the way back to the console's front page.
 *
 * ## The refusal lives here, not in each page
 *
 * Every admin page needs the same gate, and gating page by page means every new
 * page is a chance to forget one — the first forgotten one being the bug nobody
 * notices. Doing it in the layout means a route cannot be added *without* it.
 *
 * Still a convenience rather than a boundary: `requireAdmin` on the server is
 * what protects the data, and every request these pages make is refused without
 * a grant.
 */

const SECTIONS = [
  { to: '/admin', label: 'Overview', end: true },
  { to: '/admin/worlds', label: 'Worlds', end: false },
  { to: '/admin/audit', label: 'Audit log', end: false },
];

export function AdminLayout(): ReactNode {
  const { isAdmin } = useSession();

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
    <div className="console">
      <header className="console__bar">
        {/* The mark, and the way home. Both, because a logo that is not a link is
            a dead end in every interface anyone has used. */}
        <Link className="console__mark" to="/admin">
          Admin console
        </Link>

        <nav className="console__nav" aria-label="Admin sections">
          {SECTIONS.map((section) => (
            <NavLink
              key={section.to}
              to={section.to}
              end={section.end}
              className={({ isActive }) =>
                isActive ? 'console__link console__link--active' : 'console__link'
              }
            >
              {section.label}
            </NavLink>
          ))}
        </nav>

        <Link className="console__exit" to="/world">
          Back to the world
        </Link>
      </header>

      <div className="console__body">
        <Outlet />
      </div>
    </div>
  );
}
