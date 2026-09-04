import { useEffect, useRef, useState } from 'react';

import {
  type AdminNpcCarrier,
  type AdminNpcDecision,
  type AdminNpcResponse,
  type AdminWorldSummary,
  NPC_ARCHETYPE_LABEL,
  type NpcDecisionKind,
} from '@tailfin/shared';

import { StateBlock } from '../ui/StateBlock';

import { fetchNpcCarriers, fetchWorlds } from './api';
import { usePolledData } from './polling';

import type { ReactNode } from 'react';

/**
 * NPC carriers and what they decided (M3-12).
 *
 * M3-12's third acceptance criterion: *"NPC decisions are logged and
 * inspectable in the admin console."* The question this page exists to answer
 * is a support question — *why did a competitor appear in my market last
 * week?* — so the decision log is the page, and the carrier list is context
 * for reading it.
 *
 * Every figure here is the server's. The client parses no basis and recomputes
 * no margin; lint already stops `packages/web` importing `@tailfin/sim`, so it
 * could not compute one even by accident.
 */

/** Matches the engine's weekly review closely enough to feel live without polling hard. */
const REFRESH_MS = 30_000;

const DECISION_LABEL: Record<NpcDecisionKind, string> = {
  route_opened: 'Entered',
  route_closed: 'Left',
  fare_changed: 'Repriced',
  entry_declined: 'Declined',
};

function money(minor: number): string {
  // Plain, not `toLocaleString`: the server writes its reason sentences with
  // `String(n)`, and a separator here would render the same figure two ways on
  // one row with the locale deciding which.
  return String(minor);
}

function CarrierCard({ carrier }: { carrier: AdminNpcCarrier }): ReactNode {
  return (
    <article className="node" aria-labelledby={`carrier-${carrier.airlineId}`}>
      <header className="node__head">
        <h3 className="node__name" id={`carrier-${carrier.airlineId}`}>
          {carrier.iataCode} — {carrier.name}
        </h3>
        <span className="node__state">{NPC_ARCHETYPE_LABEL[carrier.archetype]}</span>
      </header>
      <dl className="node__stats">
        <div>
          <dt>Hub</dt>
          <dd className="figure">{carrier.hubIcao ?? '—'}</dd>
        </div>
        <div>
          <dt>Country</dt>
          <dd className="figure">{carrier.baseCountry}</dd>
        </div>
        <div>
          <dt>Routes</dt>
          <dd className="figure">{carrier.routes}</dd>
        </div>
        <div>
          <dt>Reputation</dt>
          <dd className="figure">{carrier.reputation.toFixed(2)}</dd>
        </div>
        <div>
          <dt>Cash</dt>
          <dd className="figure">{money(carrier.cashMinor)}</dd>
        </div>
      </dl>
    </article>
  );
}

function DecisionRow({ decision }: { decision: AdminNpcDecision }): ReactNode {
  const market =
    decision.originIcao !== null && decision.destinationIcao !== null
      ? `${decision.originIcao}–${decision.destinationIcao}`
      : '—';

  return (
    <tr>
      <td className="figure">{new Date(decision.decidedAt).toISOString().slice(0, 10)}</td>
      <td>
        {decision.airlineIataCode} {decision.airlineName}
      </td>
      <td>{DECISION_LABEL[decision.kind]}</td>
      <td className="figure">{market}</td>
      {/* The server's sentence, rendered verbatim. §21: the client must not
          reach a different conclusion about a decision than the server did. */}
      <td>{decision.reason}</td>
      <td className="figure">{decision.economyConfigVersion}</td>
    </tr>
  );
}

export function CarriersPage(): ReactNode {
  const [worlds, setWorlds] = useState<AdminWorldSummary[] | null>(null);
  const [worldId, setWorldId] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void fetchWorlds()
      .then((list) => {
        if (!live) return;
        setWorlds(list);
        setWorldId((current) => current ?? list[0]?.id ?? null);
      })
      .catch(() => {
        if (live) setWorlds([]);
      });
    return () => {
      live = false;
    };
  }, []);

  const { value, loading, failed, refresh } = usePolledData<AdminNpcResponse | null>(
    // Null until a world is chosen, rather than a request with an empty id.
    () => (worldId === null ? Promise.resolve(null) : fetchNpcCarriers(worldId)),
    REFRESH_MS,
  );

  /**
   * Fetch again when the chosen world changes.
   *
   * `usePolledData` loads on mount and on its interval, and nothing else — the
   * loader lives in a ref precisely so that a caller passing an inline closure
   * does not restart the interval on every render. That is right for a page
   * whose subject is fixed, and wrong for this one: the world id arrives from a
   * *second* request after mount, so the first load resolves null and, without
   * this, the page sits empty until the thirty-second tick.
   *
   * `refresh` is a fresh closure each render, so it is held in a ref rather
   * than listed as a dependency — depending on it directly would re-run this
   * effect on every render and fetch in a loop.
   */
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (worldId !== null) refreshRef.current();
  }, [worldId]);

  return (
    <section className="admin__section">
      <h2 className="admin__heading">Carriers</h2>

      {worlds !== null && worlds.length > 1 && (
        <p className="admin__note">
          <label htmlFor="carriers-world">World </label>
          <select
            id="carriers-world"
            value={worldId ?? ''}
            onChange={(event) => {
              setWorldId(event.target.value);
            }}
          >
            {worlds.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </p>
      )}

      {failed && (
        <p className="admin__note" role="alert">
          The last refresh failed; the figures below are older than they look.
        </p>
      )}

      {loading && value === null && <StateBlock kind="loading">Loading…</StateBlock>}

      {value !== null && !value.seeded && (
        <StateBlock kind="empty">
          This world has no NPC carriers. Seed them with <code>pnpm npc:seed &lt;worldId&gt;</code>{' '}
          — the world needs its demand pools generated first.
        </StateBlock>
      )}

      {value !== null && value.seeded && (
        <>
          <div className="node__list">
            {value.carriers.map((carrier) => (
              <CarrierCard key={carrier.airlineId} carrier={carrier} />
            ))}
          </div>

          <h3 className="admin__heading">Recent decisions</h3>
          {value.decisions.length === 0 ? (
            <StateBlock kind="empty">
              No decisions recorded yet. Carriers review their networks weekly in game time, so a
              young world has not reached its first review.
            </StateBlock>
          ) : (
            <table>
              <caption>
                The most recent {String(value.decisions.length)} decisions, newest first. Dates are
                the world&rsquo;s own calendar, not real time.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Game date</th>
                  <th scope="col">Carrier</th>
                  <th scope="col">Decision</th>
                  <th scope="col">Market</th>
                  <th scope="col">Why</th>
                  <th scope="col">Economy</th>
                </tr>
              </thead>
              <tbody>
                {value.decisions.map((decision) => (
                  <DecisionRow key={decision.id} decision={decision} />
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      <button className="admin__submit" type="button" onClick={refresh}>
        Refresh now
      </button>
    </section>
  );
}
