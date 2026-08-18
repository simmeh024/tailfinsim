import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import type { AuthenticatedPlayer } from '@tailfin/shared';

import { fetchMe, postSignOut } from './api';

import type { ReactNode } from 'react';

/**
 * Session state (M0-11).
 *
 * One `GET /api/me` on mount. The server is the only authority on who is signed
 * in — there is no client-side token to inspect, because the session cookie is
 * `httpOnly` and the client is deliberately unable to read it.
 */

export type SessionStatus =
  | 'loading'
  /** Answered, nobody signed in. */
  | 'anonymous'
  | 'signed-in'
  /**
   * `/api/me` could not be reached or did not answer sensibly. Distinct from
   * `anonymous` on purpose: "you are not signed in" and "we cannot tell" call for
   * different words, and conflating them means a server outage shows up as an
   * invitation to sign in that will not work.
   */
  | 'unavailable';

interface SessionContextValue {
  status: SessionStatus;
  player: AuthenticatedPlayer | null;
  /** Whether this instance would create an account for a new Google user. */
  registrationOpen: boolean;
  /**
   * Whether this player may open the admin console.
   *
   * Used to decide whether to *offer* it. What protects it is `requireAdmin` on
   * the server, which every admin route carries — a client that flipped this to
   * true would reach a console that answers 403 to everything.
   */
  isAdmin: boolean;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }): ReactNode {
  const [status, setStatus] = useState<SessionStatus>('loading');
  const [player, setPlayer] = useState<AuthenticatedPlayer | null>(null);
  const [registrationOpen, setRegistrationOpen] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const me = await fetchMe();
      setPlayer(me.player);
      setRegistrationOpen(me.registrationOpen);
      setIsAdmin(me.isAdmin);
      setStatus(me.player ? 'signed-in' : 'anonymous');
    } catch {
      // Not logged to the console: an unreachable API is a normal condition
      // during a deploy, and the UI already says so.
      setPlayer(null);
      setIsAdmin(false);
      setStatus('unavailable');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signOut = useCallback(async () => {
    try {
      await postSignOut();
    } finally {
      // Local state clears either way. If the request failed the cookie may
      // still be live, and `refresh` will discover that; leaving the UI claiming
      // "signed in" after the user asked to leave is the worse failure.
      setPlayer(null);
      // Cleared with the player, not left behind. An admin who signs out on a
      // shared machine must not leave the console door visibly ajar.
      setIsAdmin(false);
      setStatus('anonymous');
    }
  }, []);

  const value = useMemo(
    () => ({ status, player, registrationOpen, isAdmin, signOut, refresh }),
    [status, player, registrationOpen, isAdmin, signOut, refresh],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) {
    throw new Error('useSession must be used inside a SessionProvider');
  }
  return context;
}
