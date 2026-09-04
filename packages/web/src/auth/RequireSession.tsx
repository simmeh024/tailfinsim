import { Button } from '../ui/Button';
import { BuildBadge } from '../version/BuildBadge';

import { LoginPage } from './LoginPage';
import { useSession } from './SessionProvider';

import type { ReactNode } from 'react';

/**
 * The login wall (M0-12).
 *
 * Four states, four different things to show, because collapsing them is what
 * makes a login screen infuriating:
 *
 *   - `loading` — a quiet holding screen. Rendering the login page here would
 *     flash "sign in" at somebody who *is* signed in, every single page load.
 *   - `unavailable` — say the server is unreachable. Showing a sign-in button
 *     that cannot possibly work invites the player to blame their own password.
 *   - `anonymous` — the front door.
 *   - `signed-in` — the app.
 *
 * This is a **user-interface** gate, not a security boundary. It stops a
 * stranger browsing the interface; it does not stop anyone fetching an API.
 * Server-side `requireAuth` is what protects data, and every route that returns
 * something worth protecting must carry it.
 */
export function RequireSession({ children }: { children: ReactNode }): ReactNode {
  const { status } = useSession();

  if (status === 'loading') {
    return (
      <div className="gate">
        <p className="gate__message" aria-live="polite">
          Checking your sign-in…
        </p>
        <BuildBadge />
      </div>
    );
  }

  if (status === 'unavailable') {
    return (
      <div className="gate">
        <div className="gate__panel" role="alert">
          <h1 className="gate__title">Cannot reach Tailfin</h1>
          <p className="gate__message">
            The server did not answer. It may be mid-deploy — this usually clears within a minute.
          </p>
          <Button
            variant="primary"
            className="gate__retry"
            onClick={() => window.location.reload()}
          >
            Try again
          </Button>
        </div>
        <BuildBadge />
      </div>
    );
  }

  if (status === 'anonymous') return <LoginPage />;

  return children;
}
