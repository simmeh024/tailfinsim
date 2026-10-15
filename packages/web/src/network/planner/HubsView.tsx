import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  AirportTier,
  HubCandidate,
  HubCandidateListResponse,
  HubFacilityKind,
  HubFacilityView,
  HubsResponse,
  HubTier,
  HubView,
} from '@tailfin/shared';

import { formatUsdMinor } from '../../currency/display';
import { Button } from '../../ui/Button';
import { StateBlock } from '../../ui/StateBlock';
import {
  fetchHubs,
  openHubFacility,
  purchaseHub,
  searchHubCandidates,
  type HubRefusal,
  type HubWrite,
} from '../hubs-api';

import { Chip, StatTile } from './ui';

import type { ReactNode } from 'react';

import '../hubs.css';

/**
 * Hubs — the airline's hubs and their facilities, and taking another (SURFACE-09,
 * M7-04, App. B.5).
 *
 * ## Why it is a view of the Network page
 *
 * A hub is an arrangement **at an airport**, and the Network page is where the
 * other arrangements made at an airport already live: slots (M7-05), stands
 * (M7-06) and ground handling (§9.3) — the last of which needs a hub before a
 * line can be handled in-house. Connections, beside it, is already the view of
 * how a hub banks. App. B.5 sits in the appendix that holds all of them, and a
 * candidate hub carries its slot scarcity because that is half of what makes a
 * free flagship a decision. Headquarters is §9.1's head office: people, not
 * places.
 *
 * ## The client asserts no number
 *
 * App. B.5's curve — every hub held raises the price of the next, at every tier —
 * is the server's, and so is every figure here: the four next-hub prices, each
 * candidate's price and annual fee, each facility's opening cost and fee, and
 * each hub's bill. The page shows them, puts the price on the button, and echoes
 * the figure it showed back with the purchase; the server refuses a stale one
 * (`hub_cost_changed`) and the page re-reads the quote rather than retrying.
 *
 * Every write answers with the airline's whole hub list, which replaces the
 * page's. A refusal replaces nothing and is shown with the server's code. No
 * write is retried: both move money.
 *
 * ## What it deliberately does not do
 *
 *   - **Ask for candidates on its own.** The search runs when the player asks, and
 *     once more after a purchase or a stale quote, because each answer prices and
 *     measures twenty airports. Never per keystroke, never on a timer.
 *   - **Promise what a facility does.** Its effect belongs to the system it
 *     serves, and none is wired yet (`docs/hubs.md`); the page says so.
 *   - **Sell or close a hub.** There is no disposal path in App. B.5 or the API.
 */

const TIER_LABEL: Record<HubTier, string> = {
  small: 'Small',
  medium: 'Medium',
  large: 'Large',
  flagship: 'Flagship',
};

const AIRPORT_TIER_LABEL: Record<AirportTier, string> = {
  regional: 'Regional',
  small: 'Small',
  medium: 'Medium',
  large: 'Large',
  flagship: 'Flagship',
};

const TIERS: readonly HubTier[] = ['small', 'medium', 'large', 'flagship'];

const FACILITY_LABEL: Record<HubFacilityKind, string> = {
  lounge: 'Lounge',
  training_academy: 'Training academy',
  maintenance_line: 'Maintenance line',
  self_handling: 'Self-handling station',
  heavy_check: 'Heavy check capability',
};

/** What App. B.5 says each one is for — not what it does yet, which is nothing. */
const FACILITY_NOTE: Record<HubFacilityKind, string> = {
  lounge: 'For the cabin product.',
  training_academy: 'App. B.5’s hub unlock — not the crew academy built at a crew base.',
  maintenance_line: 'Line maintenance at this hub.',
  self_handling: 'Your own ramp station.',
  heavy_check: 'Heavy checks at this hub, after the maintenance line.',
};

function money(minor: number): string {
  return formatUsdMinor(minor, { fractionDigits: 0 });
}

function price(minor: number): string {
  return minor === 0 ? 'Free' : money(minor);
}

/** A game-time instant as its world date. UTC, so the date does not depend on the machine. */
function worldDate(iso: string): string {
  return iso.slice(0, 10);
}

