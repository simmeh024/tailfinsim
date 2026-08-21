import { useCallback, useEffect, useState } from 'react';

import { CABIN_ORDER } from '@tailfin/shared';
import type {
  CabinClass,
  CabinMarketPosition,
  FarePreviewResponse,
  FareFloorViolation,
  FareTable,
  WaterfallSegment,
} from '@tailfin/shared';

import {
  fetchRoutes,
  fetchWaterfall,
  openRoute,
  type OpenRouteOutcome,
  previewFares,
  rivalsOf,
  type RouteSummary,
  saveFares,
  type WaterfallOutcome,
} from './api';

import type { ReactNode } from 'react';

/**
 * Routes and per-class fares (M3-09, §8.3, App. A.10).
 *
 * Every number on this page comes from the server. The projected share, the
 * market average and the price floor are all computed by `@tailfin/sim` behind
 * `/api/routes/:id/fares/preview` — this file has no economics in it at all,
 * because invariant 1 says the server is authoritative and ESLint refuses the
 * client an import of the sim.
 *
 * That is what makes M3-09's second criterion true by construction: there is no
 * second estimate here to drift from resolution, because there is no estimate
 * here.
 */

/** `12345` minor units → `123.45`. Display only; the wire stays integer. */
function major(minor: number): string {
  return (minor / 100).toFixed(2);
}

/** Parse a typed major-unit fare back to whole minor units, or nothing. */
function toMinor(input: string): number | undefined {
  const trimmed = input.trim();
  if (trimmed === '') return undefined;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value * 100);
}

const CABIN_LABEL: Record<CabinClass, string> = {
  first: 'First',
  business: 'Business',
  premium_economy: 'Premium economy',
  economy: 'Economy',
};

function Position({
  position,
  draft,
  onChange,
  violation,
}: {
  position: CabinMarketPosition;
  draft: string;
  onChange: (value: string) => void;
  violation: FareFloorViolation | undefined;
}): ReactNode {
  const { cabin } = position;

  return (
    <tr className={violation ? 'fares__row fares__row--refused' : 'fares__row'}>
      <th scope="row" className="fares__cabin">
        {CABIN_LABEL[cabin]}
        <span className="fares__seats">
          {position.seats === 0 ? 'not fitted' : `${String(position.seats)} seats`}
        </span>
      </th>

      <td>
        <label className="fares__field">
          <span className="visually-hidden">{CABIN_LABEL[cabin]} fare</span>
          <input
            className="fares__input figure"
            type="text"
            inputMode="decimal"
            value={draft}
            disabled={position.seats === 0}
            aria-invalid={violation !== undefined}
            aria-describedby={violation ? `floor-${cabin}` : undefined}
            onChange={(event) => {
              onChange(event.target.value);
            }}
          />
        </label>
      </td>

      <td className="figure">{major(position.marketAverageMinor)}</td>

      <td className="figure">
        {/* A.3's PriceRel — the number the logit actually uses, so a player can
            see the input to their own share rather than a rephrasing of it. */}
        {position.priceRel === null ? '—' : `${(position.priceRel * 100).toFixed(0)}%`}
      </td>

      <td className="figure">{major(position.floorMinor)}</td>

      <td className="figure">
        {position.projectedShare === null ? '—' : `${(position.projectedShare * 100).toFixed(1)}%`}
      </td>
    </tr>
  );
}

/**
 * Which of B.4's seven checks refused it, in words.
 *
 * The reason enum is on the wire precisely so the client does not have to
 * match on prose — B.4 requires the player to be told which check failed and
 * "never a generic unavailable", and a route refused for range needs a
 * different aeroplane while one refused for a curfew needs a different time.
 */
const REACHABILITY_LABEL: Record<string, string> = {
  range: 'Out of range',
  runway: 'Runway too short',
  wingspan: 'Aircraft too large for the stand',
  etops: 'Beyond the diversion limit',
  curfew: 'Outside operating hours',
  traffic_rights: 'No traffic rights for that country pair',
  slots: 'No slot in that band',
};

