import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';

import type { AuthFailureCode } from '@tailfin/shared';

/**
 * Turning a failed sign-in into words.
 *
 * The callback is a server-side redirect, so the only place it can put a reason
 * is the query string. This lifts it off, translates it, and tidies the URL.
 */

/**
 * Typed as a total map over `AuthFailureCode`, so adding a code in
 * `@tailfin/shared` without a message here is a compile error rather than a
 * player seeing a raw slug.
 */
const FAILURE_MESSAGES: Record<AuthFailureCode, string> = {
  registration_closed: 'Tailfin is not open for new accounts yet.',
  state_mismatch: 'That sign-in attempt expired. Please try again.',
  // Provider-neutral since AUTH-08: the same code arrives from Google and
  // Discord, and the redirect carries no provider, deliberately — naming one
  // would mean trusting a query parameter to say who refused.
  provider_error: 'The sign-in was not completed.',
  exchange_failed: 'Sign-in could not be completed. Please try again.',
  // Specific about the situation, silent about the other account (AUTH-04).
  // "Please try again" would be actively wrong: repeating the attempt produces
  // the same refusal, and the two things that do work are named instead.
  identity_already_linked:
    'That account is already connected to a different Tailfin account. ' +
    'Sign out first, or connect it from your account settings.',
};

export function messageFor(code: string): string {
  return code in FAILURE_MESSAGES
    ? FAILURE_MESSAGES[code as AuthFailureCode]
    : 'Sign-in failed. Please try again.';
}

/**
 * Lifts `?auth_error=` off the URL and clears it, keeping the message.
 *
 * Clearing matters: without it a refresh resurrects a stale error, and the code
 * rides along in the address bar for the rest of the session — including into
 * any link the player copies out of it.
 */
export function useAuthError(): string | null {
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