function hubCode(hub: Pick<HubView, 'airportIcao' | 'airportIdent' | 'airportIata'>): string {
  const primary = hub.airportIcao ?? hub.airportIdent;
  return hub.airportIata === null ? primary : `${primary} / ${hub.airportIata}`;
}

function candidateCode(candidate: Pick<HubCandidate, 'icao' | 'ident' | 'iata'>): string {
  const primary = candidate.icao ?? candidate.ident;
  return candidate.iata === null ? primary : `${primary} / ${candidate.iata}`;
}

/**
 * A candidate's tier, and the band it is priced in when the two differ: B.3 has
 * five tiers and App. B.5 prices four, so a regional airport is sold as small.
 */
function tierInWords(candidate: Pick<HubCandidate, 'airportTier' | 'tier'>): string {
  return candidate.airportTier === candidate.tier
    ? `${TIER_LABEL[candidate.tier]} tier`
    : `${AIRPORT_TIER_LABEL[candidate.airportTier]} tier, priced as ${TIER_LABEL[candidate.tier].toLowerCase()}`;
}

function slotLevelLabel(slots: HubCandidate['slots']): string {
  return slots.slotLevel === null ? 'No slot level' : `Level ${String(slots.slotLevel)}`;
}

/**
 * A candidate's slots, as App. B.5's second self-balancing fact rather than a
 * warning. An uncoordinated airport's zeros are the server's way of saying there
 * is no scarcity, so they are said in words rather than shown as a cap of zero.
 */
function slotsInWords(slots: HubCandidate['slots']): string {
  if (!slots.coordinated) {
    return `${slotLevelLabel(slots)} — not coordinated; nothing here waits for a slot`;
  }
  return `${slotLevelLabel(slots)} — coordinated: ${String(slots.capacityPerBand)} airlines a band, ${String(slots.bandsFull)} of 24 bands full`;
}

/** The same fact as a sentence, for the confirmation. */
function slotsSentence(slots: HubCandidate['slots']): string {
  if (!slots.coordinated) {
    return 'Its slots are not coordinated: nothing here is refused for want of a slot.';
  }
  return `Its slots are coordinated (${slotLevelLabel(slots)}): ${String(slots.capacityPerBand)} airlines may hold any hourly band, and ${String(slots.bandsFull)} of the day’s 24 are already full.`;
}

/** ` for “EHAM”`, or nothing for the empty search, which lists airports alphabetically. */
function forQuery(query: string, lead = ' for'): string {
  return query === '' ? '' : `${lead} “${query}”`;
}

/** The server's refusal, in its words and with its code. */
function Refusal({ refusal }: { refusal: HubRefusal }): ReactNode {
  return (
    <StateBlock kind="refused">
      {refusal.message} <code className="net-hubs__code">{refusal.code}</code>
    </StateBlock>
  );
}

type HubsState =
  | { kind: 'loading' }
  | { kind: 'broken' }
  | { kind: 'refused'; refusal: HubRefusal }
  | { kind: 'ready'; hubs: HubsResponse };

type SearchState =
  | { kind: 'idle' }
  | { kind: 'loading'; query: string }
  | { kind: 'broken'; query: string }
  | { kind: 'refused'; query: string; refusal: HubRefusal }
  | { kind: 'ready'; query: string; result: HubCandidateListResponse };

/** Where a write's answer is shown: under the candidates, or in the hub it was about. */
type Scope = 'purchase' | { hubId: string };

type Notice =
  | { kind: 'none' }
  | { kind: 'refused'; scope: Scope; refusal: HubRefusal }
  | { kind: 'unconfirmed'; scope: Scope }
  | { kind: 'done'; scope: Scope; message: string };

function inScope(notice: Notice, scope: Scope): boolean {
  if (notice.kind === 'none') return false;
  if (scope === 'purchase' || notice.scope === 'purchase') return notice.scope === scope;
  return notice.scope.hubId === scope.hubId;
}

function NoticeBlock({ notice, scope }: { notice: Notice; scope: Scope }): ReactNode {
  if (!inScope(notice, scope)) return null;
  if (notice.kind === 'refused') return <Refusal refusal={notice.refusal} />;
  if (notice.kind === 'unconfirmed') {
    return (
      <StateBlock kind="broken">
        That could not be confirmed. Reload before trying again — it may have gone through, and it
        is not retried for you.
      </StateBlock>
    );
  }
  if (notice.kind === 'done') {
    return (
      <p className="net-hubs__done" role="status">
        {notice.message}
      </p>
    );
  }
  return null;
}

