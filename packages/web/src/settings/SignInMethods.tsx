import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';

import type { SignInMethod, SignInMethodsResponse, SignInProvider } from '@tailfin/shared';

import { messageFor } from '../auth/authError';
import { useSession } from '../auth/SessionProvider';
import { StateBlock } from '../ui/StateBlock';

import type { ReactNode } from 'react';

/**
 * Connect and disconnect ways into your own account (AUTH-09).
 *
 * A section on Settings rather than a page of its own: #304 owns the account
 * page that will eventually say everything about how you get in, and a
 * half-page here would be something that has to be removed rather than moved.
 * What this needs to do today is narrow — Discord sign-in is a dead end without
 * it, because a player who signs in with a provider they have not connected is
 * now refused rather than given a second account (AUTH-04).
 */

const PROVIDER_LABEL: Record<SignInProvider, string> = {
  google: 'Google',
  discord: 'Discord',
  twitch: 'Twitch',
};

/**
 * Whether a response body is the shape this section can render.
 *
 * The same reasoning as `isMeResponse` in `auth/api.ts`: a proxy, a captive
 * portal or a stale deploy can answer 200 with something else entirely, and a
 * component that trusts the shape takes the **whole page** down with it rather
 * than showing its own broken state. This section sits above the currency
 * selector, so the blast radius was all of Settings.
 */
function isMethodsResponse(value: unknown): value is SignInMethodsResponse {
  if (typeof value !== 'object' || value === null) return false;
  const body = value as Record<string, unknown>;
  return Array.isArray(body.methods) && typeof body.canDisconnect === 'boolean';
}

function describeLastUsed(method: SignInMethod): string {
  // Null is "never", not "unknown" and not the epoch — AUTH-01 made the column
  // nullable precisely so this sentence could be true.
  if (method.lastUsedAt === null) return 'Connected, never used to sign in';
  return `Last used ${new Date(method.lastUsedAt).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })}`;
}

export function SignInMethods(): ReactNode {
  const { signInProviders } = useSession();
  const [params, setParams] = useSearchParams();

  const [methods, setMethods] = useState<SignInMethod[] | null>(null);
  const [canDisconnect, setCanDisconnect] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/me/sign-in-methods', {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      });
      if (!response.ok) throw new Error(String(response.status));
      const body: unknown = await response.json();
      if (!isMethodsResponse(body)) throw new Error('unexpected body');
      setMethods(body.methods);
      setCanDisconnect(body.canDisconnect);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * The connect flow returns here through a redirect, so its result arrives in
   * the query string. Lifted off and cleared for the same reason `useAuthError`
   * does it: without clearing, a refresh resurrects a stale message and the code
   * rides along in any link the player copies out of the address bar.
   */
  useEffect(() => {
    const linked = params.get('linked');
    const failure = params.get('link_error');
    if (linked === null && failure === null) return;

    setNotice(
      failure !== null
        ? messageFor(failure)
        : `${PROVIDER_LABEL[linked as SignInProvider] ?? linked} is now connected to this account.`,
    );
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete('linked');
        next.delete('link_error');
        return next;
      },
      { replace: true },
    );
  }, [params, setParams]);

  const disconnect = async (method: SignInMethod) => {
    setBusy(method.id);
    try {
      const response = await fetch(`/api/me/sign-in-methods/${method.id}`, {
        method: 'DELETE',
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { message?: string };
        setNotice(body.message ?? 'That sign-in method could not be disconnected.');
      } else {
        setNotice(`${PROVIDER_LABEL[method.provider]} is no longer connected.`);
      }
      await load();
    } finally {
      setBusy(null);
    }
  };

  const connected = new Set(methods?.map((method) => method.provider) ?? []);
  const connectable = signInProviders.filter((provider) => !connected.has(provider));

  return (
    <section className="settings__section" aria-labelledby="sign-in-heading">
      <h2 id="sign-in-heading">Sign-in methods</h2>
      <p className="settings__hint">
        The ways you can get into this account. Connecting another does not create a second account
        — it adds a key to this one. You cannot remove the last one.
      </p>

      {notice !== null && (
        <p className="settings__hint" role="status">
          {notice}
        </p>
      )}

      {failed ? (
        <StateBlock kind="broken">Could not load your sign-in methods.</StateBlock>
      ) : methods === null ? (
        <p className="settings__hint">Loading…</p>
      ) : (
        <ul className="settings__methods">
          {methods.map((method) => (
            <li key={method.id} className="settings__method">
              <span className="settings__method-name">{PROVIDER_LABEL[method.provider]}</span>
              <span className="settings__method-detail">
                {method.email ?? describeLastUsed(method)}
              </span>
              <button
                type="button"
                className="settings__method-action"
                disabled={!canDisconnect || busy === method.id}
                onClick={() => void disconnect(method)}
                // Says *why* it is unavailable rather than leaving a dead
                // control: an account with no way in cannot be recovered.
                title={
                  canDisconnect
                    ? `Disconnect ${PROVIDER_LABEL[method.provider]}`
                    : 'This is the only way into your account'
                }
              >
                Disconnect
              </button>
            </li>
          ))}
        </ul>
      )}

      {connectable.map((provider) => (
        // A link, not a button: the endpoint redirects to the provider's consent
        // screen, which an XHR cannot follow.
        <a key={provider} className="settings__connect" href={`/api/auth/${provider}/connect`}>
          Connect {PROVIDER_LABEL[provider]}
        </a>
      ))}
    </section>
  );
}
