import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import type { AuthenticatedPlayer, SignInProvider } from '@tailfin/shared';

import { fetchMe, postSignOut, postSignOutEverywhere } from './api';

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
  /** Providers this instance actually has credentials for (AUTH-08). */
  signInProviders: SignInProvider[];
  /**
   * Whether this player may open the admin console.
   *
   * Used to decide whether to *offer* it. What protects it is `requireAdmin` on
   * the server, which every admin route carries — a client that flipped this to
   * true would reach a console that answers 403 to everything.
   */
  isAdmin: boolean;
  signOut: () => Promise<void>;
  signOutEverywhere: () => Promise<void>;
  refresh: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

/**
 * Where signing out goes, and why it has to be a whole page load.
 *
 * `/` is the public landing page for anyone without a session cookie (ADR-0028),
 * and it is a **static document served by Fastify** — not a route in this bundle.
 * So a client-side `navigate('/')` would not reach it: it would stay inside the
 * already-loaded SPA, hit `IndexRedirect`, and leave the signed-out player
 * looking at the login wall on whichever page they happened to be on. Only a
 * document navigation leaves the application.
 *
 * Throwing the whole in-memory tree away is a feature rather than a cost. A
 * shared machine should not keep the previous player's airline, cash position
 * and route list one back-button press away in a React tree that merely stopped
 * rendering them.
 *
 * The cookie is cleared by the request this follows. If that request failed, `/`
 * still sees a cookie and serves the SPA — whose own session check then shows
 * the login wall. Degrading to exactly the old behaviour is the right failure.
 */
function leaveForTheFrontDoor(): void {
  window.location.assign('/');
}

export function SessionProvider({ children }: { children: ReactNode }): ReactNode {
  const [status, setStatus] = useState<SessionStatus>('loading');
  const [player, setPlayer] = useState<AuthenticatedPlayer | null>(null);
  const [registrationOpen, setRegistrationOpen] = useState(false);
  const [signInProviders, setSignInProviders] = useState<SignInProvider[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const me = await fetchMe();
      setPlayer(me.player);
      setRegistrationOpen(me.registrationOpen);
      setSignInProviders(me.signInProviders ?? []);
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

  /**
   * Forget the player and leave, whatever the server said.
   *
   * State clears **before** the navigation, not instead of it: if the document
   * load is blocked or slow, what stays on screen must already be the signed-out
   * shell rather than the previous player's airline.
   */
  const forgetAndLeave = useCallback(() => {
    setPlayer(null);
    // Cleared with the player, not left behind. An admin who signs out on a
    // shared machine must not leave the console door visibly ajar.
    setIsAdmin(false);
    setStatus('anonymous');
    leaveForTheFrontDoor();
  }, []);

  const signOut = useCallback(async () => {
    try {
      await postSignOut();
    } catch {
      /*
       * Swallowed, and this is the honest handling rather than the lazy one.
       *
       * Both call sites are `void signOut()`, so rethrowing produced an
       * unhandled rejection and nothing else — no message, no retry, and a
       * console error the post-deploy smoke counts as a browser error.
       *
       * There is also nothing to tell the player here that leaving does not tell
       * them better. A refused sign-out may leave the cookie alive, and `/` then
       * serves the application rather than the landing page — so a sign-out that
       * did not take shows itself as *still being signed in*, which is the
       * accurate signal. A swallowed error with a cleared rail would be the
       * misleading one.
       */
    }
    forgetAndLeave();
  }, [forgetAndLeave]);

  const signOutEverywhere = useCallback(async () => {
    try {
      await postSignOutEverywhere();
    } catch {
      // As above.
    }
    forgetAndLeave();
  }, [forgetAndLeave]);

  const value = useMemo(
    () => ({
      status,
      player,
      registrationOpen,
      signInProviders,
      isAdmin,
      signOut,
      signOutEverywhere,
      refresh,
    }),
    [
      status,
      player,
      registrationOpen,
      signInProviders,
      isAdmin,
      signOut,
      signOutEverywhere,
      refresh,
    ],
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
