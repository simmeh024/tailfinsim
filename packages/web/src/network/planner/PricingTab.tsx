import { useCallback, useEffect, useMemo, useState } from 'react';

import { CABIN_ORDER } from '@tailfin/shared';
import type {
  CabinClass,
  CabinMarketPosition,
  FarePreviewResponse,
  FareFloorViolation,
  FareTable,
  WaterfallSegment,
} from '@tailfin/shared';

import { activeCurrency, inputToUsdMinor, usdMinorToInput } from '../../currency/display';
import { Button } from '../../ui/Button';
import { StateBlock } from '../../ui/StateBlock';
import {
  fetchWaterfall,
  previewFares,
  rivalsOf,
  saveFares,
  type RouteSummary,
  type WaterfallOutcome,
} from '../api';

import { major } from './ui';

import type { ReactNode } from 'react';

/**
 * The Pricing tab (M3-09, M3-10).
 *
 * Lifted wholesale from the old single-page Network view — the fare table, the
 * live preview, the floor-explained refusal, and the "why am I losing?" waterfall.
 * Every number still comes from the server; this package has no economics in it
 * (invariant 1, and ESLint refuses the client an import of `@tailfin/sim`). The
 * only change from before is where it lives: its own tab, not the whole page.
 *
 * ## The fields are in the display currency, and the table is replaced whole
 *
 * `PUT /fares` replaces the route's whole fare table, so every cabin the page
 * does not send is a cabin it deletes. The fields therefore hold a plain number
 * in the player's display currency — the currency of the market average and the
 * floor beside them — and a cabin the player has not touched sends its stored
 * fare exactly rather than a round trip through that currency. They were once
 * pre-filled with the *formatted* figure (`$120.00`), which reads back as NaN, so
 * every cabin the player did not retype was dropped and Save deleted its fare.
 */

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
  unreadable,
}: {
  position: CabinMarketPosition;
  draft: string;
  onChange: (value: string) => void;
  violation: FareFloorViolation | undefined;
  /** The field holds something that is not a number, so it cannot be sent. */
  unreadable: boolean;
}): ReactNode {
  const { cabin } = position;
  const describedBy = unreadable ? `unreadable-${cabin}` : violation ? `floor-${cabin}` : undefined;
  return (
    <tr className={violation || unreadable ? 'fares__row fares__row--refused' : 'fares__row'}>
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
            aria-invalid={violation !== undefined || unreadable}
            aria-describedby={describedBy}
            onChange={(event) => {
              onChange(event.target.value);
            }}
          />
        </label>
        {unreadable && (
          <span id={`unreadable-${cabin}`} className="fares__violation" role="alert">
            Enter the fare as a plain number, without a currency sign.
          </span>
        )}
      </td>
      <td className="figure">{major(position.marketAverageMinor)}</td>
      <td className="figure">
        {position.priceRel === null ? '—' : `${(position.priceRel * 100).toFixed(0)}%`}
      </td>
      <td className="figure">{major(position.floorMinor)}</td>
      <td className="figure">
        {position.projectedShare === null ? '—' : `${(position.projectedShare * 100).toFixed(1)}%`}
      </td>
    </tr>
  );
}

const FACTOR_LABEL: Record<string, string> = {
  price: 'Price',
  frequency: 'Frequency',
  product: 'Product',
  reputation: 'Reputation',
  schedule: 'Schedule fit',
  loyalty: 'Loyalty',
  alliance: 'Alliance',
  attractiveness: 'Social media',
  connectionPenalty: 'Connection',
};

const SEGMENT_LABEL: Record<string, string> = {
  business: 'Business',
  leisure: 'Leisure',
  vfr: 'VFR',
};

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

