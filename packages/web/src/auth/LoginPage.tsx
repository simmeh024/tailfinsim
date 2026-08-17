import { BuildBadge } from '../version/BuildBadge';

import { SIGN_IN_PATH } from './api';
import { messageFor, useAuthError } from './authError';
import { useSession } from './SessionProvider';

import type { ReactNode } from 'react';

/**
 * The front door (M0-12).
 *
 * Everything behind it is a sealed room: `RequireSession` renders this instead
 * of the app until there is a session. Note what that is and is not — it keeps
 * the *interface* from being browsed by a stranger, and it is **not** what
 * protects data. Nothing on this page can be trusted to hold, because the
 * browser is not ours. Every route that returns anything worth protecting has to
 * carry `requireAuth` on the server; the client gate exists so that a signed-out
 * visitor sees a door instead of an empty cockpit.
 */
export function LoginPage(): ReactNode {
  const { registrationOpen } = useSession();
  const authError = useAuthError();

  return (
    <div className="login">
      <main className="login__card">
        <div className="login__brand">
          <span className="login__mark" aria-hidden="true">
            ◤
          </span>
          <span>Tailfin</span>
        </div>

        <h1 className="login__title">Run an airline</h1>
        <p className="login__lede">
          A persistent world that keeps flying whether or not you are watching. Sign in to take a
          seat.
        </p>

        {authError !== null && (
          <p className="login__error" role="alert">
            {messageFor(authError)}
          </p>
        )}

        <a className="login__button" href={SIGN_IN_PATH}>
          <span className="login__glyph" aria-hidden="true">
            ⌾
          </span>
          <span>Sign in with Google</span>
        </a>

        <p className="login__note">
          {registrationOpen
            ? 'New accounts are open. Signing in creates one.'
            : 'Tailfin is not open for new accounts yet — sign-in is limited to existing players.'}
        </p>
      </main>

      <BuildBadge />
    </div>
  );
}