/** One facility's row: built, blocked, or its price and a two-step build. */
function FacilityRow({
  hub,
  facility,
  busy,
  onBuild,
}: {
  hub: HubView;
  facility: HubFacilityView;
  busy: boolean;
  onBuild: (hub: HubView, facility: HubFacilityView) => void;
}): ReactNode {
  const [confirming, setConfirming] = useState(false);
  const built = facility.openedAt !== null;
  const blocked = facility.blockedBy === 'requires_maintenance_line';
  const label = FACILITY_LABEL[facility.kind];
  return (
    <tr data-facility={facility.kind} data-built={built ? 'yes' : 'no'}>
      <th scope="row" className="net-hubs__prose">
        {label}
        <span className="net-hubs__detail">{FACILITY_NOTE[facility.kind]}</span>
      </th>
      {/* An open facility's opening cost is today's quote, not what was paid, so
          a built row shows none rather than a figure that reads as a receipt. */}
      <td className="figure">{built ? '—' : money(facility.openingCostMinor)}</td>
      <td className="figure">{money(facility.annualFeeMinor)}</td>
      <td className="net-hubs__action">
        {built ? (
          <Chip tone="positive">Built {worldDate(facility.openedAt ?? '')}</Chip>
        ) : blocked ? (
          <>
            <Chip tone="warn">Locked</Chip>
            <span className="net-hubs__detail">Needs the maintenance line first.</span>
          </>
        ) : confirming ? (
          <span className="net-gates__actions">
            <Button
              variant="primary"
              size="sm"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
                onBuild(hub, facility);
              }}
            >
              Confirm — build for {money(facility.openingCostMinor)}
            </Button>
            <Button
              variant="tertiary"
              size="sm"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
              }}
            >
              Keep
            </Button>
          </span>
        ) : (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => {
              setConfirming(true);
            }}
          >
            Build — {money(facility.openingCostMinor)}
          </Button>
        )}
      </td>
    </tr>
  );
}