function Waterfall({ route }: { route: RouteSummary }): ReactNode {
  const [cabin, setCabin] = useState<CabinClass>('economy');
  const [rival, setRival] = useState<string | undefined>(undefined);
  const [outcome, setOutcome] = useState<WaterfallOutcome | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
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
    return <StateBlock kind="broken">The market would not answer just now.</StateBlock>;
  }
  if (outcome === null) return <StateBlock kind="loading">Working out why…</StateBlock>;

  if (!outcome.ok && outcome.kind === 'no-rival') {
    return (
      <StateBlock kind="empty">
        Nobody else is selling {route.originIcao} → {route.destinationIcao}, so there is no gap to
        decompose. You have the route to yourself.
      </StateBlock>
    );
  }

  const rivals = rivalsOf(outcome);
  const against = outcome.ok ? outcome.waterfall.rivalId : rival;

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
        <StateBlock kind="empty">
          {outcome.kind === 'cabin-not-contested'
            ? `Nobody else sells ${CABIN_LABEL[outcome.cabin].toLowerCase()} on this route.`
            : 'That airline does not fly this route.'}
        </StateBlock>
      )}
    </div>
  );
}

/** The stored fares as the fields show them: plain numbers in the display currency. */
function fieldsFor(fares: FareTable): Record<string, string> {
  return Object.fromEntries(
    CABIN_ORDER.map((cabin) => [
      cabin,
      fares[cabin] === undefined ? '' : usdMinorToInput(fares[cabin]),
    ]),
  );
}

export function PricingTab({
  route,
  onSaved,
}: {
  route: RouteSummary;
  /**
   * The table the server now holds, so the page's copy of the route follows it.
   * Without it, reopening the tab showed the fares from before the save, and
   * saving again put them back.
   */
  onSaved?: (fares: FareTable) => void;
}): ReactNode {
  const stored = useMemo(() => fieldsFor(route.fares), [route.fares]);
  const [draft, setDraft] = useState<Record<string, string>>(() => stored);
  const [preview, setPreview] = useState<FarePreviewResponse | null>(null);
  const [violations, setViolations] = useState<FareFloorViolation[]>([]);
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState(false);
  const [why, setWhy] = useState(false);

  /**
   * The table a Save would send, and the cabins whose field cannot be read.
   *
   * A field left as it was shown sends the stored fare itself: converting it to
   * the display currency and back could move it by a cent, and a Save must not
   * reprice a cabin nobody touched. An emptied field sends nothing, which is how
   * a player withdraws a cabin's fare.
   */
  const proposal = useMemo(() => {
    const fares: FareTable = {};
    const unreadable: CabinClass[] = [];
    for (const cabin of CABIN_ORDER) {
      const text = draft[cabin] ?? '';
      if (text.trim() === '') continue;
      const kept = route.fares[cabin];
      if (kept !== undefined && text === stored[cabin]) {
        fares[cabin] = kept;
        continue;
      }
      const minor = inputToUsdMinor(text);
      if (minor === undefined) unreadable.push(cabin);
      else fares[cabin] = minor;
    }
    return { fares, unreadable };
  }, [draft, route.fares, stored]);

  const proposed = useCallback((): FareTable => proposal.fares, [proposal]);
  const blocked = proposal.unreadable.length > 0;

  useEffect(() => {
    // A preview without an unreadable cabin would price a table nobody asked for.
    if (blocked) return;
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
  }, [route.id, proposed, blocked]);

  const onSave = async () => {
    if (blocked) return;
    setSaved(false);
    try {
      const result = await saveFares(route.id, proposed());
      if (result.ok) {
        setViolations([]);
        setSaved(true);
        onSaved?.(result.fares);
      } else {
        setViolations(result.violations);
      }
    } catch {
      setFailed(true);
    }
  };

  const violationFor = (cabin: CabinClass) => violations.find((v) => v.cabin === cabin);
  const delta = preview === null ? null : preview.projectedPassengers - preview.currentPassengers;

  return (
    <section className="net-panel">
      <div className="net-panel__head">
        <h2 className="net-panel__title">Fares &amp; market position</h2>
        <span className="net-panel__hint">Every figure is the server’s, previewed live.</span>
      </div>

      <table className="admin__table fares__table">
        <thead>
          <tr>
            <th scope="col">Cabin</th>
            <th scope="col">Your fare ({activeCurrency()})</th>
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
              unreadable={proposal.unreadable.includes(position.cabin)}
            />
          ))}
        </tbody>
      </table>

      {preview === null && !failed && (
        <StateBlock kind="loading">Working out the market…</StateBlock>
      )}
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
        <Button variant="primary" disabled={blocked} onClick={() => void onSave()}>
          Save fares
        </Button>
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
