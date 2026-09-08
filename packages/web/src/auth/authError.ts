import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';

import { authFailureMessage } from '@tailfin/shared';

/**
 * Turning a failed sign-in into words.
 *
 * The callback is a server-side redirect, so the only place it can put a reason
 * is the query string. This lifts it off, translates it, and tidies the URL.
 */

/**
 * The words live in `@tailfin/shared` (LANDING-04).
 *
 * They used to live here, which was fine while the login wall was the only
 * surface that had to explain a refused sign-in. The public landing page is now
 * the front door, it is a static document, and its funnel deliberately needs no
 * JavaScript — so the *server* renders the same message into the HTML. One table,
 * two renderers; two tables would have drifted invisibly, because each surface
 * looks correct on its own.
 *
 * Kept as a named export rather than replaced at every call site: this is the
 * client's word for it, and the indirection costs nothing.
 */
export const messageFor = authFailureMessage;

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