/** One hub the airline holds: what it cost, what it bills, and what it could become. */
function HubPanel({
  hub,
  busy,
  notice,
  onBuild,
}: {
  hub: HubView;
  busy: boolean;
  notice: Notice;
  onBuild: (hub: HubView, facility: HubFacilityView) => void;
}): ReactNode {
  const code = hubCode(hub);
  const titleId = `hub-${hub.id}`;
  return (
    <section className="net-panel net-hubs__hub" aria-labelledby={titleId}>
      <div className="net-panel__head">
        <h4 id={titleId} className="net-panel__title">
          {hub.airportName} <span className="figure net-hubs__code-inline">{code}</span>
        </h4>
        <span className="net-hubs__chips">
          <Chip tone="accent">{TIER_LABEL[hub.tier]}</Chip>{' '}
          {hub.founderGrant ? (
            <Chip>Founder hub</Chip>
          ) : (
            <Chip>Bought for {price(hub.purchaseCostMinor)}</Chip>
          )}
        </span>
      </div>
      <p className="net-panel__hint">
        Opened {worldDate(hub.openedAt)}. The hub itself costs {money(hub.annualFeeMinor)} a year;
        with what is built here, {money(hub.totalAnnualFeeMinor)} a year, billed monthly.
      </p>

      <NoticeBlock notice={notice} scope={{ hubId: hub.id }} />

      <div
        className="net-table-scroll"
        role="region"
        aria-label={`Facilities at ${code}`}
        tabIndex={0}
      >
        <table className="admin__table net-comp-table">
          <caption className="visually-hidden">Facilities at {code}</caption>
          <thead>
            <tr>
              <th scope="col">Facility</th>
              <th scope="col">To build</th>
              <th scope="col">A year</th>
              <th scope="col">
                <span className="visually-hidden">State</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {hub.facilities.map((facility) => (
              <FacilityRow
                key={`${facility.kind}-${facility.openedAt ?? 'none'}`}
                hub={hub}
                facility={facility}
                busy={busy}
                onBuild={onBuild}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** The candidate a player has asked to buy, with everything App. B.5 says to show first. */
function ConfirmPurchase({
  candidate,
  busy,
  onConfirm,
  onKeep,
}: {
  candidate: HubCandidate;
  busy: boolean;
  onConfirm: () => void;
  onKeep: () => void;
}): ReactNode {
  const code = candidateCode(candidate);
  return (
    <section className="net-hubs__confirm" aria-label="Confirm the purchase">
      <p className="net-hubs__confirm-text">
        <strong>
          {candidate.name} ({code})
        </strong>{' '}
        as your next hub: {price(candidate.purchaseCostMinor)} now, then{' '}
        {money(candidate.annualFeeMinor)} a year before any facility, billed monthly.{' '}
        {slotsSentence(candidate.slots)} A hub cannot be sold or closed.
      </p>
      <span className="net-gates__actions">
        <Button variant="primary" disabled={busy} onClick={onConfirm}>
          {busy
            ? 'Buying…'
            : candidate.purchaseCostMinor === 0
              ? 'Confirm — take it free'
              : `Confirm — buy for ${money(candidate.purchaseCostMinor)}`}
        </Button>
        <Button variant="tertiary" disabled={busy} onClick={onKeep}>
          Keep looking
        </Button>
      </span>
    </section>
  );
}

function CandidateTable({
  result,
  busy,
  pending,
  onPick,
}: {
  result: HubCandidateListResponse;
  busy: boolean;
  pending: string | null;
  onPick: (candidate: HubCandidate) => void;
}): ReactNode {
  return (
    <div className="net-table-scroll" role="region" aria-label="Hub candidates" tabIndex={0}>
      <table className="admin__table net-comp-table">
        <caption className="visually-hidden">Airports you could take as your next hub</caption>
        <thead>
          <tr>
            <th scope="col">Airport</th>
            <th scope="col">Price, then a year</th>
            <th scope="col">Slots</th>
            <th scope="col">
              <span className="visually-hidden">Buy</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {result.airports.map((candidate) => (
            <tr
              key={candidate.ident}
              data-ident={candidate.ident}
              aria-current={pending === candidate.ident ? 'true' : undefined}
              className={pending === candidate.ident ? 'net-hubs__pending' : undefined}
            >
              <th scope="row" className="net-hubs__prose">
                {candidate.name}
                <span className="net-hubs__detail">
                  {candidateCode(candidate)}
                  {candidate.city === null ? '' : ` · ${candidate.city}`} · {candidate.country}
                </span>
                <span className="net-hubs__detail">{tierInWords(candidate)}</span>
              </th>
              <td>
                <span className="figure">{price(candidate.purchaseCostMinor)}</span>
                <span className="net-hubs__detail">
                  then <span className="figure">{money(candidate.annualFeeMinor)}</span> a year
                </span>
              </td>
              <td className="net-hubs__slots">{slotsInWords(candidate.slots)}</td>
              <td>
                {candidate.alreadyHeld ? (
                  <Chip tone="positive">Your hub</Chip>
                ) : (
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      onPick(candidate);
                    }}
                  >
                    Buy — {price(candidate.purchaseCostMinor)}
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface HubsViewProps {
  /** An airport to search for on arrival — `/network?view=hubs&station=EHAM`. */
  initialQuery?: string | null;
}

export function HubsView({ initialQuery = null }: HubsViewProps): ReactNode {
  const [hubs, setHubs] = useState<HubsState>({ kind: 'loading' });
  const [query, setQuery] = useState(initialQuery ?? '');
  const [search, setSearch] = useState<SearchState>({ kind: 'idle' });
  const [pending, setPending] = useState<HubCandidate | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>({ kind: 'none' });
  // The search that is on screen, so a purchase can re-price exactly that list.
  const shownQuery = useRef<string | null>(null);

  const loadHubs = useCallback(async () => {
    try {
      const read = await fetchHubs();
      setHubs(
        read.ok ? { kind: 'ready', hubs: read.hubs } : { kind: 'refused', refusal: read.refusal },
      );
    } catch {
      setHubs({ kind: 'broken' });
    }
  }, []);

  const runSearch = useCallback(async (text: string) => {
    shownQuery.current = text;
    setPending(null);
    setSearch({ kind: 'loading', query: text });
    try {
      const read = await searchHubCandidates(text);
      // A later search has replaced this one; its answer is the one to show.
      if (shownQuery.current !== text) return;
      setSearch(
        read.ok
          ? { kind: 'ready', query: text, result: read.candidates }
          : { kind: 'refused', query: text, refusal: read.refusal },
      );
    } catch {
      if (shownQuery.current === text) setSearch({ kind: 'broken', query: text });
    }
  }, []);

  useEffect(() => {
    void loadHubs();
  }, [loadHubs]);

  // Arriving with an airport in the link: search for it, once.
  useEffect(() => {
    if (initialQuery !== null && initialQuery !== '') void runSearch(initialQuery);
    // Once, on mount: the link is read once, as the other views read theirs.
  }, []);

  /**
   * One write, sent once, whose answer replaces the hub list or says why not.
   *
   * After a purchase every candidate's price has moved — the curve counts hubs
   * held — so the list on screen is re-read once. After a stale quote both the
   * hub list and the candidates are re-read, so the new figure is the one on
   * screen when the player decides again; nothing is re-sent for them.
   */
  const send = useCallback(
    async (
      scope: Scope,
      request: () => Promise<HubWrite>,
      done: (hubs: HubsResponse) => string,
    ) => {
      setBusy(true);
      setNotice({ kind: 'none' });
      try {
        const result = await request();
        if (result.ok) {
          setHubs({ kind: 'ready', hubs: result.hubs });
          setNotice({ kind: 'done', scope, message: done(result.hubs) });
          if (scope === 'purchase' && shownQuery.current !== null) {
            void runSearch(shownQuery.current);
          }
          return;
        }
        // Refused: the hubs on screen stay exactly as they were.
        setNotice({ kind: 'refused', scope, refusal: result.refusal });
        if (result.refusal.code === 'hub_cost_changed') {
          void loadHubs();
          if (shownQuery.current !== null) void runSearch(shownQuery.current);
        }
      } catch {
        setNotice({ kind: 'unconfirmed', scope });
      } finally {
        setBusy(false);
        // Whatever the answer, a second purchase starts from Buy again: a refused
        // or unconfirmed one is never one click from being sent twice.
        if (scope === 'purchase') setPending(null);
      }
    },
    [loadHubs, runSearch],
  );

  const onConfirmPurchase = useCallback(
    (candidate: HubCandidate) => {
      void send(
        'purchase',
        () => purchaseHub(candidate.ident, candidate.purchaseCostMinor),
        (after) => {
          const bought = after.hubs.find((hub) => hub.airportIdent === candidate.ident);
          return bought === undefined
            ? `${candidate.name} is now one of your hubs.`
            : `${bought.airportName} is now one of your hubs, bought for ${price(bought.purchaseCostMinor)}.`;
        },
      );
    },
    [send],
  );

  const onBuild = useCallback(
    (hub: HubView, facility: HubFacilityView) => {
      void send(
        { hubId: hub.id },
        () => openHubFacility(hub.id, facility.kind, facility.openingCostMinor),
        () => `${FACILITY_LABEL[facility.kind]} built at ${hubCode(hub)}.`,
      );
    },
    [send],
  );

  return (
    <div className="net-performance net-hubs">
      <div className="net-panel__head">
        <h2 className="net-panel__title">Hubs</h2>
      </div>
      <p className="net-panel__hint">
        A hub is where you base aircraft, hold gates, station crew and handle your own ramp (App.
        B.5). Every hub you hold raises the price of the next, at every tier — so a cheap hub taken
        now makes every later flagship dearer. Each one bills its fee every month for as long as you
        hold it.
      </p>

      {hubs.kind === 'loading' ? (
        <StateBlock kind="loading">Reading your hubs…</StateBlock>
      ) : hubs.kind === 'broken' ? (
        <StateBlock kind="broken">Could not load your hubs.</StateBlock>
      ) : hubs.kind === 'refused' ? (
        <Refusal refusal={hubs.refusal} />
      ) : (
        <>
          <section className="net-panel" aria-labelledby="hubs-held-title">
            <div className="net-panel__head">
              <h3 id="hubs-held-title" className="net-panel__title">
                Your hubs
              </h3>
              <span className="net-panel__hint">
                {String(hubs.hubs.hubs.length)} {hubs.hubs.hubs.length === 1 ? 'hub' : 'hubs'} ·{' '}
                {money(hubs.hubs.totalAnnualFeeMinor)} a year in hub fees
              </span>
            </div>
            {hubs.hubs.hubs.length === 0 ? (
              <StateBlock kind="empty">
                You hold no hub yet. Search for an airport below to take one.
              </StateBlock>
            ) : (
              <>
                <p className="net-panel__hint">
                  A facility is App. B.5’s per-hub unlock, priced from the hub’s tier. What each one
                  does belongs to the system it serves, and none is wired to it yet: today a
                  facility is its cost and its fee, and nothing more.
                </p>
                {hubs.hubs.hubs.map((hub) => (
                  <HubPanel key={hub.id} hub={hub} busy={busy} notice={notice} onBuild={onBuild} />
                ))}
              </>
            )}
          </section>

          <section className="net-panel net-hubs__next" aria-labelledby="hubs-next-title">
            <div className="net-panel__head">
              <h3 id="hubs-next-title" className="net-panel__title">
                The next hub
              </h3>
              <span className="net-panel__hint">
                You hold {String(hubs.hubs.nextHub.hubsOwned)}; this is what one more costs
              </span>
            </div>
            <div
              className="net-tiles net-hubs__tiles"
              role="group"
              aria-label="The next hub’s price at each tier"
            >
              {TIERS.map((tier) => (
                <StatTile
                  key={tier}
                  label={TIER_LABEL[tier]}
                  value={price(hubs.hubs.nextHub[tier])}
                />
              ))}
            </div>
          </section>
        </>
      )}

      {/* Buying needs the hub count the prices were quoted against, so the search
          sits under a hub list that loaded rather than beside a broken one. */}
      {hubs.kind === 'ready' && (
        <section className="net-panel" aria-labelledby="hubs-find-title">
          <div className="net-panel__head">
            <h3 id="hubs-find-title" className="net-panel__title">
              Take another hub
            </h3>
          </div>
          <form
            className="net-hubs__search"
            role="search"
            onSubmit={(event) => {
              event.preventDefault();
              void runSearch(query.trim());
            }}
          >
            <label className="net-hubs__field">
              <span className="visually-hidden">Airport</span>
              <input
                type="search"
                className="net-rail__search"
                placeholder="ICAO, IATA, name or city"
                value={query}
                maxLength={80}
                onChange={(event) => {
                  setQuery(event.target.value);
                }}
              />
            </label>
            <Button type="submit" size="sm" disabled={search.kind === 'loading'}>
              Search
            </Button>
          </form>
          <p className="net-panel__hint">
            Every price is the server’s, on today’s curve, for your next hub — with what the hub
            then costs a year and how contested its slots already are. Nothing is asked until you
            search.
          </p>

          {search.kind === 'loading' && (
            <StateBlock kind="loading">Pricing airports{forQuery(search.query)}…</StateBlock>
          )}
          {search.kind === 'broken' && (
            <StateBlock kind="broken">Could not price airports{forQuery(search.query)}.</StateBlock>
          )}
          {search.kind === 'refused' && <Refusal refusal={search.refusal} />}
          {search.kind === 'ready' &&
            (search.result.airports.length === 0 ? (
              <StateBlock kind="empty">
                No airport with scheduled service matches{forQuery(search.result.query, '')}. Only
                an airport with scheduled service can be a hub.
              </StateBlock>
            ) : (
              <CandidateTable
                result={search.result}
                busy={busy}
                pending={pending?.ident ?? null}
                onPick={(candidate) => {
                  setNotice({ kind: 'none' });
                  setPending(candidate);
                }}
              />
            ))}

          {pending !== null && (
            <ConfirmPurchase
              candidate={pending}
              busy={busy}
              onConfirm={() => {
                onConfirmPurchase(pending);
              }}
              onKeep={() => {
                setPending(null);
              }}
            />
          )}
          <NoticeBlock notice={notice} scope="purchase" />
        </section>
      )}
    </div>
  );
}
