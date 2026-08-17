import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';

import type { AuthFailureCode } from '@tailfin/shared';

import { SIGN_IN_PATH } from './api';
import { useSession } from './SessionProvider';

import type { ReactNode } from 'react';

/**
 * The account control in the left rail (M0-11).
 *
 * Minimal by intent: sign in, see who you are, sign out. Profile, worlds and
 * airline selection belong to M1 and later.
 */

/**
 * Typed as a total map over `AuthFailureCode`, so adding a code in
 * `@tailfin/shared` without a message here is a compile error rather than a
 * player seeing a raw slug.
 */
const FAILURE_MESSAGES: Record<AuthFailureCode, string> = {
  registration_closed: 'Tailfin is not open for new accounts yet.',
  state_mismatch: 'That sign-in attempt expired. Please try again.',
  provider_error: 'Google did not complete the sign-in.',
  exchange_failed: 'Sign-in could not be completed. Please try again.',
};

function messageFor(code: string): string {
  return code in FAILURE_MESSAGES
    ? FAILURE_MESSAGES[code as AuthFailureCode]
    : 'Sign-in failed. Please try again.';
}

/**
 * Lifts `?auth_error=` off the URL and clears it.
 *
 * The callback route redirects with the code in the query string, since it is a
 * server-side redirect and has nowhere else to put it. Clearing it means a
 * refresh does not resurrect a stale error, and the address bar does not carry
 * one around for the rest of the session.
 */
function useAuthError(): string | null {
  const [params, setParams] = useSearchParams();
  const [error, setError] = useState<string | null>(null);

  const fromUrl = params.get('auth_error');

  useEffect(() => {
    if (fromUrl === null) return;
    setError(fromUrl);
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete('auth_error');
        return next;
      },
      { replace: true },
    );
  }, [fromUrl, setParams]);

  return error;
}

export function AccountBadge(): ReactNode {
  const { status, player, signOut } = useSession();
  const authError = useAuthError();

  return (
    <div className="account">
      {authError !== null && (
        <p className="account__error" role="alert">
          {messageFor(authError)}
        </p>
      )}

      {status === 'loading' && (
        <p className="account__note" aria-live="polite">
          Checking sign-in…
        </p>
      )}

      {status === 'unavailable' && (
        <p className="account__note" role="alert">
          Server unreachable.
        </p>
      )}

      {status === 'anonymous' && (
        // A link, not a button: the endpoint redirects to Google, which needs a
        // top-level navigation. See SIGN_IN_PATH.
        <a className="account__signin" href={SIGN_IN_PATH}>
          <span className="account__glyph" aria-hidden="true">
            ⌾
          </span>
          <span>Sign in with Google</span>
        </a>
      )}

      {status === 'signed-in' && player && (
        <>
          <div className="account__player">
            {player.avatarUrl === null ? (
              <span className="account__avatar account__avatar--empty" aria-hidden="true">
                {player.displayName.slice(0, 1).toUpperCase()}
              </span>
            ) : (
              <img
                className="account__avatar"
                src={player.avatarUrl}
                alt=""
                width={28}
                height={28}
                // The avatar is hosted by Google; do not tell them which page it
                // was loaded from.
                referrerPolicy="no-referrer"
              />
            )}
            <span className="account__name">{player.displayName}</span>
          </div>
          <button type="button" className="account__signout" onClick={() => void signOut()}>
            Sign out
          </button>
        </>
      )}
    </div>
  );
}