function OpenRouteForm({ onOpened }: { onOpened: () => void }): ReactNode {
  const [origin, setOrigin] = useState('');
  const [destination, setDestination] = useState('');
  const [outcome, setOutcome] = useState<OpenRouteOutcome | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setOutcome(null);
    try {
      const result = await openRoute(origin, destination);
      setOutcome(result);
      if (result.ok) {
        setOrigin('');
        setDestination('');
        onOpened();
      }
    } catch {
      setOutcome(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h2 className="card__heading">Open a route</h2>

      <div className="fares__actions">
        <label className="fares__field">
          <span className="visually-hidden">Origin ICAO</span>
          <input
            className="fares__input figure"
            type="text"
            placeholder="EHAM"
            maxLength={4}
            value={origin}
            onChange={(event) => {
              setOrigin(event.target.value.toUpperCase());
            }}
          />
        </label>

        <span aria-hidden="true">→</span>

        <label className="fares__field">
          <span className="visually-hidden">Destination ICAO</span>
          <input
            className="fares__input figure"
            type="text"
            placeholder="LEBL"
            maxLength={4}
            value={destination}
            onChange={(event) => {
              setDestination(event.target.value.toUpperCase());
            }}
          />
        </label>

        <button
          className="admin__submit"
          type="button"
          disabled={busy || origin.length < 4 || destination.length < 4}
          onClick={() => void submit()}
        >
          Open
        </button>
      </div>

      {outcome !== null && !outcome.ok && (
        <p className="fares__violation" role="alert">
          {outcome.kind === 'unreachable' && (
            <>
              <strong>
                {REACHABILITY_LABEL[outcome.reachability.reason] ?? outcome.reachability.reason}
              </strong>{' '}
              — {outcome.reachability.detail}
            </>
          )}
          {outcome.kind === 'unknown-airport' && <>No airport with the code {outcome.icao}.</>}
          {outcome.kind === 'same-airport' && <>A route needs two different airports.</>}
          {outcome.kind === 'no-airline' && (
            <>You do not have an airline in this world yet, so there is nothing to fly the route.</>
          )}
          {outcome.kind === 'duplicate' && <>You already fly that pair.</>}
        </p>
      )}
    </section>
  );
}

/**
 * A.9's factor names, in the player's words rather than the model's.
 *
 * The model calls it `product`; a player is choosing between a seat pitch and a
 * lounge. A chart that explains the game in the vocabulary of its own source
 * code is explaining it to the wrong audience.
 */
const FACTOR_LABEL: Record<string, string> = {
  price: 'Price',
  frequency: 'Frequency',
  product: 'Product',
  reputation: 'Reputation',
  schedule: 'Schedule fit',
};

const SEGMENT_LABEL: Record<string, string> = {
  business: 'Business',
  leisure: 'Leisure',
  vfr: 'VFR',
};

/**
 * One segment's decomposition, drawn as bars either side of a zero line.
 *
 * Scaled against the largest bar in *this* segment, so the shape of the answer
 * is readable whether the gap is 0.05 or 2.0. A shared scale would make the
 * business column — where price matters far less, so every term is smaller —
 * look like nothing was happening in it.
 */
function SegmentWaterfall({ segment }: { segment: WaterfallSegment }): ReactNode {
  const widest = Math.max(
    ...segment.factors.map((f) => Math.abs(f.delta)),
    Math.abs(segment.netDelta),
  );
  const width = (value: number) => `${((Math.abs(value) / (widest || 1)) * 100).toFixed(1)}%`;

  return (
    <div className="waterfall__segment">
      <h4 className="waterfall__segment-name">
        {SEGMENT_LABEL[segment.segment] ?? segment.segment}
      </h4>

      <ul className="waterfall__bars">
        {segment.factors.map((factor) => (
          <li key={factor.factor} className="waterfall__bar-row">
            <span className="waterfall__factor">
              {FACTOR_LABEL[factor.factor] ?? factor.factor}
            </span>
            <span className="waterfall__track">
              <span
                className={
                  factor.delta < 0
                    ? 'waterfall__bar waterfall__bar--against'
                    : 'waterfall__bar waterfall__bar--for'
                }
                style={{ width: width(factor.delta) }}
              />
            </span>
            {/* Glyph as well as colour, per H.4: the sign has to survive a
                monochrome screen and a red-green reader. */}
            <span
              className={
                factor.delta < 0
                  ? 'waterfall__delta figure waterfall__delta--against'
                  : 'waterfall__delta figure waterfall__delta--for'
              }
            >
              {factor.delta < 0 ? '▼' : '▲'} {factor.delta.toFixed(3)}
            </span>
          </li>
        ))}
      </ul>

      <p className="waterfall__net">
        {/* No residual line, and there cannot be one: the factors sum to this
            exactly. That is A.9's claim, and why the chart can be trusted. */}
        Net{' '}
        <strong
          className={
            segment.netDelta < 0
              ? 'figure waterfall__delta--against'
              : 'figure waterfall__delta--for'
          }
        >
          {segment.netDelta.toFixed(3)}
        </strong>{' '}
        — you hold <span className="figure">{(segment.yourShare * 100).toFixed(1)}%</span> of this
        segment against their{' '}
        <span className="figure">{(segment.theirShare * 100).toFixed(1)}%</span>
      </p>
    </div>
  );
}

/**
 * "Why am I losing?" (M3-10, App. A.9).
 *
 * One click from the route opens it against whichever rival the server names
 * first; a second changes the cabin. That is the two-click requirement met with
 * the common case at one.
 *
 * All three segments at once, because the interesting thing about a route is
 * usually that the answer differs between them.
 */
function Waterfall({ route }: { route: RouteSummary }): ReactNode {
  const [cabin, setCabin] = useState<CabinClass>('economy');
  const [rival, setRival] = useState<string | undefined>(undefined);
  const [outcome, setOutcome] = useState<WaterfallOutcome | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    // Guarded because the pickers are not debounced: clicking cabin twice
    // quickly puts two requests in flight, and without this the slower one
    // wins and draws a chart for the cabin the player just left.
    let current = true;
    void (async () => {
      try {
        const answer = await fetchWaterfall(route.id, cabin, rival);
        if (!current) return;
        setOutcome(answer);
        setFailed(false);
      } catch {
        if (current) setFailed(true);
      }
    })();

    return () => {
      current = false;
    };
  }, [route.id, cabin, rival]);

  if (failed) {
    return (
      <p className="admin__note" role="alert">
        The market would not answer just now.
      </p>
    );
  }
  if (outcome === null) return <p className="admin__note">Working out why…</p>;

  // The one outcome with no controls to keep: there is nobody to pick between,
  // and no cabin would change that.
  if (!outcome.ok && outcome.kind === 'no-rival') {
    return (
      <p className="admin__note">
        Nobody else is selling {route.originIcao} → {route.destinationIcao}, so there is no gap to
        decompose. You have the route to yourself.
      </p>
    );
  }

  const rivals = rivalsOf(outcome);
  const against = outcome.ok ? outcome.waterfall.rivalId : rival;

  /*
   * The pickers render above whatever the outcome turned out to be, refusal
   * included. Returning early on `cabin-not-contested` used to remove the only
   * control that could recover from it — the player was told nobody sells
   * economy here and left with no way to ask about business.
   */
  return (
    <div className="waterfall">
      <div className="waterfall__controls">
        <label className="fares__field">
          <span className="visually-hidden">Cabin</span>
          <select
            className="fares__input"
            value={cabin}
            onChange={(event) => {
              setCabin(event.target.value as CabinClass);
            }}
          >
            {CABIN_ORDER.map((c) => (
              <option key={c} value={c}>
                {CABIN_LABEL[c]}
              </option>
            ))}
          </select>
        </label>

        {/* A.8's route has two rivals and you lose to them for opposite
            reasons — the LCC on price, the legacy carrier on product. A fixed
            comparison would show one of those and hide the other. */}
        {rivals.length > 1 ? (
          <label className="fares__field">
            <span className="visually-hidden">Compare against</span>
            <select
              className="fares__input"
              value={against ?? rivals[0]?.id}
              onChange={(event) => {
                setRival(event.target.value);
              }}
            >
              {rivals.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.id}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p className="waterfall__against">
            against <strong>{against ?? rivals[0]?.id}</strong>
          </p>
        )}
      </div>

      {outcome.ok ? (
        <div className="waterfall__segments">
          {outcome.waterfall.bySegment.map((segment) => (
            <SegmentWaterfall key={segment.segment} segment={segment} />
          ))}
        </div>
      ) : (
        <p className="admin__note">
          {outcome.kind === 'cabin-not-contested'
            ? `Nobody else sells ${CABIN_LABEL[outcome.cabin].toLowerCase()} on this route.`
            : 'That airline does not fly this route.'}
        </p>
      )}
    </div>
  );
}

