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
  provider_error: 'Google did not complete the sign-in.',
  exchange_failed: 'Sign-in could not be completed. Please try again.',
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
