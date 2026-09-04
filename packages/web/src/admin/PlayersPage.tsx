import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';

import type { AdminPlayerDetail, AdminPlayerSummary } from '@tailfin/shared';

import { StateBlock } from '../ui/StateBlock';

import { fetchPlayer, fetchPlayers, revokePlayerSessions } from './api';

import type { ReactNode } from 'react';

/**
 * Players (M1A-08, design doc §22).
 *
 * ## Read-only game state, with one security control
 *
 * There is nothing here that edits, bans, deletes or impersonates. Those are
 * M11-06. Revoking sessions is the deliberate exception: it is an immediate,
 * audited incident-response action and cannot alter game state.
 *
 * ## Looking is an act
 *
 * Opening one player's detail writes a `player.viewed` row, because it discloses
 * their identities, email address and sessions. The page says so before the
 * detail is opened, not after — an admin should know that reading somebody's
 * account leaves a trace, and being told afterwards is not being told.
 *
 * ## One search box, four fields
 *
 * Support is handed whatever the player quoted: their name, their airline's
 * name, or the code on the aircraft. Making them pick the right field first
 * makes the feature useless in the situation it exists for.
 */

/** `2026-08-18 14:07` — UTC, as everywhere else in the console. */
function formatAt(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/** Integer minor units to something readable. Which currency is M8-02's problem. */
function formatCash(minor: number): string {
  return (minor / 100).toLocaleString('en-GB', { maximumFractionDigits: 2 });
}

type Load<T> = { state: 'loading' } | { state: 'ready'; value: T } | { state: 'failed' };

export function PlayersPage(): ReactNode {
  const { playerId } = useParams();
  return playerId === undefined ? <PlayerList /> : <PlayerDetail playerId={playerId} />;
}

function PlayerList(): ReactNode {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState<
    Load<{ players: AdminPlayerSummary[]; total: number; query: string }>
  >({ state: 'loading' });

  const load = useCallback(async (search: string) => {
    try {
      const result = await fetchPlayers(search);
      // The server echoes the query back so a slow answer for an older search
      // cannot be rendered over a newer one.
      setPage({
        state: 'ready',
        value: { players: result.players, total: result.total, query: result.query },
      });
    } catch {
      setPage({ state: 'failed' });
    }
  }, []);

  useEffect(() => {
    void load('');
  }, [load]);

  return (
    <>
      <section className="admin__section">
        <h2 className="admin__heading">Players</h2>
        <p className="admin__note">
          Game and identity data are read-only. Editing, suspending and impersonating an account are
          a separate milestone (M11-06). Session revocation is the audited security exception.
        </p>

        <form
          className="admin__form"
          onSubmit={(event) => {
            event.preventDefault();
            void load(query);
          }}
        >
          <div className="admin__field">
            <label className="admin__label" htmlFor="player-search">
              Search
            </label>
            <input
              className="admin__input"
              id="player-search"
              value={query}
              aria-describedby="player-search-hint"
              onChange={(event) => {
                setQuery(event.target.value);
              }}
            />
            <span className="admin__hint" id="player-search-hint">
              Player name, airline name, or IATA/ICAO code — whichever you were given.
            </span>
          </div>
          <button className="admin__submit" type="submit">
            Search
          </button>
        </form>
      </section>

      <section className="admin__section">
        {page.state === 'loading' && <StateBlock kind="loading">Loading…</StateBlock>}
        {page.state === 'failed' && (
          <StateBlock kind="broken">Could not load the player list.</StateBlock>
        )}
        {page.state === 'ready' &&
          (page.value.players.length === 0 ? (
            <StateBlock kind="empty">
              {page.value.query === ''
                ? 'No players yet.'
                : `Nothing matches “${page.value.query}”.`}
            </StateBlock>
          ) : (
            <>
              <p className="admin__note">
                {page.value.total === page.value.players.length
                  ? `${String(page.value.total)} ${page.value.total === 1 ? 'player' : 'players'}.`
                  : `${String(page.value.players.length)} of ${String(page.value.total)} players.`}
              </p>
              <table className="admin__table">
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Signed up</th>
                    <th scope="col">Last seen</th>
                    <th scope="col">Airlines</th>
                    <th scope="col">Admin</th>
                  </tr>
                </thead>
                <tbody>
                  {page.value.players.map((entry) => (
                    <tr key={entry.id}>
                      <td>
                        <Link to={`/admin/players/${entry.id}`}>{entry.displayName}</Link>
                      </td>
                      <td className="figure">{formatAt(entry.createdAt)}</td>
                      <td className="figure">
                        {entry.lastSeenAt === null ? 'never' : formatAt(entry.lastSeenAt)}
                      </td>
                      <td>
                        {entry.airlineLinks.length === 0
                          ? 'none'
                          : entry.airlineLinks.map((airline, index) => (
                              <span key={airline.id}>
                                {index > 0 && ', '}
                                <Link to={`/admin/airlines/${airline.id}`}>{airline.name}</Link>
                                <span className="figure"> ({airline.iataCode})</span>
                              </span>
                            ))}
                      </td>
                      <td>{entry.isAdmin ? 'yes' : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="admin__hint">
                Opening a player records a <code className="admin__action">player.viewed</code>{' '}
                entry in the audit log. Those entries are hidden on the audit page unless asked for.
              </p>
            </>
          ))}
      </section>
    </>
  );
}

function PlayerDetail({ playerId }: { playerId: string }): ReactNode {
  const [detail, setDetail] = useState<Load<AdminPlayerDetail | null>>({ state: 'loading' });
  const [revocation, setRevocation] = useState<
    | { state: 'idle' }
    | { state: 'working' }
    | { state: 'done'; count: number }
    | { state: 'failed' }
  >({ state: 'idle' });

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const result = await fetchPlayer(playerId);
        if (live) setDetail({ state: 'ready', value: result });
      } catch {
        if (live) setDetail({ state: 'failed' });
      }
    })();
    return () => {
      live = false;
    };
  }, [playerId]);

  if (detail.state === 'loading') return <StateBlock kind="loading">Loading…</StateBlock>;
  if (detail.state === 'failed')
    return <StateBlock kind="broken">Could not load this player.</StateBlock>;
  if (detail.value === null)
    return (
      <section className="admin__section">
        <h2 className="admin__heading">Not found</h2>
        <StateBlock
          kind="empty"
          action={
            <Link className="admin__back" to="/admin/players">
              Back to players
            </Link>
          }
        >
          No player with that id.
        </StateBlock>
      </section>
    );

  const player = detail.value;

  return (
    <>
      <section className="admin__section">
        <Link className="admin__back" to="/admin/players">
          Back to players
        </Link>
        <h2 className="admin__heading">{player.displayName}</h2>
        <p className="admin__note">
          Signed up {formatAt(player.createdAt)}.
          {player.anonymizedAt && ` Anonymized ${formatAt(player.anonymizedAt)}.`}
          {player.isAdmin && ' Holds an admin grant.'} This view is recorded in the audit log.
        </p>
      </section>

      <section className="admin__section">
        <h3 className="admin__heading">Identities</h3>
        {player.identities.length === 0 ? (
          <StateBlock kind="empty">No sign-in identity — this account cannot sign in.</StateBlock>
        ) : (
          <table className="admin__table">
            <thead>
              <tr>
                <th scope="col">Provider</th>
                <th scope="col">Subject</th>
                <th scope="col">Email</th>
                <th scope="col">Added</th>
              </tr>
            </thead>
            <tbody>
              {player.identities.map((identity) => (
                <tr key={`${identity.provider}:${identity.subject}`}>
                  <td>{identity.provider}</td>
                  <td className="figure">{identity.subject}</td>
                  <td>{identity.email ?? '—'}</td>
                  <td className="figure">{formatAt(identity.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="admin__hint">
          The subject is the provider’s account key, never the email — matching accounts on an email
          address is how account-takeover bugs happen (ADR-0004).
        </p>
      </section>

      <section className="admin__section">
        <h3 className="admin__heading">Sessions</h3>
        {player.sessions.length === 0 ? (
          <StateBlock kind="empty">No sessions.</StateBlock>
        ) : (
          <table className="admin__table">
            <thead>
              <tr>
                <th scope="col">Started</th>
                <th scope="col">Last seen</th>
                <th scope="col">Expires</th>
                <th scope="col">State</th>
              </tr>
            </thead>
            <tbody>
              {player.sessions.map((entry) => (
                <tr key={entry.id}>
                  <td className="figure">{formatAt(entry.createdAt)}</td>
                  <td className="figure">{formatAt(entry.lastSeenAt)}</td>
                  <td className="figure">{formatAt(entry.expiresAt)}</td>
                  <td>{entry.expired ? 'expired' : 'live'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="admin__hint">
          Metadata only. The session token is never stored — only a SHA-256 of it — so there is
          nothing here that could sign anybody in.
        </p>
        <button
          className="admin__submit"
          type="button"
          disabled={revocation.state === 'working' || player.sessions.length === 0}
          onClick={() => {
            setRevocation({ state: 'working' });
            void revokePlayerSessions(player.id)
              .then((count) => {
                setDetail({ state: 'ready', value: { ...player, sessions: [] } });
                setRevocation({ state: 'done', count });
              })
              .catch(() => {
                setRevocation({ state: 'failed' });
              });
          }}
        >
          Revoke all sessions
        </button>
        {revocation.state === 'done' && (
          <p className="admin__note" role="status">
            Revoked {revocation.count} {revocation.count === 1 ? 'session' : 'sessions'}.
          </p>
        )}
        {revocation.state === 'failed' && (
          <p className="admin__note" role="alert">
            Could not revoke this player’s sessions.
          </p>
        )}
      </section>

      <section className="admin__section">
        <h3 className="admin__heading">Airlines</h3>
        {player.airlines.length === 0 ? (
          <StateBlock kind="empty">No airlines in any world.</StateBlock>
        ) : (
          <table className="admin__table">
            <thead>
              <tr>
                <th scope="col">World</th>
                <th scope="col">Airline</th>
                <th scope="col">IATA</th>
                <th scope="col">ICAO</th>
                <th scope="col">Callsign</th>
                <th scope="col">State</th>
                <th scope="col">Cash</th>
                <th scope="col">Reputation</th>
              </tr>
            </thead>
            <tbody>
              {player.airlines.map((entry) => (
                <tr key={entry.id}>
                  <td>{entry.worldName}</td>
                  <td>
                    <Link to={`/admin/airlines/${entry.id}`}>{entry.name}</Link>
                  </td>
                  <td className="figure">{entry.iataCode}</td>
                  <td className="figure">{entry.icaoCode}</td>
                  <td className="figure">{entry.callsign}</td>
                  <td>{entry.status}</td>
                  <td className="figure">{formatCash(entry.cashMinor)}</td>
                  <td className="figure">{entry.reputation.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