function RoutePanel({ route }: { route: RouteSummary }): ReactNode {
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      CABIN_ORDER.map((cabin) => [
        cabin,
        route.fares[cabin] === undefined ? '' : major(route.fares[cabin]),
      ]),
    ),
  );
  const [preview, setPreview] = useState<FarePreviewResponse | null>(null);
  const [violations, setViolations] = useState<FareFloorViolation[]>([]);
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState(false);
  const [why, setWhy] = useState(false);

  const proposed = useCallback((): FareTable => {
    const fares: FareTable = {};
    for (const cabin of CABIN_ORDER) {
      const minor = toMinor(draft[cabin] ?? '');
      if (minor !== undefined) fares[cabin] = minor;
    }
    return fares;
  }, [draft]);

  // The live preview. Debounced, because it runs the whole demand model on the
  // server and a request per keystroke would be a denial of service written by
  // its own author.
  useEffect(() => {
    const timer = setTimeout(() => {
      void (async () => {
        try {
          setPreview(await previewFares(route.id, proposed()));
          setFailed(false);
        } catch {
          setFailed(true);
        }
      })();
    }, 400);

    return () => {
      clearTimeout(timer);
    };
  }, [route.id, proposed]);

  const onSave = async () => {
    setSaved(false);
    try {
      const result = await saveFares(route.id, proposed());
      if (result.ok) {
        setViolations([]);
        setSaved(true);
      } else {
        // Not an error state: the server's considered answer, with the floor.
        setViolations(result.violations);
      }
    } catch {
      setFailed(true);
    }
  };

  const violationFor = (cabin: CabinClass) => violations.find((v) => v.cabin === cabin);
  const delta = preview === null ? null : preview.projectedPassengers - preview.currentPassengers;

  return (
    <section className="card">
      <h2 className="card__heading">
        {route.originIcao} → {route.destinationIcao}
        <span className="fares__distance figure">{route.greatCircleNm.toFixed(0)} nm</span>
      </h2>

      <table className="admin__table fares__table">
        <thead>
          <tr>
            <th scope="col">Cabin</th>
            <th scope="col">Your fare</th>
            <th scope="col">Market avg</th>
            <th scope="col">vs market</th>
            <th scope="col">Floor</th>
            <th scope="col">Projected share</th>
          </tr>
        </thead>
        <tbody>
          {(preview?.positions ?? []).map((position) => (
            <Position
              key={position.cabin}
              position={position}
              draft={draft[position.cabin] ?? ''}
              onChange={(value) => {
                setDraft((current) => ({ ...current, [position.cabin]: value }));
                setSaved(false);
              }}
              violation={violationFor(position.cabin)}
            />
          ))}
        </tbody>
      </table>

      {preview === null && !failed && <p className="admin__note">Working out the market…</p>}
      {failed && (
        <p className="admin__note" role="alert">
          Could not reach the market model. The figures above may be stale.
        </p>
      )}

      {preview !== null && (
        <p className="fares__projection">
          <strong className="figure">{preview.projectedPassengers.toFixed(0)}</strong> passengers a
          day at these fares
          {delta !== null && Math.abs(delta) >= 0.5 && (
            <span
              className={
                delta > 0 ? 'fares__delta fares__delta--up' : 'fares__delta fares__delta--down'
              }
            >
              {delta > 0 ? '▲' : '▼'} {Math.abs(delta).toFixed(0)} against what is saved
            </span>
          )}
        </p>
      )}

      {violations.length > 0 && (
        <ul className="fares__violations" role="alert">
          {violations.map((v) => (
            <li key={v.cabin} id={`floor-${v.cabin}`} className="fares__violation">
              <strong>{CABIN_LABEL[v.cabin]}</strong> may not be priced below{' '}
              <span className="figure">{major(v.floorMinor)}</span> — that is{' '}
              {(v.ratio * 100).toFixed(0)}% of the{' '}
              <span className="figure">{major(v.variableCostPerSeatMinor)}</span> it costs to fly a
              seat on this route. You are <span className="figure">{major(v.shortfallMinor)}</span>{' '}
              under.
            </li>
          ))}
        </ul>
      )}

      <div className="fares__actions">
        <button className="admin__submit" type="button" onClick={() => void onSave()}>
          Save fares
        </button>
        {/* One click to the chart. A.9 is the surface the game is learned
            through, so it is not behind a tab or a second page. */}
        <button
          className="waterfall__toggle"
          type="button"
          aria-expanded={why}
          onClick={() => {
            setWhy(!why);
          }}
        >
          Why am I losing?
        </button>
        {saved && <span className="fares__saved">Saved.</span>}
      </div>

      {why && <Waterfall route={route} />}
    </section>
  );
}

export function NetworkPage(): ReactNode {
  const [routes, setRoutes] = useState<RouteSummary[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      setRoutes(await fetchRoutes());
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="page">
      <h1 className="page__title">Network</h1>

      {failed && (
        <p className="page__note" role="alert">
          Could not load your routes.
        </p>
      )}
      {routes === null && !failed && <p className="page__note">Loading…</p>}
      <OpenRouteForm
        onOpened={() => {
          void load();
        }}
      />

      {routes !== null && routes.length === 0 && (
        <p className="page__note">No routes yet. Open one above, and its fares are set here.</p>
      )}

      {(routes ?? []).map((route) => (
        <RoutePanel key={route.id} route={route} />
      ))}
    </section>
  );
}
