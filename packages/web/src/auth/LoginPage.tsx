import type { SignInProvider } from '@tailfin/shared';

import { BuildBadge } from '../version/BuildBadge';

import { signInPathFor } from './api';
import { messageFor, useAuthError } from './authError';
import { useSession } from './SessionProvider';

import type { ReactNode } from 'react';

/**
 * How each provider is named and marked on the door.
 *
 * Total maps over `SignInProvider`, so a provider added in `@tailfin/shared`
 * without deciding its label here is a compile error rather than a button
 * reading "Continue with undefined".
 *
 * The glyphs are the existing typographic marks rather than brand logos:
 * reproducing Google's and Discord's marks correctly means their brand
 * guidelines, their exact assets and their colours, which is a licensing
 * question and a second visual language on a page that has one.
 */
const PROVIDER_LABEL: Record<SignInProvider, string> = {
  google: 'Google',
  discord: 'Discord',
};

const PROVIDER_GLYPH: Record<SignInProvider, string> = {
  google: '⌾',
  discord: '◈',
};

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
  const { registrationOpen, signInProviders } = useSession();
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

        {signInProviders.length === 0 ? (
          // A real state, not an error: production runs this build with no OAuth
          // client of its own. Saying so is better than a button that 503s.
          <p className="login__note" role="status">
            Sign-in is not configured on this server yet.
          </p>
        ) : (
          signInProviders.map((provider) => (
            <a key={provider} className="login__button" href={signInPathFor(provider)}>
              <span className="login__glyph" aria-hidden="true">
                {PROVIDER_GLYPH[provider]}
              </span>
              <span>Continue with {PROVIDER_LABEL[provider]}</span>
            </a>
          ))
        )}

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
